package pro.ai8ht.one

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.filled.Lightbulb
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.WorkOutline
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import pro.ai8ht.one.ui.BrandLogo
import pro.ai8ht.one.ui.logoSurfaceFor

// --- Jobs: opportunities + my applications ------------------------------------

@Composable
internal fun JobsScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tab by remember { mutableIntStateOf(0) }
    var opportunities by remember { mutableStateOf<List<OpportunityDto>?>(null) }
    var applications by remember { mutableStateOf<List<ApplicationDto>?>(null) }
    // EMP-08: the student's interviews, shown at the top of My applications (no new tab).
    var interviews by remember { mutableStateOf<List<StudentInterviewDto>?>(null) }
    var interviewsFailed by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var openOpportunityId by remember { mutableStateOf<String?>(null) }
    var jobsOverlay by remember { mutableStateOf<JobsOverlay?>(null) }
    var feedback by remember { mutableStateOf<ApplicationFeedbackDto?>(null) }
    // EMP-05: the changed terms one application is waiting on the student to answer.
    var termsChange by remember { mutableStateOf<Pair<String, TermsChangeDto>?>(null) }
    // EMP-10: the application whose conversation is open (inside My applications; no new tab).
    var conversationFor by remember { mutableStateOf<ApplicationDto?>(null) }
    // EMP-13: the application whose shared skill evidence is open, and whether sharing is on at all.
    var evidenceFor by remember { mutableStateOf<ApplicationDto?>(null) }
    var evidenceSharingAvailable by remember { mutableStateOf(false) }
    // INST-14: the college's nominations, answered at the top of My applications (no new tab).
    var nominations by remember { mutableStateOf<List<StudentNominationDto>?>(null) }
    var nominationsFailed by remember { mutableStateOf(false) }
    var openNomination by remember { mutableStateOf<StudentNominationDto?>(null) }

    LaunchedEffect(reload) {
        opportunities = runCatching { Api.listOpportunities(context) }.getOrNull()
        val listed = runCatching { Api.listApplicationsWithEvidence(context) }.getOrNull()
        applications = listed?.applications
        evidenceSharingAvailable = listed?.evidenceSharingAvailable == true
        val loadedNominations = runCatching { Api.listMyNominations(context) }
        nominations = loadedNominations.getOrNull() ?: emptyList()
        nominationsFailed = loadedNominations.isFailure
        val loaded = runCatching { Api.listStudentInterviews(context) }
        interviews = loaded.getOrNull() ?: emptyList()
        interviewsFailed = loaded.isFailure
    }

    // Back closes the overlay above the tab, rather than quitting the app.
    //
    // The shell's own BackHandler knows about the More destinations but not about these,
    // and an overlay below would never be composed while one is open — so without this
    // a student reading a job and pressing back lost the app.
    androidx.activity.compose.BackHandler(enabled = openOpportunityId != null || jobsOverlay != null) {
        if (openOpportunityId != null) openOpportunityId = null else jobsOverlay = null
    }
    androidx.activity.compose.BackHandler(enabled = feedback != null) { feedback = null }
    androidx.activity.compose.BackHandler(enabled = conversationFor != null) { conversationFor = null; reload += 1 }
    androidx.activity.compose.BackHandler(enabled = evidenceFor != null) { evidenceFor = null; reload += 1 }
    androidx.activity.compose.BackHandler(enabled = openNomination != null) { openNomination = null }

    openNomination?.let { nomination ->
        SlideIn {
            NominationReviewPage(nomination, onClose = { openNomination = null }, onAnswered = { message ->
                openNomination = null; notice = message; reload += 1
            })
        }
        return
    }

    conversationFor?.let { app ->
        SlideIn { StudentConversationPage(app.id, "${app.title} · ${app.employerName}", onClose = { conversationFor = null; reload += 1 }) }
        return
    }

    evidenceFor?.let { app ->
        SlideIn { ApplicationEvidencePage(app.id, "${app.title} · ${app.employerName}", onClose = { evidenceFor = null; reload += 1 }) }
        return
    }

    feedback?.let { released ->
        SlideIn { FeedbackPage(released, onClose = { feedback = null }) }
        return
    }

    termsChange?.let { (applicationId, change) ->
        TermsChangeDialog(change, onDismiss = { termsChange = null }, onAnswer = { accept ->
            termsChange = null
            scope.launch {
                runCatching { Api.respondToTermsChange(context, applicationId, accept, change.toVersionId) }
                    .onSuccess {
                        notice = if (accept) "You accepted the new terms. Your application carries on."
                        else "You declined the new terms, so your application was withdrawn."
                        reload += 1
                    }
                    .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Your answer could not be saved." }
            }
        })
    }

    // Full-screen overlays sit above the tab content and return to it on close.
    openOpportunityId?.let { id ->
        SlideIn {
            OpportunityDetailPage(
                opportunityId = id,
                onClose = { openOpportunityId = null },
                onApplied = { notice = "Application submitted."; reload += 1 },
            )
        }
        return
    }
    when (jobsOverlay) {
        JobsOverlay.Offers -> { SlideIn { OffersPage(onClose = { jobsOverlay = null }) }; return }
        JobsOverlay.Saved -> {
            SlideIn {
                SavedOpportunitiesPage(
                    onClose = { jobsOverlay = null },
                    onOpen = { jobsOverlay = null; openOpportunityId = it },
                )
            }
            return
        }
        JobsOverlay.External -> { SlideIn { ExternalApplicationsPage(onClose = { jobsOverlay = null }) }; return }
        null -> Unit
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(4.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            JobsQuickLink("Offers", Modifier.weight(1f)) { jobsOverlay = JobsOverlay.Offers }
            JobsQuickLink("Saved", Modifier.weight(1f)) { jobsOverlay = JobsOverlay.Saved }
            JobsQuickLink("Applied elsewhere", Modifier.weight(1.4f)) { jobsOverlay = JobsOverlay.External }
        }
        Spacer(Modifier.height(10.dp))
        val segmentColors = SegmentedButtonDefaults.colors(
            activeContainerColor = MaterialTheme.colorScheme.primaryContainer,
            activeContentColor = MaterialTheme.colorScheme.onPrimaryContainer,
            inactiveContainerColor = MaterialTheme.colorScheme.surface,
        )
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            SegmentedButton(
                selected = tab == 0, onClick = { tab = 0 }, colors = segmentColors,
                shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
            ) { Text("Opportunities") }
            SegmentedButton(
                selected = tab == 1, onClick = { tab = 1 }, colors = segmentColors,
                shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
            ) { Text("My applications") }
        }
        notice?.let {
            Spacer(Modifier.height(8.dp))
            Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer)
            }
        }
        if (tab == 0) {
            when {
                opportunities == null -> LoadingSpinner()
                opportunities!!.isEmpty() -> EmptyState(
                    androidx.compose.material.icons.Icons.Filled.WorkOutline, pro.ai8ht.one.ui.Tone.Violet,
                    "No open roles right now",
                    "When employers post opportunities for your institution, they appear here.")
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(opportunities!!, key = { it.id }) { opp ->
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Column(Modifier.clickable { openOpportunityId = opp.id }.padding(16.dp)) {
                                Row(verticalAlignment = Alignment.Top) {
                                    Column(Modifier.weight(1f)) {
                                        Text(opp.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                        Text(opp.employerName, style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    if (opp.invitedFromTalentPool && !opp.alreadyApplied) StatusChip("Invited", ChipKind.Waiting)
                                    if (opp.alreadyApplied) StatusChip("Applied", ChipKind.Positive)
                                }
                                Spacer(Modifier.height(8.dp))
                                val meta = listOfNotNull(
                                    prettify(opp.employmentType), prettify(opp.workMode), opp.locationCity,
                                ).joinToString("  ·  ")
                                Text(meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                opp.summary?.takeIf { it.isNotBlank() }?.let {
                                    Spacer(Modifier.height(6.dp))
                                    Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 3)
                                }
                                opp.applicationDeadline?.let {
                                    Spacer(Modifier.height(6.dp))
                                    Text("Apply by ${formatWhen(it)}", style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.primary)
                                }
                                // EMP-11: this reaches the student through their college's approved drive.
                                opp.campusDrives.forEach { drive ->
                                    Spacer(Modifier.height(6.dp))
                                    StatusChip("Campus drive · ${drive.institutionName}", ChipKind.Accent)
                                }
                                if (!opp.alreadyApplied) {
                                    Spacer(Modifier.height(10.dp))
                                    // Opens the role rather than applying. Applying carries a
                                    // consent decision, and a list row is no place to make one.
                                    Text("View role and apply", style = MaterialTheme.typography.labelLarge,
                                        color = MaterialTheme.colorScheme.primary)
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(18.dp)) }
                }
            }
        } else {
            when {
                applications == null -> LoadingSpinner()
                applications!!.isEmpty() -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                    NominationsSection(nominations, nominationsFailed) { openNomination = it }
                    EmptyState(
                        androidx.compose.material.icons.Icons.Filled.WorkOutline, pro.ai8ht.one.ui.Tone.Violet,
                        "No applications yet",
                        "Apply to an opportunity and every stage — submitted, shortlisted, offered — is tracked here.")
                }
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    item(key = "nominations") { NominationsSection(nominations, nominationsFailed) { openNomination = it } }
                    val upcoming = interviews.orEmpty().filter { it.upcoming }
                    val past = interviews.orEmpty().filter { !it.upcoming }
                    item(key = "interviews-heading") {
                        Spacer(Modifier.height(12.dp))
                        Text("Your interviews", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        if (interviewsFailed) {
                            Text("Your interviews could not be loaded right now.",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        } else if (upcoming.isEmpty()) {
                            Text("No upcoming interviews. When an employer schedules one, it appears here with the time and how to join.",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    items(upcoming, key = { "interview-" + it.id }) { item ->
                        Spacer(Modifier.height(10.dp))
                        StudentInterviewCard(item)
                    }
                    if (past.isNotEmpty()) {
                        item(key = "interviews-past") {
                            Spacer(Modifier.height(12.dp))
                            Text("Past interviews", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        }
                        items(past, key = { "interview-" + it.id }) { item ->
                            Spacer(Modifier.height(10.dp))
                            StudentInterviewCard(item)
                        }
                    }
                    item(key = "applications-heading") {
                        Spacer(Modifier.height(16.dp))
                        Text("Your applications", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    }
                    items(applications!!, key = { it.id }) { app ->
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Row(verticalAlignment = Alignment.Top) {
                                    Column(Modifier.weight(1f)) {
                                        Text(app.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                        Text(app.employerName, style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    StatusChip(prettify(app.state), when (app.state) {
                                        "OFFERED", "ACCEPTED", "SELECTED" -> ChipKind.Positive
                                        "REJECTED", "WITHDRAWN" -> ChipKind.Muted
                                        else -> ChipKind.Accent
                                    })
                                }
                                app.submittedAt?.let {
                                    Spacer(Modifier.height(6.dp))
                                    Text("Submitted ${formatWhen(it)}", style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                // EMP-11: applied through the college's campus drive.
                                app.campusDrive?.let {
                                    Spacer(Modifier.height(6.dp))
                                    StatusChip("Campus drive · ${it.institutionName}", ChipKind.Accent)
                                }
                                // INST-14: made by opting in to the college's nomination.
                                app.nominatedBy?.let {
                                    Spacer(Modifier.height(6.dp))
                                    StatusChip("Nominated by ${it.institutionName}", ChipKind.Accent)
                                }
                                // EMP-05: the employer cannot move this application on until the
                                // student answers the changed terms.
                                if (app.termsAcknowledgementPending) {
                                    Spacer(Modifier.height(8.dp))
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        StatusChip("Terms changed", ChipKind.Waiting)
                                        TextButton(onClick = {
                                            scope.launch {
                                                runCatching { Api.termsChange(context, app.id) }
                                                    .onSuccess { change ->
                                                        if (change != null) termsChange = app.id to change
                                                        else { notice = "Nothing is waiting for your answer on that application any more."; reload += 1 }
                                                    }
                                                    .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not load the changed terms." }
                                            }
                                        }) { Text("Review new terms") }
                                    }
                                }
                                // EMP-13: shown while sharing is on, and whenever something is shared so it can be taken back.
                                if (evidenceSharingAvailable || app.evidenceShared) {
                                    Spacer(Modifier.height(8.dp))
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        if (app.evidenceShared) StatusChip("Skill evidence shared", ChipKind.Positive)
                                        TextButton(onClick = { evidenceFor = app }) { Text("Skill evidence") }
                                    }
                                }
                                // EMP-10: the conversation the employer started, with unread messages counted.
                                if (app.conversationStarted) {
                                    Spacer(Modifier.height(8.dp))
                                    TextButton(onClick = { conversationFor = app }) {
                                        Text(if (app.unreadMessages > 0) "Messages (${app.unreadMessages} new)" else "Messages")
                                    }
                                }
                                // Only shown when the employer deliberately released
                                // something. Silence stays silent rather than offering a
                                // button that opens an empty page.
                                if (app.feedbackReleased) {
                                    Spacer(Modifier.height(8.dp))
                                    TextButton(onClick = {
                                        scope.launch {
                                            runCatching { Api.applicationFeedback(context, app.id) }
                                                .onSuccess { result ->
                                                    if (result != null) feedback = result
                                                    else notice = "That feedback is no longer available."
                                                }
                                                .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not load that feedback." }
                                        }
                                    }) { Text("See why") }
                                }
                                // Terminal states are not withdrawable, and offering to
                                // withdraw something already settled would be a dead button.
                                if (app.state !in setOf("WITHDRAWN", "REJECTED", "ACCEPTED", "DECLINED")) {
                                    Spacer(Modifier.height(8.dp))
                                    TextButton(onClick = {
                                        scope.launch {
                                            runCatching { Api.withdrawApplication(context, app.id) }
                                                .onSuccess { notice = "Application withdrawn."; reload += 1 }
                                                .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not withdraw that." }
                                        }
                                    }) { Text("Withdraw") }
                                }
                                // INST-09 / ADR-019: sharing with the college is its own choice per
                                // application — shown on every application, closed ones included, and
                                // separate from withdrawing. Pay is never shared.
                                val shared = app.institutionVisibilityGrantedAt != null && app.institutionVisibilityRevokedAt == null
                                Spacer(Modifier.height(8.dp))
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    StatusChip(
                                        when {
                                            shared -> "Shared with college"
                                            app.institutionVisibilityRevokedAt != null -> "Sharing stopped"
                                            else -> "Not shared with college"
                                        },
                                        if (shared) ChipKind.Positive else ChipKind.Muted,
                                    )
                                    TextButton(onClick = {
                                        scope.launch {
                                            runCatching {
                                                if (shared) Api.revokeInstitutionVisibility(context, app.id)
                                                else Api.grantInstitutionVisibility(context, app.id)
                                            }
                                                .onSuccess {
                                                    notice = if (shared) "Your college can no longer see this application."
                                                    else "Shared with your college: employer, role, stage, key dates and offer response — never pay."
                                                    reload += 1
                                                }
                                                .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not update that." }
                                        }
                                    }) { Text(if (shared) "Stop sharing with college" else "Share with college") }
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(18.dp)) }
                }
            }
        }
    }
}

// --- Changed terms (EMP-05) ----------------------------------------------------

private val termNames = mapOf(
    "employmentType" to "Employment type", "workMode" to "Work mode", "locationCity" to "Location",
    "compensationDisclosed" to "Pay", "compensationCurrency" to "Pay", "compensationMin" to "Pay", "compensationMax" to "Pay",
    "compensationPeriod" to "Pay", "durationMonths" to "Duration", "applicationDeadline" to "Deadline",
    "joiningConditions" to "Joining conditions", "eligibility" to "Eligibility",
)

private fun termsPay(terms: StudentTermsDto): String = terms.compensation?.let { pay ->
    val upper = pay.max?.let { " to $it" } ?: ""
    "${pay.currency} ${pay.min}$upper / ${if (pay.period == "TOTAL_STIPEND") "total" else pay.period.lowercase()}"
} ?: "Not disclosed"

/**
 * What the student applied under beside what the job says now, for the terms that moved,
 * with accept and decline. Declining withdraws the application, and the dialog says so first.
 */
@Composable
private fun TermsChangeDialog(change: TermsChangeDto, onDismiss: () -> Unit, onAnswer: (Boolean) -> Unit) {
    val changed = change.changedTerms.map { termNames[it] ?: it }.distinct()
    val rows = listOf(
        Triple("Employment type", prettify(change.appliedTerms.employmentType), prettify(change.newTerms.employmentType)),
        Triple("Work mode", prettify(change.appliedTerms.workMode), prettify(change.newTerms.workMode)),
        Triple("Location", change.appliedTerms.locationCity ?: "NA", change.newTerms.locationCity ?: "NA"),
        Triple("Pay", termsPay(change.appliedTerms), termsPay(change.newTerms)),
        Triple("Duration", change.appliedTerms.durationMonths?.let { "$it months" } ?: "NA", change.newTerms.durationMonths?.let { "$it months" } ?: "NA"),
        Triple("Joining conditions", change.appliedTerms.joiningConditions ?: "NA", change.newTerms.joiningConditions ?: "NA"),
        Triple("Deadline", change.appliedTerms.applicationDeadline?.let(::formatWhen) ?: "NA", change.newTerms.applicationDeadline?.let(::formatWhen) ?: "NA"),
    ).filter { it.first in changed }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("${change.employerName} changed this job") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("${change.newTerms.title}. The employer cannot move your application on until you answer.",
                    style = MaterialTheme.typography.bodySmall)
                rows.forEach { (label, before, after) ->
                    Spacer(Modifier.height(10.dp))
                    Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    Text("When you applied: $before", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("Now: $after", style = MaterialTheme.typography.bodySmall)
                }
                if ("Eligibility" in changed) {
                    // EMP-06: the rules themselves, before and after, in the job page's wording.
                    fun rules(list: List<TermsEligibilityRuleDto>) = list.takeIf { it.isNotEmpty() }?.joinToString("; ") {
                        describeEligibilityRule(it.ruleType, it.comparator, it.valueNumeric, it.valueText, it.displayValue)
                    } ?: "None stated"
                    Spacer(Modifier.height(10.dp))
                    Text("Eligibility", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    Text("When you applied: ${rules(change.appliedTerms.eligibility)}", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("Now: ${rules(change.newTerms.eligibility)}", style = MaterialTheme.typography.bodySmall)
                }
                Spacer(Modifier.height(12.dp))
                Text("Declining withdraws your application, and the employer loses access to your profile for this role.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = { TextButton(onClick = { onAnswer(true) }) { Text("Accept") } },
        dismissButton = {
            Row {
                TextButton(onClick = { onAnswer(false) }) { Text("Decline and withdraw") }
                TextButton(onClick = onDismiss) { Text("Later") }
            }
        },
    )
}

// --- ONE Assistant chat --------------------------------------------------------

internal data class ChatMessage(val role: String, val content: String)

@Composable
internal fun ChatOverlay(persona: String = "student", onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var messages by remember { mutableStateOf<List<ChatMessage>>(emptyList()) }
    var draft by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()

    LaunchedEffect(messages.size, (messages.lastOrNull()?.content?.length ?: 0)) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.lastIndex)
    }

    fun ask(question: String) {
        val trimmed = question.trim()
        if (trimmed.isEmpty() || busy) return
        busy = true
        draft = ""
        val history = (messages + ChatMessage("user", trimmed)).takeLast(11)
        messages = messages + ChatMessage("user", trimmed) + ChatMessage("assistant", "")
        scope.launch {
            runCatching {
                Api.assistantChat(context, history.map { it.role to it.content }, persona) { delta ->
                    messages = messages.dropLast(1) + messages.last().copy(content = messages.last().content + delta)
                }
            }.onFailure { error ->
                // 503 means the assistant is switched off on the server (OPS-SR-02), not a passing fault.
                val text = if (error is Api.ApiException && error.status == 503) {
                    "The assistant is switched off for now. Please use Help & FAQ, or contact support."
                } else {
                    "The assistant could not answer just now. Please try again in a moment."
                }
                messages = messages.dropLast(1) + ChatMessage("assistant", text)
            }
            busy = false
        }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                Text("ONE Assistant", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            if (messages.isEmpty()) {
                Column(Modifier.weight(1f).padding(20.dp), verticalArrangement = Arrangement.Center) {
                    Text("Hi! I can explain how ONE works — assessments, profiles, results and more. I don't see your personal data, and I'll say so when I don't know.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(16.dp))
                    listOf(
                        "How do I take an assessment?",
                        "Why can't I start my assessment?",
                        "How do I share my public profile?",
                    ).forEach { starter ->
                        OutlinedButton(
                            onClick = { ask(starter) },
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            shape = RoundedCornerShape(10.dp),
                        ) { Text(starter) }
                    }
                }
            } else {
                LazyColumn(Modifier.weight(1f).padding(horizontal = 14.dp), state = listState) {
                    items(messages.size) { index ->
                        val message = messages[index]
                        val isUser = message.role == "user"
                        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp),
                            horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start) {
                            Surface(
                                color = if (isUser) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface,
                                contentColor = if (isUser) androidx.compose.ui.graphics.Color.White else MaterialTheme.colorScheme.onSurface,
                                shape = RoundedCornerShape(14.dp),
                                border = if (isUser) null else androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                            ) {
                                Text(message.content.ifBlank { "…" },
                                    Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
                                    style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
            Text("Answers come from ONE's help guide and can be wrong.",
                Modifier.padding(horizontal = 16.dp),
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = draft, onValueChange = { draft = it },
                    placeholder = { Text("Ask about using ONE…") },
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(12.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = MaterialTheme.colorScheme.primary,
                        unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                    ),
                )
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = { ask(draft) }, enabled = !busy && draft.isNotBlank()) {
                    Icon(Icons.AutoMirrored.Filled.Send, "Send", tint = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}

// --- More: named sections ------------------------------------------------------

internal enum class MoreDest(val title: String) {
    Profile("Profile"), Calendar("Calendar"), Screening("Screening tests"), Resources("Resources"), Share("Public profile"), Career("Career readiness"), Target("Career target"),
    Academics("Academic record"), Support("Support"), Documents("Documents"),
    Privacy("Privacy & data"), Help("Help & FAQ"), Settings("Settings"),
    // ADR-052: appended; the menu rows, not this order, are what the student sees.
    Explain("Ask ONE to explain"),
}

@Composable
internal fun OverlayScaffold(
    title: String,
    onClose: () -> Unit,
    actions: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {},
    content: @Composable () -> Unit,
) {
    val ovPalette = pro.ai8ht.one.ui.LocalOnePalette.current
    Column(Modifier.fillMaxSize().background(ovPalette.bandBottom)) {
        BrandBand {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = ovPalette.bandInk) }
                Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = ovPalette.bandInk)
                Spacer(Modifier.weight(1f))
                actions()
            }
        }
        BandSheet { content() }
    }
}

@Composable
internal fun MoreMenuScreen(
    student: StudentDto?,
    avatarVersion: Int,
    onOpen: (MoreDest) -> Unit,
    onSignOut: () -> Unit,
) {
    val context = LocalContext.current
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
        PilotCard {
            Row(Modifier.fillMaxWidth().clickable { onOpen(MoreDest.Profile) }.padding(16.dp),
                verticalAlignment = Alignment.CenterVertically) {
                AvatarView(context, student?.fullName, 52.dp, avatarVersion)
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(student?.fullName ?: "Student", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text(student?.verifiedEmail ?: "", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (student?.academicStatus?.isNotBlank() == true) {
                        Spacer(Modifier.height(6.dp))
                        StatusChip(prettify(student.academicStatus), ChipKind.Accent)
                    }
                    // INST-10: a former student is told where they stand and what they keep.
                    student?.formerStudentLine()?.let { line ->
                        Spacer(Modifier.height(6.dp))
                        Text(line, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                        Text("Your ONE account, records and choices stay yours. ${student.institutionName ?: "Your college"} now sees only what happened before that date.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(14.dp))
        PilotCard {
            Column {
                MenuRow(Icons.Filled.Person, pro.ai8ht.one.ui.Tone.Accent, "Profile",
                    "Your details, headline and photo") { onOpen(MoreDest.Profile) }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                MenuRow(Icons.Filled.DateRange, pro.ai8ht.one.ui.Tone.Violet, "Calendar",
                    "Interviews, exam windows and deadlines") { onOpen(MoreDest.Calendar) }
                MenuRow(Icons.Filled.Assignment, pro.ai8ht.one.ui.Tone.Accent, "Screening tests",
                    "Tests employers have sent you") { onOpen(MoreDest.Screening) }
                MenuRow(Icons.Filled.MenuBook, pro.ai8ht.one.ui.Tone.Green, "Resources",
                    "Practice, company prep, scholarships and more") { onOpen(MoreDest.Resources) }
                MenuRow(Icons.Filled.Share, pro.ai8ht.one.ui.Tone.Violet, "Public profile",
                    "A link you control, showing your verified record") { onOpen(MoreDest.Share) }
                MenuRow(Icons.Filled.Insights, pro.ai8ht.one.ui.Tone.Green, "Career readiness",
                    "Your advisory band and roadmap") { onOpen(MoreDest.Career) }
                MenuRow(Icons.Filled.Insights, pro.ai8ht.one.ui.Tone.Accent, "Career target",
                    "What you are aiming at, and what is still missing") { onOpen(MoreDest.Target) }
                MenuRow(Icons.Filled.Description, pro.ai8ht.one.ui.Tone.Green, "Academic record",
                    "Your results, and what employers can actually see") { onOpen(MoreDest.Academics) }
                MenuRow(Icons.Filled.Person, pro.ai8ht.one.ui.Tone.Violet, "Support",
                    "Tasks your institution has assigned you") { onOpen(MoreDest.Support) }
                // ADR-052: after the learning rows; nothing above or below moves.
                MenuRow(Icons.Filled.Lightbulb, pro.ai8ht.one.ui.Tone.Violet, "Ask ONE to explain",
                    "AI lessons on any topic — not checked by a person") { onOpen(MoreDest.Explain) }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                MenuRow(Icons.Filled.Description, pro.ai8ht.one.ui.Tone.Violet, "Documents",
                    "Résumés, certificates and verification") { onOpen(MoreDest.Documents) }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                MenuRow(Icons.Filled.Lock, pro.ai8ht.one.ui.Tone.Amber, "Privacy & data",
                    "Your data copy and consent") { onOpen(MoreDest.Privacy) }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                MenuRow(Icons.AutoMirrored.Filled.HelpOutline, pro.ai8ht.one.ui.Tone.Accent, "Help & FAQ",
                    "Answers for your role") { onOpen(MoreDest.Help) }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                MenuRow(Icons.Filled.Settings, pro.ai8ht.one.ui.Tone.Gray, "Settings",
                    "App info and sign out") { onOpen(MoreDest.Settings) }
            }
        }
        Spacer(Modifier.height(14.dp))
        OutlinedButton(onClick = onSignOut, shape = RoundedCornerShape(10.dp)) { Text("Sign out") }
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun MenuRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tone: pro.ai8ht.one.ui.Tone,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically) {
        IconBubble(icon, tone)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun ProfilePage(
    student: StudentDto?,
    avatarVersion: Int,
    onPhotoPicked: () -> Unit,
    onEdit: () -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    var profile by remember { mutableStateOf<ProfileDto?>(null) }
    // EMP-14: joining or leaving the talent pool changes the visibility shown below, so it reloads.
    var profileReload by remember { mutableStateOf(0) }
    LaunchedEffect(profileReload) { profile = runCatching { Api.getProfile(context) }.getOrNull() }
    var talentPoolEditor by remember { mutableStateOf(false) }
    if (talentPoolEditor) {
        SlideIn { TalentPoolPage(onClose = { talentPoolEditor = false; profileReload += 1 }) }
        return
    }

    val scope = rememberCoroutineScope()
    var photoNotice by remember { mutableStateOf<String?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            scope.launch {
                val bytes = runCatching {
                    context.contentResolver.openInputStream(uri)?.use { input -> input.readBytes() }
                }.getOrNull()
                val type = context.contentResolver.getType(uri) ?: "image/jpeg"
                when {
                    bytes == null -> photoNotice = "That photo could not be read."
                    type !in setOf("image/jpeg", "image/png") -> photoNotice = "Choose a JPEG or PNG."
                    bytes.size > 5 * 1024 * 1024 -> photoNotice = "That photo is larger than 5 MB."
                    else -> runCatching {
                        val encoded = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                        Api.uploadProfilePhoto(context, type, encoded)
                        // Cached locally only so the screen updates without a round trip;
                        // the server copy is the one that counts.
                        ProfilePhoto.save(context, bytes)
                    }.onSuccess {
                        photoNotice = "Photo saved. It appears on the web too."
                        onPhotoPicked()
                    }.onFailure {
                        photoNotice = (it as? Api.ApiException)?.detail
                            ?: "That photo could not be saved. It is scanned before it is stored, so try again shortly."
                    }
                }
            }
        }
    }

    OverlayScaffold("Profile", onClose) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
            PilotCard {
                Column(Modifier.fillMaxWidth().padding(18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    AvatarView(context, student?.fullName, 84.dp, avatarVersion)
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = {
                        picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    }) { Text("Change photo") }
                    photoNotice?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    }
                    Text(student?.fullName ?: "Student", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Text(student?.verifiedEmail ?: "", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    profile?.profileHeadline?.takeIf { it.isNotBlank() }?.let {
                        Spacer(Modifier.height(6.dp))
                        Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    }
                }
            }
            profile?.profileSummary?.takeIf { it.isNotBlank() }?.let {
                SectionTitle("About")
                PilotCard { Text(it, Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium) }
            }
            SectionTitle("Details")
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    val rows = listOfNotNull(
                        profile?.targetCareer?.takeIf { it.isNotBlank() }?.let { "Target career" to it },
                        student?.program?.let { "Program" to it },
                        student?.department?.let { "Department" to it },
                        student?.batch?.let { "Batch" to it },
                        student?.institutionStudentId?.takeIf { it.isNotBlank() }?.let { "Student ID" to it },
                        profile?.portfolioUrl?.takeIf { it.isNotBlank() }?.let { "Portfolio" to it },
                    )
                    if (rows.isEmpty()) {
                        Text("Add your headline, summary and target career with Edit below.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    rows.forEach { (label, value) ->
                        Row(Modifier.padding(vertical = 4.dp)) {
                            Text(label, Modifier.width(110.dp), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(value, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                        }
                    }
                    profile?.let {
                        Spacer(Modifier.height(8.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            StatusChip("Visibility: ${prettify(it.visibilityState)}", ChipKind.Muted)
                            if (it.employerDiscoveryEnabled) StatusChip("Employer discovery on", ChipKind.Positive)
                        }
                    }
                }
            }
            // EMP-14: the consented talent pool; shows nothing while it is switched off (HG-4).
            StudentTalentPoolSection(onOpenEditor = { talentPoolEditor = true })
            // INST-13: tell a college what you did after graduating (counted only, never named).
            StudentOutcomesSection()
            Spacer(Modifier.height(16.dp))
            Button(onClick = onEdit, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp)) {
                Text("Edit profile")
            }
            Spacer(Modifier.height(8.dp))
            Text("Your photo is stored on this device and will sync to your profile when photo upload launches.",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
internal fun DocumentsPage(onClose: () -> Unit) {
    val context = LocalContext.current
    var documents by remember { mutableStateOf<List<DocumentDto>?>(null) }
    // RESUME-GEN: the résumé builder opens from here rather than from a new menu item.
    var resumeBuilder by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { documents = runCatching { Api.listDocuments(context) }.getOrDefault(emptyList()) }
    if (resumeBuilder) { ResumeBuilderPage(onClose = { resumeBuilder = false }); return }
    OverlayScaffold("Documents", onClose) {
        when {
            documents == null -> LoadingSpinner()
            documents!!.isEmpty() -> Column(Modifier.fillMaxSize().padding(18.dp)) {
                ResumeBuilderEntryCard(onOpen = { resumeBuilder = true })
                CenteredNote("No documents yet. Upload résumés and certificates from the web app at oneby8.com.")
            }
            else -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
                ResumeBuilderEntryCard(onOpen = { resumeBuilder = true })
                Spacer(Modifier.height(12.dp))
                PilotCard {
                    Column(Modifier.padding(vertical = 4.dp)) {
                        documents!!.forEachIndexed { index, doc ->
                            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                                verticalAlignment = Alignment.CenterVertically) {
                                IconBubble(Icons.Filled.Description, pro.ai8ht.one.ui.Tone.Violet)
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(doc.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                    Text(prettify(doc.documentType), style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                val label = documentVerificationLabel(doc)
                                StatusChip(label, when (label) {
                                    "Verified" -> ChipKind.Positive
                                    "Verification requested" -> ChipKind.Waiting
                                    else -> ChipKind.Muted
                                })
                            }
                            if (index != documents!!.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text("Uploads happen on the web app. A document shows as verified only once your college has checked it.",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
internal fun PrivacyPage(onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var requests by remember { mutableStateOf<List<PrivacyRequestDto>>(emptyList()) }
    var notice by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(reload) { requests = runCatching { Api.privacyRequests(context) }.getOrDefault(emptyList()) }
    OverlayScaffold("Privacy & data", onClose) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text("Your data copy", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(4.dp))
                    Text("Request an export of your personal data. Download it from the web app once ready.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val latest = requests.firstOrNull { it.requestType == "EXPORT" }
                    latest?.let {
                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            StatusChip(prettify(it.state), if (it.state == "COMPLETED") ChipKind.Positive else ChipKind.Waiting)
                            Spacer(Modifier.width(8.dp))
                            Text("Requested ${formatWhen(it.requestedAt)}", style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    notice?.let {
                        Spacer(Modifier.height(8.dp))
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }
                    Spacer(Modifier.height(10.dp))
                    OutlinedButton(
                        onClick = {
                            notice = null
                            scope.launch {
                                runCatching { Api.requestDataExport(context) }
                                    .onSuccess { notice = "Export requested — its status appears above."; reload += 1 }
                                    .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not request the export just now." }
                            }
                        },
                        shape = RoundedCornerShape(10.dp),
                    ) { Text("Request data copy") }
                }
            }
            Spacer(Modifier.height(12.dp))
            DeletionCard(
                requests = requests,
                onRequest = {
                    notice = null
                    scope.launch {
                        runCatching { Api.requestDeletion(context) }
                            .onSuccess { notice = "Deletion requested. You have 30 days to change your mind."; reload += 1 }
                            .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not request deletion just now." }
                    }
                },
                onCancel = { requestId ->
                    notice = null
                    scope.launch {
                        runCatching { Api.cancelPrivacyRequest(context, requestId) }
                            .onSuccess { notice = "Deletion cancelled. Nothing was erased."; reload += 1 }
                            .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not cancel that request." }
                    }
                },
            )
            Spacer(Modifier.height(12.dp))
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text("How your data is handled", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(6.dp))
                    Text("Readiness guidance is advisory — never shown to employers, never public. Profile sharing is always your choice. AI features send no personal data. Erasure requests are available from the web app under Settings.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
internal fun CareerPage(learner: LearnerStateDto?, onClose: () -> Unit) {
    OverlayScaffold("Career readiness", onClose) {
        if (learner == null) { CenteredNote("Career readiness data is not available right now."); return@OverlayScaffold }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
            PilotCard {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconBubble(Icons.Filled.Insights, pro.ai8ht.one.ui.Tone.Green, size = 44.dp)
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text("Readiness band", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(prettify(learner.readiness?.band ?: "NOT_ENOUGH_EVIDENCE"),
                            style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text("Advisory · visible only to you and your institution",
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            val steps = learner.roadmap
            if (steps.isNotEmpty()) {
                SectionTitle("Your roadmap")
                PilotCard {
                    Column(Modifier.padding(vertical = 4.dp)) {
                        steps.forEachIndexed { index, step ->
                            Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                StatusChip(prettify(step.state),
                                    if (step.state == "COMPLETED") ChipKind.Positive else ChipKind.Accent)
                                Spacer(Modifier.width(10.dp))
                                Column {
                                    Text(prettify(step.actionCode), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                    Text(prettify(step.reasonCode), style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                            if (index != steps.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                        }
                    }
                }
            } else {
                SectionTitle("Your roadmap")
                PilotCard {
                    Text("Complete lessons and assessments — your personalised next steps appear here.",
                        Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
internal fun SettingsPage(currentTheme: String, onThemeChange: (String) -> Unit, onClose: () -> Unit, onSignOut: () -> Unit, onSwitchWorkspace: (() -> Unit)? = null) {
    OverlayScaffold("Settings", onClose) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text("Theme", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(2.dp))
                    Text("Pick the world ONE lives in on this device.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(12.dp))
                    ThemePicker(currentTheme, onThemeChange)

                }
            }
            Spacer(Modifier.height(12.dp))
            PilotCard {
                Column(Modifier.padding(18.dp)) {
                    BrandLogo(height = 44.dp, surface = logoSurfaceFor(pro.ai8ht.one.ui.LocalOnePalette.current))
                    Spacer(Modifier.height(8.dp))
                    Text("ONE by AI8HT", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    Text("Version ${BuildConfig.VERSION_NAME} · oneby8.com",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(12.dp))
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text("On the web, not yet in the app", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(6.dp))
                    Text("Exam taking (with its timer and integrity checks), document upload, data-copy download and account erasure live at oneby8.com. Push notifications arrive in the next version.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(14.dp))
            if (onSwitchWorkspace != null) {
                OutlinedButton(onClick = onSwitchWorkspace, shape = RoundedCornerShape(10.dp)) { Text("Switch workspace") }
                Spacer(Modifier.height(8.dp))
            }
            OutlinedButton(onClick = onSignOut, shape = RoundedCornerShape(10.dp)) { Text("Sign out") }
            Spacer(Modifier.height(20.dp))
        }
    }
}

// --- Edit profile ---------------------------------------------------------------

@Composable
internal fun EditProfileOverlay(onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var loaded by remember { mutableStateOf(false) }
    var headline by remember { mutableStateOf("") }
    var summary by remember { mutableStateOf("") }
    var targetCareer by remember { mutableStateOf("") }
    var portfolio by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { Api.getProfile(context) }.onSuccess {
            headline = it.profileHeadline ?: ""
            summary = it.profileSummary ?: ""
            targetCareer = it.targetCareer ?: ""
            portfolio = it.portfolioUrl ?: ""
        }
        loaded = true
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().statusBarsPadding().imePadding().verticalScroll(rememberScrollState())) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                Text("Edit profile", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            if (!loaded) { LoadingSpinner(); return@Column }
            Column(Modifier.padding(18.dp)) {
                val fieldColors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = MaterialTheme.colorScheme.primary,
                    unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                )
                OutlinedTextField(value = headline, onValueChange = { headline = it },
                    label = { Text("Headline") }, modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp), colors = fieldColors)
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(value = summary, onValueChange = { summary = it },
                    label = { Text("Summary") }, modifier = Modifier.fillMaxWidth(), minLines = 4,
                    shape = RoundedCornerShape(10.dp), colors = fieldColors)
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(value = targetCareer, onValueChange = { targetCareer = it },
                    label = { Text("Target career") }, modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp), colors = fieldColors)
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(value = portfolio, onValueChange = { portfolio = it },
                    label = { Text("Portfolio URL (https://…)") }, modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp), colors = fieldColors)
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                Spacer(Modifier.height(16.dp))
                Button(
                    enabled = !busy,
                    onClick = {
                        busy = true; error = null
                        // Build the body manually so blank fields clear to null.
                        fun enc(value: String): String =
                            if (value.trim().isBlank()) "null"
                            else kotlinx.serialization.json.Json.encodeToString(kotlinx.serialization.serializer<String>(), value.trim())
                        val body = "{" +
                            "\"profileHeadline\":${enc(headline)}," +
                            "\"profileSummary\":${enc(summary)}," +
                            "\"targetCareer\":${enc(targetCareer)}," +
                            "\"portfolioUrl\":${enc(portfolio)}" +
                            "}"
                        scope.launch {
                            runCatching { Api.updateProfile(context, body) }
                                .onSuccess { onClose() }
                                .onFailure {
                                    busy = false
                                    error = (it as? Api.ApiException)?.detail
                                        ?: "Could not save. Check the portfolio URL uses https:// and try again."
                                }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp),
                ) { Text(if (busy) "Saving…" else "Save profile") }
            }
        }
    }
}

@Composable
internal fun ThemePicker(currentTheme: String, onThemeChange: (String) -> Unit) {
    pro.ai8ht.one.ui.AllPalettes.chunked(3).forEach { rowPalettes ->
        Row(Modifier.fillMaxWidth().padding(bottom = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            rowPalettes.forEach { option ->
                val selected = option.id == currentTheme
                Column(
                    Modifier.weight(1f).clickable { onThemeChange(option.id) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(
                        Modifier.fillMaxWidth().height(46.dp)
                            .background(option.bandBrush, RoundedCornerShape(12.dp))
                            .then(
                                if (selected) Modifier.background(
                                    Color.Transparent, RoundedCornerShape(12.dp),
                                ) else Modifier,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(Modifier.size(16.dp).background(option.accent, CircleShape))
                        if (selected) {
                            Box(
                                Modifier.matchParentSize().background(
                                    Color.Transparent, RoundedCornerShape(12.dp),
                                ),
                            )
                            Text("✓", color = option.bandInk, fontWeight = FontWeight.Bold,
                                modifier = Modifier.padding(start = 34.dp))
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                    Text(option.displayName, style = MaterialTheme.typography.labelSmall,
                        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium)
                }
            }
        }
    }
}
