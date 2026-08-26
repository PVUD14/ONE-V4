package pro.ai8ht.one

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarDefaults
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import pro.ai8ht.one.ui.BrandWordmark
import pro.ai8ht.one.ui.OneTheme
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { OneTheme { OneApp() } }
    }
}

private enum class Screen(val title: String, val subtitle: String) {
    Assessments("Assessments", "Assigned tests, windows and your results"),
    Inbox("Notifications", "Assignments, reopenings and published results"),
    More("More", "Account and app information"),
}

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

/** App-load splash: the wordmark with the 8 spinning in place, as on the web. */
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
        Text(
            "The campus-to-career workspace",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun MainScaffold(onSignOut: () -> Unit) {
    var screen by remember { mutableStateOf(Screen.Assessments) }
    var unread by remember { mutableIntStateOf(0) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = { TopBar() },
        bottomBar = {
            NavigationBar(
                containerColor = MaterialTheme.colorScheme.surface,
                windowInsets = NavigationBarDefaults.windowInsets,
            ) {
                val itemColors = NavigationBarItemDefaults.colors(
                    selectedIconColor = MaterialTheme.colorScheme.primary,
                    selectedTextColor = MaterialTheme.colorScheme.primary,
                    indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                    unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                NavigationBarItem(
                    selected = screen == Screen.Assessments,
                    onClick = { screen = Screen.Assessments },
                    icon = { Icon(Icons.Filled.Assignment, contentDescription = null) },
                    label = { Text("Assessments") },
                    colors = itemColors,
                )
                NavigationBarItem(
                    selected = screen == Screen.Inbox,
                    onClick = { screen = Screen.Inbox },
                    icon = {
                        BadgedBox(badge = { if (unread > 0) Badge { Text("$unread") } }) {
                            Icon(Icons.Filled.Notifications, contentDescription = null)
                        }
                    },
                    label = { Text("Inbox") },
                    colors = itemColors,
                )
                NavigationBarItem(
                    selected = screen == Screen.More,
                    onClick = { screen = Screen.More },
                    icon = { Icon(Icons.Filled.MoreHoriz, contentDescription = null) },
                    label = { Text("More") },
                    colors = itemColors,
                )
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            PageHeader(screen)
            when (screen) {
                Screen.Assessments -> AssessmentsScreen()
                Screen.Inbox -> InboxScreen(onUnreadChanged = { unread = it })
                Screen.More -> MoreScreen(onSignOut = onSignOut)
            }
        }
    }
}

/** The web topbar, translated: white surface, brand wordmark, hairline below. */
@Composable
private fun TopBar() {
    Surface(color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.statusBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BrandWordmark(height = 20.dp)
                Spacer(Modifier.width(10.dp))
                Text(
                    "ONE",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        }
    }
}

@Composable
private fun PageHeader(screen: Screen) {
    Column(Modifier.padding(start = 18.dp, end = 18.dp, top = 18.dp, bottom = 6.dp)) {
        Text(screen.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(
            screen.subtitle,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// --- Pilot-language building blocks -----------------------------------------

private enum class ChipKind { Positive, Accent, Waiting, Muted }

@Composable
private fun StatusChip(text: String, kind: ChipKind) {
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    val (bg, fg) = when (kind) {
        ChipKind.Positive -> if (dark) Color(0xFF16281D) to Color(0xFF7FD1A0) else Color(0xFFEAF4EE) to Color(0xFF2E6B46)
        ChipKind.Accent -> if (dark) Color(0xFF15203A) to Color(0xFF8FB0FF) else Color(0xFFEEF4FF) to Color(0xFF1F55E5)
        ChipKind.Waiting -> if (dark) Color(0xFF2A2310) to Color(0xFFE3CF8E) else Color(0xFFFDF6E0) to Color(0xFF8A6400)
        ChipKind.Muted -> if (dark) Color(0xFF1B1E24) to Color(0xFF8E939C) else Color(0xFFF2F4F7) to Color(0xFF667085)
    }
    Surface(color = bg, contentColor = fg, shape = RoundedCornerShape(999.dp)) {
        Text(
            text,
            Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun PilotCard(content: @Composable () -> Unit) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) { content() }
}

// --- Sign in ------------------------------------------------------------------

@Composable
private fun SignInScreen(onSignedIn: () -> Unit) {
    val context = LocalContext.current
    var token by remember { mutableStateOf("") }
    var apiOverride by remember { mutableStateOf(Session.apiOverride(context)) }
    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(20.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        BrandWordmark(height = 40.dp, spinEight = true)
        Spacer(Modifier.height(10.dp))
        Text(
            "The campus-to-career workspace",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(26.dp))
        PilotCard {
            Column(Modifier.padding(20.dp)) {
                Text("Sign in", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                if (Session.hostedUiConfigured) {
                    Text(
                        "Use your institution account to continue.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(16.dp))
                    Button(
                        onClick = { Session.launchHostedSignIn(context) },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
                    ) { Text("Sign in with your institution account") }
                } else {
                    Text(
                        "Institution sign-in activates once the mobile app client is registered. UAT testers: paste your access token below.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(14.dp))
                    val fieldColors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = MaterialTheme.colorScheme.primary,
                        unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                    )
                    OutlinedTextField(
                        value = token,
                        onValueChange = { token = it },
                        label = { Text("Access token (UAT)") },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 3,
                        shape = RoundedCornerShape(10.dp),
                        colors = fieldColors,
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = apiOverride,
                        onValueChange = { apiOverride = it },
                        label = { Text("API base URL (blank = production)") },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                        colors = fieldColors,
                    )
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

// --- Consent ------------------------------------------------------------------

@Composable
private fun ConsentScreen(version: String, onGranted: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(20.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Spacer(Modifier.height(24.dp))
        BrandWordmark(height = 22.dp)
        Spacer(Modifier.height(20.dp))
        Text("Your data, your consent", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text(
            "Before you continue, please read how ONE handles your personal data and confirm your consent.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
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
        Text(
            "Full notice version $version is available in Settings → Privacy.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
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

// --- Assessments --------------------------------------------------------------

@Composable
private fun AssessmentsScreen() {
    val context = LocalContext.current
    var items by remember { mutableStateOf<List<AssessmentDto>?>(null) }
    var error by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        runCatching { Api.listAssessments(context) }
            .onSuccess { items = it }
            .onFailure { error = true }
    }
    when {
        error -> CenteredNote("Could not load assessments. Reopen the app to retry.")
        items == null -> LoadingSpinner()
        items!!.isEmpty() -> CenteredNote("No assessments assigned yet. Your placement cell assigns them; they appear here with their windows.")
        else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            items(items!!, key = { it.id }) { exam ->
                Spacer(Modifier.height(12.dp))
                AssessmentCard(exam)
            }
            item { Spacer(Modifier.height(18.dp)) }
        }
    }
}

private fun formatWhen(iso: String): String = runCatching {
    DateTimeFormatter.ofPattern("d MMM, h:mm a").withZone(ZoneId.systemDefault()).format(Instant.parse(iso))
}.getOrDefault(iso)

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
                    if (meta.isNotBlank()) {
                        Text(meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.width(10.dp))
                when {
                    exam.latestResult != null ->
                        StatusChip("Completed · ${exam.latestResult.percentage}%", ChipKind.Positive)
                    starts != null && now.isBefore(starts) -> StatusChip("Opens soon", ChipKind.Waiting)
                    ends != null && now.isAfter(ends) -> StatusChip("Window closed", ChipKind.Muted)
                    exam.attemptsUsed >= exam.attemptsAllowed -> StatusChip("Attempts used", ChipKind.Muted)
                    else -> StatusChip("Open now", ChipKind.Accent)
                }
            }
            Spacer(Modifier.height(10.dp))
            Text(
                "${exam.durationSeconds / 60} min  ·  ${exam.totalMarks.toInt()} marks  ·  attempts ${exam.attemptsUsed}/${exam.attemptsAllowed}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val result = exam.latestResult
            if (result != null) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "Score ${result.score.toInt()}/${result.maxScore.toInt()}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.SemiBold,
                )
            } else if (ends != null && now.isBefore(ends)) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "Open until ${formatWhen(exam.endsAt)} · take it on the web at one.ai8ht.pro",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

// --- Inbox --------------------------------------------------------------------

@Composable
private fun InboxScreen(onUnreadChanged: (Int) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var feed by remember { mutableStateOf<NotificationsEnvelope?>(null) }
    var error by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        runCatching { Api.listNotifications(context) }
            .onSuccess { feed = it; onUnreadChanged(it.unreadCount) }
            .onFailure { error = true }
    }
    when {
        error -> CenteredNote("Could not load notifications right now.")
        feed == null -> LoadingSpinner()
        feed!!.notifications.isEmpty() -> CenteredNote("You're all caught up — nothing needs your attention.")
        else -> Column(Modifier.padding(horizontal = 18.dp)) {
            if (feed!!.unreadCount > 0) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = {
                        scope.launch {
                            runCatching { Api.markAllRead(context) }.onSuccess {
                                feed = feed!!.copy(
                                    unreadCount = 0,
                                    notifications = feed!!.notifications.map { it.copy(readAt = it.readAt ?: "now") },
                                )
                                onUnreadChanged(0)
                            }
                        }
                    }) { Text("Mark all read (${feed!!.unreadCount})") }
                }
            } else {
                Spacer(Modifier.height(6.dp))
            }
            PilotCard {
                LazyColumn(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    items(feed!!.notifications, key = { it.id }) { note ->
                        NotificationRow(note)
                        if (note != feed!!.notifications.last()) {
                            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                        }
                    }
                }
            }
            Spacer(Modifier.height(18.dp))
        }
    }
}

@Composable
private fun NotificationRow(note: NotificationDto) {
    Row(Modifier.fillMaxWidth().height(androidx.compose.foundation.layout.IntrinsicSize.Min)) {
        Box(
            Modifier
                .width(3.dp)
                .fillMaxHeight()
                .background(if (note.readAt == null) MaterialTheme.colorScheme.primary else Color.Transparent),
        )
        Column(Modifier.padding(start = 13.dp, end = 16.dp, top = 12.dp, bottom = 12.dp)) {
            Text(
                note.title,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = if (note.readAt == null) FontWeight.Bold else FontWeight.Normal,
            )
            Spacer(Modifier.height(2.dp))
            Text(note.body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

// --- More ---------------------------------------------------------------------

@Composable
private fun MoreScreen(onSignOut: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(18.dp)) {
        PilotCard {
            Column(Modifier.padding(18.dp)) {
                BrandWordmark(height = 24.dp)
                Spacer(Modifier.height(10.dp))
                Text("ONE", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(
                    "Version ${BuildConfig.VERSION_NAME} · one.ai8ht.pro",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    "Profiles, exam taking, and push notifications are on the way. This version covers your assigned assessments, results, and inbox.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(16.dp))
                OutlinedButton(onClick = onSignOut, shape = RoundedCornerShape(10.dp)) { Text("Sign out") }
            }
        }
    }
}

// --- Shared -------------------------------------------------------------------

@Composable
private fun LoadingSpinner() {
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) { CircularProgressIndicator(color = MaterialTheme.colorScheme.primary) }
}

@Composable
private fun CenteredNote(text: String) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
    }
}
