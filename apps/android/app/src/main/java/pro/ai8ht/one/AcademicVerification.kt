package pro.ai8ht.one

/*
 * Academic verification on the phone (INST-04): the same scoped queue the web shows faculty
 * under "Academic Verification" and admins and department heads under "Students", with
 * confirm and reject. Decisions are permanent and carry a reason code, exactly as on the
 * web. Evidence shows only the document's title, type and version (ADR-027) — it cannot be
 * opened until the student can consent to share that version.
 *
 * The bulk results upload stays on the web: choosing and reviewing a CSV of hundreds of
 * rows is a desk task, and the phone offers nothing the web preview does not.
 */

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable data class VerificationSummaryDto(val pending: Int = 0, val notCurrent: Int = 0)
@Serializable data class VerificationSummaryEnvelope(val summary: VerificationSummaryDto? = null)

@Serializable data class VerificationEvidenceDto(
    val title: String = "",
    val documentType: String = "",
    val versionNumber: Int = 1,
    val shared: Boolean = false,
)

@Serializable data class VerifiedRecordDto(
    val resultValue: Double? = null,
    val resultScale: String? = null,
    val resultLetter: String? = null,
    val backlogCount: Int? = null,
)

@Serializable data class VerificationEntryDto(
    val termId: String,
    val label: String = "",
    val resultValue: String? = null,
    val resultScale: String? = null,
    val resultLetter: String? = null,
    val backlogCount: Int? = null,
    val programmeName: String = "",
    val qualificationType: String = "",
    val studentEmail: String = "",
    val studentName: String? = null,
    val institutionStudentId: String? = null,
    val relationship: String = "NONE",
    val evidence: VerificationEvidenceDto? = null,
    val institutionRecord: VerifiedRecordDto? = null,
)

@Serializable data class VerificationQueueEnvelope(
    val queue: List<VerificationEntryDto> = emptyList(),
    val nextCursor: String? = null,
)

/** Server-counted backlog over the reader's scope — the same numbers as the web Dashboard. */
suspend fun Api.verificationSummary(context: Context, institutionId: String): VerificationSummaryDto? =
    json.decodeFromString<VerificationSummaryEnvelope>(
        request(context, "GET", "/api/v1/institutions/$institutionId/academic-verification-summary"),
    ).summary

suspend fun Api.verificationQueue(context: Context, institutionId: String, after: String? = null): VerificationQueueEnvelope =
    json.decodeFromString(
        request(context, "GET", "/api/v1/institutions/$institutionId/academic-verification-queue" +
            (after?.let { "?after=$it" } ?: "")),
    )

suspend fun Api.decideVerification(
    context: Context, institutionId: String, termId: String, decision: String, reasonCode: String,
): VerificationQueueEnvelope =
    json.decodeFromString(
        request(context, "POST", "/api/v1/institutions/$institutionId/academic-verification/$termId/decide",
            "{\"decision\":\"$decision\",\"reasonCode\":\"$reasonCode\"}"),
    )

/** Same codes as the web; a confirmation records MATCHES_INSTITUTION_RECORD. */
private val rejectionReasons = listOf(
    "DOES_NOT_MATCH_RECORD" to "Does not match our record",
    "RECORD_NOT_FOUND" to "No record of this result",
    "NOT_OUR_STUDENT" to "Not a student of this institution",
    "EVIDENCE_INSUFFICIENT" to "Needs clearer evidence",
)

private fun resultText(value: String?, scale: String?, letter: String?): String = when {
    letter != null -> letter
    value == null -> "NA"
    scale == "PERCENTAGE" -> "$value%"
    scale == "CGPA_10" -> "$value / 10"
    scale == "GPA_4" -> "$value / 4"
    else -> value
}

private fun standing(relationship: String): Pair<String, ChipKind> = when (relationship) {
    "CURRENT" -> "Current student" to ChipKind.Positive
    "FORMER" -> "Former student" to ChipKind.Waiting
    else -> "Not on your roster" to ChipKind.Muted
}

@Composable
internal fun VerificationQueueOverlay(organizationId: String, onClose: () -> Unit, onChanged: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var entries by remember { mutableStateOf<List<VerificationEntryDto>?>(null) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }
    var confirming by remember { mutableStateOf<VerificationEntryDto?>(null) }
    var rejecting by remember { mutableStateOf<VerificationEntryDto?>(null) }
    var reason by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(reload) {
        runCatching { Api.verificationQueue(context, organizationId) }
            .onSuccess { entries = it.queue; cursor = it.nextCursor; failed = false }
            .onFailure { failed = true }
    }

    fun decide(entry: VerificationEntryDto, decision: String, code: String) {
        busy = true
        scope.launch {
            runCatching { Api.decideVerification(context, organizationId, entry.termId, decision, code) }
                .onSuccess {
                    entries = it.queue; cursor = it.nextCursor
                    notice = if (decision == "VERIFIED") "Verified. This decision is permanent and cannot be reversed."
                    else "Rejected. The student can correct the record and submit it again."
                    onChanged()
                }
                .onFailure { notice = "That decision could not be recorded. Pull the queue again and retry." }
            busy = false; confirming = null; rejecting = null; reason = null
        }
    }

    OverlayScaffold("Academic verification", onClose) {
        val list = entries
        when {
            failed -> CenteredNote("The verification queue could not be loaded right now.")
            list == null -> LoadingSpinner()
            else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
                item {
                    Spacer(Modifier.height(12.dp))
                    Text(
                        "Results students have asked you to confirm. A confirmation is permanent. " +
                            "Bulk results upload is on the web.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    notice?.let {
                        Spacer(Modifier.height(8.dp))
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
                if (list.isEmpty()) {
                    item {
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Text("Nothing is waiting. When a student or former student submits a result for confirmation it will appear here.",
                                Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                items(list, key = { it.termId }) { entry ->
                    Spacer(Modifier.height(12.dp))
                    PilotCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp)) {
                            Row(verticalAlignment = Alignment.Top) {
                                Column(Modifier.weight(1f)) {
                                    // No roster record means ONE was never told a name; show the email instead of a guess.
                                    Text(entry.studentName ?: "No roster record — identify by email",
                                        style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                                    Text(listOfNotNull(entry.studentEmail, entry.institutionStudentId).joinToString(" · "),
                                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                val (label, kind) = standing(entry.relationship)
                                StatusChip(label, kind)
                            }
                            Spacer(Modifier.height(8.dp))
                            Text("${entry.programmeName} · ${entry.label}", style = MaterialTheme.typography.bodyMedium)
                            Text(
                                resultText(entry.resultValue, entry.resultScale, entry.resultLetter) +
                                    (entry.backlogCount?.takeIf { it > 0 }?.let { " · $it backlog" } ?: ""),
                                style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold,
                            )
                            entry.institutionRecord?.let { record ->
                                Text(
                                    "Your verified record: " +
                                        resultText(record.resultValue?.toString(), record.resultScale, record.resultLetter) +
                                        (record.backlogCount?.let { ", $it backlog" } ?: ""),
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error,
                                )
                            }
                            Spacer(Modifier.height(6.dp))
                            Text(
                                entry.evidence?.let {
                                    "Evidence: ${it.title} · ${prettify(it.documentType)} · version ${it.versionNumber}. " +
                                        "Not shared with the college — the student has not given consent to open this version."
                                } ?: "No evidence attached",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(10.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(onClick = { confirming = entry }, enabled = !busy, shape = RoundedCornerShape(10.dp)) { Text("Confirm") }
                                OutlinedButton(onClick = { rejecting = entry; reason = null }, enabled = !busy,
                                    shape = RoundedCornerShape(10.dp)) { Text("Reject") }
                            }
                        }
                    }
                }
                if (cursor != null) {
                    item {
                        TextButton(onClick = {
                            scope.launch {
                                runCatching { Api.verificationQueue(context, organizationId, cursor) }
                                    .onSuccess { page -> entries = (entries ?: emptyList()) + page.queue; cursor = page.nextCursor }
                                    .onFailure { notice = "More requests could not be loaded." }
                            }
                        }) { Text("Load more requests") }
                    }
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }

    confirming?.let { entry ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text("Confirm this result?") },
            text = { Text("${entry.label}: ${resultText(entry.resultValue, entry.resultScale, entry.resultLetter)}. " +
                "A confirmation is permanent and cannot be reversed.") },
            confirmButton = { TextButton(enabled = !busy, onClick = { decide(entry, "VERIFIED", "MATCHES_INSTITUTION_RECORD") }) { Text("Confirm") } },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text("Cancel") } },
        )
    }
    rejecting?.let { entry ->
        AlertDialog(
            onDismissRequest = { rejecting = null },
            title = { Text("Reason for rejecting") },
            text = {
                Column {
                    rejectionReasons.forEach { (code, label) ->
                        Row(Modifier.fillMaxWidth().clickable { reason = code }, verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = reason == code, onClick = { reason = code })
                            Text(label, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(enabled = reason != null && !busy, onClick = { reason?.let { decide(entry, "REJECTED", it) } }) { Text("Reject") }
            },
            dismissButton = { TextButton(onClick = { rejecting = null }) { Text("Cancel") } },
        )
    }
}
