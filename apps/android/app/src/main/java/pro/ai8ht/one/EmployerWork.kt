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
    "INTERVIEW" to "Move to interview",
    "OFFER" to "Make an offer",
    "REJECTED" to "Reject",
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
    return ahead + shortlist + listOf("REJECTED" to "Reject")
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
                    StatusChip(prettify(currentState), ChipKind.Accent)
                    stages.filter { it.applicationState == currentState }.map { it.label }.takeIf { it.isNotEmpty() }?.let {
                        Spacer(Modifier.height(4.dp))
                        Text(it.joinToString(" / "), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            // EMP-07: what the applicant chose to share, read-only, while their grant is live.
            CandidateSharedCards(employerId, applicationId, shared)
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
                        "The server decides which moves are allowed from here; anything it refuses is reported back.",
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
            text = { Text("$applicantName moves to ${prettify(state).lowercase()}. They may be notified.") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = null
                    busy = true
                    scope.launch {
                        runCatching { Api.transitionApplication(context, employerId, applicationId, state) }
                            .onSuccess { notice = "Moved to ${prettify(state)}."; shared++; onChanged() }
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

@Composable
internal fun HiringAnalyticsPage(employerId: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var analytics by remember { mutableStateOf<HiringAnalyticsDto?>(null) }
    var failed by remember { mutableStateOf(false) }

    LaunchedEffect(employerId) {
        runCatching { Api.hiringAnalytics(context, employerId) }
            .onSuccess { analytics = it }
            .onFailure { failed = true }
    }

    OverlayScaffold(title = "Hiring", onClose = onClose) {
        val data = analytics
        when {
            failed -> EmptyState(
                Icons.Filled.WorkOutline, Tone.Violet, "We could not load your figures",
                "Check your connection and try again.",
            )
            data == null -> LoadingSpinner()
            else -> Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
                Spacer(Modifier.height(12.dp))
                // The funnel in order, so the drop between stages is the thing you read
                // rather than six unrelated numbers.
                listOf(
                    "Open roles" to data.opportunitiesOpen,
                    "Applications" to data.applicationsTotal,
                    "Shortlisted" to data.shortlisted,
                    "Interviews scheduled" to data.interviewsScheduled,
                    "Offers extended" to data.offersExtended,
                    "Offers accepted" to data.offersAccepted,
                ).forEach { (label, value) ->
                    PilotCard {
                        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                            Text("$value", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                }
                Spacer(Modifier.height(14.dp))
            }
        }
    }
}

/** Employer sub-pages reachable from the dashboard. */
internal enum class EmployerOverlay { MyInterviews, Interviews, Offers, Analytics, Team, CompanyProfile }
