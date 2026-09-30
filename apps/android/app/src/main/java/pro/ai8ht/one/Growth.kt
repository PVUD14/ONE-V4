package pro.ai8ht.one

// The Growth workspace on the phone (GROWTH-01, ADR-040). Growth field staff work on phones
// (decision D5), so the app recognises the two growth roles and opens this home: the AI8HT
// wordmark on the brand band, the person's own role, teams and staff type from
// GET /api/v1/growth/me, and NA in every figure slot whose source is not built yet. Nothing is
// invented: no lead, visit, target or amount appears until a later growth goal builds its source.

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
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.School
import androidx.compose.material.icons.filled.WorkOutline
import androidx.compose.material3.Icon
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
                    icon = { Icon(Icons.Filled.MoreHoriz, null) }, label = { Text("More") }, colors = colors)
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            BrandBand {
                StaffBandHeader(
                    title = if (tab == 0) "Growth" else "More",
                    subtitle = if (tab == 0) "${growthRoleLabel(me?.role ?: role)} · partnerships" else "Workspace and app settings",
                    unread = inbox?.unreadCount ?: 0,
                    onTheme = { showThemeOv = true },
                    onBell = { showInboxOv = true },
                )
            }
            BandSheet {
                when {
                    tab == 1 -> GrowthMore(onSignOut, onSwitchWorkspace)
                    meFailed -> CenteredNote("Your growth details could not be loaded. Nothing is shown until they load. Try again shortly.")
                    me == null -> HomeSkeleton()
                    else -> GrowthHome(me!!)
                }
            }
        }
    }
}

@Composable
private fun GrowthHome(me: GrowthMeDto) {
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
            StatCell(GROWTH_NA, "Open leads", Tone.Accent, Icons.Filled.Handshake, Modifier.weight(1f))
            StatCell(GROWTH_NA, "Visits this month", Tone.Green, Icons.Filled.CalendarMonth, Modifier.weight(1f))
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell(GROWTH_NA, "Target progress", Tone.Amber, Icons.Filled.Flag, Modifier.weight(1f))
            StatCell(GROWTH_NA, "Commission this month", Tone.Violet, Icons.Filled.CurrencyRupee, Modifier.weight(1f))
        }
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
                Text("Leads, field visits, territory, targets and commission are not built yet. Each appears here when it is, and every figure above reads NA until it has a real source. Commission rates have not been set, so no amount is shown.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun GrowthMore(onSignOut: () -> Unit, onSwitchWorkspace: (() -> Unit)?) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
        PilotCard {
            Column(Modifier.padding(16.dp)) {
                Text("Growth on the phone", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Text("Your team, manager and staff type are set by AI8HT operations. Field visits and leads arrive in this app as they are built.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(12.dp))
        if (onSwitchWorkspace != null) {
            OutlinedButton(onClick = onSwitchWorkspace) { Text("Switch workspace") }
            Spacer(Modifier.height(8.dp))
        }
        OutlinedButton(onClick = onSignOut) { Text("Sign out") }
    }
}
