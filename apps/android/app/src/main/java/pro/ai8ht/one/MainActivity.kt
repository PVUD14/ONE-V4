package pro.ai8ht.one

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
import pro.ai8ht.one.ui.OneTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { OneTheme { OneApp() } }
    }
}

private enum class Screen { Assessments, Inbox, More }

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
        !consentChecked -> LoadingScreen()
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
private fun MainScaffold(onSignOut: () -> Unit) {
    var screen by remember { mutableStateOf(Screen.Assessments) }
    var unread by remember { mutableIntStateOf(0) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = screen == Screen.Assessments,
                    onClick = { screen = Screen.Assessments },
                    icon = { Icon(Icons.Filled.Assignment, contentDescription = null) },
                    label = { Text("Assessments") },
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
                )
                NavigationBarItem(
                    selected = screen == Screen.More,
                    onClick = { screen = Screen.More },
                    icon = { Icon(Icons.Filled.MoreHoriz, contentDescription = null) },
                    label = { Text("More") },
                )
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding)) {
            when (screen) {
                Screen.Assessments -> AssessmentsScreen()
                Screen.Inbox -> InboxScreen(onUnreadChanged = { unread = it })
                Screen.More -> MoreScreen(onSignOut = onSignOut)
            }
        }
    }
}

@Composable
private fun LoadingScreen() {
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) { CircularProgressIndicator() }
}

@Composable
private fun SignInScreen(onSignedIn: () -> Unit) {
    val context = LocalContext.current
    var token by remember { mutableStateOf("") }
    var apiOverride by remember { mutableStateOf(Session.apiOverride(context)) }
    Column(
        Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("ONE", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
        Text("by Ai8ht", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(24.dp))
        if (Session.hostedUiConfigured) {
            Button(onClick = { Session.launchHostedSignIn(context) }, modifier = Modifier.fillMaxWidth()) {
                Text("Sign in with your institution account")
            }
        } else {
            Text(
                "Institution sign-in activates once the mobile app client is registered. " +
                    "UAT testers: paste your access token below.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text("Access token (UAT)") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 3,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = apiOverride,
                onValueChange = { apiOverride = it },
                label = { Text("API base URL (blank = ${BuildConfig.API_BASE_URL})") },
                modifier = Modifier.fillMaxWidth(),
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
            ) { Text("Continue") }
        }
    }
}

@Composable
private fun ConsentScreen(version: String, onGranted: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState())) {
        Spacer(Modifier.height(32.dp))
        Text("Your data, your consent", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        Text(
            "Before you continue, please read how ONE handles your personal data and confirm your consent.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(16.dp))
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
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
        ) { Text(if (busy) "Recording…" else "I have read the notice and I consent") }
    }
}

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
        error -> CenteredNote("Could not load assessments. Pull down or reopen the app to retry.")
        items == null -> LoadingScreen()
        items!!.isEmpty() -> CenteredNote("No assessments assigned yet. Your placement cell assigns them; they appear here with their windows.")
        else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
            items(items!!, key = { it.id }) { exam ->
                Spacer(Modifier.height(12.dp))
                AssessmentCard(exam)
            }
            item { Spacer(Modifier.height(16.dp)) }
        }
    }
}

@Composable
private fun AssessmentCard(exam: AssessmentDto) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp)) {
            Text(exam.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            exam.subjectName?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("${exam.durationSeconds / 60} min", style = MaterialTheme.typography.bodySmall)
                Text("${exam.totalMarks.toInt()} marks", style = MaterialTheme.typography.bodySmall)
                Text("Attempts ${exam.attemptsUsed}/${exam.attemptsAllowed}", style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(8.dp))
            val result = exam.latestResult
            if (result != null) {
                Text(
                    "Result: ${result.score.toInt()}/${result.maxScore.toInt()} (${result.percentage}%)",
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                // v1 policy: attempts are taken on the web (see MOBILE_FOUNDATION.md).
                Text(
                    "Take this assessment on the web at one.ai8ht.pro — mobile attempts arrive in a later version.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

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
        feed == null -> LoadingScreen()
        feed!!.notifications.isEmpty() -> CenteredNote("You're all caught up — nothing needs your attention.")
        else -> Column {
            if (feed!!.unreadCount > 0) {
                OutlinedButton(
                    onClick = {
                        scope.launch {
                            runCatching { Api.markAllRead(context) }.onSuccess {
                                feed = feed!!.copy(unreadCount = 0)
                                onUnreadChanged(0)
                            }
                        }
                    },
                    modifier = Modifier.padding(16.dp),
                ) { Text("Mark all read (${feed!!.unreadCount})") }
            }
            LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
                items(feed!!.notifications, key = { it.id }) { note ->
                    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                        Text(
                            note.title,
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = if (note.readAt == null) FontWeight.Bold else FontWeight.Normal,
                        )
                        Text(note.body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                }
                item { Spacer(Modifier.height(16.dp)) }
            }
        }
    }
}

@Composable
private fun MoreScreen(onSignOut: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp)) {
        Spacer(Modifier.height(16.dp))
        Text("ONE by Ai8ht", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text("Version ${BuildConfig.VERSION_NAME} · one.ai8ht.pro", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(16.dp))
        Text(
            "Profiles, exam taking, and push notifications are on the way. This version covers your assigned assessments, results, and inbox.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
        OutlinedButton(onClick = onSignOut) { Text("Sign out") }
    }
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
