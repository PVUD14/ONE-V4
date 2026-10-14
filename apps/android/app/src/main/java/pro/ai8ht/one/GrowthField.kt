package pro.ai8ht.one

// Growth → Field on the phone (GROWTH-06; design §14). Field staff see what is due (overdue, today,
// upcoming), what they logged, and what is still waiting to be sent; on a lead they log a visit,
// call, meeting or note and add the next follow-up.
//
// Every write goes through GrowthQueue (encrypted, idempotent, sent in order), so it works the same
// with or without a signal. Reads keep their last answer in the app's cache (Store, cleared at
// sign-out) so the person still sees their day when the network drops. The cache holds a lead's
// detail only for the person's own leads — the server masks everyone else's contacts anyway.
//
// "Attach my location" is the only moment the app reads location: the first time, it shows the
// field-staff location notice (a draft for legal review, served by the API) and asks for foreground
// coarse location. Declining changes nothing else — the visit logs without one.

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.EventBusy
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Handshake
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
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
import pro.ai8ht.one.data.Store
import pro.ai8ht.one.ui.Tone
import java.io.IOException
import java.time.Instant
import java.time.LocalDate
import java.time.temporal.ChronoUnit

private const val FIELD_NA = "NA"
private const val FIELD_CACHE = "growth:field:MINE"

private fun leadFieldCache(leadId: String) = "growth:leadfield:$leadId"

private fun activityLabel(kind: String): String = when (kind) {
    "VISIT" -> "Visit"; "CALL" -> "Call"; "MEETING" -> "Meeting"; "NOTE" -> "Note"; else -> prettify(kind)
}

private fun activityIcon(kind: String) = when (kind) {
    "VISIT" -> Icons.Filled.Place; "CALL" -> Icons.Filled.Call; "MEETING" -> Icons.Filled.Handshake; else -> Icons.Filled.EditNote
}

private fun dueText(followUp: GrowthFollowUpDto): String = when {
    followUp.state != "OPEN" -> prettify(followUp.state)
    followUp.overdue -> "Overdue since ${formatDate(followUp.dueOn)}"
    followUp.dueToday -> "Due today"
    else -> "Due ${formatDate(followUp.dueOn)}"
}

/** The result of queueing one write and trying to send it straight away. */
internal sealed class QueuedOutcome {
    data class Sent(val body: String) : QueuedOutcome()
    /** Kept on the phone: no network, or the server was unavailable. It goes when the network returns. */
    object Waiting : QueuedOutcome()
    data class Refused(val message: String) : QueuedOutcome()
}

/**
 * Queues one field write and sends the queue. A refusal of this very write is shown on the screen
 * that made it, so it is removed from the queue here (the person has read it); a refusal of an
 * older item stays on the "Not sent" list until dismissed.
 */
internal suspend fun queueGrowthWrite(context: android.content.Context, kind: String, path: String, body: String, label: String): QueuedOutcome {
    val id = GrowthQueue.newId()
    GrowthQueue.enqueue(context, QueuedGrowthWrite(id = id, kind = kind, method = "POST", path = path, body = body, label = label, createdAtMillis = System.currentTimeMillis()))
    val report = GrowthQueue.flush(context)
    report.sent[id]?.let { return QueuedOutcome.Sent(it) }
    report.refused[id]?.let { refused ->
        GrowthQueue.dismiss(context, id)
        return QueuedOutcome.Refused(refused.refusalMessage ?: growthRefusalText(refused.refusalCode))
    }
    return QueuedOutcome.Waiting
}

/** Reads through the cache: the network answer when there is one, else the last saved copy. */
internal suspend fun growthCachedRead(context: android.content.Context, key: String, fetch: suspend () -> String): Pair<String?, Boolean> {
    val store = Store(context.applicationContext)
    return try {
        val body = fetch()
        store.write(key, body)
        body to false
    } catch (error: IOException) {
        store.read(key) to true
    } catch (error: Api.ApiException) {
        if (error.status >= 500) store.read(key) to true else throw error
    }
}

@Composable
internal fun GrowthQueueCard() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val items by GrowthQueue.items.collectAsState()
    var sending by remember { mutableStateOf(false) }
    if (items.isEmpty()) return
    val pending = items.filter { it.state == QueuedGrowthWrite.STATE_PENDING }
    val refused = items.filter { it.state == QueuedGrowthWrite.STATE_REFUSED }
    PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconBubble(Icons.Filled.CloudOff, Tone.Amber, size = 30.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(if (pending.isNotEmpty()) "${pending.size} waiting to send" else "Not sent", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    Text("Kept on this phone, encrypted. Sent in order when the network returns.", style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            pending.forEach { Text("• ${it.label}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp)) }
            if (pending.isNotEmpty()) {
                OutlinedButton(enabled = !sending, onClick = { sending = true; scope.launch { GrowthQueue.flush(context); sending = false } }) {
                    Text(if (sending) "Sending…" else "Send now")
                }
            }
            refused.forEach { item ->
                Spacer(Modifier.height(8.dp))
                Text("Not accepted: ${item.label}", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.error)
                Text(item.refusalMessage ?: growthRefusalText(item.refusalCode), style = MaterialTheme.typography.labelSmall)
                TextButton(onClick = { scope.launch { GrowthQueue.dismiss(context, item.id) } }) { Text("Dismiss") }
            }
        }
    }
}

@Composable
internal fun GrowthFieldTab(onOpenLead: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var field by remember { mutableStateOf<GrowthFieldDto?>(null) }
    var stale by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    var message by remember { mutableStateOf<String?>(null) }
    val queued by GrowthQueue.items.collectAsState()

    LaunchedEffect(reload, queued.size) {
        val result = runCatching { growthCachedRead(context, FIELD_CACHE) { Api.growthFieldRaw(context, "MINE") } }
        val (body, fromCache) = result.getOrNull() ?: (null to false)
        field = body?.let { runCatching { Api.json.decodeFromString<GrowthFieldDto>(it) }.getOrNull() }
        stale = fromCache
        failed = field == null
        // Reminders follow what the server says is open and mine, whenever it is read.
        field?.let { if (!fromCache) GrowthReminders.resync(context, it.followUps) }
    }

    fun close(followUp: GrowthFollowUpDto, done: Boolean, reason: String?) {
        scope.launch {
            val outcome = queueGrowthWrite(context, if (done) "FOLLOW_UP_DONE" else "FOLLOW_UP_CANCEL",
                "/api/v1/growth/follow-ups/${followUp.id}/${if (done) "complete" else "cancel"}",
                if (done) "{}" else Api.growthCancelBody(reason ?: "OTHER"),
                "${if (done) "Done" else "Cancelled"} · ${followUp.title ?: followUp.leadName}")
            message = when (outcome) {
                is QueuedOutcome.Sent -> null
                QueuedOutcome.Waiting -> "Saved on this phone. It will be sent when you are back online."
                is QueuedOutcome.Refused -> outcome.message
            }
            reload++
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(10.dp))
        GrowthQueueCard()
        if (stale) StatusChip("Offline — showing what was saved on this phone", ChipKind.Waiting)
        message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 6.dp)) }
        if (failed) { CenteredNote("Your field work could not be loaded, and nothing was saved on this phone yet. Try again when you have a signal."); return@Column }
        val data = field ?: run { HomeSkeleton(); return@Column }
        val counts = data.counts
        StatGrid(
            listOf(
                StatSpec(counts?.visitsThisMonth?.toString() ?: FIELD_NA, "Visits this month", Tone.Green, Icons.Filled.Place),
                StatSpec(counts?.metThisMonth?.toString() ?: FIELD_NA, "Met this month", Tone.Accent, Icons.Filled.Handshake),
                StatSpec(counts?.followUpsDueToday?.toString() ?: FIELD_NA, "Due today", Tone.Amber, Icons.Filled.CalendarMonth),
                StatSpec(counts?.followUpsOverdue?.toString() ?: FIELD_NA, "Overdue", Tone.Violet, Icons.Filled.EventBusy),
            ),
            emptyReason = "Your field counts are not available right now.",
        )
        if (!GrowthReminders.notificationsAllowed(context)) {
            Text("Reminders are off: allow notifications for ONE in the phone's settings to be reminded on the morning a follow-up is due.",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
        }
        val groups = listOf(
            "Overdue" to data.followUps.filter { it.overdue },
            "Due today" to data.followUps.filter { it.dueToday },
            "Upcoming" to data.followUps.filter { !it.overdue && !it.dueToday },
        )
        if (data.followUps.isEmpty()) {
            SectionTitle("Follow-ups")
            PilotCard { Text("No open follow-ups. Add one from a lead when there is something to do next.", Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        groups.filter { it.second.isNotEmpty() }.forEach { (title, items) ->
            SectionTitle(title, trailing = items.size.toString())
            items.forEach { followUp -> FollowUpCard(followUp, data.vocabulary, onOpenLead, onClose = ::close) }
        }
        SectionTitle("Recent field work", trailing = counts?.let { "${it.activitiesThisMonth} this month" })
        if (data.activities.isEmpty()) {
            PilotCard { Text("Nothing logged yet. Open a lead to log a visit, call, meeting or note.", Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        data.activities.take(30).forEach { ActivityCard(it, showLead = true, onOpenLead = onOpenLead, onRemoved = { reload++ }) }
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun FollowUpCard(followUp: GrowthFollowUpDto, vocabulary: GrowthFieldVocabularyDto, onOpenLead: ((String) -> Unit)?, onClose: (GrowthFollowUpDto, Boolean, String?) -> Unit) {
    var cancelling by remember { mutableStateOf(false) }
    PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp).let { if (onOpenLead != null) it.clickable { onOpenLead(followUp.leadId) } else it }) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconBubble(Icons.Filled.Schedule, if (followUp.overdue) Tone.Violet else Tone.Amber, size = 30.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(followUp.title ?: "Text erased after 24 months", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    Text("${followUp.leadName} · ${dueText(followUp)}${if (!followUp.assignee.isMe) " · ${followUp.assignee.email}" else ""}",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (followUp.state == "OPEN") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { onClose(followUp, true, null) }) { Text("Done") }
                    TextButton(onClick = { cancelling = !cancelling }) { Text("Cancel…") }
                }
                if (cancelling) {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        vocabulary.cancelReasons.forEach { reason ->
                            FilterChip(selected = false, onClick = { cancelling = false; onClose(followUp, false, reason) }, label = { Text(prettify(reason)) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ActivityCard(activity: GrowthActivityDto, showLead: Boolean, onOpenLead: ((String) -> Unit)?, onRemoved: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp).let { if (onOpenLead != null) it.clickable { onOpenLead(activity.leadId) } else it }) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconBubble(activityIcon(activity.kind), Tone.Green, size = 30.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(listOfNotNull(activityLabel(activity.kind), activity.outcome?.let(::prettify), if (showLead) activity.leadName else null).joinToString(" · "),
                        style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    Text("${activity.occurredAt?.let(::formatWhen) ?: FIELD_NA} · ${if (activity.author.isMe) "you" else activity.author.email}",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            activity.contact?.let { Text("Met ${it.fullName ?: "an erased contact"} (${prettify(it.role ?: "OTHER")})", style = MaterialTheme.typography.labelSmall) }
            activity.notes?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp)) }
            if (activity.notesErased) Text("Notes erased after 24 months.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            activity.location?.let { location ->
                Text("Location attached, about 100 m: ${"%.3f".format(location.latitude)}, ${"%.3f".format(location.longitude)} (±${location.accuracyM} m). Seen only by ${if (activity.author.isMe) "you and your manager" else "its author and you"}; erased after 180 days.",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                if (activity.author.isMe) {
                    TextButton(onClick = {
                        scope.launch {
                            runCatching { Api.removeGrowthActivityLocation(context, activity.id) }
                                .onSuccess { error = null; onRemoved() }
                                .onFailure { error = "The location could not be removed. Try again with a signal." }
                        }
                    }) { Text("Remove location") }
                }
            }
            activity.locationRemoved?.let { Text("Location removed (${prettify(it.reasonCode)}).", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            error?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error) }
        }
    }
}

/** The field-work part of a lead's detail: the log, the follow-ups, and the two actions. */
@Composable
internal fun LeadFieldSection(leadId: String, leadName: String, onLog: (GrowthFieldVocabularyDto) -> Unit, onFollowUp: () -> Unit, reloadKey: Int) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var field by remember { mutableStateOf<GrowthLeadFieldDto?>(null) }
    var stale by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    var message by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(leadId, reload, reloadKey) {
        val result = runCatching { growthCachedRead(context, leadFieldCache(leadId)) { Api.growthLeadFieldRaw(context, leadId) } }.getOrNull()
        field = result?.first?.let { runCatching { Api.json.decodeFromString<GrowthLeadFieldDto>(it) }.getOrNull() }
        stale = result?.second == true
    }
    SectionTitle("Field work", trailing = if (stale) "Saved copy" else null)
    val data = field
    if (data == null) {
        Text("Field work on this lead is not available offline until it has been opened once with a signal.", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    if (data.canLog) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { onLog(data.vocabulary) }) { Text("Log work") }
            OutlinedButton(onClick = onFollowUp) { Text("Add follow-up") }
        }
    } else {
        Text("Work on this lead is logged by its owner or their manager, while it is open and may be contacted. Claim it first if it is unowned.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    data.followUps.filter { it.state == "OPEN" }.forEach { followUp ->
        FollowUpCard(followUp, data.vocabulary, onOpenLead = null) { item, done, reason ->
            scope.launch {
                val outcome = queueGrowthWrite(context, if (done) "FOLLOW_UP_DONE" else "FOLLOW_UP_CANCEL",
                    "/api/v1/growth/follow-ups/${item.id}/${if (done) "complete" else "cancel"}", if (done) "{}" else Api.growthCancelBody(reason ?: "OTHER"),
                    "${if (done) "Done" else "Cancelled"} · ${item.title ?: leadName}")
                message = when (outcome) {
                    is QueuedOutcome.Sent -> null
                    QueuedOutcome.Waiting -> "Saved on this phone. It will be sent when you are back online."
                    is QueuedOutcome.Refused -> outcome.message
                }
                reload++
            }
        }
    }
    if (data.activities.isEmpty()) {
        Text("No visits, calls, meetings or notes logged yet.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    data.activities.take(20).forEach { ActivityCard(it, showLead = false, onOpenLead = null, onRemoved = { reload++ }) }
}

private val whenChoices = listOf("Now" to 0L, "1 hour ago" to 60L, "3 hours ago" to 180L, "Yesterday" to 1440L)

@Composable
internal fun LogActivityScreen(
    leadId: String,
    leadName: String,
    contacts: List<GrowthContactDto>,
    vocabulary: GrowthFieldVocabularyDto,
    onClose: (String?) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var kind by remember { mutableStateOf("VISIT") }
    var outcome by remember { mutableStateOf("") }
    var contactId by remember { mutableStateOf<String?>(null) }
    var notes by remember { mutableStateOf("") }
    var minutesAgo by remember { mutableStateOf(0L) }
    var fix by remember { mutableStateOf<CoarseFix?>(null) }
    var locating by remember { mutableStateOf(false) }
    var locationNote by remember { mutableStateOf<String?>(null) }
    var showNotice by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    // Captured once, when the screen opens: the time the person was there, not the time it is sent.
    val openedAt = remember { Instant.now() }

    fun locate() {
        locating = true
        scope.launch {
            val found = GrowthLocation.current(context)
            fix = found
            locationNote = if (found == null) "No location could be read. The visit logs without one." else null
            locating = false
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) locate() else locationNote = "Location not attached. Your visit logs without it; nothing else changes."
    }
    fun attach() {
        if (GrowthLocation.permitted(context)) locate() else permission.launch(Manifest.permission.ACCESS_COARSE_LOCATION)
    }

    if (showNotice) {
        AlertDialog(
            onDismissRequest = { showNotice = false },
            title = { Text("Your location on a visit") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    StatusChip("Draft for legal review", ChipKind.Waiting)
                    vocabulary.locationNotice.text.forEach { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp)) }
                    Text("Version ${vocabulary.locationNotice.version}", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(top = 6.dp))
                }
            },
            confirmButton = { TextButton(onClick = {
                showNotice = false
                GrowthReminders.setLocationNoticeSeen(context, vocabulary.locationNotice.version)
                attach()
            }) { Text("Continue") } },
            dismissButton = { TextButton(onClick = { showNotice = false; locationNote = "Location not attached." }) { Text("Not now") } },
        )
    }

    val needsOutcome = kind != "NOTE"
    val locatable = kind == "VISIT" || kind == "MEETING"
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
        TextButton(onClick = { onClose(null) }) { Text("Back to the lead") }
        Text("Log work · $leadName", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        Text("Saved on this phone first and sent when there is a signal. Work more than ${vocabulary.reportMaxAgeDays} days old cannot be logged.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(10.dp))
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            vocabulary.kinds.forEach { value ->
                FilterChip(selected = kind == value, onClick = { kind = value; outcome = ""; if (value != "VISIT" && value != "MEETING") fix = null }, label = { Text(activityLabel(value)) })
            }
        }
        if (needsOutcome) {
            Text("How it went", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 8.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                vocabulary.outcomes.forEach { value -> FilterChip(selected = outcome == value, onClick = { outcome = value }, label = { Text(prettify(value)) }) }
            }
        }
        if (contacts.isNotEmpty()) {
            Text("Who was met", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 8.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = contactId == null, onClick = { contactId = null }, label = { Text("Nobody named") })
                contacts.forEach { contact -> FilterChip(selected = contactId == contact.id, onClick = { contactId = contact.id }, label = { Text(contact.fullName) }) }
            }
        }
        Text("When", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 8.dp))
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            whenChoices.forEach { (label, minutes) -> FilterChip(selected = minutesAgo == minutes, onClick = { minutesAgo = minutes }, label = { Text(label) }) }
        }
        OutlinedTextField(notes, { notes = it.take(vocabulary.notesMax) }, label = { Text(if (kind == "NOTE") "Note (required)" else "Notes (optional)") },
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp), minLines = 3)
        Text("About the organisation only. Do not write personal details about anyone (health, family, opinions of the person).",
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (locatable) {
            Spacer(Modifier.height(10.dp))
            PilotCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp)) {
                    Text("Location (optional)", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    when {
                        fix != null -> {
                            Text("Attached, about 100 m: ${"%.3f".format(fix!!.latitude)}, ${"%.3f".format(fix!!.longitude)} (±${fix!!.accuracyM} m)",
                                style = MaterialTheme.typography.bodySmall)
                            TextButton(onClick = { fix = null }) { Text("Don't attach") }
                        }
                        locating -> Text("Reading your approximate location…", style = MaterialTheme.typography.bodySmall)
                        vocabulary.locationNotice.text.isEmpty() -> Text("Open Field once with a signal to read the location notice before attaching a location.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        else -> OutlinedButton(onClick = {
                            if (GrowthReminders.locationNoticeSeen(context) == vocabulary.locationNotice.version) attach() else showNotice = true
                        }) { Text("Attach my location") }
                    }
                    locationNote?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Text("Only you and your manager see it. Never used for attendance or pay. Erased after ${vocabulary.locationRetentionDays} days.",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp)) }
        Spacer(Modifier.height(10.dp))
        Button(enabled = !busy && !locating && (!needsOutcome || outcome.isNotEmpty()) && (kind != "NOTE" || notes.isNotBlank()), onClick = {
            busy = true
            scope.launch {
                val occurred = openedAt.minus(minutesAgo, ChronoUnit.MINUTES).toString()
                val body = Api.growthActivityBody(kind, if (needsOutcome) outcome else null, contactId, notes.trim().ifBlank { null }, occurred, if (locatable) fix else null)
                when (val result = queueGrowthWrite(context, "ACTIVITY", "/api/v1/growth/leads/$leadId/activities", body, "${activityLabel(kind)} · $leadName")) {
                    is QueuedOutcome.Sent -> onClose("Logged.")
                    QueuedOutcome.Waiting -> onClose("Saved on this phone. It will be sent when you are back online.")
                    is QueuedOutcome.Refused -> error = result.message
                }
                busy = false
            }
        }) { Text("Save") }
    }
}

@Composable
internal fun AddFollowUpScreen(leadId: String, leadName: String, titleMax: Int, onClose: (String?) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    var days by remember { mutableStateOf(1L) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    // Reminders need the notification permission on Android 13+; asked here, where it is useful.
    val notify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (android.os.Build.VERSION.SDK_INT >= 33 && !GrowthReminders.notificationsAllowed(context)) notify.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
    val choices = listOf("Today" to 0L, "Tomorrow" to 1L, "In 3 days" to 3L, "In a week" to 7L, "In 2 weeks" to 14L, "In a month" to 30L)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
        TextButton(onClick = { onClose(null) }) { Text("Back to the lead") }
        Text("Add a follow-up · $leadName", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        OutlinedTextField(title, { title = it.take(titleMax) }, label = { Text("What next") }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
        Text("Due", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 8.dp))
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            choices.forEach { (label, offset) -> FilterChip(selected = days == offset, onClick = { days = offset }, label = { Text(label) }) }
        }
        Text("Due ${formatDate(LocalDate.now().plusDays(days))}. ONE reminds you at 9:00 that morning.", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Spacer(Modifier.height(10.dp))
        Button(enabled = !busy && title.isNotBlank(), onClick = {
            busy = true
            scope.launch {
                val body = Api.growthFollowUpBody(title.trim(), LocalDate.now().plusDays(days).toString())
                when (val result = queueGrowthWrite(context, "FOLLOW_UP", "/api/v1/growth/leads/$leadId/follow-ups", body, "Follow-up · $leadName")) {
                    is QueuedOutcome.Sent -> onClose("Follow-up added.")
                    QueuedOutcome.Waiting -> onClose("Saved on this phone. It will be sent when you are back online.")
                    is QueuedOutcome.Refused -> error = result.message
                }
                busy = false
            }
        }) { Text("Add follow-up") }
    }
}

/** Home's "Today" card: follow-ups due today or overdue, from `/me`. */
@Composable
internal fun GrowthTodayCard(due: Int?, onOpenField: () -> Unit) {
    PilotCard(Modifier.fillMaxWidth().clickable { onOpenField() }) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBubble(Icons.Filled.Groups, Tone.Amber, size = 32.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("Today", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Text(when {
                    due == null -> "$FIELD_NA — follow-ups could not be counted."
                    due == 0 -> "Nothing is due today. New follow-ups appear in Field."
                    due == 1 -> "1 follow-up is due today or overdue. Open Field."
                    else -> "$due follow-ups are due today or overdue. Open Field."
                }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
