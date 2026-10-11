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
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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

// Career target, goals and onboarding: StudentGoals.kt (ENG-19).

// ---------------------------------------------------------------------------
// Tasks assigned by the institution
// ---------------------------------------------------------------------------

@Composable
internal fun SupportTasksPage(institutionId: String?, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var actions by remember { mutableStateOf<List<StaffActionDto>?>(null) }
    // INST-11: null while loading; a failed read is shown as NA, never invented.
    var sharedNotes by remember { mutableStateOf<List<SharedCounsellingNoteDto>?>(null) }
    var sharedUnavailable by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(reload, institutionId) {
        actions = if (institutionId.isNullOrBlank()) {
            emptyList()
        } else {
            runCatching { Api.listStaffActions(context, institutionId) }.getOrNull() ?: emptyList()
        }
        if (institutionId.isNullOrBlank()) {
            sharedNotes = emptyList()
        } else {
            val result = runCatching { Api.listSharedCounsellingNotes(context, institutionId) }
            sharedNotes = result.getOrNull()
            sharedUnavailable = result.isFailure
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
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    if (actions!!.isEmpty()) item {
                        EmptyState(
                            Icons.Filled.TaskAlt, Tone.Green, "Nothing assigned to you",
                            "When your placement cell or a tutor assigns you something, it appears here.",
                        )
                    }
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
                                action.note?.takeIf { it.isNotBlank() }?.let {
                                    Spacer(Modifier.height(6.dp))
                                    Text(it, style = MaterialTheme.typography.bodyMedium)
                                }
                                action.dueAt?.let {
                                    Spacer(Modifier.height(6.dp))
                                    Text("Due ${formatWhen(it)}", style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.primary)
                                }
                                if (action.canComplete) {
                                    Spacer(Modifier.height(10.dp))
                                    Button(
                                        onClick = {
                                            scope.launch {
                                                runCatching { Api.completeStaffAction(context, action.id, action.version, "Completed from the app.") }
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
                    item { SharedCounsellingNotesSection(sharedNotes, sharedUnavailable) }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }
}

/**
 * INST-11: counselling notes the college chose to share with the student, as on the web Support
 * card. A college's notes are staff only unless shared; the writer shows as a role, never a name.
 */
@Composable
private fun SharedCounsellingNotesSection(notes: List<SharedCounsellingNoteDto>?, unavailable: Boolean) {
    Column {
        Spacer(Modifier.height(18.dp))
        Text("Counselling notes shared with you", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        when {
            unavailable -> Text("NA — shared counselling notes are unavailable right now.", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            notes == null -> LoadingSpinner()
            notes.isEmpty() -> Text("Your college has not shared any counselling notes with you.", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> notes.forEach { note ->
                Spacer(Modifier.height(10.dp))
                PilotCard {
                    Column(Modifier.padding(16.dp)) {
                        Text(note.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(4.dp))
                        Text(note.note, style = MaterialTheme.typography.bodyMedium)
                        Spacer(Modifier.height(6.dp))
                        val writer = when (note.authorRole) {
                            "INSTITUTION_OWNER", "INSTITUTION_ADMIN" -> "Shared by your college administration"
                            "PLACEMENT_ADMIN" -> "Shared by your placement office"
                            "DEPARTMENT_HEAD" -> "Shared by your department head"
                            "FACULTY_LECTURER" -> "Shared by your faculty"
                            else -> "Shared by your college"
                        }
                        Text(writer + (note.createdAt?.let { " · ${formatWhen(it)}" } ?: ""), style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
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
            AddQualificationCard(
                onAdded = { notice = "Programme added. Add your results, then send them for confirmation."; reload += 1 },
                onFailed = { notice = it },
            )
            val state = records
            val data = (state as? Load.Ready)?.value
            when {
                state is Load.Loading -> LoadingSpinner()
                state is Load.Failed -> FailedState(state.message) { reload += 1 }
                data == null || data.qualifications.isEmpty() -> EmptyState(
                    Icons.Filled.School, Tone.Violet, "No academic record yet",
                    "Add the programme you studied, then ask the institution that issued it to confirm your results. " +
                        "Employers who ask for a minimum CGPA can only see confirmed results.",
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
                                            if (term.source == "INSTITUTION_IMPORTED") {
                                                // Said plainly, so a student knows this came from their college's
                                                // results upload rather than from anything they entered.
                                                Text("Recorded by your college", style = MaterialTheme.typography.labelSmall,
                                                    color = MaterialTheme.colorScheme.primary)
                                            }
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

/**
 * Declaring a programme, and naming who issued it.
 *
 * The institution search is the whole point. Without it `institutionId` can only be set by
 * already knowing a UUID, which is why nobody who left an institution has ever been able
 * to ask it to confirm anything.
 *
 * A college that is not on ONE can still be named, and is recorded as a plain string that
 * can never become verified. That is the honest outcome — there is nobody to ask — and the
 * copy says so rather than letting the student expect a confirmation that cannot come.
 */
@Composable
internal fun AddQualificationCard(onAdded: () -> Unit, onFailed: (String) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<DirectoryInstitutionDto>>(emptyList()) }
    var chosen by remember { mutableStateOf<DirectoryInstitutionDto?>(null) }
    var notOnOne by remember { mutableStateOf(false) }
    var programme by remember { mutableStateOf("") }
    var qualificationType by remember { mutableStateOf("BTECH") }
    var saving by remember { mutableStateOf(false) }

    // Two characters is the server's own floor; searching on one would just enumerate.
    LaunchedEffect(query) {
        results = if (query.trim().length < 2 || chosen != null) emptyList()
        else runCatching { Api.searchInstitutions(context, query.trim()) }.getOrDefault(emptyList())
    }

    Spacer(Modifier.height(12.dp))
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            if (!open) {
                Text("Add a programme", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(
                    "Studied somewhere before? Add it here and ask that institution to confirm your results.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(10.dp))
                Button(onClick = { open = true }) { Text("Add a programme") }
                return@Column
            }

            Text("Who issued it?", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(8.dp))
            if (chosen != null) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(chosen!!.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        val place = listOfNotNull(chosen!!.city, chosen!!.stateOrProvince).joinToString(", ")
                        if (place.isNotBlank()) {
                            Text(place, style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    TextButton(onClick = { chosen = null; query = "" }) { Text("Change") }
                }
            } else {
                OutlinedTextField(
                    value = query, onValueChange = { query = it; notOnOne = false },
                    label = { Text(if (notOnOne) "Institution name" else "Search for your institution") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                if (!notOnOne) {
                    results.take(6).forEach { institution ->
                        Spacer(Modifier.height(6.dp))
                        Text(
                            institution.name,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { chosen = institution }
                                .padding(vertical = 6.dp),
                        )
                    }
                    if (query.trim().length >= 2 && results.isEmpty()) {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "No match on ONE. You can still add it, but results from an institution that is not on ONE stay self-reported — there is nobody to confirm them.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        TextButton(onClick = { notOnOne = true }) { Text("Add it anyway") }
                    }
                }
            }

            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                value = programme, onValueChange = { programme = it },
                label = { Text("Programme, e.g. Computer Science and Engineering") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = qualificationType, onValueChange = { qualificationType = it.uppercase() },
                label = { Text("Qualification, e.g. BTECH") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    enabled = !saving && programme.isNotBlank() && (chosen != null || (notOnOne && query.isNotBlank())),
                    onClick = {
                        saving = true
                        scope.launch {
                            runCatching {
                                Api.declareQualification(
                                    context,
                                    institutionId = chosen?.id,
                                    institutionNameDeclared = if (chosen == null) query.trim() else null,
                                    qualificationType = qualificationType.trim(),
                                    programmeName = programme.trim(),
                                )
                            }.onSuccess {
                                open = false; query = ""; chosen = null; notOnOne = false; programme = ""
                                onAdded()
                            }.onFailure {
                                onFailed((it as? Api.ApiException)?.detail ?: "That programme could not be added.")
                            }
                            saving = false
                        }
                    },
                ) { Text("Add") }
                OutlinedButton(onClick = { open = false }) { Text("Cancel") }
            }
        }
    }
}
