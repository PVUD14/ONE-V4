package pro.ai8ht.one

/*
 * Cohort readiness by career role and preparation sprints on the phone (INST-17) — the Android side of the web's
 * `api/cohortReadiness.ts`, read-only.
 *
 * On the institution home, for owners, admins, placement officers and department heads: the college's preparation
 * sprints with their progress, and where the cohort stood at the end of last month on each essential requirement
 * of one role — the role behind the college's next campus drive, or else the role of the latest sprint. Choosing
 * other roles and starting or ending a sprint stay on the web (Career Readiness / Readiness), where the role picker
 * and the reason lists live. Bands and counts of people only: never a score, a ratio or a student's name; counts
 * under five read "<5"; missing data reads NA. Lecturers get 403 and the section is left out.
 */

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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable

@Serializable data class RoleCountDto(val suppressed: Boolean = true, val count: Int? = null)
@Serializable data class RoleCellDto(val key: String = "", val count: Int? = null, val suppressed: Boolean = true)

@Serializable data class CohortRoleOptionDto(val id: String = "", val title: String = "", val essentialRequirements: Int = 0)
@Serializable data class CohortDriveRoleDto(
    val driveId: String = "", val employerName: String = "", val jobTitle: String = "", val careerRoleId: String = "", val roleTitle: String = "",
)
@Serializable data class CohortRolesDto(val roles: List<CohortRoleOptionDto> = emptyList(), val drives: List<CohortDriveRoleDto> = emptyList())

@Serializable data class CohortRoleRefDto(val id: String = "", val title: String = "")
@Serializable data class CohortPeriodDto(val month: String = "")
@Serializable data class CohortRequirementCountsDto(val essential: Int = 0, val other: Int = 0)
@Serializable data class CohortTotalDto(val suppressed: Boolean = true, val total: RoleCountDto = RoleCountDto())
@Serializable data class CohortRequirementRowDto(
    val topicId: String = "", val skillName: String = "", val cells: List<RoleCellDto> = emptyList(),
    val gaps: RoleCountDto = RoleCountDto(), val unknowns: RoleCountDto = RoleCountDto(),
)
@Serializable data class CohortByRoleDto(
    val role: CohortRoleRefDto = CohortRoleRefDto(), val period: CohortPeriodDto = CohortPeriodDto(),
    val requirementCounts: CohortRequirementCountsDto = CohortRequirementCountsDto(), val cohort: CohortTotalDto = CohortTotalDto(),
    val requirements: List<CohortRequirementRowDto> = emptyList(),
)

@Serializable data class SprintResourceDto(val kind: String = "", val title: String = "")
@Serializable data class SprintDriveDto(val employerName: String = "", val jobTitle: String = "")
@Serializable data class SprintProgressDto(
    val available: Boolean = false, val requirementLive: Boolean = true, val reached: RoleCountDto = RoleCountDto(),
    val cells: List<RoleCellDto> = emptyList(), val workDone: RoleCountDto = RoleCountDto(),
)
@Serializable data class PreparationSprintDto(
    val id: String = "", val role: CohortRoleRefDto = CohortRoleRefDto(), val skillName: String = "", val resource: SprintResourceDto = SprintResourceDto(),
    val reasonCode: String = "", val unitName: String? = null, val drive: SprintDriveDto? = null,
    val startsAt: String = "", val endsAt: String = "", val state: String = "", val progress: SprintProgressDto = SprintProgressDto(),
)
@Serializable data class PreparationSprintsDto(val sprints: List<PreparationSprintDto> = emptyList())

/** The sprints and, when a role can be picked without a picker, last month's view for it. */
data class CohortByRoleView(val sprints: List<PreparationSprintDto>, val view: CohortByRoleDto?, val source: String?)

/**
 * INST-17: the college's sprints, and the cohort view for the role behind the next campus drive (or else the latest
 * sprint's role). 403 for lecturers. Every read is audited server-side.
 */
suspend fun Api.cohortByRole(context: Context, institutionId: String): CohortByRoleView {
    val roles: CohortRolesDto = json.decodeFromString(request(context, "GET", "/api/v1/institutions/$institutionId/cohort-readiness/roles"))
    val sprints: PreparationSprintsDto = json.decodeFromString(request(context, "GET", "/api/v1/institutions/$institutionId/preparation-sprints"))
    val drive = roles.drives.firstOrNull()
    val roleId = drive?.careerRoleId ?: sprints.sprints.firstOrNull()?.role?.id
    val source = when {
        drive != null -> "The role behind ${drive.employerName}’s campus drive (${drive.jobTitle})."
        roleId != null -> "The role of your latest preparation sprint."
        else -> null
    }
    val view: CohortByRoleDto? = roleId?.let {
        json.decodeFromString(request(context, "GET", "/api/v1/institutions/$institutionId/cohort-readiness?careerRoleId=$it"))
    }
    return CohortByRoleView(sprints.sprints, view, source)
}

private val requirementCells = listOf(
    "MET" to "Met", "PARTIAL" to "Partly there", "MISSING" to "Not yet", "NOT_ENOUGH_EVIDENCE" to "Too little evidence", "NO_EVIDENCE" to "No evidence yet",
)
private val sprintCells = listOf("MET" to "Now meet it", "NEW_EVIDENCE" to "New evidence", "NO_NEW_EVIDENCE" to "Nothing new yet")
private val sprintStates = mapOf("RUNNING" to "Running", "ENDED" to "Ended", "CANCELLED" to "Ended early")

private fun countText(count: RoleCountDto): String = if (count.suppressed || count.count == null) "<5" else count.count.toString()
private fun cellText(cells: List<RoleCellDto>, key: String): String =
    cells.firstOrNull { it.key == key }?.let { if (it.suppressed || it.count == null) "<5" else it.count.toString() } ?: "<5"
private fun dayText(value: String): String = runCatching {
    java.time.OffsetDateTime.parse(value).atZoneSameInstant(java.time.ZoneId.systemDefault())
        .format(java.time.format.DateTimeFormatter.ofPattern("d MMM"))
}.getOrDefault("NA")

@Composable
private fun Quiet(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun CountRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
        Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun CohortByRoleSection(state: ScopedView<CohortByRoleView>) {
    if (state is ScopedView.NotForRole) return
    SectionTitle("Readiness by career role")
    val value = (state as? ScopedView.Loaded)?.value
    if (value == null) {
        Quiet("Readiness by career role: NA right now. Open Career Readiness or Readiness on the web.")
        Spacer(Modifier.height(10.dp))
        return
    }
    val view = value.view
    PilotCard {
        Column(Modifier.padding(14.dp)) {
            if (view == null) {
                Quiet("No campus drive or sprint names a role yet. Choose a role on the web (Career Readiness or Readiness) to see where your students stand.")
            } else {
                Text(view.role.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Quiet((value.source ?: "") + " As at the end of ${view.period.month.ifBlank { "NA" }}; bands, never scores; groups under five read <5.")
                if (view.cohort.suppressed) Quiet("Fewer than five students: every figure is withheld.")
                if (view.requirements.isEmpty()) Quiet("This role has no essential requirement published in ONE yet: NA.")
                view.requirements.forEach { requirement ->
                    Spacer(Modifier.height(10.dp))
                    Text(requirement.skillName, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                    requirementCells.forEach { (key, label) -> CountRow(label, cellText(requirement.cells, key)) }
                    Quiet("Gaps ${countText(requirement.gaps)} · Unknowns ${countText(requirement.unknowns)}")
                }
            }
        }
    }
    SectionTitle("Preparation sprints")
    if (value.sprints.isEmpty()) Quiet("No sprints yet. Start one from a role’s essential requirement on the web.")
    value.sprints.take(5).forEach { sprint ->
        PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
            Column(Modifier.padding(12.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("${sprint.role.title} · ${sprint.skillName}", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    StatusChip(sprintStates[sprint.state] ?: "NA", if (sprint.state == "RUNNING") ChipKind.Accent else ChipKind.Muted)
                }
                Quiet("${sprint.resource.title} · ${dayText(sprint.startsAt)} – ${dayText(sprint.endsAt)}" +
                    (sprint.drive?.let { " · ${it.employerName}" } ?: "") + (sprint.unitName?.let { " · $it" } ?: ""))
                val progress = sprint.progress
                if (!progress.available) {
                    Quiet("Progress: NA — the first figures appear the day after a sprint starts.")
                } else {
                    CountRow("Reached", countText(progress.reached))
                    if (progress.requirementLive) sprintCells.forEach { (key, label) -> CountRow(label, cellText(progress.cells, key)) }
                    else Quiet("The requirement is no longer part of this role: NA.")
                    CountRow("Work done", countText(progress.workDone))
                }
            }
        }
    }
    Spacer(Modifier.height(10.dp))
}
