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
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
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
import pro.ai8ht.one.ui.BrandWordmark

// --- Jobs: opportunities + my applications ------------------------------------

@Composable
internal fun JobsScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var tab by remember { mutableIntStateOf(0) }
    var opportunities by remember { mutableStateOf<List<OpportunityDto>?>(null) }
    var applications by remember { mutableStateOf<List<ApplicationDto>?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        opportunities = runCatching { Api.listOpportunities(context) }.getOrNull()
        applications = runCatching { Api.listApplications(context) }.getOrNull()
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
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
                    "When employers post opportunities for your institution, they appear here with one-tap apply.")
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(opportunities!!, key = { it.id }) { opp ->
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Row(verticalAlignment = Alignment.Top) {
                                    Column(Modifier.weight(1f)) {
                                        Text(opp.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                        Text(opp.employerName, style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
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
                                if (!opp.alreadyApplied) {
                                    Spacer(Modifier.height(10.dp))
                                    Button(
                                        onClick = {
                                            notice = null
                                            scope.launch {
                                                runCatching { Api.applyToOpportunity(context, opp.id) }
                                                    .onSuccess { notice = "Application submitted for ${opp.title}."; reload += 1 }
                                                    .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not apply just now. Try again." }
                                            }
                                        },
                                        shape = RoundedCornerShape(10.dp),
                                    ) { Text("Apply") }
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
                applications!!.isEmpty() -> EmptyState(
                    androidx.compose.material.icons.Icons.Filled.WorkOutline, pro.ai8ht.one.ui.Tone.Violet,
                    "No applications yet",
                    "Apply to an opportunity and every stage — submitted, shortlisted, offered — is tracked here.")
                else -> LazyColumn(Modifier.fillMaxSize()) {
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
                            }
                        }
                    }
                    item { Spacer(Modifier.height(18.dp)) }
                }
            }
        }
    }
}

// --- ONE Assistant chat --------------------------------------------------------

internal data class ChatMessage(val role: String, val content: String)

@Composable
internal fun ChatOverlay(onClose: () -> Unit) {
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
                Api.assistantChat(context, history.map { it.role to it.content }) { delta ->
                    messages = messages.dropLast(1) + messages.last().copy(content = messages.last().content + delta)
                }
            }.onFailure {
                messages = messages.dropLast(1) +
                    ChatMessage("assistant", "The assistant could not answer just now. Please try again in a moment.")
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
    Profile("Profile"), Career("Career readiness"), Documents("Documents"),
    Privacy("Privacy & data"), Settings("Settings"),
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
                MenuRow(Icons.Filled.Insights, pro.ai8ht.one.ui.Tone.Green, "Career readiness",
                    "Your advisory band and roadmap") { onOpen(MoreDest.Career) }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                MenuRow(Icons.Filled.Description, pro.ai8ht.one.ui.Tone.Violet, "Documents",
                    "Résumés, certificates and verification") { onOpen(MoreDest.Documents) }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                MenuRow(Icons.Filled.Lock, pro.ai8ht.one.ui.Tone.Amber, "Privacy & data",
                    "Your data copy and consent") { onOpen(MoreDest.Privacy) }
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
    LaunchedEffect(Unit) { profile = runCatching { Api.getProfile(context) }.getOrNull() }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            runCatching {
                context.contentResolver.openInputStream(uri)?.use { input ->
                    ProfilePhoto.save(context, input.readBytes())
                }
            }
            onPhotoPicked()
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
    LaunchedEffect(Unit) { documents = runCatching { Api.listDocuments(context) }.getOrDefault(emptyList()) }
    OverlayScaffold("Documents", onClose) {
        when {
            documents == null -> LoadingSpinner()
            documents!!.isEmpty() -> CenteredNote("No documents yet. Upload résumés and certificates from the web app at one.ai8ht.pro.")
            else -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
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
                                StatusChip(prettify(doc.verificationState),
                                    if (doc.verificationState == "VERIFIED") ChipKind.Positive else ChipKind.Muted)
                            }
                            if (index != documents!!.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text("Uploads happen on the web app; verified documents strengthen your profile.",
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
internal fun SettingsPage(currentTheme: String, onThemeChange: (String) -> Unit, onClose: () -> Unit, onSignOut: () -> Unit) {
    OverlayScaffold("Settings", onClose) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text("Theme", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(2.dp))
                    Text("Pick the world ONE lives in on this device.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(12.dp))
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
            }
            Spacer(Modifier.height(12.dp))
            PilotCard {
                Column(Modifier.padding(18.dp)) {
                    BrandWordmark(height = 22.dp, tint = if (pro.ai8ht.one.ui.LocalOnePalette.current.dark) null else pro.ai8ht.one.ui.LocalOnePalette.current.ink)
                    Spacer(Modifier.height(8.dp))
                    Text("ONE by AI8HT", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    Text("Version ${BuildConfig.VERSION_NAME} · one.ai8ht.pro",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(12.dp))
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text("On the web, not yet in the app", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(6.dp))
                    Text("Exam taking (with its timer and integrity checks), document upload, data-copy download and account erasure live at one.ai8ht.pro. Push notifications arrive in the next version.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(14.dp))
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
