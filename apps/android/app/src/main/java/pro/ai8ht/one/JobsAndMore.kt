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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
                opportunities!!.isEmpty() -> CenteredNote("No open opportunities right now. New roles from employers appear here.")
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
                applications!!.isEmpty() -> CenteredNote("No applications yet. Apply to an opportunity and track it here.")
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

// --- More: profile, documents, privacy ----------------------------------------

@Composable
internal fun MoreScreenFull(student: StudentDto?, onSignOut: () -> Unit, onEditProfile: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var profile by remember { mutableStateOf<ProfileDto?>(null) }
    var documents by remember { mutableStateOf<List<DocumentDto>>(emptyList()) }
    var requests by remember { mutableStateOf<List<PrivacyRequestDto>>(emptyList()) }
    var privacyNotice by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        profile = runCatching { Api.getProfile(context) }.getOrNull()
        documents = runCatching { Api.listDocuments(context) }.getOrDefault(emptyList())
        requests = runCatching { Api.privacyRequests(context) }.getOrDefault(emptyList())
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
        // Identity + headline
        PilotCard {
            Column(Modifier.padding(18.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(52.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
                        contentAlignment = Alignment.Center) {
                        val initials = (student?.fullName ?: "S").split(" ").take(2)
                            .mapNotNull { it.firstOrNull()?.uppercase() }.joinToString("")
                        Text(initials, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onPrimaryContainer)
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(student?.fullName ?: "Student", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text(student?.verifiedEmail ?: "", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    TextButton(onClick = onEditProfile) { Text("Edit") }
                }
                profile?.profileHeadline?.takeIf { it.isNotBlank() }?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                }
                profile?.profileSummary?.takeIf { it.isNotBlank() }?.let {
                    Spacer(Modifier.height(4.dp))
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(Modifier.height(12.dp))
                val rows = listOfNotNull(
                    profile?.targetCareer?.takeIf { it.isNotBlank() }?.let { "Target career" to it },
                    student?.program?.let { "Program" to it },
                    student?.department?.let { "Department" to it },
                    student?.batch?.let { "Batch" to it },
                    student?.institutionStudentId?.takeIf { it.isNotBlank() }?.let { "Student ID" to it },
                )
                rows.forEach { (label, value) ->
                    Row(Modifier.padding(vertical = 3.dp)) {
                        Text(label, Modifier.width(110.dp), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(value, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                    }
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (student?.academicStatus?.isNotBlank() == true) StatusChip(prettify(student.academicStatus), ChipKind.Accent)
                    profile?.let { StatusChip("Profile: ${prettify(it.visibilityState)}", ChipKind.Muted) }
                }
            }
        }

        // Documents
        SectionTitle("Documents")
        PilotCard {
            Column(Modifier.padding(vertical = 4.dp)) {
                if (documents.isEmpty()) {
                    Text("No documents yet. Upload résumés and certificates from the web app.",
                        Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    documents.forEachIndexed { index, doc ->
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(doc.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                Text(prettify(doc.documentType), style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            StatusChip(prettify(doc.verificationState),
                                if (doc.verificationState == "VERIFIED") ChipKind.Positive else ChipKind.Muted)
                        }
                        if (index != documents.lastIndex) HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                    }
                }
            }
        }

        // Privacy
        SectionTitle("Privacy & data")
        PilotCard {
            Column(Modifier.padding(16.dp)) {
                Text("Request a copy of your personal data. You'll download it from the web app once it's ready.",
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
                privacyNotice?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                }
                Spacer(Modifier.height(10.dp))
                OutlinedButton(
                    onClick = {
                        privacyNotice = null
                        scope.launch {
                            runCatching { Api.requestDataExport(context) }
                                .onSuccess { privacyNotice = "Export requested — it appears above once processed."; reload += 1 }
                                .onFailure { privacyNotice = (it as? Api.ApiException)?.detail ?: "Could not request the export just now." }
                        }
                    },
                    shape = RoundedCornerShape(10.dp),
                ) { Text("Request data copy") }
            }
        }

        Spacer(Modifier.height(12.dp))
        PilotCard {
            Column(Modifier.padding(18.dp)) {
                BrandWordmark(height = 20.dp)
                Spacer(Modifier.height(8.dp))
                Text("Version ${BuildConfig.VERSION_NAME} · one.ai8ht.pro",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = onSignOut, shape = RoundedCornerShape(10.dp)) { Text("Sign out") }
            }
        }
        Spacer(Modifier.height(20.dp))
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
