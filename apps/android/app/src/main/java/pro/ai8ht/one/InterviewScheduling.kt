package pro.ai8ht.one

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.provider.CalendarContract
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.EventNote
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable
import pro.ai8ht.one.ui.Tone
import java.time.Instant

/**
 * Interview scheduling essentials on the phone (EMP-09).
 *
 * Students add an upcoming interview to their phone calendar and see when it moved. Employers
 * read their interviews with the stage, the latest change and why, the full schedule history,
 * and the scorecards recorded against the stage's template; a panellist fills a templated
 * scorecard criterion by criterion. Rescheduling, cancelling and managing templates stay on the
 * web, like posting a job: each needs a reason code and a confirmation.
 *
 * Nothing here is computed on the phone. Ratings are shown as each interviewer gave them and are
 * never added up; a missing value reads NA.
 */

@Serializable data class ScorecardTemplateRefDto(val id: String, val name: String? = null)

@Serializable data class ScorecardCriterionDto(val id: String, val position: Int = 0, val label: String, val guidance: String? = null)

@Serializable data class ScorecardTemplateDto(
    val id: String,
    val name: String,
    val guidance: String? = null,
    val retiredAt: String? = null,
    val criteria: List<ScorecardCriterionDto> = emptyList(),
)

@Serializable data class InterviewLastChangeDto(val kind: String, val reasonCode: String? = null, val at: String? = null)

@Serializable data class InterviewRevisionDto(
    val revisionNumber: Int,
    val changeKind: String,
    val reasonCode: String? = null,
    val note: String? = null,
    val mode: String = "",
    val scheduledStart: String? = null,
    val scheduledEnd: String? = null,
    val actorLabel: String = "",
    val recordedAt: String? = null,
)

@Serializable data class InterviewHistoryEnvelope(val revisions: List<InterviewRevisionDto> = emptyList())

@Serializable data class ScorecardRatingDto(val criterionId: String, val label: String, val rating: Int, val note: String? = null)

@Serializable data class InterviewScorecardDto(
    val submittedBy: String = "",
    val recommendation: String = "",
    val overallRating: Int? = null,
    val strengths: String? = null,
    val concerns: String? = null,
    val notes: String? = null,
    val submittedAt: String? = null,
    val ratings: List<ScorecardRatingDto> = emptyList(),
)

@Serializable data class InterviewScorecardsDto(val template: ScorecardTemplateDto? = null, val scorecards: List<InterviewScorecardDto> = emptyList())

suspend fun Api.listInterviewHistory(context: Context, employerId: String, interviewId: String): List<InterviewRevisionDto> =
    json.decodeFromString<InterviewHistoryEnvelope>(
        request(context, "GET", "/api/v1/employers/$employerId/interviews/$interviewId/history"),
    ).revisions

suspend fun Api.interviewScorecards(context: Context, employerId: String, interviewId: String): InterviewScorecardsDto =
    json.decodeFromString(request(context, "GET", "/api/v1/employers/$employerId/interviews/$interviewId/scorecards"))

/** Plain words for the reason codes (packages/hiring/src/interview-scheduling.ts). */
internal val interviewReasonLabels = mapOf(
    "CANDIDATE_REQUESTED" to "The candidate asked",
    "INTERVIEWER_UNAVAILABLE" to "An interviewer is unavailable",
    "SCHEDULING_CONFLICT" to "Scheduling conflict",
    "LOGISTICS_CHANGED" to "Arrangements changed",
    "TECHNICAL_ISSUE" to "Technical problem",
    "CANDIDATE_WITHDREW" to "The candidate withdrew",
    "POSITION_FILLED" to "The position is filled",
    "PROCESS_CHANGED" to "The process changed",
    "SCHEDULED_IN_ERROR" to "Scheduled in error",
)

private val changeLabels = mapOf(
    "BASELINE" to "As it stood when history began",
    "SCHEDULED" to "Scheduled",
    "RESCHEDULED" to "Rescheduled",
    "CANCELLED" to "Cancelled",
    "COMPLETED" to "Marked completed",
    "NO_SHOW" to "Marked no show",
)

internal fun lastChangeText(change: InterviewLastChangeDto?): String {
    if (change == null) return "NA"
    val label = changeLabels[change.kind] ?: prettify(change.kind)
    return change.reasonCode?.let { "$label — ${interviewReasonLabels[it] ?: prettify(it)}" } ?: label
}

/**
 * Hand the interview to the phone's calendar app to add, prefilled. The phone's calendar, not ONE,
 * keeps the event; if ONE later moves the interview the person is told and can add it again.
 * Returns false when no calendar app is installed.
 */
internal fun addInterviewToCalendar(
    context: Context, title: String, startIso: String, endIso: String?, location: String?, description: String,
): Boolean {
    val start = runCatching { Instant.parse(startIso).toEpochMilli() }.getOrNull() ?: return false
    val end = endIso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: (start + 60 * 60 * 1000)
    val intent = Intent(Intent.ACTION_INSERT)
        .setData(CalendarContract.Events.CONTENT_URI)
        .putExtra(CalendarContract.Events.TITLE, title)
        .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start)
        .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
        .putExtra(CalendarContract.Events.DESCRIPTION, description)
        .apply { if (!location.isNullOrBlank()) putExtra(CalendarContract.Events.EVENT_LOCATION, location) }
    return try {
        context.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}

/** A templated scorecard: one 1-5 choice per criterion, with its guidance. */
@Composable
internal fun CriteriaRatingPicker(template: ScorecardTemplateDto, ratings: Map<String, Int>, onRate: (String, Int) -> Unit) {
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            Text(template.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            template.guidance?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            template.criteria.sortedBy { it.position }.forEach { criterion ->
                Spacer(Modifier.height(10.dp))
                Text(criterion.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                criterion.guidance?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    (1..5).forEach { value ->
                        TextButton(onClick = { onRate(criterion.id, value) }) {
                            Text(if (ratings[criterion.id] == value) "[$value]" else "$value", fontWeight = if (ratings[criterion.id] == value) FontWeight.Bold else FontWeight.Normal)
                        }
                    }
                }
            }
            Spacer(Modifier.height(6.dp))
            Text("Rate every criterion from 1 to 5. ONE never adds these up; the hiring team reads each one.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

// ---------------------------------------------------------------------------
// Employer: interviews, read-only
// ---------------------------------------------------------------------------

@Composable
internal fun EmployerInterviewsPage(employerId: String, onClose: () -> Unit) {
    val context = LocalContext.current
    var interviews by remember { mutableStateOf<List<InterviewDto>?>(null) }
    var failed by remember { mutableStateOf<String?>(null) }
    var open by remember { mutableStateOf<InterviewDto?>(null) }

    LaunchedEffect(employerId) {
        runCatching { Api.listEmployerInterviews(context, employerId) }
            .onSuccess { interviews = it }
            .onFailure {
                interviews = emptyList()
                failed = if ((it as? Api.ApiException)?.status == 403) "Your organisation cannot reach candidates right now." else "Interviews could not be loaded."
            }
    }

    open?.let { interview ->
        SlideIn { EmployerInterviewDetailPage(employerId, interview, onClose = { open = null }) }
        return
    }

    OverlayScaffold(title = "Interviews", onClose = onClose) {
        when {
            interviews == null -> LoadingSpinner()
            interviews!!.isEmpty() -> EmptyState(
                Icons.Filled.EventNote, Tone.Accent, failed ?: "No interviews scheduled",
                failed?.let { "Check your connection and try again." } ?: "Interviews you schedule on the web appear here with their history.",
            )
            else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
                item {
                    Spacer(Modifier.height(10.dp))
                    Text("Reschedule, cancel and scorecard templates are on the web: each change needs a reason.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                items(interviews!!.sortedBy { it.scheduledStart ?: "9999" }, key = { it.id }) { interview ->
                    Spacer(Modifier.height(12.dp))
                    PilotCard {
                        Column(Modifier.fillMaxWidth().clickable { open = interview }.padding(16.dp)) {
                            Row(verticalAlignment = Alignment.Top) {
                                Column(Modifier.weight(1f)) {
                                    Text(candidateLabel(interview.candidateName, interview.consentRevoked, interview.candidateAccess),
                                        style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                    Text(listOfNotNull(interview.displayTitle.ifBlank { null }, interview.stageLabel ?: "Round ${interview.roundNumber}")
                                        .joinToString("  ·  "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                StatusChip(prettify(interview.state), when (interview.state) {
                                    "COMPLETED" -> ChipKind.Positive
                                    "CANCELLED", "NO_SHOW" -> ChipKind.Muted
                                    else -> ChipKind.Waiting
                                })
                            }
                            Spacer(Modifier.height(6.dp))
                            Text(interview.scheduledStart?.let { formatWhen(it) } ?: "Time to be confirmed",
                                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                            Text("Last change: ${lastChangeText(interview.lastChange)}", style = MaterialTheme.typography.bodySmall)
                            Text("Scorecards: ${interview.outcomeCount}" + (interview.scorecardTemplate?.name?.let { "  ·  Template: $it" } ?: ""),
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }
}

@Composable
private fun EmployerInterviewDetailPage(employerId: String, interview: InterviewDto, onClose: () -> Unit) {
    val context = LocalContext.current
    var history by remember { mutableStateOf<List<InterviewRevisionDto>?>(null) }
    var scorecards by remember { mutableStateOf<InterviewScorecardsDto?>(null) }
    var scorecardNotice by remember { mutableStateOf<String?>(null) }
    val canReadScorecards = !interview.consentRevoked && interview.candidateAccess && interview.outcomeCount > 0

    LaunchedEffect(interview.id) {
        history = runCatching { Api.listInterviewHistory(context, employerId, interview.id) }.getOrNull() ?: emptyList()
        if (canReadScorecards) {
            runCatching { Api.interviewScorecards(context, employerId, interview.id) }
                .onSuccess { scorecards = it }
                .onFailure { scorecardNotice = "Scorecards are not available: the candidate may no longer be sharing their details." }
        }
    }

    OverlayScaffold(title = "Interview", onClose = onClose) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            item {
                Spacer(Modifier.height(12.dp))
                PilotCard {
                    Column(Modifier.padding(16.dp)) {
                        Text(candidateLabel(interview.candidateName, interview.consentRevoked, interview.candidateAccess),
                            style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                        Text(listOfNotNull(interview.displayTitle.ifBlank { null }, interview.stageLabel ?: "Round ${interview.roundNumber}").joinToString("  ·  "),
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(6.dp))
                        Text(prettify(interview.state) + "  ·  " + (interview.scheduledStart?.let { formatWhen(it) } ?: "Time to be confirmed"),
                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            item {
                SectionTitle("History")
            }
            when {
                history == null -> item { LoadingSpinner() }
                history!!.isEmpty() -> item {
                    PilotCard { Text("No changes recorded.", Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall) }
                }
                else -> items(history!!, key = { "revision-${it.revisionNumber}" }) { revision ->
                    PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                        Column(Modifier.padding(14.dp)) {
                            Text((changeLabels[revision.changeKind] ?: prettify(revision.changeKind)) +
                                (revision.reasonCode?.let { " — ${interviewReasonLabels[it] ?: prettify(it)}" } ?: ""),
                                style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text("${revision.scheduledStart?.let { formatWhen(it) } ?: "NA"}  ·  ${prettify(revision.mode.ifBlank { "NA" })}",
                                style = MaterialTheme.typography.bodySmall)
                            Text("By ${revision.actorLabel.ifBlank { "NA" }} on ${revision.recordedAt?.let { formatWhen(it) } ?: "NA"}",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            revision.note?.takeIf { it.isNotBlank() }?.let {
                                Text("Note: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            item { SectionTitle("Scorecards") }
            val cards = scorecards
            when {
                !canReadScorecards -> item {
                    PilotCard { Text(if (interview.outcomeCount == 0) "No scorecards recorded yet." else "Scorecards are not available for this candidate.",
                        Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall) }
                }
                scorecardNotice != null -> item {
                    PilotCard { Text(scorecardNotice!!, Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall) }
                }
                cards == null -> item { LoadingSpinner() }
                else -> {
                    item {
                        Text("Template: ${cards.template?.name ?: "NA — free-text scorecard"}", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(6.dp))
                    }
                    items(cards.scorecards, key = { it.submittedBy + (it.submittedAt ?: "") }) { card ->
                        PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                            Column(Modifier.padding(14.dp)) {
                                Text(card.submittedBy, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                Text("Recommendation: ${prettify(card.recommendation)}  ·  Overall rating: ${card.overallRating ?: "NA"}",
                                    style = MaterialTheme.typography.bodySmall)
                                card.ratings.forEach { rating ->
                                    Text("${rating.label}: ${rating.rating} of 5" + (rating.note?.let { " — $it" } ?: ""), style = MaterialTheme.typography.bodySmall)
                                }
                                card.strengths?.takeIf { it.isNotBlank() }?.let { Text("Strengths: $it", style = MaterialTheme.typography.bodySmall) }
                                card.concerns?.takeIf { it.isNotBlank() }?.let { Text("Concerns: $it", style = MaterialTheme.typography.bodySmall) }
                            }
                        }
                    }
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}
