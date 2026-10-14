package pro.ai8ht.one

import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.EventNote
import androidx.compose.material.icons.filled.WorkOutline
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
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
import pro.ai8ht.one.ui.Tone

/**
 * The employer's working screens: move a candidate on, write up an interview, manage
 * offers.
 *
 * ONE's authorization is unchanged by any of this. An interviewer sees an interview
 * because they are a participant on it (ADR-026), not because of a role grant, and the
 * server re-checks that on every request — so "My interviews" here is simply the list
 * the server is willing to return.
 */

// ---------------------------------------------------------------------------
// Applicant pipeline
// ---------------------------------------------------------------------------

/** The forward moves a recruiter makes most; the server still decides what is legal. */
private val pipelineMoves = listOf(
    "SHORTLISTED" to "Shortlist",
    // EMP-12: screening tests go to candidates in the Assessment stage, as on the web.
    "ASSESSMENT" to "Move to assessment",
    "INTERVIEW" to "Move to interview",
    "OFFER" to "Make an offer",
    "REJECTED" to "Not selected",
)

/**
 * EMP-06: with the job's stages, the stages still ahead of this applicant, in order, one per
 * application state (labelled as the employer named them), then shortlist and reject; without
 * stages, the standard moves.
 */
private val pipelineOrder = listOf("APPLIED", "SCREENING", "SHORTLISTED", "ASSESSMENT", "INTERVIEW", "OFFER")
internal fun applicantMoves(stages: List<SelectionStageDto>, currentState: String): List<Pair<String, String>> {
    if (stages.isEmpty()) return pipelineMoves.filter { it.first != currentState }
    val current = pipelineOrder.indexOf(currentState)
    val seen = mutableSetOf<String>()
    val ahead = stages.sortedBy { it.order }.mapNotNull { stage ->
        val target = stage.applicationState ?: return@mapNotNull null
        if (pipelineOrder.indexOf(target) <= current || !seen.add(target)) null else target to "Move to ${stage.label}"
    }
    val shortlist = if ((currentState == "APPLIED" || currentState == "SCREENING") && ahead.none { it.first == "SHORTLISTED" }) listOf("SHORTLISTED" to "Shortlist") else emptyList()
    return ahead + shortlist + listOf("REJECTED" to "Not selected")
}

@Composable
internal fun ApplicantActionsPage(
    eligibility: ApplicantEligibilityDto? = null,
    stages: List<SelectionStageDto> = emptyList(),
    employerId: String,
    applicantName: String,
    applicationId: String,
    currentState: String,
    onClose: () -> Unit,
    onChanged: () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    var confirming by remember { mutableStateOf<Pair<String, String>?>(null) }
    var shared by remember { mutableIntStateOf(0) }

    OverlayScaffold(title = applicantName, onClose = onClose) {
        // Scrolls: the shared snapshot (EMP-07) can be longer than a screen.
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(12.dp))
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text("Current stage", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(4.dp))
                    StatusChip(applicationStageLabel(currentState), ChipKind.Accent)
                    stages.filter { it.applicationState == currentState }.map { it.label }.takeIf { it.isNotEmpty() }?.let {
                        Spacer(Modifier.height(4.dp))
                        Text(it.joinToString(" / "), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            // EMP-07: what the applicant chose to share, read-only, while their grant is live.
            CandidateSharedCards(employerId, applicationId, shared)
            // EMP-13: the verified evidence they chose to share, per job skill (nothing while the feature is off).
            CandidateEvidenceSection(employerId, applicationId, shared)
            // EMP-12: their results on this employer's own screening tests, while they share their details.
            CandidateScreeningSection(employerId, applicationId, shared)
            // EMP-10: the conversation with this candidate, while they share their details.
            EmployerConversationSection(employerId, applicationId, applicantName, shared)
            // EMP-06: eligibility as it stood when they applied. Outcome and basis only, never a figure.
            eligibility?.let { record ->
                Spacer(Modifier.height(12.dp))
                PilotCard {
                    Column(Modifier.padding(16.dp)) {
                        Text("Eligibility", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(4.dp))
                        val flagged = record.outcomes.filter { it.flagged }
                        if (flagged.isEmpty()) {
                            StatusChip("Meets every rule (college records)", ChipKind.Positive)
                        } else flagged.forEach { outcome ->
                            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(describeEligibilityRule(outcome.ruleType, outcome.comparator, outcome.valueNumeric, outcome.valueText, null) + ": " +
                                    when (outcome.outcome) { "MET" -> "met"; "NOT_MET" -> "not met"; "NOT_EVALUATED" -> "for you to judge"; else -> "not known" },
                                    Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                                if (outcome.basis == "SELF_REPORTED") StatusChip("Self-reported", ChipKind.Waiting)
                            }
                        }
                    }
                }
            }
            notice?.let {
                Spacer(Modifier.height(12.dp))
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                    Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
            Spacer(Modifier.height(12.dp))
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text("Move this candidate", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "ONE checks every move. If one is not allowed from this stage, you are told why.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(10.dp))
                    applicantMoves(stages, currentState).forEach { (state, label) ->
                        TextButton(
                            onClick = { confirming = state to label },
                            enabled = !busy,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(label, Modifier.fillMaxWidth()) }
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    // Rejection is the one move a candidate feels immediately and cannot be walked back
    // by the person who made it, so it is confirmed like the others rather than fired
    // from a list row.
    confirming?.let { (state, label) ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text("$label?") },
            text = { Text("$applicantName moves to ${applicationStageLabel(state).lowercase()}. They may be notified.") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = null
                    busy = true
                    scope.launch {
                        runCatching { Api.transitionApplication(context, employerId, applicationId, state) }
                            .onSuccess { notice = "Moved to ${applicationStageLabel(state)}."; shared++; onChanged() }
                            .onFailure { notice = (it as? Api.ApiException)?.detail ?: "That move was not allowed." }
                        busy = false
                    }
                }) { Text(label) }
            },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text("Cancel") } },
        )
    }
}

// ---------------------------------------------------------------------------
// My interviews and the scorecard
// ---------------------------------------------------------------------------

@Composable
internal fun MyInterviewsPage(employerId: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var interviews by remember { mutableStateOf<List<InterviewDto>?>(null) }
    var open by remember { mutableStateOf<InterviewDto?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        interviews = runCatching { Api.listMyInterviews(context, employerId) }.getOrNull() ?: emptyList()
    }

    open?.let { interview ->
        SlideIn {
            InterviewScorecardPage(
                employerId = employerId,
                interview = interview,
                onClose = { open = null },
                onSubmitted = { open = null; reload += 1 },
            )
        }
        return
    }

    OverlayScaffold(title = "My interviews", onClose = onClose) {
        when {
            interviews == null -> LoadingSpinner()
            interviews!!.isEmpty() -> EmptyState(
                Icons.Filled.EventNote, Tone.Accent, "No interviews assigned to you",
                "You see an interview here when you are put on its panel.",
            )
            else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
                items(interviews!!, key = { it.id }) { interview ->
                    Spacer(Modifier.height(12.dp))
                    PilotCard {
                        Column(Modifier.fillMaxWidth().clickable { open = interview }.padding(16.dp)) {
                            Row(verticalAlignment = Alignment.Top) {
                                Column(Modifier.weight(1f)) {
                                    Text(candidateLabel(interview.candidateName, interview.consentRevoked, interview.candidateAccess), style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.SemiBold)
                                    Text(interview.displayTitle, style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                StatusChip(prettify(interview.state), when (interview.state) {
                                    "COMPLETED" -> ChipKind.Positive
                                    "CANCELLED" -> ChipKind.Muted
                                    else -> ChipKind.Waiting
                                })
                            }
                            interview.scheduledStart?.let {
                                Spacer(Modifier.height(6.dp))
                                Text(formatWhen(it), style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }
}

private val recommendations = listOf(
    "STRONG_YES" to "Strong yes",
    "YES" to "Yes",
    "NO" to "No",
    "STRONG_NO" to "Strong no",
)

@Composable
private fun InterviewScorecardPage(
    employerId: String,
    interview: InterviewDto,
    onClose: () -> Unit,
    onSubmitted: () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var brief by remember { mutableStateOf<InterviewBriefDto?>(null) }
    var recommendation by remember { mutableStateOf("") }
    var rating by remember { mutableStateOf(0) }
    var strengths by remember { mutableStateOf("") }
    var concerns by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    // EMP-09: one rating per criterion of the stage's scorecard template, when it has one.
    var criteria by remember { mutableStateOf<Map<String, Int>>(emptyMap()) }

    LaunchedEffect(interview.id) {
        brief = runCatching { Api.myInterviewBrief(context, employerId, interview.id) }.getOrNull()
    }
    val template = brief?.scorecardTemplate
    val criteriaComplete = template == null || template.criteria.all { criteria.containsKey(it.id) }

    OverlayScaffold(title = "Scorecard", onClose = onClose) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            item {
                Spacer(Modifier.height(12.dp))
                PilotCard {
                    Column(Modifier.padding(16.dp)) {
                        Text(candidateLabel(interview.candidateName, interview.consentRevoked, interview.candidateAccess), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                        Text(interview.displayTitle, style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        (brief?.summary ?: brief?.opportunitySummary)?.takeIf { it.isNotBlank() }?.let {
                            Spacer(Modifier.height(8.dp))
                            Text(it, style = MaterialTheme.typography.bodySmall)
                        }
                        // EMP-09: the stage and, for the panellist's own calendar, the slot.
                        Spacer(Modifier.height(6.dp))
                        Text("Stage: ${brief?.stageLabel ?: "NA"}  ·  Scorecard: ${template?.name ?: "free text"}",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        val slot = brief?.scheduledStart ?: interview.scheduledStart
                        if (slot != null) {
                            TextButton(onClick = {
                                val added = addInterviewToCalendar(
                                    context, "Interview panel: ${interview.displayTitle}", slot, brief?.scheduledEnd ?: interview.scheduledEnd,
                                    brief?.joiningLink ?: brief?.locationDetail,
                                    "Round ${brief?.roundNumber ?: interview.roundNumber}. The candidate brief and any change are in ONE under My interviews.",
                                )
                                if (!added) notice = "No calendar app was found on this phone."
                            }) { Text("Add to calendar") }
                        }
                    }
                }
            }
            if (brief?.outcomeRecorded == true) {
                item {
                    Spacer(Modifier.height(12.dp))
                    PilotCard {
                        Column(Modifier.padding(16.dp)) {
                            StatusChip("Already submitted", ChipKind.Positive)
                            Spacer(Modifier.height(8.dp))
                            Text("Your scorecard for this interview has been recorded.",
                                style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                item { Spacer(Modifier.height(24.dp)) }
                return@LazyColumn
            }
            item {
                Spacer(Modifier.height(12.dp))
                PilotCard {
                    Column(Modifier.padding(16.dp)) {
                        Text("Your recommendation", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(8.dp))
                        recommendations.forEach { (value, label) ->
                            Row(
                                Modifier.fillMaxWidth().clickable { recommendation = value }.padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = recommendation == value, onClick = { recommendation = value })
                                Text(label, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                        Spacer(Modifier.height(10.dp))
                        Text("Overall rating (optional)", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            (1..5).forEach { value ->
                                TextButton(onClick = { rating = if (rating == value) 0 else value }) {
                                    Text(
                                        if (rating >= value) "★" else "☆",
                                        style = MaterialTheme.typography.titleLarge,
                                    )
                                }
                            }
                        }
                        // Optional on purpose: a panellist who cannot put a number on
                        // someone can still say what they think, and a forced score is
                        // invented precision.
                        Text("Leave this blank if a number would not mean anything.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            if (template != null) {
                item {
                    Spacer(Modifier.height(12.dp))
                    CriteriaRatingPicker(template, criteria) { id, value -> criteria = criteria + (id to value) }
                }
            }
            item {
                Spacer(Modifier.height(12.dp))
                PilotCard {
                    Column(Modifier.padding(16.dp)) {
                        OutlinedTextField(strengths, { strengths = it }, label = { Text("Strengths") },
                            minLines = 3, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(concerns, { concerns = it }, label = { Text("Concerns") },
                            minLines = 3, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(6.dp))
                        Text("These go to the hiring team. The candidate never sees them.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            item {
                notice?.let {
                    Spacer(Modifier.height(12.dp))
                    Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                        Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer)
                    }
                }
                Spacer(Modifier.height(14.dp))
                Button(
                    onClick = {
                        busy = true
                        notice = null
                        scope.launch {
                            runCatching {
                                Api.submitInterviewOutcome(
                                    context, employerId, interview.id, recommendation,
                                    rating.takeIf { it > 0 }, strengths.trim(), concerns.trim(), criteria,
                                )
                            }
                                .onSuccess { onSubmitted() }
                                .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not submit that." }
                            busy = false
                        }
                    },
                    enabled = !busy && recommendation.isNotBlank() && criteriaComplete,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (busy) "Submitting…" else "Submit scorecard") }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Offers and the funnel
// ---------------------------------------------------------------------------

@Composable
internal fun EmployerOffersPage(employerId: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var offers by remember { mutableStateOf<List<EmployerOfferDto>?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }
    var withdrawing by remember { mutableStateOf<EmployerOfferDto?>(null) }

    LaunchedEffect(reload) { offers = runCatching { Api.listEmployerOffers(context, employerId) }.getOrNull() ?: emptyList() }

    OverlayScaffold(title = "Offers", onClose = onClose) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            notice?.let {
                Spacer(Modifier.height(10.dp))
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                    Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
            when {
                offers == null -> LoadingSpinner()
                offers!!.isEmpty() -> EmptyState(
                    Icons.Filled.WorkOutline, Tone.Green, "No offers out",
                    "Offers you extend appear here with the candidate's response.",
                )
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(offers!!, key = { it.id }) { offer ->
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Row(verticalAlignment = Alignment.Top) {
                                    Column(Modifier.weight(1f)) {
                                        Text(candidateLabel(offer.candidateName, offer.consentRevoked, offer.candidateAccess), style = MaterialTheme.typography.titleMedium,
                                            fontWeight = FontWeight.SemiBold)
                                        Text(offer.opportunityTitle, style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    StatusChip(prettify(offer.state), when (offer.state) {
                                        "ACCEPTED" -> ChipKind.Positive
                                        "DECLINED", "WITHDRAWN" -> ChipKind.Muted
                                        else -> ChipKind.Waiting
                                    })
                                }
                                offer.respondBy?.let {
                                    Spacer(Modifier.height(6.dp))
                                    Text("Candidate responds by ${formatWhen(it)}",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.primary)
                                }
                                if (offer.state == "EXTENDED") {
                                    Spacer(Modifier.height(8.dp))
                                    TextButton(onClick = { withdrawing = offer }) { Text("Withdraw offer") }
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }

    withdrawing?.let { offer ->
        AlertDialog(
            onDismissRequest = { withdrawing = null },
            title = { Text("Withdraw this offer?") },
            text = {
                Text(
                    "${offer.candidateName ?: "The candidate"} is waiting on this. Withdrawing is recorded against your " +
                        "organisation and the candidate is told.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val target = offer
                    withdrawing = null
                    scope.launch {
                        runCatching { Api.withdrawOffer(context, employerId, target.id, "Withdrawn from the app.") }
                            .onSuccess { notice = "Offer withdrawn."; reload += 1 }
                            .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not withdraw that offer." }
                    }
                }) { Text("Withdraw") }
            },
            dismissButton = { TextButton(onClick = { withdrawing = null }) { Text("Keep it open") } },
        )
    }
}

private val reportCellLabels = listOf(
    "APPLIED" to "Applied", "SCREENING" to "Screening", "SHORTLISTED" to "Shortlisted", "ASSESSMENT" to "Assessment",
    "INTERVIEW" to "Interview", "OFFER" to "Offer", "HIRED" to "Hired",
    "LEFT_AT_APPLIED" to "Left at applied", "LEFT_AT_SCREENING" to "Left at screening", "LEFT_AT_SHORTLISTED" to "Left at shortlisted",
    "LEFT_AT_ASSESSMENT" to "Left at assessment", "LEFT_AT_INTERVIEW" to "Left at interview", "LEFT_AT_OFFER" to "Left at offer",
)
private val reportMetricLabels = mapOf(
    "SHORTLIST" to "Submission to shortlist", "INTERVIEW" to "Submission to interview",
    "OFFER" to "Submission to first offer", "HIRE" to "Submission to hire",
)
private val reportOfferLabels = listOf(
    "EXTENDED" to "Awaiting an answer", "ACCEPTED" to "Accepted", "DECLINED" to "Declined", "EXPIRED" to "Expired", "WITHDRAWN" to "Withdrawn",
)

/** One group of a report: its name, total, and each stage as the server sent it. */
@Composable
private fun ReportGroupCard(name: String, detail: String?, table: ReportTableDto) {
    PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    if (detail != null) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                val total = table.totalLabel()
                if (isMissingFigure(total)) NaValueText(total, MaterialTheme.typography.titleSmall)
                else Text(total, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.height(6.dp))
            Text(
                if (table.suppressed) "Fewer than 5 applications — not broken down."
                else reportCellLabels.joinToString(" · ") { (key, label) -> "$label ${table.cellLabel(key)}" },
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * EMP-15: the employer's hiring reports, read-only — the same suppressed figures as the web's
 * Reports. No candidate is shown; a group of fewer than 5 people reads "<5".
 */
@Composable
internal fun EmployerReportsPage(employerId: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var reports by remember { mutableStateOf<EmployerReportsDto?>(null) }
    var failed by remember { mutableStateOf(false) }

    LaunchedEffect(employerId) {
        runCatching { Api.employerReports(context, employerId) }
            .onSuccess { reports = it }
            .onFailure { failed = true }
    }

    OverlayScaffold(title = "Reports", onClose = onClose) {
        val data = reports
        when {
            failed -> EmptyState(
                Icons.Filled.WorkOutline, Tone.Violet, "We could not load your reports",
                "Check your connection and try again.",
            )
            data == null -> LoadingSpinner()
            else -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
                Spacer(Modifier.height(12.dp))
                Text("Every application to your jobs, grouped. Any group of fewer than ${data.threshold} people reads <5, and a total that would reveal one reads Withheld.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

                SectionTitle("Where applications are now")
                ReportGroupCard("All jobs", null, data.overall)

                SectionTitle("Time to each stage")
                PilotCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        data.timeToStage.forEach { row ->
                            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                                Text(reportMetricLabels[row.metric] ?: row.metric, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                Text(row.medianDays?.let { "%.1f days".format(it) } ?: "NA", fontWeight = FontWeight.SemiBold)
                            }
                        }
                        Text("Median days from submission, shown only when at least 5 applications reached the step.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }

                SectionTitle("Offer outcomes")
                PilotCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        val table = data.offers.table
                        if (table.suppressed) {
                            Text("Fewer than 5 applications have an offer — not broken down.", style = MaterialTheme.typography.bodySmall)
                        } else {
                            reportOfferLabels.forEach { (key, label) ->
                                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                                    Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                    Text(table.cellLabel(key), fontWeight = FontWeight.SemiBold)
                                }
                            }
                        }
                        Text("Acceptance: " + (data.offers.acceptanceRate?.let { "${(it * 100).toInt()}%" } ?: "too few answers"),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }

                SectionTitle("By job")
                if (data.byJob.isEmpty()) Text("No published jobs yet.", style = MaterialTheme.typography.bodySmall)
                data.byJob.forEach { ReportGroupCard(it.title ?: "Untitled", it.referenceCode, it.table) }

                SectionTitle("By college")
                if (data.byCollege.isEmpty()) Text("No applications yet.", style = MaterialTheme.typography.bodySmall)
                data.byCollege.forEach { ReportGroupCard(it.collegeName ?: "Other colleges or not stated", null, it.table) }

                SectionTitle("By campus drive")
                if (data.byDrive.isEmpty()) Text("No campus drives yet.", style = MaterialTheme.typography.bodySmall)
                data.byDrive.forEach { ReportGroupCard(it.institutionName, "${it.opportunityTitle ?: "Untitled"} · ${prettify(it.state)}", it.table) }
                Spacer(Modifier.height(20.dp))
            }
        }
    }
}

/** Employer sub-pages reachable from the dashboard. */
internal enum class EmployerOverlay { MyInterviews, Interviews, Offers, Analytics, Team, CompanyProfile, TermsTrust }

// ---------------------------------------------------------------------------
// EMP-12: screening test results for one candidate (read only)
// ---------------------------------------------------------------------------

/**
 * This employer's own screening tests for this application, question by question, with how
 * each attempt ended. Read only: tests are built and sent on the web. The server returns them
 * only while the candidate's applicant-access grant is live and records every read; nothing
 * here is readiness or anything ONE or the college measured.
 */
@Composable
internal fun CandidateScreeningSection(employerId: String, applicationId: String, reload: Int) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var results by remember { mutableStateOf<List<CandidateAssessmentDto>?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(employerId, applicationId, reload) {
        runCatching { Api.listCandidateAssessments(context, employerId, applicationId) }
            .onSuccess { results = it; status = null }
            .onFailure {
                results = null
                status = if ((it as? Api.ApiException)?.status == 403)
                    "This candidate is no longer sharing their application with you, so their test results are not shown."
                else "Their screening test results could not be loaded."
            }
    }
    Spacer(Modifier.height(12.dp))
    Text("Screening tests", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    Text("Your own tests for this application only. A score is information, not a decision.",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    status?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    val shown = results
    when {
        shown == null && status == null -> LoadingSpinner()
        shown != null && shown.isEmpty() -> Text(
            "You have not sent this candidate a screening test. Tests go to candidates in the Assessment stage, from Assessments on the web.",
            style = MaterialTheme.typography.bodySmall,
        )
        shown != null -> shown.forEach { item ->
            Spacer(Modifier.height(8.dp))
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(item.title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        StatusChip(prettify(item.state), if (item.state == "SUBMITTED") ChipKind.Positive else ChipKind.Muted)
                    }
                    Text("${item.durationSeconds / 60} min · window ${formatWhen(item.opensAt)} to ${formatWhen(item.closesAt)}",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(4.dp))
                    val ended = when (item.endedBy) { "TIME_LIMIT" -> " · time ran out"; "CANDIDATE" -> " · submitted by the candidate"; else -> "" }
                    Text(
                        (item.percentage?.let { "Score: ${it.toInt()}% (${item.score?.toInt() ?: 0} / ${item.maxScore?.toInt() ?: 0})" } ?: "Score: NA") + ended,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    item.questions.forEach { question ->
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "${question.displayOrder}. ${question.questionText} — ${question.marksAwarded.toInt()} / ${question.marks.toInt()}" +
                                if (question.answered) "" else " (not answered)",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }
    }
}
