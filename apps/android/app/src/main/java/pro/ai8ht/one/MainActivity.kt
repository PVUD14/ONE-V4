package pro.ai8ht.one

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.WorkOutline
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarDefaults
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import pro.ai8ht.one.ui.BrandWordmark
import pro.ai8ht.one.ui.OneBlue
import pro.ai8ht.one.ui.OneBlueDeep
import pro.ai8ht.one.ui.OneTheme
import java.time.Instant

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { OneTheme { OneApp() } }
    }
}

private enum class Screen(val title: String, val subtitle: String) {
    Home("Home", "Your day at a glance"),
    Assessments("Assessments", "Assigned tests, windows and your results"),
    Learning("Learning", "Modules, lessons and your progress"),
    Jobs("Jobs", "Opportunities and your applications"),
    More("Profile", "Your account, documents and privacy"),
}

private class StudentData(
    val student: StudentDto?,
    val assessments: List<AssessmentDto>,
    val learner: LearnerStateDto?,
    val notifications: NotificationsEnvelope?,
)

@Composable
fun OneApp() {
    val context = LocalContext.current
    var signedIn by remember { mutableStateOf(Session.token(context) != null) }
    var consent by remember { mutableStateOf<ConsentStatusDto?>(null) }
    var consentChecked by remember { mutableStateOf(false) }

    LaunchedEffect(signedIn) {
        if (signedIn) {
            consent = runCatching { Api.consentStatus(context) }.getOrNull()
            consentChecked = true
        }
    }

    when {
        !signedIn -> SignInScreen(onSignedIn = { signedIn = true; consentChecked = false })
        !consentChecked -> BrandSplash()
        consent?.required == true -> ConsentScreen(
            version = consent?.requiredVersion ?: "",
            onGranted = { consent = null; consentChecked = true },
        )
        else -> MainScaffold(onSignOut = {
            Session.clear(context)
            signedIn = false
        })
    }
}

@Composable
private fun BrandSplash() {
    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        BrandWordmark(height = 42.dp, spinEight = true)
        Spacer(Modifier.height(18.dp))
        Text("ONE", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        Text("The campus-to-career workspace", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun MainScaffold(onSignOut: () -> Unit) {
    val context = LocalContext.current
    var screen by remember { mutableStateOf(Screen.Home) }
    var data by remember { mutableStateOf<StudentData?>(null) }
    var loadError by remember { mutableStateOf(false) }
    var reloadKey by remember { mutableIntStateOf(0) }
    var showInbox by remember { mutableStateOf(false) }
    var showChat by remember { mutableStateOf(false) }
    var showEditProfile by remember { mutableStateOf(false) }

    LaunchedEffect(reloadKey) {
        loadError = false
        coroutineScope {
            val student = async { runCatching { Api.studentMe(context) }.getOrNull() }
            val exams = async { runCatching { Api.listAssessments(context) }.getOrNull() }
            val learner = async { runCatching { Api.learnerState(context) }.getOrNull() }
            val inbox = async { runCatching { Api.listNotifications(context) }.getOrNull() }
            val loaded = StudentData(student.await(), exams.await() ?: emptyList(), learner.await(), inbox.await())
            if (loaded.student == null && loaded.learner == null && loaded.notifications == null) loadError = true
            data = loaded
        }
    }

    when {
        showChat -> { ChatOverlay(onClose = { showChat = false }); return }
        showEditProfile -> { EditProfileOverlay(onClose = { showEditProfile = false; reloadKey += 1 }); return }
        showInbox -> { InboxOverlay(data?.notifications, onClose = { showInbox = false }, onAllRead = { reloadKey += 1 }); return }
    }

    val unread = data?.notifications?.unreadCount ?: 0

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = { TopBar(unread = unread, onBell = { showInbox = true }) },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { showChat = true },
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = Color.White,
                shape = CircleShape,
            ) { Icon(Icons.Filled.AutoAwesome, contentDescription = "ONE Assistant") }
        },
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface, windowInsets = NavigationBarDefaults.windowInsets) {
                val colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = MaterialTheme.colorScheme.primary,
                    selectedTextColor = MaterialTheme.colorScheme.primary,
                    indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                    unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                NavigationBarItem(selected = screen == Screen.Home, onClick = { screen = Screen.Home },
                    icon = { Icon(Icons.Filled.Home, null) }, label = { Text("Home") }, colors = colors)
                NavigationBarItem(selected = screen == Screen.Assessments, onClick = { screen = Screen.Assessments },
                    icon = { Icon(Icons.Filled.Assignment, null) }, label = { Text("Exams") }, colors = colors)
                NavigationBarItem(selected = screen == Screen.Learning, onClick = { screen = Screen.Learning },
                    icon = { Icon(Icons.Filled.MenuBook, null) }, label = { Text("Learning") }, colors = colors)
                NavigationBarItem(selected = screen == Screen.Jobs, onClick = { screen = Screen.Jobs },
                    icon = { Icon(Icons.Filled.WorkOutline, null) }, label = { Text("Jobs") }, colors = colors)
                NavigationBarItem(selected = screen == Screen.More, onClick = { screen = Screen.More },
                    icon = { Icon(Icons.Filled.MoreHoriz, null) }, label = { Text("More") }, colors = colors)
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            when {
                data == null -> LoadingSpinner()
                loadError -> CenteredNote("Could not reach ONE right now. Check your connection and reopen the app.")
                else -> {
                    if (screen != Screen.Home) PageHeader(screen)
                    when (screen) {
                        Screen.Home -> HomeScreen(data!!, onOpen = { destination ->
                            if (destination == null) showInbox = true else screen = destination
                        })
                        Screen.Assessments -> AssessmentsScreen(data!!.assessments)
                        Screen.Learning -> LearningScreen(data!!.learner, onChanged = { reloadKey += 1 })
                        Screen.Jobs -> JobsScreen()
                        Screen.More -> MoreScreenFull(data!!.student, onSignOut = onSignOut, onEditProfile = { showEditProfile = true })
                    }
                }
            }
        }
    }
}

@Composable
private fun TopBar(unread: Int, onBell: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.statusBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().padding(start = 18.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BrandWordmark(height = 20.dp)
                Spacer(Modifier.width(10.dp))
                Text("ONE", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onBell) {
                    BadgedBox(badge = { if (unread > 0) Badge { Text("$unread") } }) {
                        Icon(Icons.Filled.Notifications, contentDescription = "Notifications",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        }
    }
}

@Composable
private fun PageHeader(screen: Screen) {
    Column(Modifier.padding(start = 18.dp, end = 18.dp, top = 16.dp, bottom = 4.dp)) {
        Text(screen.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(screen.subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// --- Home ---------------------------------------------------------------------

@Composable
private fun HomeScreen(data: StudentData, onOpen: (Screen?) -> Unit) {
    val now = Instant.now()
    val openExams = data.assessments.count { exam ->
        exam.latestResult == null && exam.attemptsUsed < exam.attemptsAllowed &&
            runCatching { now.isAfter(Instant.parse(exam.startsAt)) && now.isBefore(Instant.parse(exam.endsAt)) }.getOrDefault(false)
    }
    val lessons = data.learner?.catalog?.modules?.flatMap { it.lessons } ?: emptyList()
    val completed = data.learner?.progress?.count { it.state == "COMPLETED" } ?: 0
    val unread = data.notifications?.unreadCount ?: 0
    val firstName = data.student?.fullName?.split(" ")?.firstOrNull() ?: "Student"
    val results = data.assessments.mapNotNull { exam -> exam.latestResult?.let { exam to it } }
    val average = if (results.isEmpty()) null else results.map { it.second.percentage }.average()
    val best = results.maxOfOrNull { it.second.percentage }
    val nextDeadline = data.assessments
        .filter { it.latestResult == null && runCatching { now.isBefore(Instant.parse(it.endsAt)) }.getOrDefault(false) }
        .minByOrNull { it.endsAt }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(16.dp))
        Box(
            Modifier.fillMaxWidth()
                .background(Brush.linearGradient(listOf(OneBlue, OneBlueDeep)), RoundedCornerShape(18.dp))
                .padding(20.dp),
        ) {
            Column {
                Text("Hi, $firstName", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = Color.White)
                val line = listOfNotNull(data.student?.program, data.student?.batch).joinToString(" · ")
                Text(
                    if (line.isNotBlank()) line else "Your placement-readiness workspace",
                    style = MaterialTheme.typography.bodyMedium, color = Color(0xCCFFFFFF),
                )
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    data.learner?.readiness?.band?.let { StatusChip("Readiness: ${prettify(it)}", ChipKind.OnDark) }
                    average?.let { StatusChip("Avg ${it.toInt()}%", ChipKind.OnDark) }
                }
                Spacer(Modifier.height(6.dp))
                Text("${data.assessments.size} assessments assigned · readiness is advisory, visible only to you",
                    style = MaterialTheme.typography.labelSmall, color = Color(0xB3FFFFFF))
            }
        }
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatTile(Icons.Filled.Assignment, Color(0xFFEEF4FF), Color(0xFF1F55E5),
                "$openExams", "Exams open now", Modifier.weight(1f)) { onOpen(Screen.Assessments) }
            StatTile(Icons.Filled.MenuBook, Color(0xFFEAF4EE), Color(0xFF2E6B46),
                "$completed of ${lessons.size}", "Lessons completed", Modifier.weight(1f)) { onOpen(Screen.Learning) }
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatTile(Icons.Filled.WorkOutline, Color(0xFFF3EEFF), Color(0xFF6941C6),
                best?.let { "${it.toInt()}%" } ?: "—", "Best exam score", Modifier.weight(1f)) { onOpen(Screen.Assessments) }
            StatTile(Icons.Filled.Notifications, Color(0xFFFDF6E0), Color(0xFF8A6400),
                "$unread", "Unread updates", Modifier.weight(1f)) { onOpen(null) }
        }

        nextDeadline?.let { exam ->
            SectionTitle("Next deadline")
            PilotCard {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconBubble(Icons.Filled.Assignment, Color(0xFFEEF4FF), Color(0xFF1F55E5))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(exam.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Text("Closes ${formatWhen(exam.endsAt)} · ${exam.durationSeconds / 60} min on the clock",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    StatusChip("Open", ChipKind.Accent)
                }
            }
        }

        if (results.isNotEmpty()) {
            SectionTitle("Recent results")
            PilotCard {
                Column(Modifier.padding(vertical = 4.dp)) {
                    results.take(3).forEachIndexed { index, (exam, result) ->
                        Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(exam.title, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                StatusChip("${result.percentage}%",
                                    if (result.percentage >= 50) ChipKind.Positive else ChipKind.Waiting)
                            }
                            Spacer(Modifier.height(6.dp))
                            LinearProgressIndicator(
                                progress = { (result.percentage / 100.0).toFloat().coerceIn(0f, 1f) },
                                modifier = Modifier.fillMaxWidth(),
                                color = if (result.percentage >= 50) Color(0xFF2E6B46) else Color(0xFF8A6400),
                                trackColor = MaterialTheme.colorScheme.surfaceVariant,
                            )
                        }
                        if (index != results.take(3).lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                    }
                }
            }
        }
        val nextSteps = data.learner?.roadmap?.filter { it.state == "PENDING" }?.take(3) ?: emptyList()
        if (nextSteps.isNotEmpty()) {
            SectionTitle("Next steps")
            PilotCard {
                Column(Modifier.padding(vertical = 4.dp)) {
                    nextSteps.forEachIndexed { index, step ->
                        Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
                            Spacer(Modifier.width(12.dp))
                            Column {
                                Text(prettify(step.actionCode), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                Text(prettify(step.reasonCode), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        if (index != nextSteps.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                    }
                }
            }
        }
        val recent = data.notifications?.notifications?.take(3) ?: emptyList()
        if (recent.isNotEmpty()) {
            SectionTitle("Recent activity")
            PilotCard {
                Column(Modifier.padding(vertical = 4.dp)) {
                    recent.forEachIndexed { index, note ->
                        Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) {
                            Text(note.title, style = MaterialTheme.typography.bodyMedium,
                                fontWeight = if (note.readAt == null) FontWeight.SemiBold else FontWeight.Normal)
                            Text(note.body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (index != recent.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                    }
                }
            }
        }
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun StatTile(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    iconBg: Color,
    iconFg: Color,
    value: String,
    label: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    PilotCard(modifier.clickable(onClick = onClick)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBubble(icon, iconBg, iconFg)
            Spacer(Modifier.width(12.dp))
            Column {
                Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

// --- Assessments --------------------------------------------------------------

@Composable
private fun AssessmentsScreen(items: List<AssessmentDto>) {
    if (items.isEmpty()) {
        CenteredNote("No assessments assigned yet. Your placement cell assigns them; they appear here with their windows.")
        return
    }
    val results = items.mapNotNull { it.latestResult }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        if (results.isNotEmpty()) {
            item {
                Spacer(Modifier.height(10.dp))
                PilotCard {
                    Row(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                        SummaryCell("${results.size}/${items.size}", "Completed", Modifier.weight(1f))
                        SummaryCell("${results.map { it.percentage }.average().toInt()}%", "Average", Modifier.weight(1f))
                        SummaryCell("${results.maxOf { it.percentage }.toInt()}%", "Best", Modifier.weight(1f))
                    }
                }
            }
        }
        items(items, key = { it.id }) { exam ->
            Spacer(Modifier.height(12.dp))
            AssessmentCard(exam)
        }
        item { Spacer(Modifier.height(18.dp)) }
    }
}

@Composable
private fun SummaryCell(value: String, label: String, modifier: Modifier = Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun AssessmentCard(exam: AssessmentDto) {
    val now = Instant.now()
    val starts = runCatching { Instant.parse(exam.startsAt) }.getOrNull()
    val ends = runCatching { Instant.parse(exam.endsAt) }.getOrNull()
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(exam.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    val meta = listOfNotNull(exam.subjectName, exam.institutionName).joinToString(" · ")
                    if (meta.isNotBlank()) Text(meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(Modifier.width(10.dp))
                when {
                    exam.latestResult != null -> StatusChip("${exam.latestResult.percentage}%", ChipKind.Positive)
                    starts != null && now.isBefore(starts) -> StatusChip("Opens soon", ChipKind.Waiting)
                    ends != null && now.isAfter(ends) -> StatusChip("Window closed", ChipKind.Muted)
                    exam.attemptsUsed >= exam.attemptsAllowed -> StatusChip("Attempts used", ChipKind.Muted)
                    else -> StatusChip("Open now", ChipKind.Accent)
                }
            }
            Spacer(Modifier.height(10.dp))
            val markWord = if (exam.totalMarks.toInt() == 1) "mark" else "marks"
            Text("${exam.durationSeconds / 60} min  ·  ${exam.totalMarks.toInt()} $markWord  ·  attempts ${exam.attemptsUsed}/${exam.attemptsAllowed}",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val result = exam.latestResult
            if (result != null) {
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    LinearProgressIndicator(
                        progress = { (result.percentage / 100.0).toFloat().coerceIn(0f, 1f) },
                        modifier = Modifier.weight(1f),
                        color = if (result.percentage >= 50) Color(0xFF2E6B46) else Color(0xFF8A6400),
                        trackColor = MaterialTheme.colorScheme.surfaceVariant,
                    )
                    Spacer(Modifier.width(10.dp))
                    Text("${result.score.toInt()}/${result.maxScore.toInt()}",
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                }
            } else if (ends != null && now.isBefore(ends)) {
                Spacer(Modifier.height(6.dp))
                Text("Open until ${formatWhen(exam.endsAt)} · take it on the web at one.ai8ht.pro",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

// --- Learning -----------------------------------------------------------------

@Composable
private fun LearningScreen(learner: LearnerStateDto?, onChanged: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busyLesson by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }

    if (learner == null || learner.catalog.modules.isEmpty()) {
        CenteredNote("Learning modules will appear here once published for your institution.")
        return
    }
    val done = learner.progress.filter { it.state == "COMPLETED" }.map { it.lessonVersionId }.toSet()
    val allLessons = learner.catalog.modules.flatMap { it.lessons }
    val doneCount = allLessons.count { done.contains(it.id) }

    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        item {
            Spacer(Modifier.height(10.dp))
            PilotCard {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconBubble(Icons.Filled.MenuBook, Color(0xFFEAF4EE), Color(0xFF2E6B46), size = 44.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Overall progress", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(6.dp))
                        LinearProgressIndicator(
                            progress = { if (allLessons.isEmpty()) 0f else doneCount.toFloat() / allLessons.size },
                            modifier = Modifier.fillMaxWidth(),
                            color = Color(0xFF2E6B46),
                            trackColor = MaterialTheme.colorScheme.surfaceVariant,
                        )
                    }
                    Spacer(Modifier.width(12.dp))
                    Text("$doneCount/${allLessons.size}", style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                }
            }
        }
        message?.let { text ->
            item {
                Spacer(Modifier.height(10.dp))
                Surface(color = Color(0xFFFDF6E0), contentColor = Color(0xFF8A6400), shape = RoundedCornerShape(10.dp)) {
                    Text(text, Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        items(learner.catalog.modules, key = { it.id }) { module ->
            Spacer(Modifier.height(12.dp))
            val moduleDone = module.lessons.count { done.contains(it.id) }
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text(module.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    if (module.description.isNotBlank()) {
                        Text(module.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        LinearProgressIndicator(
                            progress = { if (module.lessons.isEmpty()) 0f else moduleDone.toFloat() / module.lessons.size },
                            modifier = Modifier.weight(1f),
                            color = MaterialTheme.colorScheme.primary,
                            trackColor = MaterialTheme.colorScheme.surfaceVariant,
                        )
                        Spacer(Modifier.width(10.dp))
                        Text("$moduleDone/${module.lessons.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.height(6.dp))
                    module.lessons.forEach { lesson ->
                        val isDone = done.contains(lesson.id)
                        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                if (isDone) Icons.Filled.CheckCircle else Icons.Outlined.Circle,
                                contentDescription = null,
                                tint = if (isDone) Color(0xFF2E6B46) else MaterialTheme.colorScheme.outline,
                                modifier = Modifier.size(20.dp),
                            )
                            Spacer(Modifier.width(10.dp))
                            Text(lesson.title, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                            if (!isDone) {
                                TextButton(
                                    enabled = busyLesson == null,
                                    onClick = {
                                        busyLesson = lesson.id
                                        message = null
                                        scope.launch {
                                            runCatching { Api.completeLesson(context, lesson.id) }
                                                .onSuccess { busyLesson = null; onChanged() }
                                                .onFailure { error ->
                                                    busyLesson = null
                                                    message = (error as? Api.ApiException)?.detail
                                                        ?: "The lesson could not be completed. Finish its prerequisites first."
                                                }
                                        }
                                    },
                                ) { Text(if (busyLesson == lesson.id) "…" else "Complete") }
                            }
                        }
                    }
                }
            }
        }
        item { Spacer(Modifier.height(18.dp)) }
    }
}

// --- Inbox overlay ------------------------------------------------------------

@Composable
private fun InboxOverlay(feed: NotificationsEnvelope?, onClose: () -> Unit, onAllRead: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                Text("Notifications", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.weight(1f))
                if ((feed?.unreadCount ?: 0) > 0) {
                    TextButton(onClick = {
                        scope.launch { runCatching { Api.markAllRead(context) }.onSuccess { onAllRead(); onClose() } }
                    }) { Text("Mark all read") }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            when {
                feed == null || feed.notifications.isEmpty() ->
                    CenteredNote("You're all caught up — nothing needs your attention.")
                else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
                    item { Spacer(Modifier.height(10.dp)) }
                    items(feed.notifications, key = { it.id }) { note ->
                        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                            Box(Modifier.width(3.dp).fillMaxHeight()
                                .background(if (note.readAt == null) MaterialTheme.colorScheme.primary else Color.Transparent))
                            Column(Modifier.padding(start = 13.dp, end = 16.dp, top = 10.dp, bottom = 10.dp)) {
                                Text(note.title, style = MaterialTheme.typography.titleSmall,
                                    fontWeight = if (note.readAt == null) FontWeight.Bold else FontWeight.Normal)
                                Spacer(Modifier.height(2.dp))
                                Text(note.body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                    }
                    item { Spacer(Modifier.height(18.dp)) }
                }
            }
        }
    }
}

// --- Sign in / consent ---------------------------------------------------------

@Composable
private fun SignInScreen(onSignedIn: () -> Unit) {
    val context = LocalContext.current
    var token by remember { mutableStateOf("") }
    var apiOverride by remember { mutableStateOf(Session.apiOverride(context)) }
    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(20.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        BrandWordmark(height = 40.dp, spinEight = true)
        Spacer(Modifier.height(10.dp))
        Text("The campus-to-career workspace", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(26.dp))
        PilotCard {
            Column(Modifier.padding(20.dp)) {
                Text("Sign in", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                if (Session.hostedUiConfigured) {
                    Text("Use your institution account to continue.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { Session.launchHostedSignIn(context) }, modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)) {
                        Text("Sign in with your institution account")
                    }
                } else {
                    Text("Institution sign-in activates once the mobile app client is registered. UAT testers: paste your access token below.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(14.dp))
                    val fieldColors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = MaterialTheme.colorScheme.primary,
                        unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                    )
                    OutlinedTextField(value = token, onValueChange = { token = it }, label = { Text("Access token (UAT)") },
                        modifier = Modifier.fillMaxWidth(), minLines = 3, shape = RoundedCornerShape(10.dp), colors = fieldColors)
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(value = apiOverride, onValueChange = { apiOverride = it },
                        label = { Text("API base URL (blank = production)") },
                        modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), colors = fieldColors)
                    Spacer(Modifier.height(16.dp))
                    Button(
                        onClick = {
                            Session.setApiOverride(context, apiOverride)
                            Session.setToken(context, token)
                            onSignedIn()
                        },
                        enabled = token.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                    ) { Text("Continue") }
                }
            }
        }
    }
}

@Composable
private fun ConsentScreen(version: String, onGranted: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(20.dp).verticalScroll(rememberScrollState())) {
        Spacer(Modifier.height(24.dp))
        BrandWordmark(height = 22.dp)
        Spacer(Modifier.height(20.dp))
        Text("Your data, your consent", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text("Before you continue, please read how ONE handles your personal data and confirm your consent.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(16.dp))
        PilotCard {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("What we collect: your profile, assessment attempts and results, learning progress, and technical logs — to run your placement-readiness workspace.", style = MaterialTheme.typography.bodyMedium)
                Text("What stays private: readiness guidance is advisory, never shown to employers and never public.", style = MaterialTheme.typography.bodyMedium)
                Text("AI features: limited data is processed by our AI provider (Anthropic, USA); it is not used to train AI models.", style = MaterialTheme.typography.bodyMedium)
                Text("Your rights: export, correction, erasure, and consent withdrawal — any time from Settings.", style = MaterialTheme.typography.bodyMedium)
            }
        }
        Spacer(Modifier.height(8.dp))
        Text("Full notice version $version is available in Settings → Privacy.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        error?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = {
                busy = true; error = null
                scope.launch {
                    runCatching { Api.grantConsent(context, version) }
                        .onSuccess { onGranted() }
                        .onFailure { busy = false; error = "Your consent could not be recorded just now. Please try again." }
                }
            },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(10.dp),
        ) { Text(if (busy) "Recording…" else "I have read the notice and I consent") }
    }
}
