package pro.ai8ht.one

/*
 * Department head and faculty views on the phone (INST-07): the same server-scoped
 * department overview, placement pipeline and class reports the web shows under Department
 * Overview, Placement Pipeline and the lecturer's Reports. The Android institution workspace
 * merges every institution role of one college, so each section asks the server and a 403
 * leaves it out. A group under five reads <5, readiness is bands only, and offers are never
 * shown with pay. The shared-application list (Opportunities and Offers) stays on the web:
 * reading it is an audited read of application records, not a glance on a home screen.
 *
 * INST-09 adds students by placement status to the pipeline card — the suppressed
 * distribution, where "Nothing shared" is never "not applied". The per-student status
 * list stays on the web for the same reason as the application list: it is audited.
 */

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.School
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable
import pro.ai8ht.one.ui.LocalOnePalette
import pro.ai8ht.one.ui.Tone

@Serializable data class SuppressedCountDto(val suppressed: Boolean = true, val value: Int? = null)
@Serializable data class SuppressedCellDto(val key: String = "", val count: Int? = null, val suppressed: Boolean = true)
@Serializable data class SuppressedTableDto(
    val suppressed: Boolean = true,
    val total: SuppressedCountDto = SuppressedCountDto(),
    val cells: List<SuppressedCellDto> = emptyList(),
)
@Serializable data class ReadinessBandDto(val band: String = "", val count: Int? = null, val suppressed: Boolean = true)
@Serializable data class ReadinessAggregateDto(
    val suppressed: Boolean = true,
    val minimumCohortSize: Int = 5,
    val cohortSize: Int? = null,
    val cohortSizeSuppressed: Boolean = true,
    val bands: List<ReadinessBandDto> = emptyList(),
)
@Serializable data class DepartmentReadinessDto(val month: String? = null, val aggregate: ReadinessAggregateDto? = null)
@Serializable data class DepartmentStudentsDto(val onRoster: Int = 0, val current: Int = 0)
@Serializable data class DepartmentAssessmentsDto(val inProgress: Int = 0, val assignedStudents: Int = 0, val completedStudents: Int = 0)
@Serializable data class DepartmentActionsDto(val openInterventions: Int = 0, val openTasks: Int = 0)
@Serializable data class DepartmentBatchDto(
    val id: String = "", val name: String = "", val parentName: String? = null,
    val students: Int = 0, val current: Int = 0, val activated: Int = 0,
)
@Serializable data class ScopeUnitDto(val id: String = "", val kind: String = "", val name: String = "")
@Serializable data class ScopeViewDto(val kind: String = "", val units: List<ScopeUnitDto> = emptyList())
@Serializable data class DepartmentOverviewDto(
    val scope: ScopeViewDto? = null,
    val students: DepartmentStudentsDto = DepartmentStudentsDto(),
    val activation: Map<String, Int> = emptyMap(),
    val assessments: DepartmentAssessmentsDto = DepartmentAssessmentsDto(),
    val readiness: DepartmentReadinessDto = DepartmentReadinessDto(),
    val staffActions: DepartmentActionsDto = DepartmentActionsDto(),
    val batches: List<DepartmentBatchDto> = emptyList(),
)
@Serializable data class PlacementPipelineDto(
    val studentsSharing: SuppressedCountDto = SuppressedCountDto(),
    val stages: SuppressedTableDto = SuppressedTableDto(),
    val offers: SuppressedTableDto = SuppressedTableDto(),
    /** INST-09: current students by placement status; absent from an older server. */
    val placementStatus: SuppressedTableDto? = null,
)
@Serializable data class ClassAssessmentDto(
    val id: String = "", val title: String = "", val assigned: Int = 0, val completed: Int = 0,
    val averagePercentage: Double? = null, val averageSuppressed: Boolean = true,
)
@Serializable data class ClassReportDto(
    val unit: ScopeUnitDto = ScopeUnitDto(),
    val subjects: List<String> = emptyList(),
    val students: Int = 0,
    val activated: Int = 0,
    val openTasks: Int = 0,
    val assessments: List<ClassAssessmentDto> = emptyList(),
)
@Serializable data class ClassReportsDto(val mode: String = "", val classes: List<ClassReportDto> = emptyList())

/** INST-07: the department overview for the reader's scope (403 for faculty-only callers). */
suspend fun Api.departmentOverview(context: Context, institutionId: String): DepartmentOverviewDto =
    json.decodeFromString(request(context, "GET", "/api/v1/institutions/$institutionId/department-overview"))

/** INST-07: shared-application stages and offers, suppressed under five (403 for faculty-only callers). */
suspend fun Api.placementPipeline(context: Context, institutionId: String): PlacementPipelineDto =
    json.decodeFromString(request(context, "GET", "/api/v1/institutions/$institutionId/placement-pipeline"))

/** INST-07: the lecturer's class reports (403 when the caller holds no faculty role). */
suspend fun Api.classReports(context: Context, institutionId: String): ClassReportsDto =
    json.decodeFromString(request(context, "GET", "/api/v1/institutions/$institutionId/class-reports"))

/** Loaded, left out (the server said this caller has no such view), or unavailable (NA). */
internal sealed interface ScopedView<out T> {
    data object NotForRole : ScopedView<Nothing>
    data object Unavailable : ScopedView<Nothing>
    data class Loaded<T>(val value: T) : ScopedView<T>
}

internal suspend fun <T> scopedView(load: suspend () -> T): ScopedView<T> =
    runCatching { load() }.fold(
        onSuccess = { ScopedView.Loaded(it) },
        onFailure = { if (it is Api.ApiException && it.status == 403) ScopedView.NotForRole else ScopedView.Unavailable },
    )

private val readinessBandOrder = listOf(
    "READY_FOR_NEXT_STEP" to "Ready for next step", "PROGRESSING" to "Progressing",
    "DEVELOPING" to "Developing", "NOT_ENOUGH_EVIDENCE" to "Not enough evidence",
)

private fun suppressedLabel(count: Int?, suppressed: Boolean): String = if (suppressed || count == null) "<5" else count.toString()

/** Cohort readiness: students per advisory band, never an average; bands under five read <5. */
@Composable
internal fun CohortReadinessCard(overview: ScopedView<DepartmentOverviewDto>) {
    val readiness = (overview as? ScopedView.Loaded)?.value?.readiness
    val aggregate = readiness?.aggregate
    SectionTitle("Cohort readiness")
    PilotCard {
        Column(Modifier.padding(14.dp)) {
            Text(
                "Advisory bands, shared with you and the student. Employers never see them." +
                    (readiness?.month?.let { " Month $it." } ?: ""),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(10.dp))
            if (aggregate != null && aggregate.suppressed) {
                Text("Withheld: fewer than ${aggregate.minimumCohortSize} students have readiness records.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                readinessBandOrder.forEach { (band, label) ->
                    val entry = aggregate?.bands?.firstOrNull { it.band == band }
                    val value = when {
                        aggregate == null -> "NA"
                        entry == null -> "<5"
                        else -> suppressedLabel(entry.count, entry.suppressed)
                    }
                    Row(Modifier.padding(vertical = 3.dp)) {
                        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

/** Department overview (INST-07), for heads, admins and placement officers. */
@Composable
internal fun DepartmentOverviewSection(overview: DepartmentOverviewDto) {
    val scopeNames = overview.scope?.units?.joinToString(", ") { it.name }.orEmpty()
    SectionTitle("Department overview")
    if (scopeNames.isNotEmpty()) {
        Text("Showing students in $scopeNames.", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        StatCell("${overview.students.onRoster}", "On roster", Tone.Accent, Icons.Filled.School, Modifier.weight(1f))
        StatCell("${overview.students.current}", "Enrolled now", Tone.Green, Icons.Filled.School, Modifier.weight(1f))
    }
    Spacer(Modifier.height(10.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        StatCell("${overview.assessments.inProgress}", "Assessments open", Tone.Violet, Icons.Filled.Assignment, Modifier.weight(1f))
        StatCell("${overview.staffActions.openInterventions}", "Interventions", Tone.Amber, Icons.Filled.Notifications, Modifier.weight(1f))
    }
    Spacer(Modifier.height(10.dp))
    PilotCard {
        Column(Modifier.padding(14.dp)) {
            Text("Batches", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            if (overview.batches.isEmpty()) {
                Text("No batches are set up in your department yet.", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            overview.batches.take(6).forEach { batch ->
                Row(Modifier.padding(vertical = 3.dp)) {
                    Text(batch.name, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    Text("${batch.current} enrolled · ${batch.activated} activated", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(6.dp))
            Text("Open tasks: ${overview.staffActions.openTasks}", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private val pipelineStages = listOf(
    "APPLIED" to "Applied", "SHORTLISTED" to "Shortlisted", "INTERVIEW" to "Interview", "OFFER" to "Offer", "HIRED" to "Hired",
)

/** INST-09: the web's placement status labels. A student who shared nothing is not "not applied". */
private val placementStatusOrder = listOf(
    "NOT_SHARED" to "Nothing shared", "APPLIED" to "Applied", "IN_PROCESS" to "In process", "OFFER" to "Offer", "ACCEPTED" to "Accepted",
)

/** Placement pipeline over applications students shared with the college; NA when there is no source. */
@Composable
internal fun PlacementPipelineCard(pipeline: ScopedView<PlacementPipelineDto>) {
    val data = (pipeline as? ScopedView.Loaded)?.value
    SectionTitle("Placement Pipeline")
    PilotCard {
        Column(Modifier.padding(14.dp)) {
            val cells = data?.stages?.cells.orEmpty().associateBy { it.key }
            val max = cells.values.mapNotNull { if (it.suppressed) null else it.count }.maxOrNull() ?: 1
            pipelineStages.forEach { (key, label) ->
                val cell = cells[key]
                val text = when {
                    data == null -> "NA"
                    data.stages.suppressed || cell == null -> "<5"
                    else -> suppressedLabel(cell.count, cell.suppressed)
                }
                SuppressedFunnelRow(label, if (cell != null && !cell.suppressed) cell.count else null, max, text)
            }
            Spacer(Modifier.height(6.dp))
            Text(
                if (data == null) "Placement stages: NA for your role." else "Applications students have shared with the college. Offer pay is never shown.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    // INST-09: every current student by placement status, from what they shared only.
    Spacer(Modifier.height(10.dp))
    PilotCard {
        Column(Modifier.padding(14.dp)) {
            Text("Students by placement status", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            val table = data?.placementStatus
            val cells = table?.cells.orEmpty().associateBy { it.key }
            val max = cells.values.mapNotNull { if (it.suppressed) null else it.count }.maxOrNull() ?: 1
            placementStatusOrder.forEach { (key, label) ->
                val cell = cells[key]
                val text = when {
                    table == null -> "NA"
                    table.suppressed || cell == null -> "<5"
                    else -> suppressedLabel(cell.count, cell.suppressed)
                }
                SuppressedFunnelRow(label, if (cell != null && !cell.suppressed) cell.count else null, max, text)
            }
            Spacer(Modifier.height(6.dp))
            Text(
                "\"Nothing shared\" means a student has not shared an application with the college — not that they have not applied. Each student's status is on the web.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SuppressedFunnelRow(label: String, value: Int?, max: Int, text: String) {
    val palette = LocalOnePalette.current
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.width(88.dp), style = MaterialTheme.typography.labelMedium)
        Box(Modifier.weight(1f).height(7.dp).background(Color(0xFFEDF1F7), RoundedCornerShape(99.dp))) {
            val fraction = if (value != null && max > 0) (value.toFloat() / max).coerceIn(0f, 1f) else 0f
            if (fraction > 0f) {
                Box(Modifier.fillMaxWidth(fraction).height(7.dp).background(palette.accent, RoundedCornerShape(99.dp)))
            }
        }
        Spacer(Modifier.width(10.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
            color = if (value == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
    }
}

/** The lecturer's class reports (INST-07): one card per section or batch taught. */
@Composable
internal fun ClassReportsSection(state: ScopedView<ClassReportsDto>) {
    SectionTitle("My classes")
    when (state) {
        is ScopedView.NotForRole -> Unit
        is ScopedView.Unavailable -> PilotCard {
            Text("Class reports: NA right now.", Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        is ScopedView.Loaded -> {
            if (state.value.classes.isEmpty()) {
                PilotCard {
                    Text("No classes to report on. Ask your institution admin or department head to assign you to a section or batch.",
                        Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            state.value.classes.forEach { entry ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
                    Column(Modifier.padding(14.dp)) {
                        Text(entry.unit.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Text(
                            (if (entry.subjects.isEmpty()) "Subject: NA" else entry.subjects.joinToString(", ")) +
                                " · ${entry.students} students · ${entry.activated} activated · ${entry.openTasks} open tasks",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        entry.assessments.take(4).forEach { assessment ->
                            Row(Modifier.padding(top = 6.dp)) {
                                Text(assessment.title, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                                val average = assessment.averagePercentage
                                Text(
                                    "${assessment.completed}/${assessment.assigned} · " +
                                        if (assessment.averageSuppressed || average == null) "<5 results" else "avg ${"%.1f".format(average)}%",
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
