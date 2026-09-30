package pro.ai8ht.one

import android.content.Context
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/**
 * Consented, per-skill verified evidence on an application (EMP-13, ADR-043), matching the web.
 *
 * A student ticks which of their verified evidence to share with one employer while applying, and
 * can change or take any of it back later from the application; a recruiter opening an applicant
 * sees exactly those items per job skill — the kind of evidence, where it came from, the date and
 * whether it was unaided — or "no evidence shared". There is no total, percentage, score, stage or
 * ranking in these types or on these screens, and nothing shows while the feature is off (HG-4
 * pending): the server says `available = false`. Filtering applicants by skill stays on the web,
 * where the per-job applicant list lives.
 */

@Serializable data class EvidenceItemDto(
    val type: String,
    val source: String,
    val occurredAt: String? = null,
    val unaided: Boolean = false,
    /** The student's own item id, to choose by; never sent to an employer. */
    val evidenceId: String? = null,
    val shared: Boolean = false,
)
@Serializable data class EvidenceSkillDto(
    val name: String,
    val level: String = "REQUIRED",
    /** False for a free-text job skill: no evidence can be matched to it. */
    val catalogue: Boolean = false,
    val items: List<EvidenceItemDto> = emptyList(),
)
@Serializable data class EvidenceOffer(val available: Boolean = false, val skills: List<EvidenceSkillDto> = emptyList())
@Serializable data class StudentApplicationEvidenceDto(
    val available: Boolean = false,
    val canShare: Boolean = false,
    val employerName: String = "",
    val skills: List<EvidenceSkillDto> = emptyList(),
)
@Serializable private data class StudentEvidenceEnvelope(val evidence: StudentApplicationEvidenceDto)
@Serializable private data class EmployerEvidenceEnvelope(val evidence: EvidenceOffer = EvidenceOffer())
@Serializable private data class EvidenceSelection(val evidenceRecordIds: List<String>)

suspend fun Api.myApplicationEvidence(context: Context, applicationId: String): StudentApplicationEvidenceDto =
    json.decodeFromString<StudentEvidenceEnvelope>(request(context, "GET", "/api/v1/students/me/applications/$applicationId/evidence")).evidence

/** Replaces what one application shares; anything left out is taken back at once. */
suspend fun Api.setMyApplicationEvidence(context: Context, applicationId: String, evidenceIds: List<String>): StudentApplicationEvidenceDto =
    json.decodeFromString<StudentEvidenceEnvelope>(request(
        context, "PUT", "/api/v1/students/me/applications/$applicationId/evidence",
        json.encodeToString(EvidenceSelection(evidenceIds)),
    )).evidence

suspend fun Api.employerCandidateEvidence(context: Context, employerId: String, applicationId: String): EvidenceOffer =
    json.decodeFromString<EmployerEvidenceEnvelope>(request(context, "GET", "/api/v1/employers/$employerId/applications/$applicationId/evidence")).evidence

private fun typeLabel(type: String): String = when (type) {
    "ASSESSMENT_OUTCOME" -> "Assessment outcome"
    "TOPIC_DEMONSTRATION" -> "Topic demonstration"
    else -> "Evidence"
}
private fun sourceLabel(source: String): String = when (source) {
    "ONE_SKILL_CHECK" -> "ONE skill check"
    "INSTITUTION_EXAM" -> "Institution exam"
    else -> "ONE record"
}

/** One item in words, the same for the student and the employer. */
internal fun describeEvidence(item: EvidenceItemDto): String =
    "${typeLabel(item.type)}  ·  ${sourceLabel(item.source)}  ·  ${item.occurredAt?.let { formatWhen(it) } ?: "NA"}  ·  " +
        if (item.unaided) "unaided" else "aided (hint or tutor)"

private fun skillHeading(skill: EvidenceSkillDto): String = skill.name + if (skill.level == "PREFERRED") " (preferred)" else ""

private const val WHAT_IS_SHARED = "The employer sees only the items you tick, for this application: the skill, the kind of evidence, where it came from, the date and whether it was unaided. Never your readiness, marks, scores or a total. You can take any item back at any time."

/** The student's checklist, per job skill. */
@Composable
internal fun EvidenceChoiceList(skills: List<EvidenceSkillDto>, selected: Set<String>, enabled: Boolean, onToggle: (String, Boolean) -> Unit) {
    if (skills.isEmpty()) {
        Text("This job lists no skills, so there is no evidence to match.", style = MaterialTheme.typography.bodySmall)
        return
    }
    skills.forEach { skill ->
        Spacer(Modifier.height(6.dp))
        Text(skillHeading(skill), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        when {
            !skill.catalogue -> Text("Not a ONE catalogue skill, so no evidence can be matched to it.", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            skill.items.isEmpty() -> Text("You have no verified evidence for this skill yet.", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> skill.items.forEach { item ->
                val id = item.evidenceId ?: return@forEach
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = id in selected, enabled = enabled, onCheckedChange = { onToggle(id, it) })
                    Text(describeEvidence(item), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

/** The apply-time card; renders nothing while the feature is off. */
@Composable
internal fun ApplyEvidenceCard(offer: EvidenceOffer?, employerName: String, selected: Set<String>, enabled: Boolean, onToggle: (String, Boolean) -> Unit) {
    if (offer?.available != true) return
    Spacer(Modifier.height(10.dp))
    Text("Verified skill evidence to share with $employerName (optional)", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(4.dp))
    Text(WHAT_IS_SHARED, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    EvidenceChoiceList(offer.skills, selected, enabled, onToggle)
}

/** After applying: change or take back what one application shares. */
@Composable
internal fun ApplicationEvidencePage(applicationId: String, title: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var evidence by remember { mutableStateOf<StudentApplicationEvidenceDto?>(null) }
    var selected by remember { mutableStateOf(emptySet<String>()) }
    var notice by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    fun show(loaded: StudentApplicationEvidenceDto) {
        evidence = loaded
        selected = loaded.skills.flatMap { skill -> skill.items.filter { it.shared }.mapNotNull { it.evidenceId } }.toSet()
    }
    fun save(ids: List<String>, message: String) {
        busy = true
        scope.launch {
            runCatching { Api.setMyApplicationEvidence(context, applicationId, ids) }
                .onSuccess { show(it); notice = message }
                .onFailure {
                    notice = when ((it as? Api.ApiException)?.code) {
                        "APPLICATION_CLOSED" -> "This application has ended, so nothing new can be shared. You can still take items back."
                        "EVIDENCE_SHARING_UNAVAILABLE" -> "Sharing new evidence is not available right now. You can still take items back."
                        "EVIDENCE_NOT_SHAREABLE" -> "One of those items can no longer be shared. Close this and choose again."
                        else -> "Your choice could not be saved. Try again."
                    }
                }
            busy = false
        }
    }
    LaunchedEffect(applicationId) {
        runCatching { Api.myApplicationEvidence(context, applicationId) }
            .onSuccess { show(it) }
            .onFailure { failed = true }
    }

    OverlayScaffold(title = "Skill evidence", onClose = onClose) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(12.dp))
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(4.dp))
                    Text(WHAT_IS_SHARED, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    notice?.let { Spacer(Modifier.height(8.dp)); Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
                    val record = evidence
                    when {
                        failed -> Text("Your evidence for this application could not be loaded.", style = MaterialTheme.typography.bodySmall)
                        record == null -> LoadingSpinner()
                        else -> {
                            if (!record.canShare) {
                                Spacer(Modifier.height(8.dp))
                                Text(
                                    if (record.available) "This application has ended, so nothing new can be shared. You can still take items back."
                                    else "Sharing new evidence is not available right now. Anything already shared is listed so you can take it back.",
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                            EvidenceChoiceList(record.skills, selected, !busy) { id, on -> selected = if (on) selected + id else selected - id }
                            Spacer(Modifier.height(12.dp))
                            Button(onClick = { save(selected.toList(), "Saved. ${record.employerName} now sees what is ticked above.") },
                                enabled = !busy, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) { Text("Save what I share") }
                            if (record.skills.any { skill -> skill.items.any { it.shared } }) {
                                Spacer(Modifier.height(6.dp))
                                OutlinedButton(onClick = { save(emptyList(), "Stopped. ${record.employerName} no longer sees any of your evidence for this application.") },
                                    enabled = !busy, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) { Text("Stop sharing all evidence") }
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

/**
 * The recruiter's Evidence card on an applicant. Loads its own route (audited by the server);
 * renders nothing while the feature is off, and says plainly when nothing is shared for a skill.
 */
@Composable
internal fun CandidateEvidenceSection(employerId: String, applicationId: String, reload: Int) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var offer by remember { mutableStateOf<EvidenceOffer?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(employerId, applicationId, reload) {
        runCatching { Api.employerCandidateEvidence(context, employerId, applicationId) }
            .onSuccess { offer = it; failure = null }
            .onFailure {
                offer = null
                failure = if ((it as? Api.ApiException)?.status == 403) "This candidate is no longer sharing their details with you."
                else "The evidence this candidate shared could not be loaded."
            }
    }
    val record = offer
    if (failure == null && record?.available != true) return
    Spacer(Modifier.height(12.dp))
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            Text("Skill evidence", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            failure?.let { Text(it, style = MaterialTheme.typography.bodySmall); return@Column }
            Text("Verified by ONE from the candidate's graded work, shown only because they chose to share it for this application. Nothing here is totalled, graded or ranked.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val skills = record?.skills.orEmpty()
            if (skills.isEmpty()) Text("This job lists no skills, so there is no evidence to show.", style = MaterialTheme.typography.bodySmall)
            skills.forEach { skill ->
                Spacer(Modifier.height(8.dp))
                Text(skillHeading(skill), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                when {
                    !skill.catalogue -> Text("Not a ONE catalogue skill, so evidence cannot be matched to it.", style = MaterialTheme.typography.bodySmall)
                    skill.items.isEmpty() -> Text("No evidence shared.", style = MaterialTheme.typography.bodySmall)
                    else -> skill.items.forEach { item ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(describeEvidence(item), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                            StatusChip(if (item.unaided) "Unaided" else "Aided", if (item.unaided) ChipKind.Positive else ChipKind.Waiting)
                        }
                    }
                }
            }
        }
    }
}
