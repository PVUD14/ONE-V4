package pro.ai8ht.one

// The college pipeline on the phone (GROWTH-04; design §6). On a lead, the person sees its stage,
// moves it (a hold or a loss asks for a reason; a backward move does too), asks operations to onboard
// a signed college — the agreement reference the college gave and which contacts to hand over — and,
// once operations has linked it, follows onboarding through milestones read from Operations' own
// records: NA where there is no source, "<5" for a small count, never a student or an amount.
//
// GROWTH-05: on an employer lead, the employer's milestones from the start (access request,
// onboarding, verification, terms, first job with how many are published now, campus drives per
// state) and the access requests linked to it, with whether the referral link was yours or another
// team member's. Counts and states only: never a job's content, an applicant or a college.
//
// Moves and the handoff request go through GrowthQueue (offline-safe, sent once). A move carries the
// stage the person saw; if the lead moved meanwhile the server refuses it and the queue says so.

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RemoveCircleOutline
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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

private val milestoneLabels = mapOf(
    "HANDED_OFF" to "Handed off to operations",
    "CONTRACT_RECORDED" to "Contract recorded by operations",
    "VERIFIED" to "College verified",
    "ADMIN_JOINED" to "College administrator joined",
    "DATA_TERMS_ACCEPTED" to "Data-processing terms accepted",
    "FIRST_ROSTER" to "First students rostered",
    "STUDENTS_ACTIVATING" to "Students activating",
    "FIRST_PAYMENT_CLEARED" to "First payment cleared",
    "EXITED" to "College left ONE",
    "ACCESS_REQUESTED" to "Asked for employer access",
    "ONBOARDED" to "Onboarded by operations",
    "TERMS_ACCEPTED" to "Employer terms accepted",
    "FIRST_JOB_PUBLISHED" to "First job published",
    "CAMPUS_DRIVE" to "Campus drives",
    "SUSPENDED" to "Suspended by operations",
)

private val requestStateLabels = mapOf("PENDING" to "Waiting for operations", "ONBOARDED" to "Onboarded", "DECLINED" to "Declined", "SPAM" to "Closed as spam")

private fun milestoneCounts(milestone: GrowthMilestoneDto): String? = when {
    milestone.counts.isEmpty() -> null
    milestone.code == "FIRST_JOB_PUBLISHED" -> "${milestone.counts["PUBLISHED_NOW"] ?: 0} published now"
    else -> milestone.counts.entries.joinToString(" · ") { "${it.value} ${prettify(it.key).lowercase()}" }
}

private val contractReferencePattern = Regex("^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,63}$")

private fun milestoneValue(milestone: GrowthMilestoneDto): String = when {
    milestone.state == "NA" -> "NA"
    milestone.code == "STUDENTS_ACTIVATING" && milestone.count != null -> if (milestone.count.suppressed) "<5" else milestone.count.value?.toString() ?: "NA"
    milestone.state == "REACHED" -> milestone.at?.let(::formatWhen) ?: "Reached"
    else -> "Not yet"
}

@Composable
internal fun LeadPipelineSection(leadId: String, leadName: String, contacts: List<GrowthContactDto>, reloadKey: Int, onChanged: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pipeline by remember { mutableStateOf<GrowthLeadPipelineDto?>(null) }
    var stale by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    var target by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var handingOff by remember { mutableStateOf(false) }
    var reference by remember { mutableStateOf("") }
    var handover by remember { mutableStateOf(setOf<String>()) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(leadId, reload, reloadKey) {
        val result = runCatching { growthCachedRead(context, "growth:pipeline:$leadId") { Api.growthLeadPipelineRaw(context, leadId) } }.getOrNull()
        pipeline = result?.first?.let { runCatching { Api.json.decodeFromString<GrowthLeadPipelineDto>(it) }.getOrNull() }
        stale = result?.second == true
    }

    fun send(kind: String, path: String, body: String, label: String) {
        busy = true
        scope.launch {
            message = when (val outcome = queueGrowthWrite(context, kind, path, body, label)) {
                is QueuedOutcome.Sent -> null
                QueuedOutcome.Waiting -> "Saved on this phone. It will be sent when you are back online."
                is QueuedOutcome.Refused -> outcome.message
            }
            target = null; handingOff = false; busy = false
            reload++
            onChanged()
        }
    }

    SectionTitle("Pipeline", trailing = if (stale) "Saved copy" else null)
    val data = pipeline
    if (data == null) {
        Text("The pipeline is not available offline until this lead has been opened once with a signal.", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        StatusChip(prettify(data.stage), ChipKind.Accent)
        data.lostReasonCode?.let { StatusChip("Lost: ${prettify(it)}", ChipKind.Muted) }
    }
    message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 4.dp)) }

    if (data.nextStages.isNotEmpty()) {
        Text("Move to", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 8.dp))
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            data.nextStages.forEach { stage ->
                FilterChip(selected = target == stage, onClick = { target = if (target == stage) null else stage },
                    label = { Text(if (stage == "RESUME") "Resume" else prettify(stage)) })
            }
        }
        target?.let { chosen ->
            val reasons = when (chosen) {
                "LOST" -> data.vocabulary.reasons.lost
                "ON_HOLD" -> data.vocabulary.reasons.hold
                else -> data.vocabulary.reasons.backward
            }
            val required = chosen == "LOST" || chosen == "ON_HOLD"
            if (chosen == "RESUME") {
                Button(enabled = !busy, onClick = { send("STAGE_MOVE", "/api/v1/growth/leads/$leadId/stage", Api.growthStageBody(data.stage, "RESUME", null), "Resume · $leadName") }) { Text("Resume") }
            } else {
                Text(if (required) "Why (required)" else "Moving back? Say why. Moving forward needs no reason.", style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (!required) {
                        OutlinedButton(enabled = !busy, onClick = { send("STAGE_MOVE", "/api/v1/growth/leads/$leadId/stage", Api.growthStageBody(data.stage, chosen, null), "${prettify(chosen)} · $leadName") }) { Text("Move") }
                    }
                    reasons.forEach { reason ->
                        FilterChip(selected = false, enabled = !busy, onClick = {
                            send("STAGE_MOVE", "/api/v1/growth/leads/$leadId/stage", Api.growthStageBody(data.stage, chosen, reason), "${prettify(chosen)} · $leadName")
                        }, label = { Text(prettify(reason)) })
                    }
                }
            }
        }
    } else if (data.stage == "HANDOFF_REQUESTED" && data.milestones == null) {
        Text("Waiting for operations to onboard the college. The stage moves again only if they decline the request.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
    }

    if (data.canRequestHandoff) {
        Spacer(Modifier.height(8.dp))
        if (!handingOff) {
            Button(onClick = { handingOff = true }) { Text("Hand the college to operations") }
        } else {
            PilotCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp)) {
                    Text("Hand the college to operations", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    Text("Operations creates and verifies the college. Contacts you hand over move to the college's account and are erased from this lead.",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedTextField(reference, { reference = it.take(64) }, label = { Text("Agreement reference the college gave you") }, modifier = Modifier.fillMaxWidth())
                    if (reference.isNotBlank() && !contractReferencePattern.matches(reference.trim())) {
                        Text("Letters, digits and / _ . : - only. No amounts or names.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                    }
                    contacts.forEach { contact ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = contact.id in handover, onCheckedChange = { handover = if (it) handover + contact.id else handover - contact.id })
                            Text("${contact.fullName} (${prettify(contact.role)})", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    Button(enabled = !busy && contractReferencePattern.matches(reference.trim()), onClick = {
                        send("HANDOFF_REQUEST", "/api/v1/growth/leads/$leadId/handoff", Api.growthHandoffBody(reference.trim(), handover.toList()), "Handoff · $leadName")
                    }) { Text("Request the handoff") }
                }
            }
        }
    }

    data.handoffRequests.take(3).forEach { item ->
        Text("Handoff ${prettify(item.state).lowercase()} · reference ${item.contractReferenceReported}" +
            (item.declineReasonCode?.let { " · declined: ${prettify(it)}" } ?: "") +
            (if (item.state == "LINKED") " · ${item.contactsCarried ?: 0} contact(s) moved to the account" else ""),
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
    }

    if (data.kind == "EMPLOYER") {
        SectionTitle("Access requests")
        if (data.accessRequests.isEmpty()) {
            Text("No access request from this company yet. Share your referral link, or ask them to use the request form with their work email.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        data.accessRequests.forEach { item ->
            Text((item.receivedAt?.let(::formatWhen) ?: "NA") + " · " + (requestStateLabels[item.state] ?: prettify(item.state)) +
                when (item.referral) { "YOU" -> " · through your referral link"; "ANOTHER_TEAM_MEMBER" -> " · through another team member's referral link"; else -> "" },
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
        }
    }

    data.milestones?.let { milestones ->
        SectionTitle("Onboarding")
        PilotCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp)) {
                milestones.forEach { milestone ->
                    Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconBubble(when (milestone.state) { "REACHED" -> Icons.Filled.CheckCircle; "NA" -> Icons.Filled.RemoveCircleOutline; else -> Icons.Filled.Schedule },
                            if (milestone.code == "SUSPENDED" && milestone.state == "REACHED") Tone.Amber
                            else when (milestone.state) { "REACHED" -> Tone.Green; "NA" -> Tone.Violet; else -> Tone.Amber }, size = 26.dp)
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(if (milestone.code == "VERIFIED" && data.kind == "EMPLOYER") "Employer verified" else milestoneLabels[milestone.code] ?: prettify(milestone.code),
                                style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                            milestone.note?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            milestoneCounts(milestone)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                        Text(milestoneValue(milestone), style = MaterialTheme.typography.labelMedium)
                    }
                }
                Text(if (data.kind == "EMPLOYER") "Read from operations' and the employer's records each time; counts and states only, never a job's content, an applicant or a college."
                    else "Read from operations' records each time; nothing here names a student or shows an amount.",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
}
