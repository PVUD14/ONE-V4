package pro.ai8ht.one

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/**
 * The consented talent pool on the phone (EMP-14, ADR-044), matching the web Profile card.
 *
 * A student joins only by agreeing to the employer-discovery notice, ticks exactly what their card shows
 * (verified evidence per skill, branch, graduation year, preferred cities), answers invitations to apply,
 * blocks employers and can leave at any time — leaving takes effect on the employer's next request.
 * Nothing shows while the feature is off (HG-4 pending) unless the student joined while it was on, in
 * which case they can still leave. The employer's search lives on the web only: the app has no Talent
 * Pool screen for recruiters, and adding one would be a navigation change. No name, contact, college,
 * score, stage or count is in these types or on these screens.
 */

@Serializable data class TalentPoolChoiceDto(
    val evidenceId: String,
    val type: String,
    val source: String,
    val occurredAt: String? = null,
    val unaided: Boolean = false,
    val shown: Boolean = false,
)
@Serializable data class TalentPoolSkillDto(val name: String, val items: List<TalentPoolChoiceDto> = emptyList())
@Serializable data class TalentPoolConsentDto(val version: String, val title: String, val granted: Boolean = false)
@Serializable data class TalentPoolListingDto(
    val showBranch: Boolean = false,
    val showGraduationYear: Boolean = false,
    val preferredCities: List<String> = emptyList(),
    val optedInAt: String? = null,
)
@Serializable data class TalentPoolRosterDto(val branch: String? = null, val graduationYear: Int? = null)
@Serializable data class TalentPoolInvitationDto(
    val id: String,
    val opportunityId: String,
    val employerName: String = "",
    val title: String? = null,
    val state: String = "SENT",
    val sentAt: String? = null,
    val expiresAt: String? = null,
)
@Serializable data class TalentPoolBlockDto(val employerId: String, val employerName: String = "", val blockedAt: String? = null)
@Serializable data class StudentTalentPoolDto(
    val available: Boolean = false,
    val optedIn: Boolean = false,
    val discoverable: Boolean = false,
    val consent: TalentPoolConsentDto? = null,
    val visibility: String? = null,
    val listing: TalentPoolListingDto? = null,
    val roster: TalentPoolRosterDto? = null,
    val skills: List<TalentPoolSkillDto> = emptyList(),
    val invitations: List<TalentPoolInvitationDto> = emptyList(),
    val blocks: List<TalentPoolBlockDto> = emptyList(),
)
@Serializable private data class TalentPoolEnvelope(val talentPool: StudentTalentPoolDto = StudentTalentPoolDto())
@Serializable private data class TalentPoolSave(
    val consentVersion: String? = null,
    val showBranch: Boolean,
    val showGraduationYear: Boolean,
    val preferredCities: List<String>,
    val evidenceRecordIds: List<String>,
)
@Serializable data class BlockableEmployerDto(val employerId: String, val name: String = "")
@Serializable private data class BlockableEnvelope(val employers: List<BlockableEmployerDto> = emptyList())
@Serializable private data class BlockRequest(val employerId: String)

private val talentPoolJson = kotlinx.serialization.json.Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

suspend fun Api.myTalentPool(context: Context): StudentTalentPoolDto =
    json.decodeFromString<TalentPoolEnvelope>(request(context, "GET", "/api/v1/students/me/talent-pool")).talentPool

/** Join (with the notice version) or change what the card shows (without it). */
suspend fun Api.saveMyTalentPool(context: Context, consentVersion: String?, showBranch: Boolean, showGraduationYear: Boolean, cities: List<String>, evidenceIds: List<String>): StudentTalentPoolDto =
    json.decodeFromString<TalentPoolEnvelope>(request(context, "PUT", "/api/v1/students/me/talent-pool",
        talentPoolJson.encodeToString(TalentPoolSave(consentVersion, showBranch, showGraduationYear, cities, evidenceIds)))).talentPool

suspend fun Api.leaveTalentPool(context: Context): StudentTalentPoolDto =
    json.decodeFromString<TalentPoolEnvelope>(request(context, "DELETE", "/api/v1/students/me/talent-pool")).talentPool

suspend fun Api.declineTalentPoolInvitation(context: Context, invitationId: String): StudentTalentPoolDto =
    json.decodeFromString<TalentPoolEnvelope>(request(context, "POST", "/api/v1/students/me/talent-pool/invitations/$invitationId/decline")).talentPool

suspend fun Api.findEmployersToBlock(context: Context, query: String): List<BlockableEmployerDto> =
    json.decodeFromString<BlockableEnvelope>(request(context, "GET", "/api/v1/students/me/talent-pool/employers?q=" + java.net.URLEncoder.encode(query.trim().take(80), "UTF-8"))).employers

suspend fun Api.blockEmployer(context: Context, employerId: String): StudentTalentPoolDto =
    json.decodeFromString<TalentPoolEnvelope>(request(context, "POST", "/api/v1/students/me/talent-pool/blocks", json.encodeToString(BlockRequest(employerId)))).talentPool

suspend fun Api.unblockEmployer(context: Context, employerId: String): StudentTalentPoolDto =
    json.decodeFromString<TalentPoolEnvelope>(request(context, "DELETE", "/api/v1/students/me/talent-pool/blocks/$employerId")).talentPool

private const val WHAT_EMPLOYERS_SEE = "Verified employers searching the talent pool see a card with only what you tick: your skills with the evidence you choose (the kind of evidence, where it came from, its date and whether you did it without help), and, if you tick them, your branch, graduation year and preferred cities. Never your name, email, phone, photo, college, marks, scores or readiness. An employer can invite you to apply to a job; nothing about you reaches them unless you apply."

private fun statusLine(pool: StudentTalentPoolDto): String = when {
    !pool.optedIn -> "You are not in the talent pool. No employer can find you."
    pool.discoverable -> "You are in the talent pool. Verified employers you have not blocked can find your card."
    pool.consent?.granted == false -> "You are not findable: the notice changed (or you withdrew it). Agree again to be findable."
    else -> "You are not findable: your profile visibility is not set to employer discovery. Agree again to be findable."
}

private fun errorText(error: Throwable, fallback: String): String = when ((error as? Api.ApiException)?.code) {
    "TALENT_POOL_UNAVAILABLE" -> "The talent pool is not available right now."
    "CONSENT_VERSION_MISMATCH" -> "The notice changed. Close this and read it again before joining."
    "INVALID_PREFERRED_CITIES" -> "Cities must be up to five place names, letters only."
    "EVIDENCE_NOT_SHOWABLE" -> "One of those items can no longer be shown. Close this and choose again."
    "INVITATION_NOT_OPEN" -> "That invitation is no longer open."
    else -> fallback
}

private fun invitationLabel(state: String): String = when (state) {
    "SENT" -> "Waiting for your answer"
    "EXPIRED" -> "Expired"
    "APPLIED" -> "You applied"
    "DECLINED" -> "You declined"
    "CANCELLED" -> "Cancelled (you blocked this employer)"
    else -> prettify(state)
}

/**
 * The Profile section: where the student stands, and their invitations. Renders nothing while the
 * feature is off, unless they joined while it was on (then only the way out).
 */
@Composable
internal fun StudentTalentPoolSection(onOpenEditor: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pool by remember { mutableStateOf<StudentTalentPoolDto?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { pool = runCatching { Api.myTalentPool(context) }.getOrNull() }
    val record = pool ?: return
    if (!record.available && !record.optedIn) return

    fun act(run: suspend () -> StudentTalentPoolDto, message: String, fallback: String) {
        busy = true
        scope.launch {
            runCatching { run() }.onSuccess { pool = it; notice = message }.onFailure { notice = errorText(it, fallback) }
            busy = false
        }
    }

    SectionTitle("Talent pool")
    PilotCard {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            if (!record.available) {
                Text("The talent pool is not available right now. No employer can find you. You joined while it was open; you can leave it now.",
                    style = MaterialTheme.typography.bodySmall)
            } else {
                Text(record.consent?.title ?: "Let verified employers find me in the talent pool", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(4.dp))
                Text(statusLine(record), style = MaterialTheme.typography.bodySmall,
                    color = if (record.optedIn && record.discoverable) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            notice?.let { Spacer(Modifier.height(6.dp)); Text(it, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold) }
            if (record.available) {
                Spacer(Modifier.height(10.dp))
                Button(onClick = onOpenEditor, enabled = !busy, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                    Text(if (record.optedIn) "Change my card or blocked employers" else "Read about it and join")
                }
            }
            if (record.optedIn) {
                Spacer(Modifier.height(6.dp))
                OutlinedButton(onClick = { act({ Api.leaveTalentPool(context) }, "You have left the talent pool. Employers can no longer find you.", "You could not be removed. Try again.") },
                    enabled = !busy, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) { Text("Leave the talent pool") }
            }
            if (record.available && record.invitations.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Text("Invitations to apply", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                record.invitations.forEachIndexed { index, invitation ->
                    if (index > 0) HorizontalDivider(Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.outline)
                    Spacer(Modifier.height(6.dp))
                    Text(invitation.title ?: "NA", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    Text("${invitation.employerName}  ·  sent ${invitation.sentAt?.let { formatWhen(it) } ?: "NA"}", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        StatusChip(if (invitation.state == "SENT") "Open until ${invitation.expiresAt?.let { formatWhen(it) } ?: "NA"}" else invitationLabel(invitation.state),
                            if (invitation.state == "SENT") ChipKind.Waiting else ChipKind.Muted)
                        if (invitation.state == "SENT") {
                            TextButton(onClick = { act({ Api.declineTalentPoolInvitation(context, invitation.id) }, "Declined. The employer is not told.", "The invitation could not be declined.") },
                                enabled = !busy) { Text("Decline") }
                        }
                    }
                    if (invitation.state == "SENT") {
                        Text("Find this job under Jobs, marked Invited, to read it and apply.", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

/** The full editor: the notice, what the card shows, a preview, and blocked employers. */
@Composable
internal fun TalentPoolPage(onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pool by remember { mutableStateOf<StudentTalentPoolDto?>(null) }
    var failed by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    var showBranch by remember { mutableStateOf(false) }
    var showYear by remember { mutableStateOf(false) }
    var cities by remember { mutableStateOf("") }
    var chosen by remember { mutableStateOf(emptySet<String>()) }
    var employerQuery by remember { mutableStateOf("") }
    var employerResults by remember { mutableStateOf<List<BlockableEmployerDto>>(emptyList()) }

    fun show(loaded: StudentTalentPoolDto) {
        pool = loaded
        showBranch = loaded.listing?.showBranch ?: false
        showYear = loaded.listing?.showGraduationYear ?: false
        cities = loaded.listing?.preferredCities.orEmpty().joinToString(", ")
        chosen = loaded.skills.flatMap { skill -> skill.items.filter { it.shown }.map { it.evidenceId } }.toSet()
    }
    fun act(run: suspend () -> StudentTalentPoolDto, message: String, fallback: String) {
        busy = true
        scope.launch {
            runCatching { run() }.onSuccess { show(it); notice = message }.onFailure { notice = errorText(it, fallback) }
            busy = false
        }
    }
    LaunchedEffect(Unit) {
        runCatching { Api.myTalentPool(context) }.onSuccess { show(it) }.onFailure { failed = true }
    }
    val cityList = cities.split(',').map { it.trim() }.filter { it.isNotEmpty() }

    OverlayScaffold("Talent pool", onClose) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(12.dp))
            val record = pool
            when {
                failed -> CenteredNote("Your talent pool settings could not be loaded.")
                record == null -> LoadingSpinner()
                !record.available -> CenteredNote("The talent pool is not available right now.")
                else -> {
                    PilotCard {
                        Column(Modifier.fillMaxWidth().padding(16.dp)) {
                            Text(record.consent?.title ?: "Let verified employers find me in the talent pool", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                            Spacer(Modifier.height(4.dp))
                            Text(WHAT_EMPLOYERS_SEE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.height(6.dp))
                            Text(statusLine(record), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                            notice?.let { Spacer(Modifier.height(6.dp)); Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
                        }
                    }
                    SectionTitle("What your card shows")
                    PilotCard {
                        Column(Modifier.fillMaxWidth().padding(16.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(checked = showBranch, enabled = !busy, onCheckedChange = { showBranch = it })
                                Text("My branch: ${record.roster?.branch ?: "NA (your college has not recorded one)"}", style = MaterialTheme.typography.bodySmall)
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(checked = showYear, enabled = !busy, onCheckedChange = { showYear = it })
                                Text("My graduation year: ${record.roster?.graduationYear?.toString() ?: "NA (your college has not recorded one)"}", style = MaterialTheme.typography.bodySmall)
                            }
                            OutlinedTextField(value = cities, onValueChange = { cities = it.take(320) }, enabled = !busy, modifier = Modifier.fillMaxWidth(),
                                label = { Text("Cities I would like to work in (up to five, comma separated)") }, singleLine = true)
                            Spacer(Modifier.height(10.dp))
                            Text("Verified skill evidence to show", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                            if (record.skills.isEmpty()) {
                                Text("You have no verified skill evidence yet. Evidence appears here once ONE has seen you demonstrate a skill without help on two different days.",
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            record.skills.forEach { skill ->
                                Spacer(Modifier.height(6.dp))
                                Text(skill.name, style = MaterialTheme.typography.labelLarge)
                                skill.items.forEach { item ->
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Checkbox(checked = item.evidenceId in chosen, enabled = !busy,
                                            onCheckedChange = { on -> chosen = if (on) chosen + item.evidenceId else chosen - item.evidenceId })
                                        Text(describeEvidence(EvidenceItemDto(item.type, item.source, item.occurredAt, item.unaided)), Modifier.weight(1f),
                                            style = MaterialTheme.typography.bodySmall)
                                    }
                                }
                            }
                        }
                    }
                    SectionTitle("Your card, as employers see it")
                    PilotCard {
                        Column(Modifier.fillMaxWidth().padding(16.dp)) {
                            val shownSkills = record.skills.filter { skill -> skill.items.any { it.evidenceId in chosen } }.map { it.name }
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (shownSkills.isEmpty()) StatusChip("No skills shown", ChipKind.Muted)
                                shownSkills.take(4).forEach { StatusChip(it, ChipKind.Accent) }
                            }
                            Spacer(Modifier.height(6.dp))
                            Text("Branch: ${if (showBranch) record.roster?.branch ?: "NA" else "hidden"}  ·  Graduation year: ${if (showYear) record.roster?.graduationYear?.toString() ?: "NA" else "hidden"}  ·  Cities: ${cityList.joinToString(", ").ifEmpty { "none" }}",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    if (!record.optedIn || !record.discoverable) {
                        Button(onClick = {
                            act({ Api.saveMyTalentPool(context, record.consent?.version ?: "", showBranch, showYear, cityList, chosen.toList()) },
                                "You are in the talent pool. Verified employers can now find your card.", "You could not be added. Try again.")
                        }, enabled = !busy && record.consent != null, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                            Text(if (record.optedIn) "I agree — make me findable again" else "I agree — add me to the talent pool")
                        }
                    }
                    if (record.optedIn) {
                        Spacer(Modifier.height(6.dp))
                        OutlinedButton(onClick = {
                            act({ Api.saveMyTalentPool(context, null, showBranch, showYear, cityList, chosen.toList()) },
                                "Saved. Employers now see your card as shown above.", "Your card could not be saved. Try again.")
                        }, enabled = !busy, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) { Text("Save my card") }
                    }
                    SectionTitle("Employers you have blocked")
                    PilotCard {
                        Column(Modifier.fillMaxWidth().padding(16.dp)) {
                            Text("A blocked employer never finds your card and cannot invite you. Its open invitations are cancelled.",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (record.blocks.isEmpty()) Text("You have not blocked any employer.", style = MaterialTheme.typography.bodySmall)
                            record.blocks.forEach { block ->
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(block.employerName, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                    TextButton(onClick = { act({ Api.unblockEmployer(context, block.employerId) }, "${block.employerName} is no longer blocked.", "The block could not be lifted.") },
                                        enabled = !busy) { Text("Unblock") }
                                }
                            }
                            Spacer(Modifier.height(6.dp))
                            OutlinedTextField(value = employerQuery, onValueChange = { employerQuery = it.take(80) }, modifier = Modifier.fillMaxWidth(),
                                label = { Text("Block an employer by name") }, singleLine = true)
                            TextButton(onClick = {
                                if (employerQuery.trim().length >= 2) scope.launch {
                                    runCatching { Api.findEmployersToBlock(context, employerQuery) }
                                        .onSuccess { employerResults = it }.onFailure { notice = "Employers could not be searched." }
                                }
                            }) { Text("Find") }
                            employerResults.forEach { employer ->
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(employer.name, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                    TextButton(onClick = {
                                        employerResults = emptyList()
                                        act({ Api.blockEmployer(context, employer.employerId) }, "${employer.name} is blocked.", "The employer could not be blocked.")
                                    }, enabled = !busy) { Text("Block") }
                                }
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
