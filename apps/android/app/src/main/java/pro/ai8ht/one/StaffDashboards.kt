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
    if (out.none { it.kind == WorkspaceKind.STUDENT } && ctx.studentRelationships.any { it.state == "ACTIVE" }) {
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
private fun StatCell(value: String, label: String, tone: Tone, icon: androidx.compose.ui.graphics.vector.ImageVector, modifier: Modifier = Modifier) {
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

    LaunchedEffect(Unit) {
        coroutineScope {
            val exams = async { runCatching { Api.listInstitutionExams(context, organizationId) }.getOrDefault(emptyList()) }
            val subjects = async { runCatching { Api.listSubjects(context, organizationId).size }.getOrDefault(0) }
            val review = async { runCatching { Api.countQuestions(context, organizationId, "UNDER_REVIEW") }.getOrDefault(0) }
            val inbox = async { runCatching { Api.listNotifications(context) }.getOrNull() }
            val loadedExams = exams.await()
            val target = loadedExams.firstOrNull { it.lifecycleState == "PUBLISHED" && it.assignedCount > 0 }
            val attention = if (target != null) {
                runCatching { Api.examResults(context, organizationId, target.id).notAttempted.map { it to target } }
                    .getOrDefault(emptyList())
            } else emptyList()
            data = InstitutionData(loadedExams, subjects.await(), review.await(), inbox.await(), attention)
        }
    }

    androidx.activity.compose.BackHandler(enabled = showInboxOv || showChatOv || showThemeOv || showHelpOv || resultsFor != null) {
        when {
            showChatOv -> showChatOv = false
            showThemeOv -> showThemeOv = false
            showInboxOv -> showInboxOv = false
            showHelpOv -> showHelpOv = false
            else -> resultsFor = null
        }
    }
    when {
        showHelpOv -> { SlideIn { HelpFaqPage(persona = "institution", onClose = { showHelpOv = false }) }; return }
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
                        0 -> InstitutionHome(data!!) { tab = 1 }
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
private fun InstitutionHome(data: InstitutionData, onExams: () -> Unit) {
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

        // Pilot: Cohort Readiness - NA multi-ring until the aggregate engine exists.
        SectionTitle("Cohort Readiness")
        PilotCard {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                PilotRing(null, "NA", "AVG", size = 84, stroke = 9f)
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    listOf("Job Ready", "Nearly Ready", "Developing", "Needs Support").forEach { label ->
                        Row(Modifier.padding(vertical = 2.dp)) {
                            Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                            Text("NA", style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }

        // Pilot: Placement Pipeline - NA funnel until drives exist.
        SectionTitle("Placement Pipeline")
        PilotCard {
            Column(Modifier.padding(14.dp)) {
                listOf("Eligible", "Applied", "Shortlisted", "Offers", "Placed").forEach { label ->
                    FunnelRow(label, null, 1)
                }
            }
        }

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

    LaunchedEffect(Unit) {
        coroutineScope {
            val r = async { runCatching { Api.listEmployerOpportunities(context, organizationId) }.getOrDefault(emptyList()) }
            val n = async { runCatching { Api.listNotifications(context) }.getOrNull() }
            val loadedRoles = r.await()
            val loadedApplicants = loadedRoles.filter { it.applicationCount > 0 }.take(4).flatMap { role ->
                runCatching { Api.listEmployerApplicants(context, organizationId, role.id) }.getOrDefault(emptyList())
            }
            roles = loadedRoles; applicants = loadedApplicants; inbox = n.await()
        }
    }

    androidx.activity.compose.BackHandler(enabled = showInboxOv || showChatOv || showThemeOv || showHelpOv) {
        when {
            showChatOv -> showChatOv = false
            showThemeOv -> showThemeOv = false
            showHelpOv -> showHelpOv = false
            else -> showInboxOv = false
        }
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
                when {
                    roles == null -> HomeSkeleton()
                    else -> when (tab) {
                        0 -> EmployerHome(roles!!, applicants) { tab = 1 }
                        1 -> EmployerRoles(roles!!)
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
private fun EmployerHome(roles: List<EmployerOpportunityDto>, applicants: List<EmployerApplicantDto>, onRoles: () -> Unit) {
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
            Text("NA - an interview calendar is not built yet. Interviews are scheduled from the applicant row on the web.",
                Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(applicant.candidateName ?: "Candidate", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text(prettify(applicant.state), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        StatusChip(prettify(applicant.state), ChipKind.Accent)
                    }
                }
            }
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
                        StatusChip(prettify(role.lifecycleState),
                            if (role.lifecycleState == "PUBLISHED") ChipKind.Positive else ChipKind.Muted)
                    }
                }
            }
        }
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun EmployerRoles(roles: List<EmployerOpportunityDto>) {
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
                        StatusChip(prettify(role.lifecycleState),
                            if (role.lifecycleState == "PUBLISHED") ChipKind.Positive else ChipKind.Muted)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("${role.applicationCount} applications · ${role.openApplicationCount} open" +
                        (role.applicationDeadline?.let { " · apply by ${formatWhen(it)}" } ?: ""),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        item { Spacer(Modifier.height(18.dp)) }
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
                    "Platform updates for your account land here.")
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
    var orgs by remember { mutableStateOf<List<OpsOrganizationDto>?>(null) }
    var invitations by remember { mutableStateOf<List<OpsInvitationDto>>(emptyList()) }
    var inbox by remember { mutableStateOf<NotificationsEnvelope?>(null) }
    var showInboxOv by remember { mutableStateOf(false) }
    var showThemeOv by remember { mutableStateOf(false) }
    var showHelpOv by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        coroutineScope {
            val o = async { runCatching { Api.listOperationsOrganizations(context) }.getOrDefault(emptyList()) }
            val i = async { runCatching { Api.listOperationsInvitations(context) }.getOrDefault(emptyList()) }
            val n = async { runCatching { Api.listNotifications(context) }.getOrNull() }
            orgs = o.await(); invitations = i.await(); inbox = n.await()
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
                    orgs == null -> HomeSkeleton()
                    tab == 0 -> OpsOverview(orgs!!, invitations)
                    else -> StaffMore(onSignOut, onSwitchWorkspace,
                        "This workspace is view-only in the app by policy. All changes - onboarding, invitations, configuration - happen on the web at one.ai8ht.pro.",
                        onHelp = { showHelpOv = true })
                }
            }
        }
    }
}

@Composable
private fun OpsOverview(orgs: List<OpsOrganizationDto>, invitations: List<OpsInvitationDto>) {
    val institutions = orgs.count { it.kind == "INSTITUTION" }
    val employers = orgs.count { it.kind == "EMPLOYER" }
    val verified = orgs.count { it.verificationState.uppercase().startsWith("VERIF") }
    val pendingInvites = invitations.count { it.state.uppercase() == "PENDING" }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(10.dp))
        PilotCard(glow = true) {
            Text("View-only workspace: monitoring only. Changes happen on the web.",
                Modifier.padding(12.dp), style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell("$institutions", "Institutions", Tone.Green, Icons.Filled.School, Modifier.weight(1f))
            StatCell("$employers", "Employers", Tone.Violet, Icons.Filled.WorkOutline, Modifier.weight(1f))
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell("$verified", "Verified", Tone.Accent, Icons.Filled.Assignment, Modifier.weight(1f))
            StatCell("$pendingInvites", "Invites pending", Tone.Amber, Icons.Filled.Notifications, Modifier.weight(1f))
        }
        SectionTitle("Organizations")
        if (orgs.isEmpty()) {
            PilotCard { Text("No organizations onboarded yet.", Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        } else {
            orgs.take(10).forEach { org ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconBubble(
                            if (org.kind == "INSTITUTION") Icons.Filled.School else Icons.Filled.WorkOutline,
                            if (org.kind == "INSTITUTION") Tone.Green else Tone.Violet, size = 32.dp,
                        )
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(org.legalName, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
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
