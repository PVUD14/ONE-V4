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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/**
 * Placement-office nominations on the phone (INST-14), matching the web.
 *
 * The student's college may put them forward for one of its campus drives. Under My applications
 * the student sees each nomination — who nominated them (the college and the nominator's role), for
 * which employer and job, why, and the college's note — and, before answering, exactly what opting
 * in would share (the EMP-07 review the apply screen uses). Opting in is applying with that reviewed
 * snapshot; declining is recorded, never shown to the employer, and the college sees only "not
 * opted in". Withdrawing the application later withdraws the consent. Nominating is a desk task on
 * the web; the college's nomination list is not carried to the phone.
 */

@Serializable data class NominatedByDto(val role: String = "", val label: String = "Placement office")
@Serializable data class NominationOpportunityDto(
    val id: String,
    val title: String? = null,
    val employerName: String = "",
    val applicationDeadline: String? = null,
)
@Serializable data class NominationDriveDto(
    val state: String = "",
    val scheduledStartAt: String? = null,
    val scheduledEndAt: String? = null,
    val venueMode: String? = null,
)
@Serializable data class StudentNominationDto(
    val id: String,
    /** INVITED, ACCEPTED, DECLINED, WITHDRAWN, CANCELLED, or CLOSED once the drive has ended. */
    val state: String = "INVITED",
    val institutionName: String = "",
    val nominatedBy: NominatedByDto = NominatedByDto(),
    val reasonCode: String = "",
    val note: String? = null,
    val nominatedAt: String? = null,
    val respondedAt: String? = null,
    val opportunity: NominationOpportunityDto,
    val drive: NominationDriveDto = NominationDriveDto(),
    val applicationId: String? = null,
    val applicationState: String? = null,
    val alreadyApplied: Boolean = false,
    val canRespond: Boolean = false,
    val blocksYou: Boolean = false,
)
@Serializable data class NominationsEnvelope(val nominations: List<StudentNominationDto> = emptyList())

@Serializable private data class AcceptNominationRequest(
    val consentGranted: Boolean = true,
    val institutionVisibilityGranted: Boolean = false,
    val resumeDocumentId: String? = null,
    val contactPhone: String? = null,
    val links: List<SnapshotLinkInput>? = null,
    val reviewedSnapshotHash: String,
)

suspend fun Api.listMyNominations(context: Context): List<StudentNominationDto> =
    json.decodeFromString<NominationsEnvelope>(request(context, "GET", "/api/v1/students/me/nominations")).nominations

/** Opting in applies, with exactly the reviewed snapshot; the server requires the hash for a nomination. */
suspend fun Api.acceptNomination(context: Context, nominationId: String, institutionVisibility: Boolean, choices: SnapshotChoices, reviewedHash: String) {
    request(
        context, "POST", "/api/v1/students/me/nominations/$nominationId/accept",
        json.encodeToString(AcceptNominationRequest(true, institutionVisibility, choices.resumeDocumentId, choices.contactPhone, choices.links, reviewedHash)),
    )
}

suspend fun Api.declineNomination(context: Context, nominationId: String) {
    request(context, "POST", "/api/v1/students/me/nominations/$nominationId/decline", "{}")
}

private val nominationStateLabels = mapOf(
    "INVITED" to "Waiting for your answer", "ACCEPTED" to "You opted in", "DECLINED" to "You declined",
    "WITHDRAWN" to "You withdrew", "CANCELLED" to "Your college withdrew this nomination", "CLOSED" to "Closed — the drive has ended",
)
private val nominationReasonWords = mapOf(
    "MEETS_ELIGIBILITY" to "You meet the role's eligibility rules",
    "PLACEMENT_OFFICE_SHORTLIST" to "The placement office shortlisted you",
    "STUDENT_EXPRESSED_INTEREST" to "You told the placement office you were interested",
)
private val venueWords = mapOf("ON_CAMPUS" to "On campus", "VIRTUAL" to "Virtual", "OFF_CAMPUS" to "Off campus")

private fun nominationError(error: Throwable, fallback: String): String = when ((error as? Api.ApiException)?.code) {
    "NOMINATION_REVIEW_REQUIRED" -> "Review what would be shared before opting in."
    "NOMINATION_NOT_OPEN" -> "This nomination can no longer be answered."
    "NOMINATION_CLOSED" -> "The campus drive for this nomination has ended."
    "ALREADY_APPLIED" -> "You have already applied to this role."
    "PLACEMENT_POLICY_ONE_OFFER" -> "Your college allows one accepted offer per student, and you already hold one, so you cannot apply through its campus drive."
    "SNAPSHOT_CHANGED" -> "Something you would share changed after you reviewed it. Check it again, then opt in."
    "ELIGIBILITY_NOT_MET" -> "You do not meet a rule this employer requires. Open the role to see which."
    "ELIGIBILITY_UNKNOWN" -> "ONE cannot confirm a rule this employer requires yet. Open the role to see what is missing."
    else -> (error as? Api.ApiException)?.detail ?: fallback
}

/** The nominations list at the top of My applications. Nothing is drawn when there are none. */
@Composable
internal fun NominationsSection(nominations: List<StudentNominationDto>?, failed: Boolean, onOpen: (StudentNominationDto) -> Unit) {
    if (failed) {
        Spacer(Modifier.height(12.dp))
        Text("Your nominations could not be loaded right now.", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    if (nominations.isNullOrEmpty()) return
    Spacer(Modifier.height(12.dp))
    Text("Nominations from your college", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
    Text("Nothing about you is shared with the employer unless you opt in, and you can decline without any effect on your standing.",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    nominations.forEach { nomination ->
        Spacer(Modifier.height(10.dp))
        PilotCard {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f)) {
                        Text(nomination.opportunity.title ?: "Untitled role", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text(nomination.opportunity.employerName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    StatusChip(nominationStateLabels[nomination.state] ?: prettify(nomination.state), when (nomination.state) {
                        "INVITED" -> ChipKind.Waiting
                        "ACCEPTED" -> ChipKind.Positive
                        else -> ChipKind.Muted
                    })
                }
                Spacer(Modifier.height(6.dp))
                Text("Nominated by ${nomination.nominatedBy.label}, ${nomination.institutionName}", style = MaterialTheme.typography.bodySmall)
                if (nomination.canRespond) {
                    Spacer(Modifier.height(6.dp))
                    TextButton(onClick = { onOpen(nomination) }) { Text("Review and decide") }
                }
            }
        }
    }
}

/** One nomination: who, to whom, why, what would be shared, and the answer. */
@Composable
internal fun NominationReviewPage(nomination: StudentNominationDto, onClose: () -> Unit, onAnswered: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var reviewed by remember { mutableStateOf<Pair<ApplicationPreviewDto, SnapshotChoices>?>(null) }
    var reviewReload by remember { mutableIntStateOf(0) }
    var share by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val employer = nomination.opportunity.employerName
    val canOptIn = nomination.canRespond && !nomination.blocksYou && !nomination.alreadyApplied

    OverlayScaffold(title = "Nomination", onClose = onClose) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(10.dp))
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text(nomination.opportunity.title ?: "Untitled role", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(employer, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(8.dp))
                    Text("Nominated by ${nomination.nominatedBy.label}, ${nomination.institutionName} · ${nomination.nominatedAt?.let { formatWhen(it) } ?: "NA"}",
                        style = MaterialTheme.typography.bodySmall)
                    Text("Why: ${nominationReasonWords[nomination.reasonCode] ?: "Chosen by your placement office"}", style = MaterialTheme.typography.bodySmall)
                    nomination.note?.let { Text("\"$it\"", style = MaterialTheme.typography.bodySmall) }
                    Text("Drive: ${nomination.drive.scheduledStartAt?.let { formatWhen(it) } ?: "NA"}" +
                        (nomination.drive.venueMode?.let { " · ${venueWords[it] ?: prettify(it)}" } ?: "") +
                        " · applications close ${nomination.opportunity.applicationDeadline?.let { formatWhen(it) } ?: "NA"}",
                        style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(6.dp))
                    StatusChip(nominationStateLabels[nomination.state] ?: prettify(nomination.state), ChipKind.Accent)
                }
            }
            if (nomination.blocksYou) {
                Spacer(Modifier.height(10.dp))
                Text("Your college's one-offer policy stops you applying through this drive, because you already hold an accepted offer.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            if (nomination.alreadyApplied) {
                Spacer(Modifier.height(10.dp))
                Text("You have already applied to this role yourself. Track it under My applications.", style = MaterialTheme.typography.bodySmall)
            }
            problem?.let {
                Spacer(Modifier.height(10.dp))
                Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(10.dp)) {
                    Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
                }
            }
            if (canOptIn) {
                Spacer(Modifier.height(12.dp))
                PilotCard {
                    Column(Modifier.padding(16.dp)) {
                        Text("Opting in applies to this role for you, sharing this copy of your profile with $employer for this role only. " +
                            "Your college sees that you opted in; it follows your application only if you also share it below. " +
                            "You can withdraw at any time from My applications, which ends the employer's access.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(10.dp))
                        ApplicationReviewSection(
                            opportunityId = nomination.opportunity.id,
                            employerName = employer,
                            enabled = !busy,
                            onPreview = { preview, choices -> reviewed = preview?.let { it to choices } },
                            reload = reviewReload,
                        )
                        Spacer(Modifier.height(10.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = share, onCheckedChange = { share = it }, enabled = !busy)
                            Text("Also share this application's employer, role, stage, key dates and offer response with my college (optional). Never pay.",
                                Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        }
                        Spacer(Modifier.height(10.dp))
                        Button(
                            onClick = {
                                val review = reviewed ?: return@Button
                                busy = true; problem = null
                                scope.launch {
                                    runCatching { Api.acceptNomination(context, nomination.id, share, review.second, review.first.snapshotHash) }
                                        .onSuccess { onAnswered("You opted in. Your application to $employer is under My applications.") }
                                        .onFailure {
                                            problem = nominationError(it, "Your answer could not be saved.")
                                            if ((it as? Api.ApiException)?.code == "SNAPSHOT_CHANGED") reviewReload++
                                        }
                                    busy = false
                                }
                            },
                            enabled = !busy && reviewed != null,
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(if (busy) "Saving…" else "Opt in and share my profile") }
                    }
                }
            }
            if (nomination.canRespond && nomination.state == "INVITED") {
                Spacer(Modifier.height(10.dp))
                OutlinedButton(
                    onClick = {
                        busy = true; problem = null
                        scope.launch {
                            runCatching { Api.declineNomination(context, nomination.id) }
                                .onSuccess { onAnswered("You declined. $employer is not told, and your college sees only that you did not opt in.") }
                                .onFailure { problem = nominationError(it, "Your answer could not be saved.") }
                            busy = false
                        }
                    },
                    enabled = !busy,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Decline") }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
