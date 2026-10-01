package pro.ai8ht.one

// The Growth workspace on the phone (GROWTH-01, ADR-040). Growth field staff work on phones
// (decision D5), so the app recognises the two growth roles and opens this home: the AI8HT
// wordmark on the brand band, the person's own role, teams and staff type from
// GET /api/v1/growth/me, and NA in every figure slot whose source is not built yet. Nothing is
// invented: no lead, visit, target or amount appears until a later growth goal builds its source.
//
// GROWTH-02: a read-only "My territory" tab — the regions the person works today, as operations
// set them, with their states or districts and people (GET /api/v1/growth/territory). Territory
// set-up is desk work for operators and stays off the phone (design §14.1).
//
// GROWTH-03: a Leads tab (GrowthLeads.kt) and real counts in the Open leads and Unowned slots.
//
// GROWTH-06: a Field tab (GrowthField.kt) — follow-ups due, recent work, and what is still waiting
// to be sent — real "Visits this month" and a Today card on Home, the offline queue sent whenever
// the network returns, and a sign-out that warns about unsent work and then clears the cache, the
// queue and the reminders from the phone.

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CurrencyRupee
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.Handshake
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Map
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.School
import androidx.compose.material.icons.filled.WorkOutline
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.TextButton
import androidx.compose.material.icons.filled.EventNote
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarDefaults
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
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
import kotlinx.coroutines.launch
import pro.ai8ht.one.data.Store
import pro.ai8ht.one.ui.LocalOnePalette
import pro.ai8ht.one.ui.Tone

private const val GROWTH_NA = "NA"

private fun growthTeamLabel(team: String): String = when (team) {
    "COLLEGE_PARTNERSHIPS" -> "College partnerships"
    "EMPLOYER_PARTNERSHIPS" -> "Employer partnerships"
    else -> prettify(team)
}

private fun growthRoleLabel(role: String): String = when (role.uppercase()) {
    "GROWTH_MANAGER" -> "Regional manager"
    "GROWTH_EXECUTIVE" -> "Growth executive"
    else -> prettify(role)
}

private fun growthStaffTypeLabel(type: String?): String = when (type) {
    "EMPLOYEE" -> "Employee"
    "CONTRACTOR" -> "Contractor"
    null -> "Staff type not set"
    else -> prettify(type)
}

@Composable
internal fun GrowthScaffold(
    role: String,
    currentTheme: String,
    onThemeChange: (String) -> Unit,
    onSignOut: () -> Unit,
    onSwitchWorkspace: (() -> Unit)?,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val palette = LocalOnePalette.current
    var tab by remember { mutableStateOf(0) }
    var me by remember { mutableStateOf<GrowthMeDto?>(null) }
    var meFailed by remember { mutableStateOf(false) }
    var inbox by remember { mutableStateOf<NotificationsEnvelope?>(null) }
    var showInboxOv by remember { mutableStateOf(false) }
    var showThemeOv by remember { mutableStateOf(false) }
    var openLead by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // GROWTH-06: load the offline queue and send it now, and again whenever a network appears.
    LaunchedEffect(Unit) { GrowthQueue.load(context); GrowthQueue.flush(context) }
    DisposableEffect(Unit) {
        val connectivity = context.getSystemService(android.net.ConnectivityManager::class.java)
        val callback = object : android.net.ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: android.net.Network) { scope.launch { GrowthQueue.flush(context) } }
        }
        val registered = runCatching { connectivity?.registerDefaultNetworkCallback(callback) }.isSuccess
        onDispose { if (registered) runCatching { connectivity?.unregisterNetworkCallback(callback) } }
    }

    LaunchedEffect(Unit) {
        coroutineScope {
            val m = async { runCatching { Api.growthMe(context) } }
            val n = async { runCatching { Api.listNotifications(context) }.getOrNull() }
            val result = m.await()
            me = result.getOrNull(); meFailed = result.isFailure; inbox = n.await()
        }
    }

    androidx.activity.compose.BackHandler(enabled = showInboxOv || showThemeOv) {
        if (showThemeOv) showThemeOv = false else showInboxOv = false
    }
    when {
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
                    icon = { Icon(Icons.Filled.Home, null) }, label = { Text("Home") }, colors = colors)
                NavigationBarItem(selected = tab == 1, onClick = { tab = 1 },
                    icon = { Icon(Icons.Filled.Handshake, null) }, label = { Text("Leads") }, colors = colors)
                NavigationBarItem(selected = tab == 4, onClick = { tab = 4 },
                    icon = { Icon(Icons.Filled.EventNote, null) }, label = { Text("Field") }, colors = colors)
                NavigationBarItem(selected = tab == 2, onClick = { tab = 2 },
                    icon = { Icon(Icons.Filled.Map, null) }, label = { Text("Territory") }, colors = colors)
                NavigationBarItem(selected = tab == 3, onClick = { tab = 3 },
                    icon = { Icon(Icons.Filled.MoreHoriz, null) }, label = { Text("More") }, colors = colors)
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            BrandBand {
                StaffBandHeader(
                    title = when (tab) { 0 -> "Growth"; 1 -> "Leads"; 2 -> "My territory"; 4 -> "Field"; else -> "More" },
                    subtitle = when (tab) {
                        0 -> "${growthRoleLabel(me?.role ?: role)} · partnerships"
                        1 -> "Your leads and your regions' unowned leads"
                        4 -> "Follow-ups due and your recent field work"
                        2 -> "Regions set by operations"
                        else -> "Workspace and app settings"
                    },
                    unread = inbox?.unreadCount ?: 0,
                    onTheme = { showThemeOv = true },
                    onBell = { showInboxOv = true },
                )
            }
            BandSheet {
                when {
                    tab == 3 -> GrowthMore(onSignOut, onSwitchWorkspace)
                    tab == 4 -> GrowthFieldTab(onOpenLead = { id -> openLead = id; tab = 1 })
                    tab == 2 -> GrowthTerritory()
                    tab == 1 -> GrowthLeadsTab(initialLead = openLead, onInitialLeadShown = { openLead = null })
                    meFailed -> CenteredNote("Your growth details could not be loaded. Nothing is shown until they load. Try again shortly.")
                    me == null -> HomeSkeleton()
                    else -> GrowthHome(me!!, onOpenField = { tab = 4 })
                }
            }
        }
    }
}

@Composable
private fun GrowthHome(me: GrowthMeDto, onOpenField: () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(10.dp))
        PilotCard(glow = true) {
            Column(Modifier.padding(14.dp)) {
                Text("Your partnerships workspace", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusChip(growthRoleLabel(me.role), ChipKind.Accent)
                    StatusChip(growthStaffTypeLabel(me.staffType), ChipKind.Muted)
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        // Every figure reads NA until its source exists: nothing here is invented.
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell(me.openLeads?.toString() ?: GROWTH_NA, "Open leads", Tone.Accent, Icons.Filled.Handshake, Modifier.weight(1f))
            StatCell(me.visitsThisMonth?.toString() ?: GROWTH_NA, "Visits this month", Tone.Green, Icons.Filled.CalendarMonth, Modifier.weight(1f))
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell(GROWTH_NA, "Target progress", Tone.Amber, Icons.Filled.Flag, Modifier.weight(1f))
            StatCell(GROWTH_NA, "Commission this month", Tone.Violet, Icons.Filled.CurrencyRupee, Modifier.weight(1f))
        }
        Spacer(Modifier.height(12.dp))
        GrowthTodayCard(me.followUpsDue, onOpenField)
        Spacer(Modifier.height(10.dp))
        GrowthQueueCard()
        SectionTitle("Your teams")
        if (me.teams.isEmpty()) {
            PilotCard {
                Text("You are not on a team yet. Operations sets your team in Settings.", Modifier.padding(16.dp),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            me.teams.forEach { team ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconBubble(
                            if (team.team == "COLLEGE_PARTNERSHIPS") Icons.Filled.School else Icons.Filled.WorkOutline,
                            if (team.team == "COLLEGE_PARTNERSHIPS") Tone.Green else Tone.Violet, size = 32.dp,
                        )
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(growthTeamLabel(team.team), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text(team.manager?.let { "Manager: ${it.email}" } ?: "No manager recorded",
                                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
        SectionTitle("Coming next")
        PilotCard {
            Column(Modifier.padding(16.dp)) {
                Text("Not built yet", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Text("Targets and commission are not built yet. Each appears here when it is, and every figure above reads NA until it has a real source. Commission rates have not been set, so no amount is shown.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun GrowthMore(onSignOut: () -> Unit, onSwitchWorkspace: (() -> Unit)?) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var confirming by remember { mutableStateOf(false) }
    // GROWTH-06 (design §14.2): a shared or lost phone must not keep contacts or unsent work, so
    // sign-out clears the cache, the queue and the reminders — after saying what would be lost.
    fun signOut() {
        scope.launch {
            GrowthQueue.clear(context)
            Store(context.applicationContext).clear()
            GrowthReminders.clearForSignOut(context)
            onSignOut()
        }
    }
    if (confirming) {
        val unsent = GrowthQueue.unsentCount()
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Unsent work will be deleted") },
            text = { Text("$unsent item${if (unsent == 1) " has" else "s have"} not been sent yet. Signing out deletes ${if (unsent == 1) "it" else "them"} from this phone. Stay signed in and send them when you have a signal, or sign out anyway.") },
            confirmButton = { TextButton(onClick = { confirming = false; signOut() }) { Text("Sign out and delete") } },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("Stay signed in") } },
        )
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
        PilotCard {
            Column(Modifier.padding(16.dp)) {
                Text("Growth on the phone", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Text("Your team, manager and staff type are set by AI8HT operations. Work you log here is kept on this phone, encrypted, until it is sent; signing out deletes it, and the saved copies of your leads, from the phone.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(12.dp))
        GrowthQueueCard()
        if (onSwitchWorkspace != null) {
            OutlinedButton(onClick = onSwitchWorkspace) { Text("Switch workspace") }
            Spacer(Modifier.height(8.dp))
        }
        OutlinedButton(onClick = { if (GrowthQueue.unsentCount() > 0) confirming = true else signOut() }) { Text("Sign out") }
    }
}

private fun growthAreaLabel(area: GrowthAreaDto): String =
    if (area.districtName != null) "${area.districtName}, ${area.stateName}" else "${area.stateName} (whole state)"

/** GROWTH-02: "My territory", read-only. Unowned leads read NA until the lead register exists. */
@Composable
private fun GrowthTerritory() {
    val context = androidx.compose.ui.platform.LocalContext.current
    var territory by remember { mutableStateOf<GrowthTerritoryDto?>(null) }
    var failed by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        val result = runCatching { Api.growthTerritory(context) }
        territory = result.getOrNull(); failed = result.isFailure
    }
    when {
        failed -> { CenteredNote("Your territory could not be loaded. Nothing is shown until it loads. Try again shortly."); return }
        territory == null -> { HomeSkeleton(); return }
    }
    val data = territory!!
    val managing = data.regions.any { it.myRole == "MANAGER" }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell(data.regions.size.toString(), "Regions you work", Tone.Accent, Icons.Filled.Map, Modifier.weight(1f))
            StatCell(data.regions.sumOf { it.areas.size }.toString(), "Areas covered", Tone.Green, Icons.Filled.Place, Modifier.weight(1f))
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell(data.regions.flatMap { r -> r.people.map { it.email } }.toSet().size.toString(),
                if (managing) "People in your regions" else "Managers in your regions", Tone.Amber, Icons.Filled.Groups, Modifier.weight(1f))
            // GROWTH-03: open, unowned, contactable leads in the regions worked; NA from a server that does not say.
            val unowned = if (data.regions.all { it.unownedLeads != null }) data.regions.sumOf { it.unownedLeads ?: 0 }.toString() else GROWTH_NA
            StatCell(unowned, "Unowned leads", Tone.Violet, Icons.Filled.Handshake, Modifier.weight(1f))
        }
        if (data.regions.isEmpty()) {
            SectionTitle("Your regions")
            PilotCard {
                Text("You are not assigned to a region yet. Operations assigns regions. You always see your own leads; unowned leads appear once you have a region.",
                    Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        data.regions.forEach { region ->
            SectionTitle(region.name, trailing = (if (region.myRole == "MANAGER") "You manage" else "You work") +
                (region.unownedLeads?.let { " · $it unowned" } ?: ""))
            PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                Column(Modifier.padding(14.dp)) {
                    Text("Areas", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(6.dp))
                    if (region.areas.isEmpty()) {
                        Text("No areas yet — operations has not added a state or district.", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        region.areas.forEach { area ->
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
                                IconBubble(Icons.Filled.Place, Tone.Green, size = 24.dp)
                                Spacer(Modifier.width(8.dp))
                                Text(growthAreaLabel(area), style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    Text(if (region.myRole == "MANAGER") "People" else "Managers", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(6.dp))
                    if (region.people.isEmpty()) {
                        Text(if (region.myRole == "MANAGER") "Nobody else is assigned to this region." else "No manager is assigned to this region yet.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        region.people.forEach { person ->
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
                                StatusChip(if (person.role == "MANAGER") "Manager" else "Executive", if (person.role == "MANAGER") ChipKind.Accent else ChipKind.Muted)
                                Spacer(Modifier.width(8.dp))
                                Text(person.email, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(20.dp))
    }
}
