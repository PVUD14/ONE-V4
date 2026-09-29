package pro.ai8ht.one

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.togetherWith
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
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
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
import pro.ai8ht.one.data.valueOrNull
import pro.ai8ht.one.ui.BrandWordmark
import pro.ai8ht.one.ui.OneBlue
import pro.ai8ht.one.ui.OneBlueDeep
import pro.ai8ht.one.ui.OneTheme
import pro.ai8ht.one.ui.Tone
import java.time.Instant

class MainActivity : ComponentActivity() {
    /**
     * Set when the OAuth redirect brings us back, and read once by the sign-in screen.
     *
     * The activity is `singleTask`, so a redirect while the app is already running
     * arrives at [onNewIntent] rather than a fresh instance — both paths funnel here.
     */
    private val pendingRedirect = androidx.compose.runtime.mutableStateOf<android.net.Uri?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        captureRedirect(intent)
        setContent {
            val context = androidx.compose.ui.platform.LocalContext.current
            var themeId by remember { mutableStateOf(Session.theme(context)) }
            OneTheme(themeId) {
                OneApp(
                    currentTheme = themeId,
                    onThemeChange = { id ->
                        themeId = id
                        Session.setTheme(context, id)
                    },
                    oauthRedirect = pendingRedirect.value,
                    onRedirectHandled = { pendingRedirect.value = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        captureRedirect(intent)
    }

    private fun captureRedirect(intent: android.content.Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "one.ai8ht.pro" && data.host == "signin") pendingRedirect.value = data
    }
}

internal enum class Screen(val title: String, val subtitle: String) {
    Home("Home", "Your day at a glance"),
    Assessments("Assessments", "Assigned tests, windows and your results"),
    Learning("Learning", "Modules, lessons and your progress"),
    Jobs("Jobs", "Opportunities and your applications"),
    More("Profile", "Your account, documents and privacy"),
}

internal class StudentData(
    val student: StudentDto?,
    val assessments: List<AssessmentDto>,
    val learner: LearnerStateDto?,
    val notifications: NotificationsEnvelope?,
    val activity: StudentActivityDto? = null,
)

private fun parseWorkspace(raw: String?): Workspace? {
    if (raw == null) return null
    val parts = raw.split("|")
    if (parts.size < 3) return null
    val kind = runCatching { WorkspaceKind.valueOf(parts[0]) }.getOrNull() ?: return null
    return Workspace(kind, parts[1].ifBlank { null }, parts[2])
}

private fun encodeWorkspace(ws: Workspace): String = "${ws.kind.name}|${ws.organizationId ?: ""}|${ws.role}"

@Composable
fun OneApp(
    currentTheme: String,
    onThemeChange: (String) -> Unit,
    oauthRedirect: android.net.Uri? = null,
    onRedirectHandled: () -> Unit = {},
) {
    val context = LocalContext.current
    var signedIn by remember { mutableStateOf(Session.token(context) != null) }
    var sessionExpired by remember { mutableStateOf(false) }
    var consent by remember { mutableStateOf<ConsentStatusDto?>(null) }
    var consentChecked by remember { mutableStateOf(false) }
    // Fails closed (ENG-01): a check that could not be answered is not consent.
    var consentUnavailable by remember { mutableStateOf(false) }
    var consentAttempt by remember { mutableStateOf(0) }
    var workspace by remember { mutableStateOf(parseWorkspace(Session.workspace(context))) }
    var workspaceOptions by remember { mutableStateOf<List<Workspace>?>(null) }
    var multiWorkspace by remember { mutableStateOf(false) }

    LaunchedEffect(signedIn, consentAttempt) {
        if (signedIn) {
            runCatching { Api.consentStatus(context) }
                .onSuccess { consent = it; consentUnavailable = false; consentChecked = true }
                .onFailure { failure ->
                    if (failure is Api.ApiException && failure.status == 401) {
                        Session.clear(context)
                        workspace = null
                        sessionExpired = true
                        signedIn = false
                    } else {
                        consentUnavailable = true
                    }
                }
        }
    }

    // Role detection: institution/employer accounts get their own dashboards.
    LaunchedEffect(signedIn, consentChecked) {
        if (signedIn && consentChecked && workspace == null && workspaceOptions == null) {
            val options = runCatching { classifyWorkspaces(Api.securityContext(context)) }
                .getOrDefault(emptyList())
                .ifEmpty { listOf(Workspace(WorkspaceKind.STUDENT, null, "STUDENT")) }
            multiWorkspace = options.size > 1
            if (options.size == 1) {
                workspace = options.first()
                Session.setWorkspace(context, encodeWorkspace(options.first()))
            } else {
                workspaceOptions = options
            }
        }
    }

    when {
        !signedIn -> SignInScreen(
            expired = sessionExpired,
            oauthRedirect = oauthRedirect,
            onRedirectHandled = onRedirectHandled,
            onSignedIn = { sessionExpired = false; signedIn = true; consentChecked = false },
        )
        consentUnavailable -> ConsentUnavailableScreen(onRetry = { consentUnavailable = false; consentAttempt += 1 })
        !consentChecked -> BrandSplash()
        consent?.required == true -> ConsentScreen(
            version = consent?.requiredVersion ?: "",
            onGranted = { consent = null; consentChecked = true },
        )
        Session.email(context)?.startsWith("demo.") == true -> DemoAccountScreen(onSignOut = {
            Session.clear(context)
            workspace = null
            signedIn = false
        })
        workspace == null && workspaceOptions == null -> BrandSplash()
        workspace == null -> WorkspaceChooserScreen(workspaceOptions!!) { picked ->
            workspace = picked
            workspaceOptions = null
            Session.setWorkspace(context, encodeWorkspace(picked))
        }
        workspace!!.kind == WorkspaceKind.OPS -> OpsScaffold(
            currentTheme = currentTheme,
            onThemeChange = onThemeChange,
            onSignOut = { Session.clear(context); workspace = null; signedIn = false },
            onSwitchWorkspace = if (multiWorkspace) ({ Session.setWorkspace(context, null); workspace = null }) else null,
        )
        workspace!!.kind == WorkspaceKind.INSTITUTION -> InstitutionScaffold(
            organizationId = workspace!!.organizationId ?: "",
            currentTheme = currentTheme,
            onThemeChange = onThemeChange,
            onSignOut = { Session.clear(context); workspace = null; signedIn = false },
            onSwitchWorkspace = if (multiWorkspace) ({ Session.setWorkspace(context, null); workspace = null }) else null,
        )
        workspace!!.kind == WorkspaceKind.EMPLOYER -> EmployerScaffold(
            organizationId = workspace!!.organizationId ?: "",
            currentTheme = currentTheme,
            onThemeChange = onThemeChange,
            onSignOut = { Session.clear(context); workspace = null; signedIn = false },
            onSwitchWorkspace = if (multiWorkspace) ({ Session.setWorkspace(context, null); workspace = null }) else null,
        )
        else -> MainScaffold(
            currentTheme = currentTheme,
            onThemeChange = onThemeChange,
            onSwitchWorkspace = if (multiWorkspace) ({ Session.setWorkspace(context, null); workspace = null }) else null,
            onSignOut = {
                Session.clear(context)
                workspace = null
                signedIn = false
            },
            onSessionExpired = {
                Session.clear(context)
                workspace = null
                sessionExpired = true
                signedIn = false
            },
        )
    }
}

/** Continues the system splash's look: black brand ground, the original
 *  silver wordmark, the 8 spinning in place while the app loads. */
@Composable
private fun BrandSplash() {
    Column(
        Modifier.fillMaxSize().background(Color(0xFF0B0C0F)),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        BrandWordmark(height = 46.dp, spinEight = true)
        Spacer(Modifier.height(18.dp))
        Text("ONE", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = Color(0xFFD9DCE1))
        Text("The campus-to-career workspace", style = MaterialTheme.typography.bodySmall, color = Color(0xFF8E939C))
    }
}

/** Demo accounts drive the web pilot's fictional showcase only — the app talks
 *  to the real API, so they would just see empty screens. Say so honestly. */
@Composable
private fun DemoAccountScreen(onSignOut: () -> Unit) {
    val palette = pro.ai8ht.one.ui.LocalOnePalette.current
    Column(Modifier.fillMaxSize().background(palette.bandBottom)) {
        BrandBand {
            Spacer(Modifier.height(20.dp))
            BrandWordmark(height = 24.dp, tint = palette.wordmarkTint)
            Spacer(Modifier.height(12.dp))
            Text("Demo account", style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold, color = palette.bandInk)
        }
        BandSheet {
            Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally) {
                IconBubble(Icons.Filled.AutoAwesome, Tone.Amber, size = 64.dp)
                Spacer(Modifier.height(16.dp))
                Text("This account showcases the web pilot", style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                Spacer(Modifier.height(6.dp))
                Text("Demo accounts present a guided, fictional walkthrough at one.ai8ht.pro on the web. " +
                    "The app shows real accounts with real data — sign in with your own account instead.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center)
                Spacer(Modifier.height(20.dp))
                Button(onClick = onSignOut, shape = RoundedCornerShape(10.dp)) { Text("Sign in with another account") }
            }
        }
    }
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun MainScaffold(
    currentTheme: String,
    onThemeChange: (String) -> Unit,
    onSignOut: () -> Unit,
    onSessionExpired: () -> Unit,
    onSwitchWorkspace: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val palette = pro.ai8ht.one.ui.LocalOnePalette.current
    var screen by remember { mutableStateOf(Screen.Home) }
    var data by remember { mutableStateOf<StudentData?>(null) }
    var loadError by remember { mutableStateOf(false) }
    var reloadKey by remember { mutableIntStateOf(0) }
    var showInbox by remember { mutableStateOf(false) }
    var showChat by remember { mutableStateOf(false) }
    var showEditProfile by remember { mutableStateOf(false) }
    var moreDest by remember { mutableStateOf<MoreDest?>(null) }
    var readinessOpen by remember { mutableStateOf(false) }
    // The student's institution is on the security context, not the student record: a
    // student can have several relationships over time, and the active one is what
    // scopes anything their college assigned them.
    var studentInstitutionId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        studentInstitutionId = runCatching { Api.securityContext(context) }.getOrNull()
            ?.studentRelationships?.firstOrNull { it.state == "ACTIVE" || it.state == "VERIFIED" }
            ?.institutionId
    }
    var showTheme by remember { mutableStateOf(false) }
    var avatarVersion by remember { mutableIntStateOf(0) }
    var refreshing by remember { mutableStateOf(false) }

    // Data now comes from a ViewModel over a cache-then-network repository, so a tab
    // switch or a rotation no longer throws everything away and re-fetches it. What the
    // screens below consume is unchanged; only where it comes from has moved.
    val studentVm: pro.ai8ht.one.data.StudentViewModel =
        androidx.lifecycle.viewmodel.compose.viewModel()
    LaunchedEffect(Unit) { studentVm.start() }
    LaunchedEffect(reloadKey) { if (reloadKey > 0) studentVm.refresh() }

    val studentState by studentVm.student.collectAsState()
    val assessmentsState by studentVm.assessments.collectAsState()
    val learnerState by studentVm.learner.collectAsState()
    val notificationsState by studentVm.notifications.collectAsState()
    val activityState by studentVm.activity.collectAsState()
    val sessionEnded by studentVm.sessionEnded.collectAsState()

    // An expired session returns to sign-in rather than sitting on a retry screen that
    // can never succeed. The cache goes with it: it belongs to the session that ended.
    LaunchedEffect(sessionEnded) {
        if (sessionEnded) {
            studentVm.clearOnSignOut()
            studentVm.acknowledgeSessionEnded()
            onSessionExpired()
        }
    }

    LaunchedEffect(studentState, assessmentsState, learnerState, notificationsState, activityState) {
        data = StudentData(
            student = studentState.valueOrNull(),
            assessments = assessmentsState.valueOrNull() ?: emptyList(),
            learner = learnerState.valueOrNull(),
            notifications = notificationsState.valueOrNull(),
            activity = activityState.valueOrNull(),
        )
        // Only an error when nothing at all resolved, cache included. A stale screen is
        // a working screen.
        loadError = studentState is pro.ai8ht.one.data.Repository.State.Failed &&
            learnerState is pro.ai8ht.one.data.Repository.State.Failed &&
            notificationsState is pro.ai8ht.one.data.Repository.State.Failed
        if (data?.student != null || data?.learner != null) refreshing = false
        if (loadError) refreshing = false
    }

    // System back closes the topmost overlay instead of quitting the app.
    androidx.activity.compose.BackHandler(
        enabled = showChat || showEditProfile || showInbox || showTheme || readinessOpen || moreDest != null,
    ) {
        when {
            showChat -> showChat = false
            showEditProfile -> showEditProfile = false
            showInbox -> showInbox = false
            showTheme -> showTheme = false
            readinessOpen -> readinessOpen = false
            else -> moreDest = null
        }
    }
    when {
        showTheme -> { SlideIn { ThemeOverlay(currentTheme, onThemeChange, onClose = { showTheme = false }) }; return }
        showChat -> { SlideIn { ChatOverlay(onClose = { showChat = false }) }; return }
        showEditProfile -> { SlideIn { EditProfileOverlay(onClose = { showEditProfile = false; reloadKey += 1 }) }; return }
        showInbox -> { SlideIn { InboxOverlay(data?.notifications, onClose = { showInbox = false }, onAllRead = { reloadKey += 1 }) }; return }
        moreDest == MoreDest.Profile -> {
            SlideIn {
                ProfilePage(data?.student, avatarVersion, onPhotoPicked = { avatarVersion += 1 },
                    onEdit = { showEditProfile = true }, onClose = { moreDest = null })
            }
            return
        }
        moreDest == MoreDest.Documents -> { SlideIn { DocumentsPage(onClose = { moreDest = null }) }; return }
        moreDest == MoreDest.Privacy -> { SlideIn { PrivacyPage(onClose = { moreDest = null }) }; return }
        moreDest == MoreDest.Calendar -> { SlideIn { CalendarPage(onClose = { moreDest = null }) }; return }
        moreDest == MoreDest.Screening -> { SlideIn { ScreeningPage(onClose = { moreDest = null }) }; return }
        moreDest == MoreDest.Resources -> { SlideIn { ResourcesPage(onClose = { moreDest = null }) }; return }
        moreDest == MoreDest.Share -> { SlideIn { ShareProfilePage(onClose = { moreDest = null }) }; return }
        moreDest == MoreDest.Career -> { SlideIn { CareerPage(data?.learner, onClose = { moreDest = null }) }; return }
        readinessOpen -> {
            SlideIn {
                ReadinessAssessmentPage(
                    onClose = { readinessOpen = false },
                    onSubmitted = { reloadKey += 1 },
                )
            }
            return
        }
        moreDest == MoreDest.Target -> { SlideIn { CareerTargetPage(onClose = { moreDest = null }) }; return }
        moreDest == MoreDest.Academics -> { SlideIn { AcademicRecordsPage(onClose = { moreDest = null }) }; return }
        moreDest == MoreDest.Support -> {
            SlideIn {
                SupportTasksPage(
                    institutionId = studentInstitutionId,
                    onClose = { moreDest = null },
                )
            }
            return
        }
        moreDest == MoreDest.Help -> { SlideIn { HelpFaqPage(persona = "student", onClose = { moreDest = null }) }; return }
        moreDest == MoreDest.Settings -> { SlideIn { SettingsPage(currentTheme = currentTheme, onThemeChange = onThemeChange, onClose = { moreDest = null }, onSignOut = onSignOut, onSwitchWorkspace = onSwitchWorkspace) }; return }
    }

    val unread = data?.notifications?.unreadCount ?: 0

    Scaffold(
        containerColor = palette.bandBottom,
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0, 0, 0, 0),
        floatingActionButton = {
            FloatingActionButton(
                onClick = { showChat = true },
                containerColor = palette.accent,
                contentColor = palette.onAccent,
                shape = CircleShape,
            ) { Icon(Icons.Filled.AutoAwesome, contentDescription = "ONE Assistant") }
        },
        bottomBar = {
            NavigationBar(containerColor = palette.navBg, windowInsets = NavigationBarDefaults.windowInsets) {
                val colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = palette.navSelected,
                    selectedTextColor = palette.navSelected,
                    indicatorColor = palette.accentSoft,
                    unselectedIconColor = palette.muted,
                    unselectedTextColor = palette.muted,
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
        BrandBand {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                BrandWordmark(height = 17.dp, tint = palette.wordmarkTint)
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { showTheme = true }) {
                    Icon(Icons.Filled.Palette, contentDescription = "Theme", tint = palette.bandMuted)
                }
                IconButton(onClick = { showInbox = true }) {
                    BadgedBox(badge = { if (unread > 0) Badge { Text("$unread") } }) {
                        Icon(Icons.Filled.Notifications, contentDescription = "Notifications", tint = palette.bandMuted)
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
            if (screen == Screen.Home) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            "Hi, " + (data?.student?.fullName?.split(" ")?.firstOrNull()
                                ?: Session.email(context)?.substringBefore("@")?.substringBefore(".")
                                    ?.replaceFirstChar { c -> c.uppercase() }
                                ?: "there"),
                            style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, color = palette.bandInk,
                        )
                        val line = listOfNotNull(data?.student?.program, data?.student?.batch).joinToString(" · ")
                        Text(
                            if (line.isNotBlank()) line else "Your placement-readiness workspace",
                            style = MaterialTheme.typography.bodyMedium, color = palette.bandMuted,
                        )
                    }
                    AvatarView(context, data?.student?.fullName, 46.dp, avatarVersion)
                    Spacer(Modifier.width(6.dp))
                }
                val bandChips = data?.learner?.readiness?.band
                val chipResults = data?.assessments?.mapNotNull { it.latestResult } ?: emptyList()
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    bandChips?.let { StatusChip("Readiness: " + prettify(it), ChipKind.OnDark) }
                    if (chipResults.isNotEmpty()) StatusChip("Avg " + chipResults.map { r -> r.percentage }.average().toInt() + "%", ChipKind.OnDark)
                }
            } else {
                Text(screen.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = palette.bandInk)
                Text(screen.subtitle, style = MaterialTheme.typography.bodySmall, color = palette.bandMuted)
            }
        }
        BandSheet {
        androidx.compose.material3.pulltorefresh.PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { refreshing = true; reloadKey += 1 },
            modifier = Modifier.fillMaxSize(),
        ) {
            when {
                data == null -> HomeSkeleton()
                loadError -> CenteredNote("Could not reach ONE right now. Check your connection and reopen the app.")
                else -> androidx.compose.animation.AnimatedContent(
                    targetState = screen,
                    transitionSpec = {
                        (androidx.compose.animation.fadeIn(androidx.compose.animation.core.tween(220)) +
                            androidx.compose.animation.slideInVertically(
                                animationSpec = androidx.compose.animation.core.tween(220),
                                initialOffsetY = { it / 24 },
                            ))
                            .togetherWith(androidx.compose.animation.fadeOut(androidx.compose.animation.core.tween(120)))
                    },
                    label = "tab-content",
                ) { current ->
                    Column(Modifier.fillMaxSize()) {
                        if (current == Screen.Home) Spacer(Modifier.height(2.dp))
                        when (current) {
                            Screen.Home -> PilotHomeScreen(
                                data!!,
                                activity = data!!.activity,
                                onOpen = { screen = it },
                                onInbox = { showInbox = true },
                                onChat = { showChat = true },
                                onSection = { moreDest = it },
                            )
                            Screen.Assessments -> AssessmentsScreen(
                                data!!.assessments,
                                onOpenReadiness = { readinessOpen = true },
                            )
                            Screen.Learning -> LearningScreen(data!!.learner, onChanged = { reloadKey += 1 }, onOpenCareer = { moreDest = MoreDest.Target })
                            Screen.Jobs -> JobsScreen()
                            Screen.More -> MoreMenuScreen(data!!.student, avatarVersion, onOpen = { moreDest = it }, onSignOut = onSignOut)
                        }
                    }
                }
            }
        }
        }
        }
    }
}

// --- Home ---------------------------------------------------------------------

@Composable
private fun HomeScreen(
    data: StudentData,
    onOpen: (Screen) -> Unit,
    onInbox: () -> Unit,
    onChat: () -> Unit,
    onSection: (MoreDest) -> Unit,
) {
    val palette = pro.ai8ht.one.ui.LocalOnePalette.current
    val now = Instant.now()
    val openExams = data.assessments.count { exam ->
        exam.latestResult == null && exam.attemptsUsed < exam.attemptsAllowed &&
            runCatching { now.isAfter(Instant.parse(exam.startsAt)) && now.isBefore(Instant.parse(exam.endsAt)) }.getOrDefault(false)
    }
    val lessons = data.learner?.catalog?.modules?.flatMap { it.lessons } ?: emptyList()
    val completed = data.learner?.progress?.count { it.state == "COMPLETED" } ?: 0
    val unread = data.notifications?.unreadCount ?: 0
    val results = data.assessments.mapNotNull { exam -> exam.latestResult?.let { exam to it } }
    val best = results.maxOfOrNull { it.second.percentage }
    val nextDeadline = data.assessments
        .filter { it.latestResult == null && runCatching { now.isBefore(Instant.parse(it.endsAt)) }.getOrDefault(false) }
        .minByOrNull { it.endsAt }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(12.dp))

        // Progress hero: ring + status + jump into learning.
        PilotCard(glow = true) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                ProgressRing(
                    progress = if (lessons.isEmpty()) 0f else completed.toFloat() / lessons.size,
                    center = "$completed/${lessons.size}",
                    caption = "LESSONS",
                )
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text("Career progress", style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        if (lessons.isNotEmpty() && completed == lessons.size) "All lessons completed"
                        else "Keep building your evidence",
                        style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(6.dp))
                    data.learner?.readiness?.band?.let { StatusChip("Readiness: " + prettify(it), ChipKind.Accent) }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "$openExams exams open · best " + (best?.let { "${it.toInt()}%" } ?: "—") + " · $unread unread",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = { onOpen(Screen.Learning) }) { Text("Open") }
            }
        }

        // Everything the student can do, one tap away.
        SectionTitle("Quick actions")
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            QuickTile(Icons.Filled.Assignment, Tone.Accent, "Exams", Modifier.weight(1f)) { onOpen(Screen.Assessments) }
            QuickTile(Icons.Filled.MenuBook, Tone.Green, "Learning", Modifier.weight(1f)) { onOpen(Screen.Learning) }
            QuickTile(Icons.Filled.WorkOutline, Tone.Violet, "Jobs", Modifier.weight(1f)) { onOpen(Screen.Jobs) }
            QuickTile(Icons.Filled.AutoAwesome, Tone.Amber, "Assistant", Modifier.weight(1f)) { onChat() }
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            QuickTile(Icons.Filled.Notifications, Tone.Amber, "Inbox", Modifier.weight(1f), badge = unread) { onInbox() }
            QuickTile(Icons.Filled.Person, Tone.Accent, "Profile", Modifier.weight(1f)) { onSection(MoreDest.Profile) }
            QuickTile(Icons.Filled.Description, Tone.Violet, "Documents", Modifier.weight(1f)) { onSection(MoreDest.Documents) }
            QuickTile(Icons.Filled.Insights, Tone.Green, "Readiness", Modifier.weight(1f)) { onSection(MoreDest.Career) }
        }

        nextDeadline?.let { exam ->
            SectionTitle("Next deadline")
            PilotCard(Modifier.clickable { onOpen(Screen.Assessments) }) {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconBubble(Icons.Filled.Assignment, Tone.Accent)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(exam.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Text("Closes ${formatWhen(exam.endsAt)} · ${exam.durationSeconds / 60} min · laptop only",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    StatusChip("Open", ChipKind.Accent)
                }
            }
        }

        // A visible way into the assistant, with real starter questions.
        SectionTitle("Ask ONE")
        PilotCard(Modifier.clickable { onChat() }) {
            Column(Modifier.padding(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconBubble(Icons.Filled.AutoAwesome, Tone.Amber)
                    Spacer(Modifier.width(10.dp))
                    Text("Stuck? Ask the assistant", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusChip("How do I take an assessment?", ChipKind.Muted)
                }
                Spacer(Modifier.height(6.dp))
                Row { StatusChip("Why can't I start my assessment?", ChipKind.Muted) }
            }
        }

        if (results.isNotEmpty()) {
            SectionTitle("Recent results", trailing = "View all", onTrailing = { onOpen(Screen.Assessments) })
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
                                color = if (result.percentage >= 50) palette.soft(Tone.Green).second else palette.soft(Tone.Amber).second,
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
            SectionTitle("Recent activity", trailing = "Inbox", onTrailing = onInbox)
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
private fun ProgressRing(progress: Float, center: String, caption: String) {
    val palette = pro.ai8ht.one.ui.LocalOnePalette.current
    Box(contentAlignment = Alignment.Center) {
        androidx.compose.material3.CircularProgressIndicator(
            progress = { progress.coerceIn(0f, 1f) },
            modifier = Modifier.size(72.dp),
            color = palette.accent,
            trackColor = if (palette.dark) Color(0x22FFFFFF) else Color(0xFFE7EBF3),
            strokeWidth = 7.dp,
        )
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(center, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            Text(caption, style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
internal fun QuickTile(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tone: Tone,
    label: String,
    modifier: Modifier = Modifier,
    badge: Int = 0,
    onClick: () -> Unit,
) {
    PilotCard(modifier.clickable(onClick = onClick)) {
        Column(
            Modifier.fillMaxWidth().padding(vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box {
                IconBubble(icon, tone, size = 34.dp)
                if (badge > 0) {
                    Box(
                        Modifier.size(15.dp).background(MaterialTheme.colorScheme.primary, CircleShape)
                            .padding(0.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("$badge", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Bold)
                    }
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(label, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        }
    }
}

// --- Assessments --------------------------------------------------------------

@Composable
private fun AssessmentsScreen(items: List<AssessmentDto>, onOpenReadiness: () -> Unit) {
    val bannerPalette = pro.ai8ht.one.ui.LocalOnePalette.current
    if (items.isEmpty()) {
        // Not an empty screen any more: institution exams may be absent while a
        // readiness check is still available, and those are two different things.
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(12.dp))
            ReadinessEntryCard(onOpenReadiness)
            EmptyState(Icons.Filled.Assignment, Tone.Accent,
                "No exams assigned yet",
                "Your placement cell assigns tests to you. They appear here with their windows, timers and results.")
        }
        return
    }
    val results = items.mapNotNull { it.latestResult }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        item { Spacer(Modifier.height(12.dp)); ReadinessEntryCard(onOpenReadiness) }
        if (items.any { it.openAttemptId != null }) {
            item {
                Spacer(Modifier.height(10.dp))
                val (warnBg, warnFg) = bannerPalette.soft(Tone.Amber)
                Surface(color = warnBg, contentColor = warnFg, shape = RoundedCornerShape(12.dp)) {
                    Text("You have an attempt in progress. Exams are laptop-only — continue right away at one.ai8ht.pro on a laptop; the timer keeps running.",
                        Modifier.padding(12.dp), style = MaterialTheme.typography.labelMedium)
                }
            }
        }
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
    val palette = pro.ai8ht.one.ui.LocalOnePalette.current
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
                        color = if (result.percentage >= 50) palette.soft(pro.ai8ht.one.ui.Tone.Green).second else palette.soft(pro.ai8ht.one.ui.Tone.Amber).second,
                        trackColor = MaterialTheme.colorScheme.surfaceVariant,
                    )
                    Spacer(Modifier.width(10.dp))
                    Text("${result.score.toInt()}/${result.maxScore.toInt()}",
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                }
            } else if (exam.openAttemptId != null) {
                Spacer(Modifier.height(8.dp))
                val (warnBg, warnFg) = palette.soft(Tone.Amber)
                Surface(color = warnBg, contentColor = warnFg, shape = RoundedCornerShape(10.dp)) {
                    Text("Attempt in progress — continue now on your LAPTOP at one.ai8ht.pro. The timer keeps running; exams cannot be taken on mobile.",
                        Modifier.padding(10.dp), style = MaterialTheme.typography.labelMedium)
                }
            } else if (ends != null && now.isBefore(ends)) {
                Spacer(Modifier.height(6.dp))
                Text("Open until ${formatWhen(exam.endsAt)} · exams are taken on a laptop at one.ai8ht.pro",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

// --- Learning -----------------------------------------------------------------

@Composable
private fun LearningScreen(learner: LearnerStateDto?, onChanged: () -> Unit, onOpenCareer: () -> Unit) {
    val context = LocalContext.current
    val palette = pro.ai8ht.one.ui.LocalOnePalette.current
    val scope = rememberCoroutineScope()
    var busyLesson by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }

    // ENG-18: the learning plan (placement test, next step and practice, path, due reviews) comes first,
    // whether or not any module is published.
    if (learner == null || learner.catalog.modules.isEmpty()) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            item { LearningPlanSection(onOpenCareer) }
            item {
                Spacer(Modifier.height(12.dp))
                PilotCard {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconBubble(Icons.Filled.MenuBook, pro.ai8ht.one.ui.Tone.Green, size = 44.dp)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text("No modules yet", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text("Learning modules appear here once your institution publishes them. Completed lessons build your readiness.",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                Spacer(Modifier.height(18.dp))
            }
        }
        return
    }
    val done = learner.progress.filter { it.state == "COMPLETED" }.map { it.lessonVersionId }.toSet()
    val allLessons = learner.catalog.modules.flatMap { it.lessons }
    val doneCount = allLessons.count { done.contains(it.id) }

    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        item { LearningPlanSection(onOpenCareer) }
        item {
            Spacer(Modifier.height(10.dp))
            PilotCard {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconBubble(Icons.Filled.MenuBook, pro.ai8ht.one.ui.Tone.Green, size = 44.dp)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Overall progress", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(6.dp))
                        LinearProgressIndicator(
                            progress = { if (allLessons.isEmpty()) 0f else doneCount.toFloat() / allLessons.size },
                            modifier = Modifier.fillMaxWidth(),
                            color = palette.soft(pro.ai8ht.one.ui.Tone.Green).second,
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
                val (warnBg, warnFg) = palette.soft(pro.ai8ht.one.ui.Tone.Amber)
                Surface(color = warnBg, contentColor = warnFg, shape = RoundedCornerShape(10.dp)) {
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
                                tint = if (isDone) palette.soft(pro.ai8ht.one.ui.Tone.Green).second else MaterialTheme.colorScheme.outline,
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
    OverlayScaffold(
        "Notifications",
        onClose,
        actions = {
            if ((feed?.unreadCount ?: 0) > 0) {
                TextButton(
                    onClick = { scope.launch { runCatching { Api.markAllRead(context) }.onSuccess { onAllRead(); onClose() } } },
                    colors = ButtonDefaults.textButtonColors(contentColor = pro.ai8ht.one.ui.LocalOnePalette.current.bandInk),
                ) { Text("Mark all read") }
            }
        },
    ) {
        when {
            feed == null || feed.notifications.isEmpty() ->
                EmptyState(Icons.Filled.Notifications, Tone.Amber,
                    "All caught up",
                    "Nothing needs your attention. College announcements, assignments, results, and news about your applications, interviews and offers land here the moment they happen.")
            else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
                // INST-06: college announcements get their own list, with who they are from.
                val announcements = feed.notifications.filter { it.kind == "ANNOUNCEMENT" }
                val others = feed.notifications.filter { it.kind != "ANNOUNCEMENT" }
                item { Spacer(Modifier.height(10.dp)) }
                if (announcements.isNotEmpty()) {
                    item { Text("Announcements", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(vertical = 6.dp)) }
                    items(announcements, key = { it.id }) { note ->
                        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                            Box(Modifier.width(3.dp).fillMaxHeight()
                                .background(if (note.readAt == null) MaterialTheme.colorScheme.primary else Color.Transparent))
                            Column(Modifier.padding(start = 13.dp, end = 16.dp, top = 10.dp, bottom = 10.dp)) {
                                Text(note.title, style = MaterialTheme.typography.titleSmall,
                                    fontWeight = if (note.readAt == null) FontWeight.Bold else FontWeight.Normal)
                                Spacer(Modifier.height(2.dp))
                                Text(note.body, style = MaterialTheme.typography.bodySmall)
                                Spacer(Modifier.height(2.dp))
                                Text(note.announcementSource(), style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                    }
                    if (others.isNotEmpty()) item { Text("Other notifications", style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 14.dp, bottom = 6.dp)) }
                }
                items(others, key = { it.id }) { note ->
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

// --- Sign in / consent ---------------------------------------------------------

@Composable
private fun SignInScreen(
    expired: Boolean = false,
    oauthRedirect: android.net.Uri? = null,
    onRedirectHandled: () -> Unit = {},
    onSignedIn: () -> Unit,
) {
    val redirectContext = LocalContext.current
    var redirectError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(oauthRedirect) {
        val uri = oauthRedirect ?: return@LaunchedEffect
        runCatching { OAuth.complete(redirectContext, uri) }
            .onSuccess { if (it) onSignedIn() }
            .onFailure { redirectError = it.message ?: "Sign-in did not complete." }
        onRedirectHandled()
    }
    val context = LocalContext.current
    val signPalette = pro.ai8ht.one.ui.LocalOnePalette.current
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var apiOverride by remember { mutableStateOf(Session.apiOverride(context)) }
    var showAdvanced by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(Modifier.fillMaxSize().background(signPalette.bandBottom)) {
        BrandBand {
            Spacer(Modifier.height(34.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                BrandWordmark(height = 40.dp, spinEight = true, tint = signPalette.wordmarkTint)
            }
            Spacer(Modifier.height(12.dp))
            Text(
                "The campus-to-career workspace",
                Modifier.fillMaxWidth(),
                style = MaterialTheme.typography.bodyMedium,
                color = signPalette.bandMuted,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(10.dp))
        }
        BandSheet {
        Column(Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState())) {
        Spacer(Modifier.height(8.dp))
        PilotCard {
            Column(Modifier.padding(20.dp)) {
                Text("Sign in", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                if (expired) {
                    Spacer(Modifier.height(6.dp))
                    Surface(color = Color(0xFFFDF6E0), contentColor = Color(0xFF8A6400), shape = RoundedCornerShape(8.dp)) {
                        Text("Your session expired — sign in again to continue.",
                            Modifier.padding(8.dp), style = MaterialTheme.typography.bodySmall)
                    }
                }
                Spacer(Modifier.height(12.dp))
                val fieldColors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = MaterialTheme.colorScheme.primary,
                    unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                )
                OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Email") },
                    modifier = Modifier.fillMaxWidth(), singleLine = true, shape = RoundedCornerShape(10.dp), colors = fieldColors)
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("Password") },
                    modifier = Modifier.fillMaxWidth(), singleLine = true,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = androidx.compose.ui.text.input.KeyboardType.Password),
                    shape = RoundedCornerShape(10.dp), colors = fieldColors)
                (error ?: redirectError)?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                // Hosted sign-in, shown only once an operator has registered the mobile
                // app client. It is the only path that can complete an MFA challenge, so
                // it is offered first and password sign-in becomes the fallback.
                if (OAuth.isConfigured()) {
                    Spacer(Modifier.height(14.dp))
                    Button(
                        onClick = {
                            error = null
                            runCatching { OAuth.begin(context) }
                                .onFailure { error = it.message ?: "Could not start sign-in." }
                        },
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                    ) { Text("Sign in securely") }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Opens your browser so two-factor sign-in works.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(14.dp))
                Button(
                    onClick = {
                        busy = true; error = null
                        scope.launch {
                            runCatching { Api.passwordSignIn(context, email, password) }
                                .onSuccess { busy = false; onSignedIn() }
                                .onFailure {
                                    busy = false
                                    error = (it as? Api.SignInException)?.message ?: "Sign-in failed. Try again."
                                }
                        }
                    },
                    enabled = !busy && email.isNotBlank() && password.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
                ) { Text(if (busy) "Signing in…" else "Sign in") }

                Spacer(Modifier.height(10.dp))
                TextButton(onClick = { showAdvanced = !showAdvanced }) {
                    Text(if (showAdvanced) "Hide UAT options" else "UAT options (token sign-in)")
                }
                if (showAdvanced) {
                    OutlinedTextField(value = token, onValueChange = { token = it }, label = { Text("Access token (UAT)") },
                        modifier = Modifier.fillMaxWidth(), minLines = 3, shape = RoundedCornerShape(10.dp), colors = fieldColors)
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(value = apiOverride, onValueChange = { apiOverride = it },
                        label = { Text("API base URL (blank = production)") },
                        modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), colors = fieldColors)
                    Spacer(Modifier.height(10.dp))
                    OutlinedButton(
                        onClick = {
                            Session.setApiOverride(context, apiOverride)
                            Session.setToken(context, token)
                            onSignedIn()
                        },
                        enabled = token.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                    ) { Text("Continue with token") }
                }
            }
        }
        }
        }
    }
}

@Composable
private fun ConsentUnavailableScreen(onRetry: () -> Unit) {
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(20.dp).verticalScroll(rememberScrollState())) {
        Spacer(Modifier.height(24.dp))
        BrandWordmark(height = 22.dp)
        Spacer(Modifier.height(20.dp))
        Text("We could not confirm your privacy consent", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text("ONE will not open your workspace until it can confirm your consent is on record. This is usually a temporary connection problem.",
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(16.dp))
        Button(onClick = onRetry, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp)) { Text("Try again") }
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

/**
 * Entry point to the readiness check.
 *
 * Kept visually distinct from institution exams because they are not the same thing:
 * exams are assigned, timed and laptop-only; this is a short self-service check that
 * moves the advisory band.
 */
@Composable
private fun ReadinessEntryCard(onOpen: () -> Unit) {
    PilotCard {
        Row(
            Modifier.fillMaxWidth().clickable { onOpen() }.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconBubble(Icons.Filled.Assignment, Tone.Green)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text("Readiness check", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Text("A few questions, right here on your phone",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
        }
    }
}
