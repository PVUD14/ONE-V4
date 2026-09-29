package pro.ai8ht.one

/*
 * Faculty learning actions on the phone (INST-16) — the Android side of the web's `api/learningActions.ts`.
 *
 * Students: "From your lecturer" at the top of the existing Learning tab (no navigation change) — assigned
 * practice sets and lessons with their status, group sessions they are invited to, and a next step a lecturer
 * chose for them with the reason in plain words. Lecturers are named by role and college only.
 *
 * Lecturers: a read-only summary on the institution home of what they assigned, planned and set. Assigning,
 * planning sessions and setting a student's next step stay on the web (Learning Resources), where the content
 * catalogue and the reason picker live. Nothing here is a score or a model number; counts of people under five
 * read "<5"; missing data reads NA.
 */

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable

// --- Student view -----------------------------------------------------------------------------------

@Serializable data class LinkedContentDto(val kind: String = "", val title: String = "", val skillName: String = "")

@Serializable data class AssignedWorkDto(
    val id: String = "", val kind: String = "", val title: String = "", val skillName: String = "",
    val institutionName: String = "", val note: String? = null, val assignedAt: String = "", val status: String = "OPEN",
)

@Serializable data class GroupSessionDto(
    val id: String = "", val title: String = "", val institutionName: String = "",
    val scheduledStartAt: String = "", val scheduledEndAt: String = "", val content: List<LinkedContentDto> = emptyList(),
)

@Serializable data class LecturerNextStepDto(
    val id: String = "", val action: String = "", val kind: String = "", val title: String = "", val skillName: String = "",
    val reasonCode: String = "", val note: String? = null, val institutionName: String = "", val createdAt: String = "",
)

@Serializable data class StudentLearningActionsDto(
    val assignments: List<AssignedWorkDto> = emptyList(),
    val sessions: List<GroupSessionDto> = emptyList(),
    val pendingOverride: LecturerNextStepDto? = null,
)

suspend fun Api.myLearningActions(context: Context): StudentLearningActionsDto =
    json.decodeFromString(request(context, "GET", "/api/v1/students/me/learning-actions"))

/** Why a lecturer set a student's next step, as the student reads it (same words as the web). */
internal val lecturerReasonText = mapOf(
    "CLASS_TOPIC_ALIGNMENT" to "It matches what your class is working on now.",
    "PREREQUISITE_FIRST" to "Something it builds on needs attention first.",
    "REVISIT_FUNDAMENTALS" to "Going back over the fundamentals will help.",
    "UPCOMING_ASSESSMENT" to "It prepares you for an upcoming assessment.",
    "STUDENT_REQUEST" to "You asked for it.",
    "FACULTY_JUDGEMENT" to "Your lecturer thinks it is the right next step.",
)
private val actionWord = mapOf("LEARN" to "Learn", "PRACTICE" to "Practise", "REVIEW" to "Review")
private val kindWord = mapOf("PRACTICE" to "Practice set", "LESSON" to "Lesson")

/** True when a lecturer has set something the planner will bring up next. */
internal fun StudentLearningActionsDto.hasLecturerWork(): Boolean =
    pendingOverride != null || assignments.any { it.status == "OPEN" }

private fun whenText(value: String): String = runCatching {
    java.time.OffsetDateTime.parse(value).atZoneSameInstant(java.time.ZoneId.systemDefault())
        .format(java.time.format.DateTimeFormatter.ofPattern("d MMM, h:mm a"))
}.getOrDefault("NA")

@Composable
private fun Quiet(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** The student's "From your lecturer" card. [onStart] plans the next step (which brings the lecturer's work up). */
@Composable
internal fun FromYourLecturerCard(state: Load<StudentLearningActionsDto>, busy: Boolean, onStart: () -> Unit) {
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            val value = (state as? Load.Ready)?.value
            val open = value?.assignments?.count { it.status == "OPEN" } ?: 0
            val pending = value?.pendingOverride
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("From your lecturer", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                StatusChip(
                    when { value == null -> "NA"; pending != null -> "Next step set"; else -> "$open open" },
                    if (value != null && (open > 0 || pending != null)) ChipKind.Accent else ChipKind.Muted,
                )
            }
            Spacer(Modifier.height(8.dp))
            when (state) {
                is Load.Loading -> Quiet("Loading…")
                is Load.Failed -> Quiet("NA — what your lecturers set could not be loaded right now.")
                is Load.Ready -> {
                    val actions = state.value
                    if (actions.assignments.isEmpty() && actions.sessions.isEmpty() && pending == null) {
                        Quiet("Nothing from your lecturers right now. Work they assign you appears here and comes up as your next step.")
                    }
                    pending?.let { step ->
                        Text("Your lecturer at ${step.institutionName} set your next step: ${actionWord[step.action] ?: "Work on"} ${step.title}",
                            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Quiet((lecturerReasonText[step.reasonCode] ?: "NA") + (step.note?.let { " “$it”" } ?: "") + " It starts when you plan your next step.")
                        Spacer(Modifier.height(8.dp))
                    }
                    actions.assignments.forEach { work ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(work.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                Quiet("${kindWord[work.kind] ?: "Work"} · ${work.skillName} · from your lecturer at ${work.institutionName}" +
                                    (work.note?.let { " · “$it”" } ?: ""))
                            }
                            StatusChip(if (work.status == "DONE") "Done" else "To do", if (work.status == "DONE") ChipKind.Positive else ChipKind.Waiting)
                        }
                    }
                    actions.sessions.forEach { session ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(session.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                Quiet("${whenText(session.scheduledStartAt)} – ${whenText(session.scheduledEndAt)} · ${session.institutionName}")
                                Quiet("Covers: " + session.content.joinToString(", ") { it.title }.ifBlank { "NA" })
                            }
                            StatusChip("Group session", ChipKind.Positive)
                        }
                    }
                    if (actions.hasLecturerWork()) {
                        Spacer(Modifier.height(8.dp))
                        if (pending == null) Quiet("Your plan brings assigned work up next, after anything due for review.")
                        Button(enabled = !busy, onClick = onStart) { Text("Start my lecturer’s work") }
                    }
                }
            }
        }
    }
}

// --- Lecturer view (read-only) --------------------------------------------------------------------------

@Serializable data class LearningResourceRefDto(val kind: String = "", val skillId: String = "", val lessonVersionId: String? = null, val title: String = "", val skillName: String = "")
@Serializable data class DoneCountDto(val suppressed: Boolean = true, val count: Int? = null)
@Serializable data class AssignmentTargetDto(val kind: String = "", val unitName: String? = null)
@Serializable data class FacultyAssignmentDto(
    val id: String = "", val resource: LearningResourceRefDto = LearningResourceRefDto(), val target: AssignmentTargetDto = AssignmentTargetDto(),
    val note: String? = null, val assignedAt: String = "", val withdrawn: Boolean = false, val students: Int = 0, val done: DoneCountDto = DoneCountDto(),
)
@Serializable data class FacultySessionDto(
    val id: String = "", val title: String = "", val scheduledStartAt: String = "", val scheduledEndAt: String = "", val state: String = "",
    val attendees: Int = 0, val content: List<LinkedContentDto> = emptyList(),
)
@Serializable data class OverrideStudentDto(val profileId: String = "", val fullName: String = "", val rollNumber: String = "")
@Serializable data class FacultyOverrideDto(
    val id: String = "", val student: OverrideStudentDto? = null, val action: String = "", val resource: LearningResourceRefDto = LearningResourceRefDto(),
    val reasonCode: String = "", val state: String = "", val createdAt: String = "",
)
@Serializable data class FacultyLearningActionsDto(
    val mode: String = "", val canAct: Boolean = false,
    val assignments: List<FacultyAssignmentDto> = emptyList(),
    val sessions: List<FacultySessionDto> = emptyList(),
    val overrides: List<FacultyOverrideDto> = emptyList(),
)

/** INST-16: what this lecturer assigned, planned and set (403 when the caller holds no faculty role). */
suspend fun Api.facultyLearningActions(context: Context, institutionId: String): FacultyLearningActionsDto =
    json.decodeFromString(request(context, "GET", "/api/v1/institutions/$institutionId/learning-actions"))

private val overrideReasonLabel = mapOf(
    "CLASS_TOPIC_ALIGNMENT" to "Matches what the class is working on now",
    "PREREQUISITE_FIRST" to "A prerequisite needs attention first",
    "REVISIT_FUNDAMENTALS" to "Go back over the fundamentals",
    "UPCOMING_ASSESSMENT" to "Preparation for an upcoming assessment",
    "STUDENT_REQUEST" to "The student asked for it",
    "FACULTY_JUDGEMENT" to "The lecturer’s judgement",
)
private val overrideStateLabel = mapOf("PENDING" to "Waiting for the student", "APPLIED" to "Used as their next step", "WITHDRAWN" to "Withdrawn")

@Composable
internal fun FacultyLearningActionsSection(state: ScopedView<FacultyLearningActionsDto>) {
    if (state is ScopedView.NotForRole) return
    SectionTitle("Assigned learning")
    val view = (state as? ScopedView.Loaded)?.value
    if (view == null) {
        Quiet("Assigned learning: NA right now. Open Learning Resources on the web.")
        Spacer(Modifier.height(10.dp))
        return
    }
    if (!view.canAct) Quiet("You need an active teaching assignment to assign work. Ask your institution administrator to assign your classes.")
    if (view.assignments.isEmpty() && view.sessions.isEmpty() && view.overrides.isEmpty()) {
        Quiet("You have not assigned anything yet. Assign practice sets and lessons, plan group sessions and set a student’s next step from Learning Resources on the web.")
    }
    view.assignments.take(5).forEach { assignment ->
        PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text(assignment.resource.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                val done = if (assignment.done.suppressed || assignment.done.count == null) "<5" else assignment.done.count.toString()
                Quiet((assignment.target.unitName ?: "Selected students") + " · ${assignment.students} students · " +
                    if (assignment.withdrawn) "Withdrawn" else "$done done")
            }
        }
    }
    view.sessions.take(3).forEach { session ->
        PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text(session.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Quiet("${whenText(session.scheduledStartAt)} · ${session.attendees} invited" + if (session.state == "CANCELLED") " · Cancelled" else "")
            }
        }
    }
    view.overrides.take(5).forEach { override ->
        PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text(override.student?.let { "${it.fullName} (${it.rollNumber})" } ?: "No longer in your classes",
                    style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Quiet("${actionWord[override.action] ?: "Next step"} ${override.resource.title} · ${overrideReasonLabel[override.reasonCode] ?: "NA"} · " +
                    (overrideStateLabel[override.state] ?: "NA"))
            }
        }
    }
    Spacer(Modifier.height(10.dp))
}
