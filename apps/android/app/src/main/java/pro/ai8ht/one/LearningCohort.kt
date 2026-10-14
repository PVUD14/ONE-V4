package pro.ai8ht.one

/*
 * The faculty cohort view on the phone (INST-15): the same server-scoped read the web shows as
 * "Learning across your students" on My Students — skills several of the lecturer's students are
 * stuck on, misconceptions held by five or more of them, and who has reviews due. Read-only: the
 * actions (assigning a task, planning an intervention) stay on the web. The server scopes it to the
 * lecturer's active teaching assignments and to students who hold the adaptive-learning consent;
 * until students have been asked for that consent every figure reads NA. Nothing here is a number
 * about a student's learning — names, skill names and counts of students only, never a date.
 */

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.School
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable
import pro.ai8ht.one.ui.Tone

@Serializable data class CohortStudentDto(val profileId: String = "", val fullName: String = "", val rollNumber: String = "")
@Serializable data class CohortConsentDto(val offered: Boolean = false)
@Serializable data class CohortSharingDto(val suppressed: Boolean = true, val count: Int? = null)
@Serializable data class CohortStuckSkillDto(
    val skillId: String = "", val skillName: String = "", val studentCount: Int = 0,
    val students: List<CohortStudentDto> = emptyList(),
)
@Serializable data class CohortMisconceptionDto(val code: String = "", val title: String = "", val skillName: String = "", val students: Int = 0)
@Serializable data class LearningCohortDto(
    val mode: String = "",
    val consent: CohortConsentDto = CohortConsentDto(),
    val students: Int = 0,
    val studentsSharing: CohortSharingDto = CohortSharingDto(),
    val stuckSkills: List<CohortStuckSkillDto> = emptyList(),
    val misconceptions: List<CohortMisconceptionDto> = emptyList(),
    val misconceptionsWithheld: Boolean = false,
)
@Serializable data class CohortDueStudentDto(
    val profileId: String = "", val fullName: String = "", val rollNumber: String = "",
    val dueSkills: List<String> = emptyList(),
)
@Serializable data class LearningCohortDueDto(val mode: String = "", val students: List<CohortDueStudentDto> = emptyList(), val nextCursor: String? = null)

/** The summary and the first page of due reviews, read together (both audited server-side). */
data class LearningCohortView(val summary: LearningCohortDto, val due: LearningCohortDueDto)

/** INST-15: the lecturer's cohort view (403 when the caller holds no faculty role). */
suspend fun Api.learningCohort(context: Context, institutionId: String): LearningCohortView {
    val summary: LearningCohortDto = json.decodeFromString(request(context, "GET", "/api/v1/institutions/$institutionId/learning-cohort"))
    val due: LearningCohortDueDto = json.decodeFromString(request(context, "GET", "/api/v1/institutions/$institutionId/learning-cohort/due-reviews?limit=50"))
    return LearningCohortView(summary, due)
}

@Composable
internal fun LearningCohortSection(state: ScopedView<LearningCohortView>) {
    if (state is ScopedView.NotForRole) return
    SectionTitle("Learning across your students")
    val view = (state as? ScopedView.Loaded)?.value
    val offered = view?.summary?.consent?.offered == true
    val stuck = view?.summary?.stuckSkills?.flatMap { skill -> skill.students.map { it.profileId } }?.toSet()?.size
    val sharing = view?.summary?.studentsSharing
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        StatCell(
            if (!offered || sharing == null) "NA" else if (sharing.suppressed || sharing.count == null) "<5" else sharing.count.toString(),
            "Sharing", Tone.Accent, Icons.Filled.School, Modifier.weight(1f),
        )
        StatCell(if (offered && stuck != null) stuck.toString() else "NA", "Stuck", Tone.Violet, Icons.Filled.Assignment, Modifier.weight(1f))
    }
    Spacer(Modifier.height(10.dp))
    when {
        view == null -> CohortNote("Learning across your students: NA right now. Open My Students on the web.")
        !offered -> CohortNote("Students have not yet been asked whether to share their learning data, so nothing from their practice is shown here.")
        else -> {
            if (view.summary.mode == "MEMBERSHIP") {
                CohortNote("Your college has not started recording teaching assignments, so no students are included here yet.")
            }
            Text("Stuck on the same skill", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            if (view.summary.stuckSkills.isEmpty()) CohortNote("No student is stuck on a skill right now.")
            view.summary.stuckSkills.take(6).forEach { skill ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Text("${skill.skillName} · ${skill.studentCount} student(s)", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Text(skill.students.joinToString(", ") { "${it.fullName} (${it.rollNumber})" },
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Spacer(Modifier.height(6.dp))
            Text("Most common misconceptions", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            if (view.summary.misconceptions.isEmpty()) {
                CohortNote(if (view.summary.misconceptionsWithheld) "Some misconceptions are held by fewer than five students, so none is shown."
                    else "No misconception is common among your students right now.")
            }
            view.summary.misconceptions.take(6).forEach { entry ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Text(entry.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Text("${entry.skillName} · ${entry.students} students", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            if (view.summary.misconceptions.isNotEmpty() && view.summary.misconceptionsWithheld) {
                CohortNote("Other misconceptions are held by fewer than five students and are not shown.")
            }
            Spacer(Modifier.height(6.dp))
            Text("Reviews due", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            if (view.due.students.isEmpty()) CohortNote("No student has a review due right now.")
            view.due.students.take(8).forEach { student ->
                PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Text("${student.fullName} (${student.rollNumber})", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Text(student.dueSkills.joinToString(", ").ifBlank { "NA" }, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            if (view.due.students.size > 8 || view.due.nextCursor != null) {
                CohortNote("The full list, and the actions for each student, are on My Students on the web.")
            }
        }
    }
}

@Composable
private fun CohortNote(text: String) {
    Text(text, Modifier.padding(vertical = 4.dp), style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant)
}
