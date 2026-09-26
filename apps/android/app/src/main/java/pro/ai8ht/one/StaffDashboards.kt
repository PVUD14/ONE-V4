package pro.ai8ht.one

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.School
import androidx.compose.material.icons.filled.WorkOutline
import androidx.compose.material3.Badge
import androidx.compose.material3.TextButton
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarDefaults
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import pro.ai8ht.one.ui.BrandWordmark
import pro.ai8ht.one.ui.LocalOnePalette
import pro.ai8ht.one.ui.Tone

// --- Workspaces ----------------------------------------------------------------

enum class WorkspaceKind { STUDENT, INSTITUTION, EMPLOYER, OPS }

data class Workspace(val kind: WorkspaceKind, val organizationId: String?, val role: String)

fun classifyWorkspaces(ctx: SecurityContextDto): List<Workspace> {
    val institutionRoles = setOf("PLACEMENT_ADMIN", "DEPARTMENT_HEAD", "FACULTY_LECTURER", "CAREER_COUNSELOR")
    val out = mutableListOf<Workspace>()
    for (m in ctx.memberships) {
        val role = m.role.uppercase()
        when {
            role == "OPERATIONS_ADMIN" || role == "PLATFORM_SUPER_ADMIN" ->
                out += Workspace(WorkspaceKind.OPS, null, m.role)
            role.startsWith("INSTITUTION") || role in institutionRoles ->
                out += Workspace(WorkspaceKind.INSTITUTION, m.organizationId, m.role)
            role.startsWith("EMPLOYER") || role == "RECRUITER" ->
                out += Workspace(WorkspaceKind.EMPLOYER, m.organizationId, m.role)
            role == "STUDENT" -> out += Workspace(WorkspaceKind.STUDENT, m.organizationId, m.role)
        }
    }
    // INST-10: someone who graduated, transferred or left keeps their student workspace.
    val student = ctx.studentRelationships.any { it.state == "ACTIVE" || it.state == "VERIFIED" } || ctx.formerStudentRelationships.isNotEmpty()
    if (out.none { it.kind == WorkspaceKind.STUDENT } && student) {
        out += Workspace(WorkspaceKind.STUDENT, null, "STUDENT")
    }
    // One entry per kind+org.
    return out.distinctBy { it.kind to it.organizationId }
}

@Composable
internal fun WorkspaceChooserScreen(options: List<Workspace>, onPick: (Workspace) -> Unit) {
    val palette = LocalOnePalette.current
    Column(Modifier.fillMaxSize().background(palette.bandBottom)) {
        BrandBand {
            Spacer(Modifier.height(20.dp))
            BrandWordmark(height = 24.dp, tint = palette.wordmarkTint)
            Spacer(Modifier.height(12.dp))
            Text("Choose your workspace", style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold, color = palette.bandInk)
            Text("Your account has more than one role.", style = MaterialTheme.typography.bodySmall, color = palette.bandMuted)
        }
        BandSheet {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
                options.forEach { workspace ->
                    PilotCard(Modifier.fillMaxWidth().padding(bottom = 12.dp).clickable { onPick(workspace) }) {
                        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            IconBubble(
                                when (workspace.kind) {
                                    WorkspaceKind.STUDENT -> Icons.Filled.School
                                    WorkspaceKind.INSTITUTION -> Icons.Filled.Assignment
                                    WorkspaceKind.EMPLOYER -> Icons.Filled.WorkOutline
                                    WorkspaceKind.OPS -> Icons.Filled.MoreHoriz
                                },
                                when (workspace.kind) {
                                    WorkspaceKind.STUDENT -> Tone.Accent
                                    WorkspaceKind.INSTITUTION -> Tone.Green
                                    WorkspaceKind.EMPLOYER -> Tone.Violet
                                    WorkspaceKind.OPS -> Tone.Amber
                                },
                            )
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    when (workspace.kind) {
                                        WorkspaceKind.STUDENT -> "Student"
                                        WorkspaceKind.INSTITUTION -> "Institution"
                                        WorkspaceKind.EMPLOYER -> "Employer"
                                        WorkspaceKind.OPS -> "Operations"
                                    },
                                    style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold,
                                )
                                Text(prettify(workspace.role), style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

// --- Theme overlay ---------------------------------------------------------------

@Composable
internal fun ThemeOverlay(currentTheme: String, onThemeChange: (String) -> Unit, onClose: () -> Unit) {
    OverlayScaffold("Theme", onClose) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
            PilotCard { Column(Modifier.padding(16.dp)) { ThemePicker(currentTheme, onThemeChange) } }
        }
    }
}

// --- Shared staff chrome ---------------------------------------------------------

@Composable
private fun StaffBandHeader(title: String, subtitle: String, unread: Int, onTheme: () -> Unit, onBell: () -> Unit) {
    val palette = LocalOnePalette.current
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        BrandWordmark(height = 17.dp, tint = palette.wordmarkTint)
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onTheme) {
            Icon(Icons.Filled.Palette, contentDescription = "Theme", tint = palette.bandMuted)
        }
        IconButton(onClick = onBell) {
            BadgedBox(badge = { if (unread > 0) Badge { Text("$unread") } }) {
                Icon(Icons.Filled.Notifications, contentDescription = "Notifications", tint = palette.bandMuted)
            }
        }
    }
    Spacer(Modifier.height(4.dp))
    Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = palette.bandInk)
    Text(subtitle, style = MaterialTheme.typography.bodySmall, color = palette.bandMuted)
}

@Composable
internal fun StatCell(value: String, label: String, tone: Tone, icon: androidx.compose.ui.graphics.vector.ImageVector, modifier: Modifier = Modifier) {
    PilotCard(modifier) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBubble(icon, tone, size = 32.dp)
            Spacer(Modifier.width(10.dp))
            Column {
                Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

// --- Institution dashboard -------------------------------------------------------

private class InstitutionData(
    val exams: List<InstitutionExamDto>,
    val subjects: Int,
    val underReview: Int,
    val notifications: NotificationsEnvelope?,
    val attention: List<Pair<NotAttemptedDto, InstitutionExamDto>> = emptyList(),
    /** Student invitation activation counts; null when the roster could not be read (shown as NA). */
    val activation: Map<String, Int>? = null,
    /** Faculty "My Students" (INST-03). */
    val myStudents: MyStudentsState = MyStudentsState.NotFaculty,
    /** Academic verification backlog (INST-04), server-counted over the reader's scope; null reads NA. */
    val verification: VerificationSummaryDto? = null,
    /** Current and upcoming academic calendar entries (INST-05); null when it could not be read (NA). */
    val academicTerms: List<CalendarTermDto>? = null,
    /** Cohort announcements (INST-06); NotSender when the server says this caller cannot send (403). */
    val announcements: AnnouncementsState = AnnouncementsState.NotSender,
    /** INST-07: department overview (heads, admins, placement officers); NotForRole for faculty-only callers. */
    val department: ScopedView<DepartmentOverviewDto> = ScopedView.NotForRole,
    /** INST-07: shared-application stages, suppressed under five. */
    val pipeline: ScopedView<PlacementPipelineDto> = ScopedView.NotForRole,
    /** INST-07: the lecturer's class reports; NotForRole when the caller holds no faculty role. */
    val classes: ScopedView<ClassReportsDto> = ScopedView.NotForRole,
)

private sealed interface AnnouncementsState {
    data object NotSender : AnnouncementsState
    data object Unavailable : AnnouncementsState
    data class Loaded(val envelope: AnnouncementsEnvelope) : AnnouncementsState
}

/**
 * The Android institution workspace merges every institution role of one college into a
 * single workspace, so the phone asks the server rather than guessing from the role: a 403
 * means no faculty role here and the section is left out; any other failure shows NA.
 */
private sealed interface MyStudentsState {
    data object NotFaculty : MyStudentsState
    data object Unavailable : MyStudentsState
    data class Loaded(val envelope: MyStudentsEnvelope) : MyStudentsState
}

private val activationLabels = mapOf(
    "ACTIVATED" to "Activated", "INVITED" to "Invited", "EXPIRED" to "Expired",
    "BOUNCED" to "Bounced", "NOT_INVITED" to "Not invited",
)

@Composable
internal fun InstitutionScaffold(
    organizationId: String,
    currentTheme: String,
    onThemeChange: (String) -> Unit,
    onSignOut: () -> Unit,
    onSwitchWorkspace: (() -> Unit)?,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val palette = LocalOnePalette.current
    var tab by remember { mutableStateOf(0) }
    var data by remember { mutableStateOf<InstitutionData?>(null) }
    var showInboxOv by remember { mutableStateOf(false) }
    var showChatOv by remember { mutableStateOf(false) }
    var showThemeOv by remember { mutableStateOf(false) }
    var resultsFor by remember { mutableStateOf<InstitutionExamDto?>(null) }
    var showHelpOv by remember { mutableStateOf(false) }
    var showVerifyOv by remember { mutableStateOf(false) }
    var refresh by remember { mutableStateOf(0) }

    LaunchedEffect(refresh) {
        coroutineScope {
            val exams = async { runCatching { Api.listInstitutionExams(context, organizationId) }.getOrDefault(emptyList()) }
            val subjects = async { runCatching { Api.listSubjects(context, organizationId).size }.getOrDefault(0) }
            val review = async { runCatching { Api.countQuestions(context, organizationId, "UNDER_REVIEW") }.getOrDefault(0) }
            val inbox = async { runCatching { Api.listNotifications(context) }.getOrNull() }
            val activation = async { runCatching { Api.institutionActivationSummary(context, organizationId) }.getOrNull() }
            val myStudents = async {
                runCatching { Api.myStudents(context, organizationId) }.fold(
                    onSuccess = { MyStudentsState.Loaded(it) },
                    onFailure = { if (it is Api.ApiException && it.status == 403) MyStudentsState.NotFaculty else MyStudentsState.Unavailable },
                )
            }
            val verification = async { runCatching { Api.verificationSummary(context, organizationId) }.getOrNull() }
            val calendar = async {
                runCatching { Api.academicTerms(context, organizationId, java.time.LocalDate.now().toString()) }.getOrNull()
            }
            val announcements = async {
                runCatching { Api.institutionAnnouncements(context, organizationId) }.fold(
                    onSuccess = { AnnouncementsState.Loaded(it) },
                    onFailure = { if (it is Api.ApiException && it.status == 403) AnnouncementsState.NotSender else AnnouncementsState.Unavailable },
                )
            }
            val department = async { scopedView { Api.departmentOverview(context, organizationId) } }
            val pipeline = async { scopedView { Api.placementPipeline(context, organizationId) } }
            val classes = async { scopedView { Api.classReports(context, organizationId) } }
            val loadedExams = exams.await()
            val target = loadedExams.firstOrNull { it.lifecycleState == "PUBLISHED" && it.assignedCount > 0 }
            val attention = if (target != null) {
                runCatching { Api.examResults(context, organizationId, target.id).notAttempted.map { it to target } }
                    .getOrDefault(emptyList())
            } else emptyList()
            data = InstitutionData(loadedExams, subjects.await(), review.await(), inbox.await(), attention, activation.await(),
                myStudents.await(), verification.await(), calendar.await(), announcements.await(),
                department.await(), pipeline.await(), classes.await())
        }
    }

    androidx.activity.compose.BackHandler(enabled = showInboxOv || showChatOv || showThemeOv || showHelpOv || showVerifyOv || resultsFor != null) {
        when {
            showVerifyOv -> showVerifyOv = false
            showChatOv -> showChatOv = false
            showThemeOv -> showThemeOv = false
            showInboxOv -> showInboxOv = false
            showHelpOv -> showHelpOv = false
            else -> resultsFor = null
        }
    }
    when {
        showHelpOv -> { SlideIn { HelpFaqPage(persona = "institution", onClose = { showHelpOv = false }) }; return }
        showVerifyOv -> {
            SlideIn { VerificationQueueOverlay(organizationId, onClose = { showVerifyOv = false }, onChanged = { refresh += 1 }) }
            return
        }
        showChatOv -> { SlideIn { ChatOverlay(persona = "institution", onClose = { showChatOv = false }) }; return }
        showThemeOv -> { SlideIn { ThemeOverlay(currentTheme, onThemeChange, onClose = { showThemeOv = false }) }; return }
        showInboxOv -> { SlideIn { StaffInboxOverlay(data?.notifications, onClose = { showInboxOv = false }) }; return }
        resultsFor != null -> {
            SlideIn { ExamResultsOverlay(organizationId, resultsFor!!, onClose = { resultsFor = null }) }
            return
        }
    }

    val unread = data?.notifications?.unreadCount ?: 0
    Scaffold(
        containerColor = palette.bandBottom,
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
        floatingActionButton = {
            FloatingActionButton(onClick = { showChatOv = true }, containerColor = palette.accent,
                contentColor = palette.onAccent, shape = CircleShape) {
                Icon(Icons.Filled.AutoAwesome, contentDescription = "ONE Assistant")
            }
        },
        bottomBar = {
            NavigationBar(containerColor = palette.navBg, windowInsets = NavigationBarDefaults.windowInsets) {
                val colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = palette.navSelected, selectedTextColor = palette.navSelected,
                    indicatorColor = palette.accentSoft,
                    unselectedIconColor = palette.muted, unselectedTextColor = palette.muted,
                )
                NavigationBarItem(selected = tab == 0, onClick = { tab = 0 },
                    icon = { Icon(Icons.Filled.Home, null) }, label = { Text("Home") }, colors = colors)
                NavigationBarItem(selected = tab == 1, onClick = { tab = 1 },
                    icon = { Icon(Icons.Filled.Assignment, null) }, label = { Text("Exams") }, colors = colors)
                NavigationBarItem(selected = tab == 2, onClick = { tab = 2 },
                    icon = { Icon(Icons.Filled.MoreHoriz, null) }, label = { Text("More") }, colors = colors)
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            BrandBand {
                StaffBandHeader(
                    title = when (tab) { 0 -> "Institution" 1 -> "Assessments" else -> "More" },
                    subtitle = when (tab) {
                        0 -> "Your placement command centre"
                        1 -> "Exams, assignment and results"
                        else -> "Workspace and app settings"
                    },
                    unread = unread,
                    onTheme = { showThemeOv = true },
                    onBell = { showInboxOv = true },
                )
            }
            BandSheet {
                when {
                    data == null -> HomeSkeleton()
                    else -> when (tab) {
                        0 -> InstitutionHome(data!!, onVerify = { showVerifyOv = true }) { tab = 1 }
                        1 -> InstitutionExams(data!!.exams) { resultsFor = it }
                        else -> StaffMore(onSignOut, onSwitchWorkspace,
                            "Question authoring, exam building, publishing and reopening stay on the web at one.ai8ht.pro.",
                            onHelp = { showHelpOv = true })
                    }
                }
            }
        }
    }
}

@Composable
private fun InstitutionHome(data: InstitutionData, onVerify: () -> Unit, onExams: () -> Unit) {
    val published = data.exams.count { it.lifecycleState == "PUBLISHED" }
    val assigned = data.exams.sumOf { it.assignedCount }
    val attempts = data.exams.sumOf { it.completedAttempts }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(12.dp))
        // Pilot KPI row: real where an engine exists, NA where it does not.
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell("${data.exams.size}", "Exams", Tone.Accent, Icons.Filled.Assignment, Modifier.weight(1f))
            StatCell("$published", "Published", Tone.Green, Icons.Filled.Assignment, Modifier.weight(1f))
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell("${data.underReview}", "To review", Tone.Amber, Icons.Filled.Notifications, Modifier.weight(1f))
            StatCell("${data.attention.size}", "Need intervention", Tone.Gray, Icons.Filled.Notifications, Modifier.weight(1f))
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell("$attempts/$assigned", "Attempts", Tone.Violet, Icons.Filled.School, Modifier.weight(1f))
            StatCell("NA", "Students placed", Tone.Gray, Icons.Filled.School, Modifier.weight(1f))
        }

        // Cohort readiness: how many students sit in each band, never an average (ADR-020).
        // INST-07: last ended month's bands for the reader's scope, from the department
        // overview; a band under five reads <5, and NA when this caller has no such view.
        CohortReadinessCard(data.department)

        // INST-07: department overview for heads, admins and placement officers.
        (data.department as? ScopedView.Loaded)?.let { DepartmentOverviewSection(it.value) }

        // Faculty "My Students" (INST-03): the students of this lecturer's active teaching
        // assignments, as the server scopes them. Assigning stays on the web Staff screen.
        if (data.myStudents !is MyStudentsState.NotFaculty) MyStudentsSection(data.myStudents)
        // INST-07: the lecturer's class reports (web: faculty Reports).
        if (data.classes !is ScopedView.NotForRole) ClassReportsSection(data.classes)

        // Academic calendar (INST-05): the college's current and upcoming terms, examination
        // periods and breaks, as its admins set them on the web Settings screen.
        AcademicCalendarSection(data.academicTerms)
        // Cohort announcements (INST-06): what this staff member sent and how it was delivered.
        // Composing stays on the web (faculty: Messages), where the audience picker lives.
        if (data.announcements !is AnnouncementsState.NotSender) AnnouncementsSection(data.announcements)

        // Student activation (INST-01): who has accepted their invitation. Same summary as the
        // web Dashboard; resending invitations stays on the web Students page.
        SectionTitle("Student activation")
        PilotCard {
            Column(Modifier.padding(14.dp)) {
                listOf(
                    "ACTIVATED" to "Activated", "INVITED" to "Invited", "EXPIRED" to "Expired",
                    "BOUNCED" to "Bounced", "NOT_INVITED" to "Not invited",
                ).forEach { (key, label) ->
                    Row(Modifier.padding(vertical = 3.dp)) {
                        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        Text(data.activation?.get(key)?.toString() ?: "NA", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }

        // Academic verification (INST-04): the same scoped backlog as the web Dashboard. Tap to
        // confirm or reject on the phone; bulk results upload stays on the web.
        SectionTitle("Academic verification", trailing = "Review", onTrailing = onVerify)
        PilotCard(Modifier.fillMaxWidth().clickable { onVerify() }) {
            Column(Modifier.padding(14.dp)) {
                listOf(
                    "Waiting for a decision" to data.verification?.pending,
                    "From former students or people not on the roster" to data.verification?.notCurrent,
                ).forEach { (label, value) ->
                    Row(Modifier.padding(vertical = 3.dp)) {
                        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        Text(value?.toString() ?: "NA", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }

        // Placement Pipeline (INST-07): stages of applications students shared with the college,
        // suppressed under five; NA for a caller with no department view.
        PlacementPipelineCard(data.pipeline)

        // Pilot: Students Needing Attention - real, from assessment data.
        SectionTitle("Needing attention")
        if (data.attention.isEmpty()) {
            PilotCard { Text("Nobody needs attention right now - every assigned assessment is attempted.",
                Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant) }
        } else {
            data.attention.take(5).forEach { (entry, exam) ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp).clickable { onExams() }) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(entry.studentName, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text(if (entry.inProgress) "In progress now: ${exam.title}" else "Has not attempted: ${exam.title}",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        StatusChip("Review", ChipKind.Waiting)
                    }
                }
            }
        }

        SectionTitle("Recent assessments", trailing = "View all", onTrailing = onExams)
        if (data.exams.isEmpty()) {
            PilotCard {
                Text("No assessments yet. Create question banks and exams on the web at one.ai8ht.pro.",
                    Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            data.exams.take(4).forEach { exam ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(exam.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text("${exam.subjectName} · ${exam.completedAttempts}/${exam.assignedCount} attempted",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        StatusChip(prettify(exam.lifecycleState),
                            if (exam.lifecycleState == "PUBLISHED") ChipKind.Positive else ChipKind.Muted)
                    }
                }
            }
        }
        Spacer(Modifier.height(20.dp))
    }
}

private val academicTermKindLabels = mapOf("TERM" to "Term", "EXAMINATIONS" to "Examinations", "BREAK" to "Break")

@Composable
private fun AcademicCalendarSection(terms: List<CalendarTermDto>?) {
    SectionTitle("Academic calendar")
    PilotCard {
        Column(Modifier.padding(14.dp)) {
            when {
                terms == null -> Text("The academic calendar could not be loaded right now (NA).",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                terms.isEmpty() -> Text("No academic calendar has been set up yet. Your institution admin adds terms under Settings on the web.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> terms.take(5).forEach { term ->
                    Row(Modifier.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(term.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text("${academicTermKindLabels[term.kind] ?: "NA"} · ${term.startsOn} to ${term.endsOn} · ${term.unit?.name ?: "Whole college"}",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (term.current) StatusChip("Now", ChipKind.Positive)
                    }
                }
            }
        }
    }
}

@Composable
private fun AnnouncementsSection(state: AnnouncementsState) {
    val loaded = (state as? AnnouncementsState.Loaded)?.envelope
    SectionTitle("Announcements")
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        StatCell(loaded?.announcements?.count { it.state == "SENT" }?.toString() ?: "NA", "Sent", Tone.Accent, Icons.Filled.Notifications, Modifier.weight(1f))
        StatCell(loaded?.announcements?.count { it.state == "SCHEDULED" }?.toString() ?: "NA", "Scheduled", Tone.Violet, Icons.Filled.Notifications, Modifier.weight(1f))
    }
    Spacer(Modifier.height(10.dp))
    when {
        loaded == null -> PilotCard {
            Text("Your announcements could not be loaded right now. Open Messages on the web.",
                Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        !loaded.canSend && loaded.announcements.isEmpty() -> PilotCard {
            Text("You have nobody to send announcements to yet. Faculty send to the sections and batches they are assigned to teach.",
                Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        loaded.announcements.isEmpty() -> PilotCard {
            Text("No announcements yet. Compose one under Messages on the web.",
                Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        else -> loaded.announcements.take(4).forEach { announcement ->
            PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                Column(Modifier.padding(12.dp)) {
                    Text(announcement.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    val audience = if (announcement.audience.unitId == null) "Whole institution" else announcement.audience.name ?: "NA"
                    val status = when (announcement.state) {
                        "SENT" -> "Sent to ${announcement.delivery?.recipients ?: 0} student(s)"
                        "SCHEDULED" -> "Scheduled"
                        else -> "Cancelled"
                    }
                    val email = announcement.delivery?.email
                    val emailNote = when {
                        !announcement.channels.contains("EMAIL") -> ""
                        email != null && email.notConfigured > 0 -> " · email not sent: no sender is set up yet"
                        email != null -> " · ${email.sent} email(s) sent"
                        else -> ""
                    }
                    Text("$audience · $status$emailNote", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun MyStudentsSection(state: MyStudentsState) {
    val loaded = (state as? MyStudentsState.Loaded)?.envelope
    SectionTitle("My students")
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        StatCell(loaded?.students?.size?.toString() ?: "NA", "Students", Tone.Accent, Icons.Filled.School, Modifier.weight(1f))
        StatCell(loaded?.assignments?.size?.toString() ?: "NA", "Teaching", Tone.Violet, Icons.Filled.Assignment, Modifier.weight(1f))
    }
    Spacer(Modifier.height(10.dp))
    when {
        loaded == null -> PilotCard {
            Text("Your students could not be loaded right now. Pull down later or open My Students on the web.",
                Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        loaded.mode == "ASSIGNMENTS" && loaded.assignments.isEmpty() -> PilotCard {
            Text("You have no active teaching assignment yet. Ask your institution admin or department head to assign you to a section or batch.",
                Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        else -> {
            if (loaded.mode == "MEMBERSHIP") {
                Text("Your college has not started recording teaching assignments, so this follows the department and batch on your staff account.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
            }
            loaded.assignments.take(4).forEach { assignment ->
                val subject = assignment.subject?.name ?: assignment.subjectCode ?: "NA"
                Text("$subject · ${assignment.unit.name} · ${assignment.academicTerm}",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.height(6.dp))
            if (loaded.students.isEmpty()) {
                PilotCard { Text("No students are enrolled in your assigned sections yet.", Modifier.padding(14.dp),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            loaded.students.take(8).forEach { student ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(student.fullName, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            val units = listOfNotNull(student.units.section, student.units.batch).joinToString(" · ").ifBlank { "NA" }
                            val recent = if (student.recentAssessments.submitted > 0)
                                "${student.recentAssessments.submitted} assessment(s) in 30 days" else "No assessment in 30 days"
                            Text("$units · $recent · ${student.openTasks} open task(s)",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        val activation = student.activation?.state
                        StatusChip(activationLabels[activation] ?: "NA",
                            if (activation == "ACTIVATED") ChipKind.Positive else ChipKind.Waiting)
                    }
                }
            }
            if (loaded.students.size > 8 || loaded.nextCursor != null) {
                Text("The full list is on My Students on the web.", style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun InstitutionExams(exams: List<InstitutionExamDto>, onOpen: (InstitutionExamDto) -> Unit) {
    if (exams.isEmpty()) {
        EmptyState(Icons.Filled.Assignment, Tone.Accent, "No assessments yet",
            "Author questions and build exams on the web; they appear here with live results.")
        return
    }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        items(exams, key = { it.id }) { exam ->
            Spacer(Modifier.height(12.dp))
            PilotCard(Modifier.fillMaxWidth().clickable { onOpen(exam) }) {
                Column(Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.Top) {
                        Column(Modifier.weight(1f)) {
                            Text(exam.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                            Text(exam.subjectName, style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        StatusChip(prettify(exam.lifecycleState),
                            if (exam.lifecycleState == "PUBLISHED") ChipKind.Positive else ChipKind.Muted)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("${exam.durationSeconds / 60} min · ${exam.totalMarks.toInt()} marks · " +
                        "${exam.completedAttempts}/${exam.assignedCount} attempted · closes ${formatWhen(exam.endsAt)}",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(6.dp))
                    Text("Tap for results and who has not attempted", style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary)
                }
            }
        }
        item { Spacer(Modifier.height(18.dp)) }
    }
}

@Composable
private fun ExamResultsOverlay(orgId: String, exam: InstitutionExamDto, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var results by remember { mutableStateOf<ExamResultsDto?>(null) }
    var failed by remember { mutableStateOf(false) }
    LaunchedEffect(exam.id) {
        runCatching { Api.examResults(context, orgId, exam.id) }
            .onSuccess { results = it }.onFailure { failed = true }
    }
    OverlayScaffold(exam.title, onClose) {
        when {
            failed -> CenteredNote("Could not load results right now.")
            results == null -> LoadingSpinner()
            else -> {
                val r = results!!
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        StatCell("${r.summary.assigned}", "Assigned", Tone.Accent, Icons.Filled.School, Modifier.weight(1f))
                        StatCell("${r.summary.attempts}", "Attempts", Tone.Green, Icons.Filled.Assignment, Modifier.weight(1f))
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        StatCell("${r.summary.averagePercentage.toInt()}%", "Average", Tone.Violet, Icons.Filled.Assignment, Modifier.weight(1f))
                        StatCell("${r.summary.notAttemptedCount}", "Not attempted", Tone.Amber, Icons.Filled.Notifications, Modifier.weight(1f))
                    }
                    if (r.results.isNotEmpty()) {
                        SectionTitle("Scores")
                        PilotCard {
                            Column(Modifier.padding(vertical = 4.dp)) {
                                r.results.take(20).forEachIndexed { index, row ->
                                    Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Column(Modifier.weight(1f)) {
                                            Text(row.studentName, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                            Text("Attempt ${row.attemptNumber}" + if (row.autoSubmitted) " · auto-submitted" else "",
                                                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                        StatusChip("${row.percentage.toInt()}%",
                                            if (row.percentage >= 50) ChipKind.Positive else ChipKind.Waiting)
                                    }
                                    if (index != r.results.take(20).lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                                }
                            }
                        }
                    }
                    if (r.notAttempted.isNotEmpty()) {
                        SectionTitle("Not attempted")
                        PilotCard {
                            Column(Modifier.padding(vertical = 4.dp)) {
                                r.notAttempted.forEachIndexed { index, row ->
                                    Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Text(row.studentName, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                        if (row.inProgress) StatusChip("In progress", ChipKind.Accent)
                                    }
                                    if (index != r.notAttempted.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(20.dp))
                }
            }
        }
    }
}

// --- Employer dashboard ----------------------------------------------------------

@Composable
internal fun EmployerScaffold(
    organizationId: String,
    currentTheme: String,
    onThemeChange: (String) -> Unit,
    onSignOut: () -> Unit,
    onSwitchWorkspace: (() -> Unit)?,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val palette = LocalOnePalette.current
    var tab by remember { mutableStateOf(0) }
    var roles by remember { mutableStateOf<List<EmployerOpportunityDto>?>(null) }
    var applicants by remember { mutableStateOf<List<EmployerApplicantDto>>(emptyList()) }
    var inbox by remember { mutableStateOf<NotificationsEnvelope?>(null) }
    var showInboxOv by remember { mutableStateOf(false) }
    var showChatOv by remember { mutableStateOf(false) }
    var showThemeOv by remember { mutableStateOf(false) }
    var showHelpOv by remember { mutableStateOf(false) }
    var employerOverlay by remember { mutableStateOf<EmployerOverlay?>(null) }
    var openApplicant by remember { mutableStateOf<EmployerApplicantDto?>(null) }
    var employerReload by remember { mutableStateOf(0) }
    // EMP-03: null when the status could not be read; the app then behaves as before and
    // the server still refuses what it must.
    var orgStatus by remember { mutableStateOf<EmployerOrganisationStatusDto?>(null) }

    LaunchedEffect(employerReload) {
        coroutineScope {
            val s = async { runCatching { Api.employerOrganisationStatus(context, organizationId) }.getOrNull() }
            val r = async { runCatching { Api.listEmployerOpportunities(context, organizationId) }.getOrDefault(emptyList()) }
            val n = async { runCatching { Api.listNotifications(context) }.getOrNull() }
            orgStatus = s.await()
            val loadedRoles = r.await()
            val loadedApplicants = loadedRoles.filter { it.applicationCount > 0 }.take(4).flatMap { role ->
                runCatching { Api.listEmployerApplicants(context, organizationId, role.id) }.getOrDefault(emptyList())
            }
            roles = loadedRoles; applicants = loadedApplicants; inbox = n.await()
        }
    }

    // Back closes the topmost overlay rather than quitting.
    //
    // This has to be declared before the early returns below, not after them. Each
    // overlay returns out of the composable, so a BackHandler placed underneath them is
    // never composed while an overlay is open — which is exactly when it is needed. The
    // result was that system back from Offers, My interviews, Hiring analytics or an
    // applicant closed the whole app.
    androidx.activity.compose.BackHandler(
        enabled = showInboxOv || showChatOv || showThemeOv || showHelpOv ||
            openApplicant != null || employerOverlay != null,
    ) {
        when {
            showChatOv -> showChatOv = false
            showThemeOv -> showThemeOv = false
            showHelpOv -> showHelpOv = false
            showInboxOv -> showInboxOv = false
            openApplicant != null -> openApplicant = null
            else -> employerOverlay = null
        }
    }

    openApplicant?.let { applicant ->
        SlideIn {
            ApplicantActionsPage(
                eligibility = applicant.eligibility,
                stages = applicant.stages,
                employerId = organizationId,
                applicantName = candidateLabel(applicant.candidateName, applicant.consentRevoked, applicant.candidateAccess),
                applicationId = applicant.id,
                currentState = applicant.state,
                onClose = { openApplicant = null },
                onChanged = { employerReload += 1 },
            )
        }
        return
    }
    when (employerOverlay) {
        EmployerOverlay.MyInterviews -> {
            SlideIn { MyInterviewsPage(organizationId, onClose = { employerOverlay = null }) }
            return
        }
        EmployerOverlay.Offers -> {
            SlideIn { EmployerOffersPage(organizationId, onClose = { employerOverlay = null }) }
            return
        }
        EmployerOverlay.Analytics -> {
            SlideIn { HiringAnalyticsPage(organizationId, onClose = { employerOverlay = null }) }
            return
        }
        EmployerOverlay.Team -> {
            SlideIn { EmployerTeamPage(organizationId, onClose = { employerOverlay = null }) }
            return
        }
        EmployerOverlay.CompanyProfile -> {
            SlideIn { EmployerCompanyProfilePage(organizationId, onClose = { employerOverlay = null }) }
            return
        }
        null -> Unit
    }

    when {
        showHelpOv -> { SlideIn { HelpFaqPage(persona = "employer", onClose = { showHelpOv = false }) }; return }
        showChatOv -> { SlideIn { ChatOverlay(persona = "employer", onClose = { showChatOv = false }) }; return }
        showThemeOv -> { SlideIn { ThemeOverlay(currentTheme, onThemeChange, onClose = { showThemeOv = false }) }; return }
        showInboxOv -> { SlideIn { StaffInboxOverlay(inbox, onClose = { showInboxOv = false }) }; return }
    }

    Scaffold(
        containerColor = palette.bandBottom,
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
        floatingActionButton = {
            FloatingActionButton(onClick = { showChatOv = true }, containerColor = palette.accent,
                contentColor = palette.onAccent, shape = CircleShape) {
                Icon(Icons.Filled.AutoAwesome, contentDescription = "ONE Assistant")
            }
        },
        bottomBar = {
            NavigationBar(containerColor = palette.navBg, windowInsets = NavigationBarDefaults.windowInsets) {
                val colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = palette.navSelected, selectedTextColor = palette.navSelected,
                    indicatorColor = palette.accentSoft,
                    unselectedIconColor = palette.muted, unselectedTextColor = palette.muted,
                )
                NavigationBarItem(selected = tab == 0, onClick = { tab = 0 },
                    icon = { Icon(Icons.Filled.Home, null) }, label = { Text("Home") }, colors = colors)
                NavigationBarItem(selected = tab == 1, onClick = { tab = 1 },
                    icon = { Icon(Icons.Filled.WorkOutline, null) }, label = { Text("Roles") }, colors = colors)
                NavigationBarItem(selected = tab == 2, onClick = { tab = 2 },
                    icon = { Icon(Icons.Filled.MoreHoriz, null) }, label = { Text("More") }, colors = colors)
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            BrandBand {
                StaffBandHeader(
                    title = when (tab) { 0 -> "Employer" 1 -> "Roles" else -> "More" },
                    subtitle = when (tab) {
                        0 -> "Your hiring at a glance"
                        1 -> "Postings and applications"
                        else -> "Workspace and app settings"
                    },
                    unread = inbox?.unreadCount ?: 0,
                    onTheme = { showThemeOv = true },
                    onBell = { showInboxOv = true },
                )
            }
            BandSheet {
                val awaitingVerification = orgStatus?.let { it.canDraft && !it.canReachCandidates } == true
                when {
                    // Suspended or rejected: Home and Roles show the plain status; More (help,
                    // switch workspace, sign out) stays reachable.
                    orgStatus?.canDraft == false && tab != 2 -> EmployerOrganisationStatusPanel(orgStatus!!)
                    roles == null -> HomeSkeleton()
                    else -> when (tab) {
                        0 -> Column(Modifier.fillMaxSize()) {
                            if (awaitingVerification) EmployerVerificationNotice()
                            EmployerHome(
                                roles = roles!!,
                                applicants = applicants,
                                onRoles = { tab = 1 },
                                onOpenOverlay = { employerOverlay = it },
                                onOpenApplicant = { openApplicant = it },
                            )
                        }
                        1 -> Column(Modifier.fillMaxSize()) {
                            if (awaitingVerification) EmployerVerificationNotice()
                            EmployerRoles(organizationId, roles!!)
                        }
                        else -> StaffMore(onSignOut, onSwitchWorkspace,
                            "Posting roles, publishing and candidate review stay on the web at one.ai8ht.pro.",
                            onHelp = { showHelpOv = true })
                    }
                }
            }
        }
    }
}

@Composable
private fun EmployerHome(
    roles: List<EmployerOpportunityDto>,
    applicants: List<EmployerApplicantDto>,
    onRoles: () -> Unit,
    onOpenOverlay: (EmployerOverlay) -> Unit,
    onOpenApplicant: (EmployerApplicantDto) -> Unit,
) {
    val published = roles.count { it.lifecycleState == "PUBLISHED" }
    val applications = roles.sumOf { it.applicationCount }
    val open = roles.sumOf { it.openApplicationCount }
    fun stage(needle: String) = applicants.count { it.state.contains(needle) }
    val offers = applicants.count { it.offerState != null }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(12.dp))
        // Pilot KPI rows - all real.
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell("$published", "Open Roles", Tone.Violet, Icons.Filled.WorkOutline, Modifier.weight(1f))
            StatCell("$applications", "Total Applicants", Tone.Accent, Icons.Filled.School, Modifier.weight(1f))
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell("$open", "In Pipeline", Tone.Amber, Icons.Filled.Notifications, Modifier.weight(1f))
            StatCell("$offers", "Offers", Tone.Green, Icons.Filled.WorkOutline, Modifier.weight(1f))
        }

        // Pilot: Hiring Funnel - real stage counts.
        SectionTitle("Hiring Funnel")
        PilotCard {
            Column(Modifier.padding(14.dp)) {
                val max = applications.coerceAtLeast(1)
                FunnelRow("Applied", applications, max)
                FunnelRow("Shortlisted", stage("SHORTLIST"), max)
                FunnelRow("Interview", stage("INTERVIEW"), max)
                FunnelRow("Offer", offers, max)
                FunnelRow("Hired", stage("HIRED"), max)
            }
        }

        // Pilot: This Week's Interviews - NA until a calendar engine exists.
        SectionTitle("This Week's Interviews")
        PilotCard {
            Column(Modifier.padding(14.dp)) {
                Text("Interviews you are on the panel for, with their scorecards.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { onOpenOverlay(EmployerOverlay.MyInterviews) }) { Text("My interviews") }
                    TextButton(onClick = { onOpenOverlay(EmployerOverlay.Offers) }) { Text("Offers") }
                    TextButton(onClick = { onOpenOverlay(EmployerOverlay.Analytics) }) { Text("Hiring") }
                }
            }
        }

        // Pilot: Recently Shortlisted - real.
        SectionTitle("Recently Shortlisted")
        val shortlisted = applicants.filter { it.state.contains("SHORTLIST") || it.state.contains("INTERVIEW") }
        if (shortlisted.isEmpty()) {
            PilotCard { Text("Nobody shortlisted yet.", Modifier.padding(14.dp),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        } else {
            shortlisted.take(4).forEach { applicant ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                    Row(
                        Modifier.clickable { onOpenApplicant(applicant) }.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(candidateLabel(applicant.candidateName, applicant.consentRevoked, applicant.candidateAccess), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text(prettify(applicant.state), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        StatusChip(prettify(applicant.state), ChipKind.Accent)
                    }
                }
            }
        }

        // EMP-02: the team, read-only; changes are made on the web. The server decides who
        // may see it, so a recruiter opening it is told Team is managed by the owner or admin.
        SectionTitle("Team", trailing = "View", onTrailing = { onOpenOverlay(EmployerOverlay.Team) })
        PilotCard(Modifier.fillMaxWidth()) {
            Text("Who is on your hiring team, in which role, and which invitations are still open.",
                Modifier.clickable { onOpenOverlay(EmployerOverlay.Team) }.padding(14.dp),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        // EMP-04: the company profile students see on every job, read-only; the owner or admin
        // edits it on the web.
        SectionTitle("Company profile", trailing = "View", onTrailing = { onOpenOverlay(EmployerOverlay.CompanyProfile) })
        PilotCard(Modifier.fillMaxWidth()) {
            Text("What students see about your company on every job, and the details AI8HT operations verified.",
                Modifier.clickable { onOpenOverlay(EmployerOverlay.CompanyProfile) }.padding(14.dp),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        SectionTitle("Recent roles", trailing = "View all", onTrailing = onRoles)
        if (roles.isEmpty()) {
            PilotCard {
                Text("No roles yet. Post opportunities on the web at one.ai8ht.pro; applications track here.",
                    Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            roles.take(4).forEach { role ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(role.title ?: role.referenceCode, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text("${role.applicationCount} applications · ${role.openApplicationCount} open",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        StatusChip(prettify(role.lifecycleState), roleStateChip(role.lifecycleState))
                    }
                }
            }
        }
        Spacer(Modifier.height(20.dp))
    }
}

/**
 * EMP-05: a role is live, paused (hidden, expected back), a draft, or closed/withdrawn.
 * Editing, pausing, closing and reopening happen on the web's Opportunity Detail, where each
 * change is confirmed and carries a reason; the app shows where every role stands.
 */
internal fun roleStateChip(state: String): ChipKind = when (state) {
    "PUBLISHED" -> ChipKind.Positive
    "PAUSED" -> ChipKind.Waiting
    "DRAFT" -> ChipKind.Accent
    else -> ChipKind.Muted
}

private fun roleStateNote(role: EmployerOpportunityDto): String? = when (role.lifecycleState) {
    "PAUSED" -> "Paused: hidden from students, no new applications"
    "CLOSED" -> "Closed to new applications" + (role.closedAt?.let { " since ${formatWhen(it)}" } ?: "")
    "WITHDRAWN" -> "Withdrawn"
    "DRAFT" -> "Draft: not visible to students yet"
    else -> null
}

@Composable
private fun EmployerRoles(employerId: String, roles: List<EmployerOpportunityDto>) {
    var expanded by remember { mutableStateOf<String?>(null) }
    if (roles.isEmpty()) {
        EmptyState(Icons.Filled.WorkOutline, Tone.Violet, "No roles yet",
            "Post opportunities on the web; applications and their states track here.")
        return
    }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        items(roles, key = { it.id }) { role ->
            Spacer(Modifier.height(12.dp))
            PilotCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.Top) {
                        Column(Modifier.weight(1f)) {
                            Text(role.title ?: role.referenceCode, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                            val meta = listOfNotNull(role.employmentType?.let(::prettify), role.workMode?.let(::prettify), role.locationCity)
                                .joinToString(" · ")
                            if (meta.isNotBlank()) Text(meta, style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        StatusChip(prettify(role.lifecycleState), roleStateChip(role.lifecycleState))
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("${role.applicationCount} applications · ${role.openApplicationCount} open" +
                        (role.applicationDeadline?.let { " · apply by ${formatWhen(it)}" } ?: "") +
                        (role.versionNumber?.takeIf { it > 1 }?.let { " · version $it" } ?: ""),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    roleStateNote(role)?.let {
                        Spacer(Modifier.height(4.dp))
                        Text("$it. Edit, pause, close or reopen on the web.", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    // EMP-06: eligibility, skills and stages, read-only; they are edited on the web.
                    TextButton(onClick = { expanded = if (expanded == role.id) null else role.id }) {
                        Text(if (expanded == role.id) "Hide eligibility, skills and stages" else "Eligibility, skills and stages")
                    }
                    if (expanded == role.id) RoleRequirements(employerId, role.id)
                }
            }
        }
        item { Spacer(Modifier.height(18.dp)) }
    }
}

/** A role's current eligibility, skills and stages, as the server returns them. Nothing is invented. */
@Composable
private fun RoleRequirements(employerId: String, opportunityId: String) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var state by remember(opportunityId) { mutableStateOf<Load<OpportunityRequirementsDto?>>(Load.Loading) }
    LaunchedEffect(opportunityId) {
        state = loadOf { Api.employerOpportunityRequirements(context, employerId, opportunityId) }
    }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    when (val current = state) {
        Load.Loading -> Text("Loading…", style = MaterialTheme.typography.bodySmall, color = muted)
        is Load.Failed -> Text(current.message, style = MaterialTheme.typography.bodySmall, color = muted)
        is Load.Ready -> {
            val requirements = current.value
            Text("Who can apply", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            val rules = requirements?.eligibilityRules.orEmpty()
            Text(if (rules.isEmpty()) "No eligibility rules." else rules.joinToString("\n") {
                describeEligibilityRule(it.ruleType, it.comparator, it.valueNumeric, it.valueText, it.displayValue) +
                    if (it.isBlocking) "" else " (shown; does not stop anyone applying)"
            }, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(6.dp))
            Text("Skills", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            val skills = requirements?.skills.orEmpty()
            Text(if (skills.isEmpty()) "No skills listed." else skills.joinToString("  ·  ") {
                it.name + (if (it.level == "PREFERRED") " (preferred)" else "") + (if (it.catalogue) "" else " · not in the ONE catalogue")
            }, style = MaterialTheme.typography.bodySmall)
            Text("Catalogue role: ${requirements?.careerRole?.let { "${it.title} (${it.code})" } ?: "NA"}", style = MaterialTheme.typography.bodySmall, color = muted)
            Spacer(Modifier.height(6.dp))
            Text("Selection stages", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            val stages = requirements?.stages.orEmpty()
            Text(if (stages.isEmpty()) "No stages set." else stages.sortedBy { it.order }.joinToString("\n") { "${it.order}. ${it.label}" },
                style = MaterialTheme.typography.bodySmall)
        }
    }
}

// --- Shared staff pages ----------------------------------------------------------

@Composable
private fun StaffMore(onSignOut: () -> Unit, onSwitchWorkspace: (() -> Unit)?, webNote: String, onHelp: () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
        PilotCard {
            Column(Modifier.padding(16.dp)) {
                Text("On the web, not in the app", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Text(webNote, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = onHelp) { Text("Help & FAQ") }
        Spacer(Modifier.height(8.dp))
        if (onSwitchWorkspace != null) {
            OutlinedButton(onClick = onSwitchWorkspace) { Text("Switch workspace") }
            Spacer(Modifier.height(8.dp))
        }
        OutlinedButton(onClick = onSignOut) { Text("Sign out") }
    }
}

@Composable
private fun StaffInboxOverlay(feed: NotificationsEnvelope?, onClose: () -> Unit) {
    OverlayScaffold("Notifications", onClose) {
        when {
            feed == null || feed.notifications.isEmpty() ->
                EmptyState(Icons.Filled.Notifications, Tone.Amber, "All caught up",
                    "Platform updates for your account land here, including a candidate's answer to an offer you made.")
            else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
                items(feed.notifications, key = { it.id }) { note ->
                    Column(Modifier.padding(vertical = 10.dp)) {
                        Text(note.title, style = MaterialTheme.typography.titleSmall,
                            fontWeight = if (note.readAt == null) FontWeight.Bold else FontWeight.Normal)
                        Text(note.body, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                }
            }
        }
    }
}

// --- Operations dashboard (view-only by policy) ----------------------------------

@Composable
internal fun OpsScaffold(
    currentTheme: String,
    onThemeChange: (String) -> Unit,
    onSignOut: () -> Unit,
    onSwitchWorkspace: (() -> Unit)?,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val palette = LocalOnePalette.current
    var tab by remember { mutableStateOf(0) }
    // OPS-03: one server-side summary replaces the two full-list fetches (each capped at 200).
    var overview by remember { mutableStateOf<OpsOverviewDto?>(null) }
    var overviewFailed by remember { mutableStateOf(false) }
    var inbox by remember { mutableStateOf<NotificationsEnvelope?>(null) }
    var showInboxOv by remember { mutableStateOf(false) }
    var showThemeOv by remember { mutableStateOf(false) }
    var showHelpOv by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        coroutineScope {
            val o = async { runCatching { Api.operationsOverview(context) } }
            val n = async { runCatching { Api.listNotifications(context) }.getOrNull() }
            val result = o.await()
            overview = result.getOrNull(); overviewFailed = result.isFailure; inbox = n.await()
        }
    }

    androidx.activity.compose.BackHandler(enabled = showInboxOv || showThemeOv || showHelpOv) {
        when {
            showHelpOv -> showHelpOv = false
            showThemeOv -> showThemeOv = false
            else -> showInboxOv = false
        }
    }
    when {
        showHelpOv -> { SlideIn { HelpFaqPage(persona = "institution", onClose = { showHelpOv = false }) }; return }
        showThemeOv -> { SlideIn { ThemeOverlay(currentTheme, onThemeChange, onClose = { showThemeOv = false }) }; return }
        showInboxOv -> { SlideIn { StaffInboxOverlay(inbox, onClose = { showInboxOv = false }) }; return }
    }

    Scaffold(
        containerColor = palette.bandBottom,
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
        bottomBar = {
            NavigationBar(containerColor = palette.navBg, windowInsets = NavigationBarDefaults.windowInsets) {
                val colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = palette.navSelected, selectedTextColor = palette.navSelected,
                    indicatorColor = palette.accentSoft,
                    unselectedIconColor = palette.muted, unselectedTextColor = palette.muted,
                )
                NavigationBarItem(selected = tab == 0, onClick = { tab = 0 },
                    icon = { Icon(Icons.Filled.Home, null) }, label = { Text("Overview") }, colors = colors)
                NavigationBarItem(selected = tab == 1, onClick = { tab = 1 },
                    icon = { Icon(Icons.Filled.MoreHoriz, null) }, label = { Text("More") }, colors = colors)
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            BrandBand {
                StaffBandHeader(
                    title = if (tab == 0) "Operations" else "More",
                    subtitle = if (tab == 0) "Platform overview · view-only" else "Workspace and app settings",
                    unread = inbox?.unreadCount ?: 0,
                    onTheme = { showThemeOv = true },
                    onBell = { showInboxOv = true },
                )
            }
            BandSheet {
                when {
                    tab == 0 && overviewFailed -> CenteredNote("The operations overview could not be loaded. No numbers are shown until the server's counts load. Try again shortly.")
                    tab == 0 && overview == null -> HomeSkeleton()
                    tab == 0 -> OpsOverview(overview!!)
                    else -> StaffMore(onSignOut, onSwitchWorkspace,
                        "This workspace is view-only in the app by policy. All changes - onboarding, invitations, configuration - happen on the web at one.ai8ht.pro.",
                        onHelp = { showHelpOv = true })
                }
            }
        }
    }
}

private const val OPS_NA = "NA"

/** A bounded server count as text: NA when the section is not available, "+" when capped. */
private fun opsCount(count: OpsCountDto?): String =
    count?.let { if (it.capped) "%,d+".format(it.value) else "%,d".format(it.value) } ?: OPS_NA

private fun opsSum(first: OpsCountDto?, second: OpsCountDto?): OpsCountDto? =
    if (first == null || second == null) null else OpsCountDto(first.value + second.value, first.capped || second.capped)

private data class OpsQueueRow(val title: String, val count: OpsCountDto?, val detail: String?, val screen: String)

/** The same ten queues as the web Overview, in the same order. */
private fun opsQueues(overview: OpsOverviewDto): List<OpsQueueRow> = listOf(
    OpsQueueRow("Organizations awaiting verification", overview.verification?.awaitingDecision,
        overview.verification?.let { "${opsCount(it.underReview)} under review" }, "Verification"),
    OpsQueueRow("Employer access requests", overview.employerAccessRequests?.pending,
        overview.employerAccessRequests?.let { "Waiting for a decision" }, "Organizations"),
    OpsQueueRow("Invitations pending over 72 hours", overview.invitations?.staff?.pendingOver72Hours,
        overview.invitations?.let { "${opsCount(it.staff.expiredUnaccepted)} expired without being accepted" }, "Users"),
    OpsQueueRow("Student invitations not delivered", overview.invitations?.student?.notDelivered,
        overview.invitations?.let { "Of ${opsCount(it.student.pending)} pending · ${opsCount(it.student.pendingOver72Hours)} over 72 hours" }, "Users"),
    OpsQueueRow("Open trust and safety cases", overview.trustSafety?.open,
        overview.trustSafety?.let { "Critical ${opsCount(it.bySeverity["CRITICAL"])} · high ${opsCount(it.bySeverity["HIGH"])} · unassigned ${opsCount(it.unassigned)}" }, "Trust and Safety"),
    OpsQueueRow("Failed background events", overview.jobs?.failedEvents,
        overview.jobs?.let { "${opsCount(it.openAlerts)} open health alerts" }, "System Health"),
    OpsQueueRow("Open privacy requests", overview.privacyRequests?.open,
        overview.privacyRequests?.let { "${opsCount(it.deletionsDueWithin7Days)} deletions scheduled within 7 days · ${opsCount(it.failed)} failed" }, "Security"),
    OpsQueueRow("Active legal holds", overview.privacyHolds?.active,
        overview.privacyHolds?.let { "Releasing a hold needs a second person's approval" }, "Security"),
    OpsQueueRow("Approvals awaiting a decision", overview.approvals?.pending,
        overview.approvals?.let { "${opsCount(it.awaitingExecution)} approved, awaiting execution" }, "Settings"),
    OpsQueueRow("Open support cases", overview.support?.open,
        overview.support?.let { "${opsCount(it.overdue)} past their SLA · ${opsCount(it.unassigned)} unassigned" }, "Support"),
)

@Composable
private fun OpsOverview(overview: OpsOverviewDto) {
    val orgs = overview.organizations
    val verified = orgs?.let { opsSum(it.institutions.byVerification["VERIFIED"], it.employers.byVerification["VERIFIED"]) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(10.dp))
        PilotCard(glow = true) {
            Text("View-only workspace: monitoring only. Changes happen on the web.",
                Modifier.padding(12.dp), style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell(opsCount(orgs?.institutions?.total), "Institutions", Tone.Green, Icons.Filled.School, Modifier.weight(1f))
            StatCell(opsCount(orgs?.employers?.total), "Employers", Tone.Violet, Icons.Filled.WorkOutline, Modifier.weight(1f))
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell(opsCount(verified), "Verified", Tone.Accent, Icons.Filled.Assignment, Modifier.weight(1f))
            StatCell(opsCount(overview.invitations?.staff?.pending), "Invites pending", Tone.Amber, Icons.Filled.Notifications, Modifier.weight(1f))
        }
        SectionTitle("Operator queues")
        opsQueues(overview).forEach { queue ->
            PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(queue.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Text(queue.detail?.let { "$it · worked in ${queue.screen} on the web" } ?: "NA - not available with your access.",
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.width(8.dp))
                    val count = queue.count
                    StatusChip(opsCount(count), when {
                        count == null -> ChipKind.Muted
                        count.value > 0 -> ChipKind.Waiting
                        else -> ChipKind.Positive
                    })
                }
            }
        }
        SectionTitle("Organizations")
        when {
            orgs == null -> PilotCard {
                Text("NA - organization management is not part of your access.", Modifier.padding(16.dp),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            orgs.recent.isEmpty() -> PilotCard {
                Text("No organizations onboarded yet.", Modifier.padding(16.dp),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> orgs.recent.forEach { org ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconBubble(
                            if (org.kind == "INSTITUTION") Icons.Filled.School else Icons.Filled.WorkOutline,
                            if (org.kind == "INSTITUTION") Tone.Green else Tone.Violet, size = 32.dp,
                        )
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(org.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text(prettify(org.kind), style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        StatusChip(prettify(org.verificationState),
                            if (org.verificationState.uppercase().startsWith("VERIF")) ChipKind.Positive else ChipKind.Waiting)
                    }
                }
            }
        }
        Spacer(Modifier.height(20.dp))
    }
}

// --- Help & FAQ -------------------------------------------------------------------

@Composable
internal fun HelpFaqPage(persona: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var articles by remember { mutableStateOf<List<HelpArticleDto>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        runCatching { Api.helpArticles(context) }
            .onSuccess { articles = it }
            .onFailure { failed = true }
    }
    OverlayScaffold("Help & FAQ", onClose) {
        when {
            failed -> CenteredNote("The help guide could not be loaded right now. Try again shortly.")
            articles == null -> LoadingSpinner()
            else -> {
                val visible = articles!!.filter { it.personas.contains("all") || it.personas.contains(persona) }
                LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
                    item {
                        Spacer(Modifier.height(10.dp))
                        Text(
                            "Answers for your role — from the same guide that powers the ONE Assistant.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(6.dp))
                    }
                    items(visible, key = { it.id }) { article ->
                        Spacer(Modifier.height(10.dp))
                        PilotCard(Modifier.fillMaxWidth().clickable {
                            expanded = if (expanded == article.id) null else article.id
                        }) {
                            Column(Modifier.padding(14.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(article.title, Modifier.weight(1f),
                                        style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                    Text(if (expanded == article.id) "▾" else "▸",
                                        color = MaterialTheme.colorScheme.primary)
                                }
                                if (expanded == article.id) {
                                    Spacer(Modifier.height(8.dp))
                                    Text(article.body, style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
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
