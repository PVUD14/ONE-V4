package pro.ai8ht.one

import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.School
import androidx.compose.material.icons.filled.TrackChanges
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import pro.ai8ht.one.ui.Tone

/**
 * Career targets, support tasks and academic records.
 *
 * The academic page is the one that matters most: an employer's CGPA rule resolves
 * against a verified term, and until a student declares their results and their
 * institution verifies them, every such role reads "we cannot tell yet".
 */

// ---------------------------------------------------------------------------
// Career target and the gap against it
// ---------------------------------------------------------------------------

@Composable
internal fun CareerTargetPage(onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var targets by remember { mutableStateOf<Load<List<CareerTargetDto>>>(Load.Loading) }
    var catalog by remember { mutableStateOf<List<CareerRoleDto>>(emptyList()) }
    var choosing by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(reload) {
        targets = loadOf { Api.careerTargets(context) }
        // The catalogue failing is not on its own worth a failure screen: the page can
        // still show a target that loaded. Its absence only becomes visible when the
        // student tries to choose, and the empty picker says so there.
        catalog = runCatching { Api.careerRoleCatalog(context) }.getOrNull() ?: emptyList()
    }

    OverlayScaffold(
        title = "Career target",
        onClose = onClose,
        actions = {
            if ((targets as? Load.Ready)?.value?.isNotEmpty() == true) {
                TextButton(onClick = { choosing = !choosing }) { Text(if (choosing) "Cancel" else "Change") }
            }
        },
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            notice?.let {
                Spacer(Modifier.height(10.dp))
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                    Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
            val loaded = targets
            when {
                loaded is Load.Loading -> LoadingSpinner()
                loaded is Load.Failed -> FailedState(loaded.message) { reload += 1 }
                (loaded as Load.Ready).value.isEmpty() || choosing -> CareerRolePicker(catalog) { roleId ->
                    scope.launch {
                        runCatching { Api.setCareerTarget(context, roleId) }
                            .onSuccess { choosing = false; reload += 1 }
                            .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not set that target." }
                    }
                }
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(loaded.value, key = { it.id }) { target ->
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Text(target.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                Text(target.family, style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                                val gap = target.gap
                                if (gap == null) {
                                    Spacer(Modifier.height(10.dp))
                                    Text("NA", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                                    Text("Nothing has been measured against this target yet.",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                } else {
                                    Spacer(Modifier.height(10.dp))
                                    // Deliberately not called readiness. Readiness is an advisory
                                    // band with no number (ADR-020); this is a count of met
                                    // requirements, with its own denominator.
                                    Text(
                                        "${gap.requirementsMet} of ${gap.requirementsTotal} requirements met",
                                        style = MaterialTheme.typography.titleSmall,
                                    )
                                    if (gap.requirementsUnknown > 0) {
                                        Text(
                                            "${gap.requirementsUnknown} not measured yet",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    Spacer(Modifier.height(10.dp))
                                    gap.items.take(5).forEach { item ->
                                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                            verticalAlignment = Alignment.CenterVertically) {
                                            Column(Modifier.weight(1f)) {
                                                Text(item.topicTitle ?: "Topic", style = MaterialTheme.typography.bodyMedium)
                                                Text(prettify(item.requirementLevel), style = MaterialTheme.typography.bodySmall,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                                            }
                                            StatusChip(prettify(item.status), when (item.status) {
                                                "MET" -> ChipKind.Positive
                                                "UNKNOWN" -> ChipKind.Waiting
                                                else -> ChipKind.Muted
                                            })
                                        }
                                    }
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }
}

@Composable
private fun CareerRolePicker(catalog: List<CareerRoleDto>, onPick: (String) -> Unit) {
    if (catalog.isEmpty()) {
        EmptyState(
            Icons.Filled.TrackChanges, Tone.Accent, "No careers to choose from yet",
            "The career catalogue has not been published for your institution yet.",
        )
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        item {
            Spacer(Modifier.height(12.dp))
            Text("Pick the career you are aiming at. Everything else is measured against it.",
                style = MaterialTheme.typography.bodyMedium)
        }
        items(catalog, key = { it.id }) { role ->
            Spacer(Modifier.height(10.dp))
            PilotCard {
                Column(Modifier.fillMaxWidth().clickable { onPick(role.id) }.padding(16.dp)) {
                    Text(role.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(role.family, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    role.summary?.takeIf { it.isNotBlank() }?.let {
                        Spacer(Modifier.height(6.dp))
                        Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 3)
                    }
                }
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

// ---------------------------------------------------------------------------
// Tasks assigned by the institution
// ---------------------------------------------------------------------------

@Composable
internal fun SupportTasksPage(institutionId: String?, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var actions by remember { mutableStateOf<List<StaffActionDto>?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(reload, institutionId) {
        actions = if (institutionId.isNullOrBlank()) {
            emptyList()
        } else {
            runCatching { Api.listStaffActions(context, institutionId) }.getOrNull() ?: emptyList()
        }
    }

    OverlayScaffold(title = "Support", onClose = onClose) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            notice?.let {
                Spacer(Modifier.height(10.dp))
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                    Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
            when {
                actions == null -> LoadingSpinner()
                actions!!.isEmpty() -> EmptyState(
                    Icons.Filled.TaskAlt, Tone.Green, "Nothing assigned to you",
                    "When your placement cell or a tutor assigns you something, it appears here.",
                )
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(actions!!, key = { it.id }) { action ->
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Row(verticalAlignment = Alignment.Top) {
                                    Column(Modifier.weight(1f)) {
                                        Text(action.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                        Text(prettify(action.actionType), style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    StatusChip(prettify(action.state), when (action.state) {
                                        "COMPLETED" -> ChipKind.Positive
                                        "IN_PROGRESS" -> ChipKind.Waiting
                                        else -> ChipKind.Accent
                                    })
                                }
                                action.detail?.takeIf { it.isNotBlank() }?.let {
                                    Spacer(Modifier.height(6.dp))
                                    Text(it, style = MaterialTheme.typography.bodyMedium)
                                }
                                action.dueAt?.let {
                                    Spacer(Modifier.height(6.dp))
                                    Text("Due ${formatWhen(it)}", style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.primary)
                                }
                                if (action.state != "COMPLETED") {
                                    Spacer(Modifier.height(10.dp))
                                    Button(
                                        onClick = {
                                            scope.launch {
                                                runCatching { Api.completeStaffAction(context, action.id, "Completed from the app.") }
                                                    .onSuccess { notice = "Marked as done."; reload += 1 }
                                                    .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not update that." }
                                            }
                                        },
                                        shape = RoundedCornerShape(10.dp),
                                    ) { Text("Mark as done") }
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Academic records
// ---------------------------------------------------------------------------

@Composable
internal fun AcademicRecordsPage(onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var records by remember { mutableStateOf<Load<AcademicRecordsDto>>(Load.Loading) }
    var reload by remember { mutableIntStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }
    var addingTermFor by remember { mutableStateOf<String?>(null) }
    var termLabel by remember { mutableStateOf("") }
    var termSequence by remember { mutableStateOf("") }
    var termResult by remember { mutableStateOf("") }
    var termBacklogs by remember { mutableStateOf("") }

    LaunchedEffect(reload) { records = loadOf { Api.academicRecords(context) } }

    OverlayScaffold(title = "Academic record", onClose = onClose) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            notice?.let {
                Spacer(Modifier.height(10.dp))
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                    Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
            val state = records
            val data = (state as? Load.Ready)?.value
            when {
                state is Load.Loading -> LoadingSpinner()
                state is Load.Failed -> FailedState(state.message) { reload += 1 }
                data == null || data.qualifications.isEmpty() -> EmptyState(
                    Icons.Filled.School, Tone.Violet, "No academic record yet",
                    "Add your programme and results on the web app, then ask your institution to verify them. " +
                        "Employers who ask for a minimum CGPA can only see verified results.",
                )
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    data.eligibilityFacts?.let { facts ->
                        item {
                            Spacer(Modifier.height(12.dp))
                            PilotCard {
                                Column(Modifier.padding(16.dp)) {
                                    Text("What employers can see", style = MaterialTheme.typography.titleSmall,
                                        fontWeight = FontWeight.SemiBold)
                                    Spacer(Modifier.height(8.dp))
                                    if (!facts.hasVerifiedRecord) {
                                        // The honest version of "NA". A self-reported figure never
                                        // satisfies an employer rule, and saying so here is what
                                        // makes the "we cannot tell yet" on a job page make sense.
                                        Text("Nothing verified yet", style = MaterialTheme.typography.titleMedium,
                                            fontWeight = FontWeight.Bold)
                                        Text(
                                            "Until your institution verifies a term, roles that ask for a minimum CGPA will show as undecided.",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    } else {
                                        Text(
                                            facts.cgpa10?.let { "CGPA %.2f / 10".format(it) } ?: "Result recorded on a scale we do not convert",
                                            style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold,
                                        )
                                        facts.termLabel?.let {
                                            Text("From $it", style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                        facts.cumulativeBacklogs?.let {
                                            Text("$it backlog(s) across verified terms", style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    items(data.qualifications, key = { it.id }) { qualification ->
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Row(verticalAlignment = Alignment.Top) {
                                    Column(Modifier.weight(1f)) {
                                        Text(qualification.programmeName, style = MaterialTheme.typography.titleMedium,
                                            fontWeight = FontWeight.SemiBold)
                                        Text(
                                            qualification.institutionName ?: qualification.institutionNameDeclared ?: "",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    StatusChip(prettify(qualification.verificationState), when (qualification.verificationState) {
                                        "VERIFIED" -> ChipKind.Positive
                                        "PENDING_VERIFICATION" -> ChipKind.Waiting
                                        "REJECTED" -> ChipKind.Muted
                                        else -> ChipKind.Accent
                                    })
                                }
                                qualification.terms.forEach { term ->
                                    Spacer(Modifier.height(10.dp))
                                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                        Column(Modifier.weight(1f)) {
                                            Text(term.label, style = MaterialTheme.typography.bodyMedium)
                                            Text(
                                                // Shown exactly as issued, with its scale. Nothing here
                                                // is converted; a converted number could not be told
                                                // apart from one the institution actually gave.
                                                listOfNotNull(
                                                    term.resultValue?.let { value -> term.resultScale?.let { "$value ${prettify(it)}" } },
                                                    term.resultLetter,
                                                    term.backlogCount?.let { "$it backlog(s)" },
                                                ).joinToString("  ·  ").ifBlank { "No result recorded" },
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                        if (term.verificationState == "SELF_REPORTED" || term.verificationState == "REJECTED") {
                                            TextButton(onClick = {
                                                scope.launch {
                                                    runCatching { Api.submitTermForVerification(context, term.id) }
                                                        .onSuccess { notice = "Sent to your institution."; reload += 1 }
                                                        .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not send that." }
                                                }
                                            }) { Text("Verify") }
                                        } else {
                                            StatusChip(prettify(term.verificationState), when (term.verificationState) {
                                                "VERIFIED" -> ChipKind.Positive
                                                else -> ChipKind.Waiting
                                            })
                                        }
                                    }
                                }
                                Spacer(Modifier.height(10.dp))
                                if (addingTermFor == qualification.id) {
                                    OutlinedTextField(termLabel, { termLabel = it }, label = { Text("Term name, e.g. Semester 4") },
                                        singleLine = true, modifier = Modifier.fillMaxWidth())
                                    Spacer(Modifier.height(8.dp))
                                    OutlinedTextField(termSequence, { termSequence = it.filter(Char::isDigit) },
                                        label = { Text("Which term is it? e.g. 4") }, singleLine = true,
                                        modifier = Modifier.fillMaxWidth())
                                    Spacer(Modifier.height(8.dp))
                                    OutlinedTextField(termResult, { termResult = it }, label = { Text("CGPA out of 10 (optional)") },
                                        singleLine = true, modifier = Modifier.fillMaxWidth())
                                    Spacer(Modifier.height(8.dp))
                                    OutlinedTextField(termBacklogs, { termBacklogs = it.filter(Char::isDigit) },
                                        label = { Text("Backlogs this term (optional)") }, singleLine = true,
                                        modifier = Modifier.fillMaxWidth())
                                    Spacer(Modifier.height(10.dp))
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        Button(
                                            onClick = {
                                                scope.launch {
                                                    runCatching {
                                                        Api.declareTerm(
                                                            context, qualification.id,
                                                            termSequence.toIntOrNull() ?: 1, termLabel.trim(),
                                                            termResult.trim().ifBlank { null },
                                                            if (termResult.isBlank()) null else "CGPA_10",
                                                            termBacklogs.toIntOrNull(),
                                                        )
                                                    }
                                                        .onSuccess {
                                                            addingTermFor = null; termLabel = ""; termSequence = ""
                                                            termResult = ""; termBacklogs = ""; reload += 1
                                                        }
                                                        .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not add that term." }
                                                }
                                            },
                                            enabled = termLabel.isNotBlank() && termSequence.isNotBlank(),
                                            shape = RoundedCornerShape(10.dp),
                                        ) { Text("Add") }
                                        TextButton(onClick = { addingTermFor = null }) { Text("Cancel") }
                                    }
                                } else {
                                    TextButton(onClick = { addingTermFor = qualification.id }) { Text("Add a term") }
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------

/**
 * Requesting erasure, and taking it back.
 *
 * The cancel path matters as much as the request. Deletion carries a 30-day grace
 * period precisely so a person can change their mind, and an app that can start an
 * erasure but not stop it turns a safeguard into a trap.
 */
@Composable
internal fun DeletionCard(
    requests: List<PrivacyRequestDto>,
    onRequest: () -> Unit,
    onCancel: (String) -> Unit,
) {
    val pending = requests.firstOrNull {
        it.requestType == "DELETION" && it.state !in setOf("COMPLETED", "CANCELLED", "REJECTED")
    }
    var confirming by remember { mutableStateOf(false) }

    PilotCard {
        Column(Modifier.padding(16.dp)) {
            Text("Delete your account", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(4.dp))
            if (pending == null) {
                Text(
                    "Ask us to erase your personal data. Nothing is deleted immediately — you get 30 days to change your mind.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(10.dp))
                TextButton(onClick = { confirming = true }) { Text("Request deletion") }
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusChip(prettify(pending.state), ChipKind.Waiting)
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    "Requested ${formatWhen(pending.requestedAt)}. You can still stop this.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(10.dp))
                Button(onClick = { onCancel(pending.id) }, shape = RoundedCornerShape(10.dp)) {
                    Text("Keep my account")
                }
            }
        }
    }

    if (confirming) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Request deletion?") },
            text = {
                Text(
                    "Your profile, documents, assessment history and applications will be erased after 30 days. " +
                        "You can cancel at any point before then, from this screen.",
                )
            },
            confirmButton = {
                TextButton(onClick = { confirming = false; onRequest() }) { Text("Request deletion") }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("Cancel") } },
        )
    }
}
