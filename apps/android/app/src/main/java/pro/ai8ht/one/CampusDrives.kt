package pro.ai8ht.one

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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

/**
 * Campus drives on the phone (EMP-11, ADR-038): read views for staff.
 *
 * A college's placement office approves an employer's drive before its students see the job.
 * On the phone the college sees its drive requests and the drives it has scheduled, and an
 * employer sees each role's drives with the college's decision and reason. Deciding a drive and
 * setting the one-offer policy are desk tasks with a reason and a confirmation each, so they stay
 * on the web (placement officer Dashboard, admin Placement and Settings; employer Opportunity
 * Detail), like editing a job. Students see and apply to approved drives through the ordinary
 * job screens (StudentHiring.kt, JobsAndMore.kt). Nothing is invented: a missing date reads NA.
 */

@Serializable data class CampusDrivesEnvelope(
    val drives: List<CampusDriveDto> = emptyList(),
    val canDecide: Boolean = false,
    val nextCursor: String? = null,
)

@Serializable data class CampusDriveDecisionDto(
    val reasonCode: String? = null,
    val note: String? = null,
    val decidedAt: String? = null,
)

@Serializable data class CampusDriveDto(
    val id: String,
    val opportunityId: String = "",
    val opportunityTitle: String? = null,
    val employerName: String = "",
    val institutionName: String = "",
    val state: String = "",
    val proposedStartAt: String? = null,
    val scheduledStartAt: String? = null,
    val venueMode: String? = null,
    val employerNote: String? = null,
    val offerHoldersEligible: Boolean = false,
    val decision: CampusDriveDecisionDto? = null,
    val closeReasonCode: String? = null,
    val applicationCount: Int? = null,
    /** INST-12: the college's own label for the drive (college side only). */
    val category: CampusDriveCategoryDto? = null,
)

@Serializable data class CampusDriveCategoryDto(val id: String = "", val name: String = "", val retired: Boolean = false)

suspend fun Api.institutionCampusDrives(context: Context, institutionId: String, state: String? = null): CampusDrivesEnvelope =
    json.decodeFromString(request(context, "GET", "/api/v1/institutions/$institutionId/campus-drives" + (state?.let { "?state=$it" } ?: "")))

/** INST-14: a drive's nomination summary as the college sees it (suppressed under five). */
@Serializable data class NominationSummaryDto(
    val nominated: SuppressedCountDto? = null,
    val optedIn: SuppressedCountDto? = null,
    val notOptedIn: SuppressedCountDto? = null,
)
@Serializable data class DriveNominationsEnvelope(val summary: NominationSummaryDto = NominationSummaryDto())

suspend fun Api.driveNominationSummary(context: Context, institutionId: String, driveId: String): NominationSummaryDto =
    json.decodeFromString<DriveNominationsEnvelope>(
        request(context, "GET", "/api/v1/institutions/$institutionId/campus-drives/$driveId/nominations?limit=1"),
    ).summary

suspend fun Api.employerCampusDrives(context: Context, employerId: String, opportunityId: String): List<CampusDriveDto> =
    json.decodeFromString<CampusDrivesEnvelope>(
        request(context, "GET", "/api/v1/employers/$employerId/campus-drives?opportunityId=$opportunityId"),
    ).drives

internal val campusDriveStateLabels = mapOf(
    "REQUESTED" to "Awaiting the college", "CHANGES_REQUESTED" to "Changes requested", "APPROVED" to "Approved",
    "SCHEDULED" to "Scheduled", "REJECTED" to "Declined", "COMPLETED" to "Completed", "CANCELLED" to "Cancelled",
)

internal fun campusDriveChip(state: String): ChipKind = when (state) {
    "APPROVED", "SCHEDULED" -> ChipKind.Positive
    "REQUESTED", "CHANGES_REQUESTED" -> ChipKind.Waiting
    else -> ChipKind.Muted
}

/** SCHEDULE_CHANGE_NEEDED → "Schedule change needed". */
internal fun reasonWords(code: String?): String? =
    code?.lowercase()?.replace('_', ' ')?.replaceFirstChar { it.uppercase() }

private sealed interface CollegeDrives {
    data object Loading : CollegeDrives
    data object NotForRole : CollegeDrives
    data object Unavailable : CollegeDrives
    data class Loaded(
        val waiting: List<CampusDriveDto>,
        val upcoming: List<CampusDriveDto>,
        /** INST-14: each shown drive's nomination summary; null reads NA. */
        val nominations: Map<String, NominationSummaryDto?> = emptyMap(),
    ) : CollegeDrives
}

/**
 * The college home's campus drives: requests awaiting a decision and scheduled drives ahead.
 * Hidden for faculty (the server refuses them); NA when the list cannot be loaded.
 */
@Composable
internal fun CollegeCampusDrivesSection(institutionId: String) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var state by remember(institutionId) { mutableStateOf<CollegeDrives>(CollegeDrives.Loading) }
    LaunchedEffect(institutionId) {
        state = runCatching {
            val requested = Api.institutionCampusDrives(context, institutionId, "REQUESTED").drives
            val now = System.currentTimeMillis()
            val scheduled = Api.institutionCampusDrives(context, institutionId, "SCHEDULED").drives
                .filter { drive -> drive.scheduledStartAt?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() >= now }.getOrDefault(false) } ?: false }
                .sortedBy { it.scheduledStartAt }
            val summaries = scheduled.take(4).associate { drive ->
                drive.id to runCatching { Api.driveNominationSummary(context, institutionId, drive.id) }.getOrNull()
            }
            CollegeDrives.Loaded(requested, scheduled, summaries)
        }.getOrElse { if (it is Api.ApiException && it.status == 403) CollegeDrives.NotForRole else CollegeDrives.Unavailable }
    }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    when (val current = state) {
        CollegeDrives.NotForRole -> return
        CollegeDrives.Loading -> {
            SectionTitle("Campus drives")
            PilotCard { Text("Loading…", Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall, color = muted) }
        }
        CollegeDrives.Unavailable -> {
            SectionTitle("Campus drives")
            PilotCard { Text("NA — campus drives could not be loaded right now.", Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall, color = muted) }
        }
        is CollegeDrives.Loaded -> {
            SectionTitle("Campus drives")
            PilotCard {
                Column(Modifier.padding(14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Awaiting your decision", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        StatusChip("${current.waiting.size}", if (current.waiting.isEmpty()) ChipKind.Muted else ChipKind.Waiting)
                    }
                    current.waiting.take(3).forEach { drive ->
                        Spacer(Modifier.height(6.dp))
                        Text("${drive.employerName} · ${drive.opportunityTitle ?: "Untitled"}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Text("Proposed ${drive.proposedStartAt?.let(::formatWhen) ?: "NA"}" + (drive.employerNote?.let { " · $it" } ?: ""),
                            style = MaterialTheme.typography.bodySmall, color = muted)
                    }
                    Spacer(Modifier.height(10.dp))
                    Text("Scheduled", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    if (current.upcoming.isEmpty()) {
                        Text("No drive is scheduled yet.", style = MaterialTheme.typography.bodySmall, color = muted)
                    } else current.upcoming.take(4).forEach { drive ->
                        Spacer(Modifier.height(4.dp))
                        Text("${drive.scheduledStartAt?.let(::formatWhen) ?: "NA"} · ${drive.employerName} · ${drive.opportunityTitle ?: "Untitled"}" +
                            (drive.category?.let { " · ${it.name}" } ?: ""),
                            style = MaterialTheme.typography.bodySmall)
                        // INST-14: who opted in to the college's nominations, never who declined; <5 under five.
                        val summary = current.nominations[drive.id]
                        Text(
                            if (summary == null) "Nominations: NA"
                            else "Nominated ${countText(summary.nominated)} · opted in ${countText(summary.optedIn)} · not opted in ${countText(summary.notOptedIn)}",
                            style = MaterialTheme.typography.bodySmall, color = muted,
                        )
                    }
                    Spacer(Modifier.height(10.dp))
                    Text("Approve, decline or schedule drives, nominate students, and set your one-offer policy, on the web: the placement officer Dashboard, or Placement and Settings for administrators.",
                        style = MaterialTheme.typography.bodySmall, color = muted)
                }
            }
        }
    }
}

/** One role's campus drives, read-only, for the employer's Roles list. */
@Composable
internal fun RoleCampusDrives(employerId: String, opportunityId: String) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var state by remember(opportunityId) { mutableStateOf<Load<List<CampusDriveDto>>>(Load.Loading) }
    LaunchedEffect(opportunityId) { state = loadOf { Api.employerCampusDrives(context, employerId, opportunityId) } }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Text("Campus drives", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
    when (val current = state) {
        Load.Loading -> Text("Loading…", style = MaterialTheme.typography.bodySmall, color = muted)
        is Load.Failed -> Text(current.message, style = MaterialTheme.typography.bodySmall, color = muted)
        is Load.Ready -> if (current.value.isEmpty()) {
            Text("No campus drives. Ask a college for one on the web, from Opportunity Detail.", style = MaterialTheme.typography.bodySmall, color = muted)
        } else current.value.forEach { drive ->
            Spacer(Modifier.height(6.dp))
            Column(Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(drive.institutionName, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    StatusChip(campusDriveStateLabels[drive.state] ?: prettify(drive.state), campusDriveChip(drive.state))
                }
                Text("Confirmed ${drive.scheduledStartAt?.let(::formatWhen) ?: "NA"} · ${drive.applicationCount ?: 0} applications through it",
                    style = MaterialTheme.typography.bodySmall, color = muted)
                val decision = drive.decision
                if (decision != null && (decision.reasonCode != null || decision.note != null)) {
                    Text("The college: " + listOfNotNull(reasonWords(decision.reasonCode), decision.note).joinToString(". "),
                        style = MaterialTheme.typography.bodySmall)
                }
                reasonWords(drive.closeReasonCode)?.let { Text("Cancelled: $it", style = MaterialTheme.typography.bodySmall, color = muted) }
            }
        }
    }
    Text("Request, answer changes, cancel or complete drives on the web.", style = MaterialTheme.typography.bodySmall, color = muted)
}
