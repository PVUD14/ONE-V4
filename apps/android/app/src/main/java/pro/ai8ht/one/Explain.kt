package pro.ai8ht.one

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lightbulb
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import pro.ai8ht.one.ui.Tone

/**
 * "Ask ONE to explain" on the phone (ADR-052) — the Android side of the web's `studentExplain.tsx`, over the
 * same routes (/api/v1/learning/explain).
 *
 * Why it exists: Divakar decided (2026-10-10) a student may ask ONE to explain any topic and read an
 * AI-written lesson without a person reviewing each one. Android must show the same thing with the same
 * safeguards: every lesson labelled "AI-generated — not checked by a person"; asking answers at once with
 * "Your lesson is being prepared" and the screen polls while a job writes it; a refused, blocked or withdrawn
 * lesson shows a plain sentence and no text; "Report a mistake" sends a reason and an optional note. While the
 * feature is off the screen is the existing empty state saying plainly it is not available yet — never a
 * broken widget. Nothing here counts toward readiness. Operations on Android is view-only, so the review
 * queue is web-only.
 */

internal const val EXPLAIN_LABEL = "AI-generated — not checked by a person"
private const val PREPARING_TEXT = "Your lesson is being prepared"
private const val POLL_MS = 3_000L
/** Ten minutes: the server closes a lesson still preparing after that. */
private const val POLL_LIMIT = 200

private val NOT_AVAILABLE_TEXT = mapOf(
    "CHECKS_FAILED" to "ONE could not prepare a lesson on this topic that passed its checks. Try different wording, or try again later.",
    "TIMED_OUT" to "Preparing this lesson took too long. You can ask again.",
    "AI_UNAVAILABLE" to "Lessons cannot be prepared right now. Try again later.",
    "WITHDRAWN" to "This lesson was taken down after a check.",
)
private const val REFUSED_TEXT = "ONE can’t explain this. Ask ONE to explain covers learning topics only — not anything harmful, cheating, personal information about anyone, or tasks outside learning."

private val REPORT_REASONS = listOf(
    "WRONG_FACT" to "Something in it is wrong",
    "CONFUSING" to "It is confusing",
    "UNSAFE" to "It is unsafe or inappropriate",
    "NOT_WHAT_I_ASKED" to "It is not what I asked",
    "OTHER" to "Something else",
)

// --- API ---------------------------------------------------------------------

@Serializable data class ExplainLimitsDto(val topicMin: Int = 3, val topicMax: Int = 120, val perDay: Int = 10, val reportNoteMax: Int = 300)

@Serializable data class ExplainAvailabilityDto(
    val available: Boolean = false,
    /** OFF / PREPARING / DAILY_LIMIT, or null when available. */
    val reason: String? = "OFF",
    val remainingToday: Int? = null,
    val limits: ExplainLimitsDto = ExplainLimitsDto(),
)

@Serializable data class ExplainSectionDto(val heading: String = "", val text: String = "")

@Serializable data class ExplainLessonDto(
    val label: String = EXPLAIN_LABEL,
    val title: String = "",
    val sections: List<ExplainSectionDto> = emptyList(),
    val generatedAt: String = "",
    val promptVersion: String = "",
)

@Serializable data class ExplainRequestDto(
    val id: String = "",
    val topic: String = "",
    val askedAt: String = "",
    /** PREPARING / READY / NOT_AVAILABLE / REFUSED. */
    val state: String = "NOT_AVAILABLE",
    val notAvailable: String? = null,
    val servedFromCache: Boolean = false,
    val reported: Boolean = false,
    val lesson: ExplainLessonDto? = null,
)

@Serializable private data class ExplainStatusEnvelope(val availability: ExplainAvailabilityDto = ExplainAvailabilityDto())
@Serializable private data class ExplainRequestEnvelope(val request: ExplainRequestDto = ExplainRequestDto())
@Serializable private data class ExplainListEnvelope(val requests: List<ExplainRequestDto> = emptyList())

internal suspend fun Api.explainStatus(context: Context): ExplainAvailabilityDto =
    json.decodeFromString<ExplainStatusEnvelope>(request(context, "GET", "/api/v1/learning/explain/status")).availability

/** Ask ONE to explain a topic. Answers at once (202): a cached lesson, or the lesson being prepared by a job. */
internal suspend fun Api.askOneToExplain(context: Context, topic: String): ExplainRequestDto =
    json.decodeFromString<ExplainRequestEnvelope>(request(context, "POST", "/api/v1/learning/explain", buildJson("topic" to quoted(topic)))).request

internal suspend fun Api.explainRequests(context: Context): List<ExplainRequestDto> =
    json.decodeFromString<ExplainListEnvelope>(request(context, "GET", "/api/v1/learning/explain/requests")).requests

/** One request as it stands; the screen re-reads it while the lesson is being prepared. */
internal suspend fun Api.explainRequest(context: Context, requestId: String): ExplainRequestDto =
    json.decodeFromString<ExplainRequestEnvelope>(request(context, "GET", "/api/v1/learning/explain/requests/$requestId")).request

internal suspend fun Api.reportExplainLesson(context: Context, requestId: String, reasonCode: String, note: String?): ExplainRequestDto {
    val body = if (note.isNullOrBlank()) buildJson("reasonCode" to quoted(reasonCode))
    else buildJson("reasonCode" to quoted(reasonCode), "note" to quoted(note.trim()))
    return json.decodeFromString<ExplainRequestEnvelope>(request(context, "POST", "/api/v1/learning/explain/requests/$requestId/report", body)).request
}

// --- Screen --------------------------------------------------------------------

@Composable
private fun StateChip(request: ExplainRequestDto) {
    when (request.state) {
        "READY" -> if (request.reported) StatusChip("Reported", ChipKind.Waiting) else StatusChip("Ready", ChipKind.Positive)
        "PREPARING" -> StatusChip("Preparing", ChipKind.Accent)
        "REFUSED" -> StatusChip("Refused", ChipKind.Muted)
        else -> StatusChip("Not available", ChipKind.Muted)
    }
}

@Composable
internal fun ExplainPage(onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var availability by remember { mutableStateOf<Load<ExplainAvailabilityDto>>(Load.Loading) }
    var requests by remember { mutableStateOf<List<ExplainRequestDto>>(emptyList()) }
    var selected by remember { mutableStateOf<ExplainRequestDto?>(null) }
    var topic by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        val status = loadOf { Api.explainStatus(context) }
        availability = status
        if (status is Load.Ready && status.value.reason != "OFF") {
            runCatching { Api.explainRequests(context) }.onSuccess { requests = it }
        }
    }

    fun show(next: ExplainRequestDto) {
        selected = next
        requests = listOf(next) + requests.filter { it.id != next.id }
    }

    OverlayScaffold(title = "Ask ONE to explain", onClose = onClose) {
        val current = availability
        when {
            current is Load.Loading -> LoadingSpinner()
            current is Load.Failed -> FailedState(current.message) { reload += 1 }
            current is Load.Ready && current.value.reason == "OFF" -> EmptyState(
                Icons.Filled.Lightbulb, Tone.Violet, "Ask ONE to explain is not available yet",
                "When it is switched on, you will be able to ask ONE to explain any topic and read an AI-written lesson about it.")
            current is Load.Ready -> {
                val status = current.value
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
                    PilotCard {
                        Column(Modifier.padding(16.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("Ask ONE to explain", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                                StatusChip("AI", ChipKind.Accent)
                            }
                            Spacer(Modifier.height(6.dp))
                            Text("Name a topic and ONE writes a short lesson about it. Lessons are AI-generated and not checked by a person, and they do not count toward your readiness or anything a college or employer sees.",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.height(10.dp))
                            OutlinedTextField(
                                value = topic, onValueChange = { if (it.length <= status.limits.topicMax) topic = it },
                                label = { Text("Topic (English, ${status.limits.topicMin}–${status.limits.topicMax} characters)") },
                                singleLine = true, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth(),
                            )
                            Spacer(Modifier.height(8.dp))
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Button(
                                    onClick = {
                                        busy = true; error = null
                                        scope.launch {
                                            runCatching { Api.askOneToExplain(context, topic) }
                                                .onSuccess { show(it); topic = ""; reload += 1 }
                                                .onFailure { error = (it as? Api.ApiException)?.detail ?: "ONE could not take this request. Try again." }
                                            busy = false
                                        }
                                    },
                                    enabled = !busy && status.available && topic.trim().length >= status.limits.topicMin,
                                    shape = RoundedCornerShape(10.dp),
                                ) { Text("Explain") }
                                Spacer(Modifier.width(10.dp))
                                Text(
                                    when (status.reason) {
                                        "PREPARING" -> "Your last lesson is still being prepared."
                                        "DAILY_LIMIT" -> "You have asked for 10 lessons today. You can ask again tomorrow."
                                        else -> "${status.remainingToday ?: "NA"} of ${status.limits.perDay} left today."
                                    },
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            error?.let {
                                Spacer(Modifier.height(6.dp))
                                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                    selected?.let { request ->
                        Spacer(Modifier.height(14.dp))
                        ExplainRequestCard(request, onChange = { show(it) })
                    }
                    Spacer(Modifier.height(14.dp))
                    SectionTitle("Your questions")
                    if (requests.isEmpty()) CenteredNote("You have not asked ONE to explain anything yet.")
                    requests.forEach { entry ->
                        Spacer(Modifier.height(8.dp))
                        PilotCard {
                            Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(entry.topic, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                    Text(formatWhen(entry.askedAt), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                StateChip(entry)
                                TextButton(onClick = { selected = entry }) { Text("Open") }
                            }
                        }
                    }
                    Spacer(Modifier.height(20.dp))
                }
            }
        }
    }
}

@Composable
private fun ExplainRequestCard(request: ExplainRequestDto, onChange: (ExplainRequestDto) -> Unit) {
    val context = LocalContext.current
    if (request.state == "PREPARING") {
        LaunchedEffect(request.id) {
            repeat(POLL_LIMIT) {
                delay(POLL_MS)
                val next = runCatching { Api.explainRequest(context, request.id) }.getOrNull()
                if (next != null && next.state != "PREPARING") { onChange(next); return@LaunchedEffect }
            }
        }
    }
    PilotCard {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(request.lesson?.title ?: request.topic, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                StateChip(request)
            }
            when (request.state) {
                "PREPARING" -> Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusChip("AI", ChipKind.Accent)
                    Spacer(Modifier.width(8.dp))
                    Text("$PREPARING_TEXT…", style = MaterialTheme.typography.bodyMedium)
                }
                "REFUSED" -> Text(REFUSED_TEXT, style = MaterialTheme.typography.bodyMedium)
                "NOT_AVAILABLE" -> Text(NOT_AVAILABLE_TEXT[request.notAvailable] ?: NOT_AVAILABLE_TEXT.getValue("AI_UNAVAILABLE"), style = MaterialTheme.typography.bodyMedium)
                "READY" -> request.lesson?.let { lesson ->
                    StatusChip(lesson.label, ChipKind.Accent)
                    lesson.sections.forEach { section ->
                        Spacer(Modifier.height(6.dp))
                        Text(section.heading, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Text(section.text, style = MaterialTheme.typography.bodyMedium)
                    }
                    Spacer(Modifier.height(6.dp))
                    Text("Written by ONE’s AI and checked only by ONE’s automatic rules" + (if (request.servedFromCache) "; another student asked the same topic first." else "."),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (request.reported) {
                        Text("You reported this lesson. Thank you — operations will look at it.", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        ReportMistake(request.id, onChange)
                    }
                }
            }
        }
    }
}

@Composable
private fun ReportMistake(requestId: String, onChange: (ExplainRequestDto) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf(REPORT_REASONS.first()) }
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    if (!open) {
        OutlinedButton(onClick = { open = true }, shape = RoundedCornerShape(10.dp)) { Text("Report a mistake") }
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("What is wrong?", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        REPORT_REASONS.forEach { option ->
            Row(Modifier.fillMaxWidth().clickable { reason = option }, verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = reason == option, onClick = { reason = option })
                Text(option.second, style = MaterialTheme.typography.bodyMedium)
            }
        }
        OutlinedTextField(
            value = note, onValueChange = { if (it.length <= 300) note = it },
            label = { Text("Note (optional, no personal details)") }, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp),
        )
        Row {
            Button(
                onClick = {
                    busy = true; error = null
                    scope.launch {
                        runCatching { Api.reportExplainLesson(context, requestId, reason.first, note) }
                            .onSuccess { onChange(it) }
                            .onFailure { error = (it as? Api.ApiException)?.detail ?: "The report could not be sent. Try again." }
                        busy = false
                    }
                },
                enabled = !busy, shape = RoundedCornerShape(10.dp),
            ) { Text("Send report") }
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = { open = false }, enabled = !busy) { Text("Cancel") }
        }
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    }
}
