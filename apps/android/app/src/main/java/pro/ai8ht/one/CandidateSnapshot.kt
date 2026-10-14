package pro.ai8ht.one

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/**
 * The consented application snapshot on the phone (EMP-07), matching the web.
 *
 * A student sees what applying would share with this employer — their name, education,
 * qualifications without marks, links and the résumé they attach — before they apply, and applies
 * with the hash of exactly that; the server refuses if it changed since. A recruiter opening an
 * applicant sees that same snapshot (read-only), the timeline and the offer, only while the
 * student's applicant-access grant is live. Contact details appear from SHORTLISTED. Résumé
 * downloads stay on the web, where the single-use link is redeemed in the browser.
 *
 * Nothing here can show readiness: no field for it exists in these types.
 */

@Serializable data class SnapshotCandidateDto(
    val fullName: String? = null,
    val email: String? = null,
    val phone: String? = null,
    val contactVisibleFrom: String? = null,
)
@Serializable data class SnapshotEducationDto(
    val institutionName: String? = null,
    val programmeName: String? = null,
    val departmentName: String? = null,
    val expectedGraduationYear: Int? = null,
)
@Serializable data class SnapshotQualificationDto(
    val qualificationType: String,
    val programmeName: String,
    val institutionName: String? = null,
    val startedYear: Int? = null,
    val completedYear: Int? = null,
    val awarded: Boolean = false,
    val verification: String = "SELF_REPORTED",
)
@Serializable data class SnapshotLinkDto(val label: String? = null, val url: String)
@Serializable data class SnapshotResumeDto(val title: String, val filename: String, val versionNumber: Int, val contentType: String, val byteSize: Long)
@Serializable data class ApplicationSnapshotDto(
    val schemaVersion: Int = 1,
    val candidate: SnapshotCandidateDto = SnapshotCandidateDto(),
    val education: SnapshotEducationDto? = null,
    val qualifications: List<SnapshotQualificationDto> = emptyList(),
    val profile: SnapshotProfileDto = SnapshotProfileDto(),
    val links: List<SnapshotLinkDto> = emptyList(),
    val resume: SnapshotResumeDto? = null,
)
@Serializable data class SnapshotProfileDto(val headline: String? = null, val summary: String? = null)
@Serializable data class ResumeOptionDto(val documentId: String, val title: String, val versionNumber: Int, val filename: String)
@Serializable data class ApplicationPreviewDto(
    val employerName: String = "",
    val snapshot: ApplicationSnapshotDto,
    val snapshotHash: String,
    val resumeOptions: List<ResumeOptionDto> = emptyList(),
    /** EMP-13: the student's verified evidence per job skill, to choose from; empty while the feature is off. */
    val evidence: EvidenceOffer = EvidenceOffer(),
)
@Serializable data class ApplicationPreviewEnvelope(val preview: ApplicationPreviewDto)

/** The student's choices for one application; null fields are left out of the request. */
@Serializable data class SnapshotLinkInput(val url: String)
@Serializable data class SnapshotChoices(
    val resumeDocumentId: String? = null,
    val contactPhone: String? = null,
    val links: List<SnapshotLinkInput>? = null,
)
@Serializable private data class PreviewRequest(
    val opportunityId: String,
    val resumeDocumentId: String? = null,
    val contactPhone: String? = null,
    val links: List<SnapshotLinkInput>? = null,
)
@Serializable private data class ApplyRequest(
    val opportunityId: String,
    val consentGranted: Boolean = true,
    val institutionVisibilityGranted: Boolean = false,
    val resumeDocumentId: String? = null,
    val contactPhone: String? = null,
    val links: List<SnapshotLinkInput>? = null,
    val reviewedSnapshotHash: String,
    /** EMP-13: left out of the request when nothing is chosen. */
    val evidenceRecordIds: List<String>? = null,
)

suspend fun Api.previewApplication(context: Context, opportunityId: String, choices: SnapshotChoices): ApplicationPreviewDto =
    json.decodeFromString<ApplicationPreviewEnvelope>(request(
        context, "POST", "/api/v1/students/me/application-previews",
        json.encodeToString(PreviewRequest(opportunityId, choices.resumeDocumentId, choices.contactPhone, choices.links)),
    )).preview

/** Applies with exactly the reviewed snapshot; a change since the review is refused as SNAPSHOT_CHANGED. */
suspend fun Api.applyWithSnapshot(context: Context, opportunityId: String, institutionVisibility: Boolean, choices: SnapshotChoices, reviewedHash: String,
    evidenceIds: List<String> = emptyList()) {
    request(
        context, "POST", "/api/v1/students/me/applications",
        json.encodeToString(ApplyRequest(opportunityId, true, institutionVisibility, choices.resumeDocumentId, choices.contactPhone, choices.links, reviewedHash,
            evidenceIds.takeIf { it.isNotEmpty() })),
    )
}

@Serializable data class CandidateApplicationDto(
    val state: String,
    val title: String = "",
    val appliedVersionNumber: Int = 1,
    val currentVersionNumber: Int? = null,
    val submittedAt: String? = null,
)
@Serializable data class CandidateTimelineEntryDto(val toState: String, val actor: String? = null, val occurredAt: String)
@Serializable data class CandidateInterviewDto(val roundNumber: Int, val mode: String, val state: String, val scheduledStart: String? = null)
@Serializable data class CandidateOfferDto(val state: String, val joiningDate: String? = null, val expiresAt: String? = null)
@Serializable data class CandidateDetailDto(
    val application: CandidateApplicationDto,
    val snapshot: ApplicationSnapshotDto? = null,
    val snapshotStatus: String = "NOT_CAPTURED",
    val sharedAt: String? = null,
    val resumeAvailable: Boolean = false,
    val timeline: List<CandidateTimelineEntryDto> = emptyList(),
    val interviews: List<CandidateInterviewDto> = emptyList(),
    val offer: CandidateOfferDto? = null,
)
@Serializable data class CandidateDetailEnvelope(val candidate: CandidateDetailDto)

suspend fun Api.employerCandidate(context: Context, employerId: String, applicationId: String): CandidateDetailDto =
    json.decodeFromString<CandidateDetailEnvelope>(request(context, "GET", "/api/v1/employers/$employerId/applications/$applicationId")).candidate

private fun verificationLabel(state: String): String = when (state) {
    "VERIFIED" -> "Verified by the college"
    "SELF_REPORTED" -> "Self-reported"
    "PENDING_VERIFICATION" -> "Awaiting the college"
    else -> prettify(state)
}

/** The snapshot itself, as the web shows it. */
@Composable
internal fun SnapshotCard(snapshot: ApplicationSnapshotDto, forEmployer: Boolean) {
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            Text(snapshot.candidate.fullName ?: "NA", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Text(
                if (forEmployer && snapshot.candidate.contactVisibleFrom != null) "Contact details are shown once you shortlist this candidate."
                else "Email: ${snapshot.candidate.email ?: "NA"}  ·  Phone: ${snapshot.candidate.phone ?: if (forEmployer) "NA" else "not shared"}",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(6.dp))
            val education = snapshot.education
            Text(
                listOf(
                    listOfNotNull(education?.programmeName ?: "NA", education?.departmentName).joinToString(", "),
                    education?.institutionName ?: "NA",
                    "Graduating ${education?.expectedGraduationYear ?: "NA"}",
                ).joinToString("  ·  "),
                style = MaterialTheme.typography.bodyMedium,
            )
            snapshot.profile.headline?.let { Spacer(Modifier.height(6.dp)); Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold) }
            snapshot.profile.summary?.let { Spacer(Modifier.height(4.dp)); Text(it, style = MaterialTheme.typography.bodySmall) }
            Spacer(Modifier.height(10.dp))
            Text("Qualifications", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            if (snapshot.qualifications.isEmpty()) Text("No qualifications recorded.", style = MaterialTheme.typography.bodySmall)
            snapshot.qualifications.forEach { q ->
                Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("${q.programmeName} (${q.qualificationType})  ·  ${q.institutionName ?: "NA"}  ·  ${q.startedYear ?: "NA"} – ${q.completedYear ?: "present"}",
                        Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    StatusChip(verificationLabel(q.verification), if (q.verification == "VERIFIED") ChipKind.Positive else ChipKind.Waiting)
                }
            }
            Spacer(Modifier.height(10.dp))
            Text("Links", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            Text(if (snapshot.links.isEmpty()) "No links shared." else snapshot.links.joinToString("\n") { (it.label?.let { label -> "$label: " } ?: "") + it.url },
                style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(10.dp))
            Text("Résumé", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            Text(snapshot.resume?.let { "${it.title} — ${it.filename}, version ${it.versionNumber}" } ?: "No résumé attached.",
                style = MaterialTheme.typography.bodySmall)
        }
    }
}

/**
 * The student's review step before applying: the snapshot, the résumé to attach, and an optional
 * phone and link. [onPreview] reports the preview and the choices it was built from, so apply
 * sends exactly what was on screen.
 */
@Composable
internal fun ApplicationReviewSection(
    opportunityId: String,
    employerName: String,
    enabled: Boolean,
    onPreview: (ApplicationPreviewDto?, SnapshotChoices) -> Unit,
    reload: Int,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var preview by remember { mutableStateOf<ApplicationPreviewDto?>(null) }
    var failed by remember { mutableStateOf(false) }
    var resume by remember { mutableStateOf<String?>(null) }
    var phone by remember { mutableStateOf("") }
    var link by remember { mutableStateOf("") }
    var requested by remember { mutableStateOf(SnapshotChoices()) }
    var problem by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(opportunityId, requested, reload) {
        runCatching { Api.previewApplication(context, opportunityId, requested) }
            .onSuccess { preview = it; failed = false; problem = null; onPreview(it, requested) }
            .onFailure {
                problem = when ((it as? Api.ApiException)?.code) {
                    "RESUME_NOT_AVAILABLE" -> "That résumé cannot be attached. Choose one with an uploaded file, or apply without one."
                    "INVALID_CONTACT_PHONE" -> "Enter a phone number with at least 7 digits, or leave it empty."
                    "INVALID_LINK_URL" -> "Links must start with https://."
                    else -> null
                }
                if (preview == null) { failed = true; onPreview(null, requested) }
            }
    }

    Text("What $employerName will see", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(4.dp))
    Text("A copy of your profile as it stands now, kept with your application and never updated. It never includes readiness, marks or your photo. Contact details reach the employer only if they shortlist you.",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(8.dp))
    val shown = preview
    when {
        shown != null -> {
            SnapshotCard(shown.snapshot, forEmployer = false)
            Spacer(Modifier.height(8.dp))
            Text("Résumé to attach", style = MaterialTheme.typography.labelLarge)
            val options = listOf<Pair<String?, String>>(null to "No résumé") + shown.resumeOptions.map { it.documentId to "${it.title} — ${it.filename} (version ${it.versionNumber})" }
            options.forEach { (id, label) ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = resume == id, enabled = enabled, onClick = { resume = id })
                    Text(label, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (shown.resumeOptions.isEmpty()) Text("Upload a résumé under Documents to attach one.", style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(phone, { phone = it.take(20) }, Modifier.fillMaxWidth(), enabled = enabled, singleLine = true, label = { Text("Phone for this employer (optional)") })
            OutlinedTextField(link, { link = it.take(256) }, Modifier.fillMaxWidth(), enabled = enabled, singleLine = true, label = { Text("A link to share (optional, https://)") })
            val wanted = SnapshotChoices(resume, phone.trim().ifBlank { null }, link.trim().ifBlank { null }?.let { listOf(SnapshotLinkInput(it)) })
            TextButton(onClick = { requested = wanted }, enabled = enabled) { Text("Update what I share") }
            if (wanted != requested) Text("Tap \"Update what I share\" to include your changes; applying now shares what is shown above.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            problem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        }
        failed -> Text("What you would share could not be shown right now.", style = MaterialTheme.typography.bodySmall)
        else -> LoadingSpinner()
    }
}

/**
 * EMP-07 for the recruiter: what the applicant shared, their timeline and the offer. Loaded on
 * open and refused by the server once the student's grant has ended, which this says plainly.
 */
@Composable
internal fun CandidateSharedCards(employerId: String, applicationId: String, reload: Int) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var candidate by remember { mutableStateOf<CandidateDetailDto?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(employerId, applicationId, reload) {
        runCatching { Api.employerCandidate(context, employerId, applicationId) }
            .onSuccess { candidate = it; failure = null }
            .onFailure {
                candidate = null
                failure = if ((it as? Api.ApiException)?.status == 403) "This candidate is no longer sharing their details with you."
                else "What this candidate shared could not be loaded."
            }
    }
    Spacer(Modifier.height(12.dp))
    Text("What they shared with you", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(6.dp))
    val record = candidate
    when {
        failure != null -> Text(failure!!, style = MaterialTheme.typography.bodySmall)
        record == null -> LoadingSpinner()
        else -> {
            val snapshot = record.snapshot
            if (snapshot != null) {
                record.sharedAt?.let { Text("Shared when they applied, ${formatWhen(it)}. Not their live profile.", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant) }
                Spacer(Modifier.height(6.dp))
                SnapshotCard(snapshot, forEmployer = true)
                if (record.resumeAvailable) {
                    Spacer(Modifier.height(4.dp))
                    Text("Download the résumé from Candidate Detail on the web; each download is recorded.", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else Text(when (record.snapshotStatus) {
                "ERASED" -> "This person deleted their ONE account. What they shared has been erased."
                "NOT_CAPTURED" -> "This person applied before ONE kept a copy of what was shared. Their live profile is not shown in its place."
                else -> "What this person shared could not be shown."
            }, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(12.dp))
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text("Timeline", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    Text("${record.application.title}  ·  applied under version ${record.application.appliedVersionNumber}", style = MaterialTheme.typography.bodySmall)
                    record.timeline.forEach { entry ->
                        Text("${prettify(entry.toState)}  ·  ${formatWhen(entry.occurredAt)}${if (entry.actor == "STUDENT") "  ·  by the candidate" else ""}",
                            style = MaterialTheme.typography.bodySmall)
                    }
                    Spacer(Modifier.height(6.dp))
                    Text("Interviews: ${if (record.interviews.isEmpty()) "none yet" else record.interviews.joinToString { "round ${it.roundNumber} ${prettify(it.state).lowercase()}" }}",
                        style = MaterialTheme.typography.bodySmall)
                    Text("Offer: ${record.offer?.let { prettify(it.state) } ?: "none yet"}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}
