package pro.ai8ht.one

// Growth → Leads on the phone (GROWTH-03; design §14.1). Field staff list their leads and the
// unowned leads of their regions, open one, claim it, create a lead, and add a contact with the
// permission basis it was obtained under and whether the contact notice was given. Calling and
// emailing a contact go through the phone's own dialler and mail app; ONE records no calls.
// Contacts arrive in full only on the person's own leads (the server masks every other), so the
// app never holds anyone else's contacts. The notice text is shown with its DRAFT label.
//
// GROWTH-06: a new lead goes through the offline queue (GrowthQueue), so one made without a signal
// is kept and sent once; the lists, the vocabulary and the person's own leads keep a saved copy for
// offline reading (other leads are never saved); the lead detail carries its field work — log a
// visit, call, meeting or note (with an optional location on a tap), and add a follow-up.

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.School
import androidx.compose.material.icons.filled.WorkOutline
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
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
import pro.ai8ht.one.ui.Tone

private fun leadLabel(code: String?): String = if (code.isNullOrBlank()) "NA" else prettify(code)

private val basisLabels = mapOf(
    "PROVIDED_BY_PERSON" to "They gave it to us themselves",
    "PUBLIC_INSTITUTIONAL_LISTING" to "Their organisation published it for enquiries",
    "INTRODUCED_BY_COLLEAGUE" to "A colleague at their organisation passed it on",
)

private fun leadArea(area: GrowthLeadAreaDto): String =
    listOfNotNull(area.city, area.districtName, area.stateName).joinToString(", ").ifBlank { "Area not set" }

/** The words of a refusal: the server words the duplicate answer itself and names nobody it may not. */
private fun leadErrorText(error: Throwable, fallback: String): String {
    val api = error as? Api.ApiException ?: return fallback
    return when (api.code) {
        "GROWTH_LEAD_DUPLICATE" -> api.detail ?: "Already registered by another team member — ask your manager."
        "GROWTH_LEAD_DO_NOT_CONTACT" -> "This organisation asked not to be contacted. It cannot be added or worked."
        "GROWTH_ORGANIZATION_ALREADY_ON_ONE" -> "This employer is already on ONE. It is an existing account, not a new lead."
        "GROWTH_TEAM_MISMATCH" -> "You are not on the team that works this kind of lead."
        "GROWTH_LEAD_ALREADY_OWNED" -> "Someone claimed this lead first."
        "GROWTH_CONTACT_LIMIT_REACHED" -> "This lead already has the most contacts allowed."
        else -> fallback
    }
}

@Composable
private fun ChoiceRow(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (value, label) ->
            FilterChip(selected = selected == value, onClick = { onSelect(value) }, label = { Text(label) })
        }
    }
}

@Composable
internal fun GrowthLeadsTab(initialLead: String? = null, onInitialLeadShown: () -> Unit = {}) {
    val context = LocalContext.current
    var kind by remember { mutableStateOf("COLLEGE") }
    var view by remember { mutableStateOf("MINE") }
    var page by remember { mutableStateOf<GrowthLeadPageDto?>(null) }
    var failed by remember { mutableStateOf(false) }
    var vocabulary by remember { mutableStateOf<GrowthLeadVocabularyDto?>(null) }
    var selected by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }

    var stale by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        vocabulary = runCatching { growthCachedRead(context, "growth:leads:vocabulary") { Api.request(context, "GET", "/api/v1/growth/leads/vocabulary") }.first }
            .getOrNull()?.let { runCatching { Api.json.decodeFromString<GrowthLeadVocabularyDto>(it) }.getOrNull() }
    }
    LaunchedEffect(initialLead) { if (initialLead != null) { selected = initialLead; onInitialLeadShown() } }
    LaunchedEffect(kind, view, reload) {
        page = null
        val result = runCatching { growthCachedRead(context, "growth:leads:$kind:$view") { Api.request(context, "GET", "/api/v1/growth/leads?kind=$kind&view=$view") } }
        val (body, fromCache) = result.getOrNull() ?: (null to false)
        page = body?.let { runCatching { Api.json.decodeFromString<GrowthLeadPageDto>(it) }.getOrNull() }
        stale = fromCache
        failed = page == null
    }

    androidx.activity.compose.BackHandler(enabled = selected != null || creating) { selected = null; creating = false }
    if (creating && vocabulary != null) {
        SlideIn { NewLeadScreen(vocabulary!!, kind, onClose = { creating = false }, onCreated = { id -> creating = false; selected = id; reload++ }) }
        return
    }
    if (selected != null && vocabulary != null) {
        SlideIn { LeadDetailScreen(selected!!, vocabulary!!, onClose = { selected = null; reload++ }) }
        return
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(10.dp))
        ChoiceRow(listOf("COLLEGE" to "Colleges", "EMPLOYER" to "Employers"), kind) { kind = it }
        Spacer(Modifier.height(6.dp))
        ChoiceRow(listOf("MINE" to "Mine", "UNOWNED" to "Unowned in my regions", "ALL" to "All I can see"), view) { view = it }
        Spacer(Modifier.height(10.dp))
        Button(onClick = { creating = true }, enabled = vocabulary != null) { Text("New lead") }
        if (stale) StatusChip("Offline — showing what was saved on this phone", ChipKind.Waiting)
        SectionTitle(if (kind == "COLLEGE") "Colleges" else "Employers")
        when {
            failed -> CenteredNote("Leads could not be loaded. Nothing is shown until they load. Try again shortly.")
            page == null -> HomeSkeleton()
            page!!.leads.isEmpty() -> PilotCard {
                Text(if (view == "MINE") "You own no leads of this kind yet. Create one, or claim an unowned lead in your region."
                    else "No lead of this kind here yet.", Modifier.padding(16.dp),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> page!!.leads.forEach { lead ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp).clickable { selected = lead.id }) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconBubble(if (lead.kind == "COLLEGE") Icons.Filled.School else Icons.Filled.WorkOutline,
                            if (lead.kind == "COLLEGE") Tone.Green else Tone.Violet, size = 32.dp)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(lead.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text("${leadArea(lead.area)} · ${leadLabel(lead.stage)}", style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        when {
                            lead.doNotContact != null -> StatusChip("Do not contact", ChipKind.Muted)
                            lead.owner?.isMe == true -> StatusChip("Yours", ChipKind.Positive)
                            lead.owner == null -> StatusChip(if (lead.needsNewOwner) "Needs owner" else "Unowned", ChipKind.Waiting)
                            else -> StatusChip("Owned", ChipKind.Muted)
                        }
                    }
                }
            }
        }
        if (page?.nextCursor != null) Text("Showing the newest 50. Use the web Leads page to see older ones.",
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun NewLeadScreen(vocabulary: GrowthLeadVocabularyDto, defaultKind: String, onClose: () -> Unit, onCreated: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var kind by remember { mutableStateOf(defaultKind) }
    var name by remember { mutableStateOf("") }
    var city by remember { mutableStateOf("") }
    var identifier by remember { mutableStateOf("") }
    var source by remember { mutableStateOf("FIELD_VISIT") }
    var error by remember { mutableStateOf<String?>(null) }
    var queuedNote by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
        TextButton(onClick = onClose) { Text("Back to leads") }
        queuedNote?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold) }
        Text("New lead", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        Text("You become its owner. A lead another team member already registered is refused.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(10.dp))
        ChoiceRow(listOf("COLLEGE" to "College", "EMPLOYER" to "Employer"), kind) { kind = it; identifier = "" }
        OutlinedTextField(name, { name = it.take(180) }, label = { Text("Organisation name") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(city, { city = it.take(120) }, label = { Text("City or town") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(identifier, { identifier = it.take(253) },
            label = { Text(if (kind == "COLLEGE") "AISHE code (optional, C-12345)" else "Website (once known)") }, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        Text("How you found it", style = MaterialTheme.typography.labelMedium)
        ChoiceRow(vocabulary.sources.map { it to leadLabel(it) }, source) { source = it }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Spacer(Modifier.height(10.dp))
        Button(enabled = name.isNotBlank() && !busy && queuedNote == null, onClick = {
            busy = true
            scope.launch {
                // GROWTH-06: through the offline queue, so a lead made without a signal lands once.
                val body = Api.growthLeadBody(kind, name.trim(), city.trim().ifBlank { null },
                    if (kind == "COLLEGE") identifier.trim().ifBlank { null } else null,
                    if (kind == "EMPLOYER") identifier.trim().ifBlank { null } else null, source)
                when (val result = queueGrowthWrite(context, "LEAD_CREATE", "/api/v1/growth/leads", body, "New lead · ${name.trim()}")) {
                    is QueuedOutcome.Sent -> runCatching { Api.json.decodeFromString<GrowthLeadEnvelope>(result.body).lead.id }
                        .onSuccess { onCreated(it) }.onFailure { onClose() }
                    QueuedOutcome.Waiting -> { error = null; queuedNote = "Saved on this phone. The lead is sent when you are back online; log visits on it once it has synced." }
                    is QueuedOutcome.Refused -> error = result.message
                }
                busy = false
            }
        }) { Text("Create lead") }
        Text("State and district are set on the web Leads page.", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun LeadDetailScreen(leadId: String, vocabulary: GrowthLeadVocabularyDto, onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var lead by remember { mutableStateOf<GrowthLeadDetailDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var logging by remember { mutableStateOf<GrowthFieldVocabularyDto?>(null) }
    var addingFollowUp by remember { mutableStateOf(false) }
    var fieldNote by remember { mutableStateOf<String?>(null) }
    var fieldReload by remember { mutableStateOf(0) }
    LaunchedEffect(leadId) {
        // Only the person's own leads are kept on the phone: the server masks every other lead's
        // contacts, and a lead someone else owns has no business in this phone's storage.
        val store = pro.ai8ht.one.data.Store(context.applicationContext)
        val key = "growth:lead:$leadId"
        runCatching { Api.request(context, "GET", "/api/v1/growth/leads/$leadId") }
            .onSuccess { body ->
                val parsed = Api.json.decodeFromString<GrowthLeadEnvelope>(body).lead
                lead = parsed
                if (parsed.owner?.isMe == true) store.write(key, body)
            }
            .onFailure { failure ->
                val saved = if (failure is java.io.IOException) store.read(key) else null
                val parsed = saved?.let { runCatching { Api.json.decodeFromString<GrowthLeadEnvelope>(it).lead }.getOrNull() }
                if (parsed != null) lead = parsed else error = leadErrorText(failure, "The lead could not be loaded.")
            }
    }
    androidx.activity.compose.BackHandler(enabled = logging != null || addingFollowUp) { logging = null; addingFollowUp = false }
    val loaded = lead
    if (logging != null && loaded != null) {
        LogActivityScreen(loaded.id, loaded.name, loaded.contacts, logging!!) { note -> logging = null; fieldNote = note; fieldReload++ }
        return
    }
    if (addingFollowUp && loaded != null) {
        AddFollowUpScreen(loaded.id, loaded.name, 280) { note -> addingFollowUp = false; fieldNote = note; fieldReload++ }
        return
    }
    fun act(block: suspend () -> GrowthLeadDetailDto, fallback: String) {
        busy = true
        scope.launch {
            runCatching { block() }.onSuccess { lead = it; error = null }.onFailure { error = leadErrorText(it, fallback) }
            busy = false
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
        TextButton(onClick = onClose) { Text("Back to leads") }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        val current = lead ?: run { if (error == null) HomeSkeleton(); return@Column }
        val mine = current.owner?.isMe == true
        val open = !current.handedOff && current.stage != "LOST"
        Text(current.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        Text("${if (current.kind == "COLLEGE") "College" else "Employer"} · ${leadArea(current.area)} · ${leadLabel(current.stage)}",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("Owner: " + when {
            mine -> "you"
            current.owner != null -> current.owner.email ?: "NA"
            current.needsNewOwner -> "nobody — the previous owner left"
            else -> "nobody (unowned)"
        }, style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (current.doNotContact != null) StatusChip("Do not contact", ChipKind.Muted)
            if (current.possibleDuplicate) StatusChip("Possible duplicate", ChipKind.Waiting)
            if (current.stale) StatusChip("Stale", ChipKind.Waiting)
        }
        if (current.owner == null && current.doNotContact == null && open) {
            Spacer(Modifier.height(8.dp))
            Button(enabled = !busy, onClick = { act({ Api.claimGrowthLead(context, current.id) }, "The lead could not be claimed.") }) { Text("Claim this lead") }
        }
        SectionTitle("Contacts")
        if (current.contacts.isEmpty()) {
            Text("No contacts" + if (current.removedContacts > 0) " (${current.removedContacts} removed and erased)." else ".",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        current.contacts.forEach { contact ->
            PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                Column(Modifier.padding(14.dp)) {
                    Text("${contact.fullName} · ${leadLabel(contact.role)}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    listOfNotNull(contact.email, contact.phone).forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                    Text("${basisLabels[contact.permissionBasis] ?: leadLabel(contact.permissionBasis)} (${leadLabel(contact.source)})",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(contact.notice?.let { "Notice given (${it.version ?: "NA"})" } ?: "Notice not yet given",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (mine && !contact.masked) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            contact.phone?.let { phone ->
                                OutlinedButton(onClick = {
                                    context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + phone.filter { it.isDigit() || it == '+' })))
                                }) { Text("Call") }
                            }
                            contact.email?.let { email ->
                                OutlinedButton(onClick = { context.startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:$email"))) }) { Text("Email") }
                            }
                            if (contact.notice == null && current.doNotContact == null) {
                                OutlinedButton(enabled = !busy, onClick = {
                                    act({ Api.recordGrowthContactNotice(context, current.id, contact.id) }, "The notice could not be recorded.")
                                }) { Text("Notice given") }
                            }
                        }
                    }
                }
            }
        }
        if (mine && current.doNotContact == null) {
            if (!adding) {
                OutlinedButton(enabled = current.contacts.size < vocabulary.contactLimit, onClick = { adding = true }) { Text("Add a contact") }
            } else {
                AddContactForm(vocabulary, busy, onCancel = { adding = false }) { role, name, email, phone, basis, source, notice ->
                    busy = true
                    scope.launch {
                        runCatching { Api.addGrowthContact(context, current.id, role, name, email, phone, basis, source, notice) }
                            .onSuccess { lead = it; adding = false; error = null }
                            .onFailure { error = leadErrorText(it, "The contact could not be added.") }
                        busy = false
                    }
                }
            }
        }
        fieldNote?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp)) }
        LeadFieldSection(current.id, current.name, onLog = { logging = it }, onFollowUp = { addingFollowUp = true }, reloadKey = fieldReload)
        SectionTitle("Contact notice", trailing = "Draft for legal review")
        PilotCard {
            Column(Modifier.padding(14.dp)) {
                vocabulary.notice.text.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                Text("Version ${vocabulary.notice.version}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun AddContactForm(
    vocabulary: GrowthLeadVocabularyDto,
    busy: Boolean,
    onCancel: () -> Unit,
    onSubmit: (role: String, name: String, email: String?, phone: String?, basis: String, source: String, notice: Boolean) -> Unit,
) {
    var role by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var basis by remember { mutableStateOf("") }
    var source by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf(false) }
    PilotCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text("Add a contact", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            Text("${vocabulary.purpose} Never purchased lists, scraped data, or personal mobile numbers from any other source.",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(6.dp))
            ChoiceRow(vocabulary.contactRoles.map { it to leadLabel(it) }, role) { role = it }
            OutlinedTextField(name, { name = it.take(120) }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(email, { email = it.take(254) }, label = { Text("Work email") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(phone, { phone = it.take(24) }, label = { Text("Phone") }, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(6.dp))
            Text("How we got it (required)", style = MaterialTheme.typography.labelMedium)
            ChoiceRow(vocabulary.contactSourcesByBasis.keys.map { it to (basisLabels[it] ?: leadLabel(it)) }, basis) { basis = it; source = "" }
            if (basis.isNotEmpty()) ChoiceRow((vocabulary.contactSourcesByBasis[basis] ?: emptyList()).map { it to leadLabel(it) }, source) { source = it }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = notice, onCheckedChange = { notice = it })
                Text("I gave or sent them the contact notice", style = MaterialTheme.typography.bodySmall)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(enabled = !busy && role.isNotEmpty() && name.isNotBlank() && (email.isNotBlank() || phone.isNotBlank()) && basis.isNotEmpty() && source.isNotEmpty(),
                    onClick = { onSubmit(role, name.trim(), email.trim().ifBlank { null }, phone.trim().ifBlank { null }, basis, source, notice) }) { Text("Add contact") }
                TextButton(onClick = onCancel) { Text("Cancel") }
            }
        }
    }
}
