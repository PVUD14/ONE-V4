package pro.ai8ht.one

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import pro.ai8ht.one.ui.Tone
import java.time.Instant

/**
 * Screening tests an employer has sent this candidate.
 *
 * Unlike an institution exam, which is invigilated and laptop-only, a screening test makes
 * no supervision claim -- the product deliberately records no screen events for one -- so
 * there is no honest reason to refuse it on a phone.
 *
 * EMP-12: before starting, the candidate reads what the test covers and on what terms (question
 * formats and count, the minutes actually available, one sitting, no camera, microphone or screen
 * capture, where the result goes) and agrees; starting records that. The clock shown during the
 * test is a courtesy -- ONE's server keeps the time and refuses answers after it runs out.
 *
 * The paper comes from the server already frozen and already in this candidate's own
 * option order, and carries nothing that says which answer is right.
 */

private val formatLabels = mapOf(
    "SINGLE_CHOICE_MCQ" to "single choice", "MULTIPLE_SELECT" to "multiple select", "TRUE_FALSE" to "true or false",
    "SCENARIO_MCQ" to "scenario", "CODE_OUTPUT_MCQ" to "code output", "NUMERICAL_MCQ" to "numerical",
)

private fun screeningMessage(code: String?, fallback: String): String = when (code) {
    "ASSESSMENT_WINDOW_CLOSED" -> "That test has closed."
    "ASSESSMENT_NOT_OPEN_YET" -> "That test has not opened yet."
    "ASSESSMENT_ALREADY_SUBMITTED" -> "You have already submitted that test."
    "ASSESSMENT_UNAVAILABLE" -> "That test is no longer available: the employer cannot take it forward, or your application is no longer shared with them."
    "ATTEMPT_TIME_OVER" -> "Time ran out. Your answers saved before the time limit have been submitted."
    else -> fallback
}

@Composable
internal fun ScreeningPage(onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var invitations by remember { mutableStateOf<List<ScreeningInvitationDto>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var brief by remember { mutableStateOf<ScreeningBriefDto?>(null) }
    var attempt by remember { mutableStateOf<ScreeningAttemptDto?>(null) }
    var result by remember { mutableStateOf<ScreeningResultDto?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        runCatching { Api.listScreeningInvitations(context) }
            .onSuccess { invitations = it; failed = false }
            // A failed load is not an empty list, and "no tests" would be a lie the
            // candidate might act on.
            .onFailure { failed = true }
    }

    attempt?.let { open ->
        ScreeningAttemptPage(
            attempt = open,
            onFinished = { outcome -> attempt = null; result = outcome; reload += 1 },
            onTimeOver = { attempt = null; notice = screeningMessage("ATTEMPT_TIME_OVER", ""); reload += 1 },
            onCancel = { attempt = null },
        )
        return
    }

    brief?.let { current ->
        ScreeningBriefPage(
            brief = current,
            onBegin = {
                scope.launch {
                    runCatching { Api.startScreeningAttempt(context, current.id) }
                        .onSuccess { brief = null; result = null; attempt = it }
                        .onFailure {
                            brief = null
                            notice = screeningMessage((it as? Api.ApiException)?.code, "That test could not be opened.")
                        }
                }
            },
            onBack = { brief = null },
        )
        return
    }

    OverlayScaffold(title = "Screening tests", onClose = onClose) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            notice?.let {
                Spacer(Modifier.height(10.dp))
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                    Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
            result?.let {
                Spacer(Modifier.height(10.dp))
                PilotCard {
                    Column(Modifier.padding(16.dp)) {
                        Text("Submitted", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Text(
                            "You scored ${it.percentage.toInt()}% (${it.score.toInt()} of ${it.maxScore.toInt()}).",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
            when {
                failed -> EmptyState(
                    Icons.Filled.Assignment, Tone.Amber, "Your screening tests could not be loaded",
                    "Check your connection and try again.")
                invitations == null -> LoadingSpinner()
                invitations!!.isEmpty() -> EmptyState(
                    Icons.Filled.Assignment, Tone.Violet, "No screening tests",
                    "If an employer sends you a test for a role you applied to, it appears here.")
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        Spacer(Modifier.height(10.dp))
                        Text(
                            "Your result goes to that employer only. It is not part of your academic record and it does not change your readiness.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    items(invitations!!.size, key = { index -> invitations!![index].id }) { index ->
                        val invitation = invitations!![index]
                        val closed = invitation.state == "EXPIRED" ||
                            runCatching { Instant.parse(invitation.closesAt).isBefore(Instant.now()) }.getOrDefault(false)
                        val submitted = invitation.state == "SUBMITTED"
                        val unavailable = !submitted && !closed && !invitation.available
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                                    Column(Modifier.weight(1f)) {
                                        Text(invitation.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                        Text(
                                            invitation.employerName + " · " + invitation.roleTitle,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    StatusChip(
                                        when { submitted -> "Submitted"; closed -> "Closed"; unavailable -> "Unavailable"; else -> "Open" },
                                        when { submitted -> ChipKind.Positive; closed || unavailable -> ChipKind.Muted; else -> ChipKind.Accent },
                                    )
                                }
                                Spacer(Modifier.height(6.dp))
                                val questions = if (invitation.questionCount > 0) " · ${invitation.questionCount} questions" else ""
                                Text(
                                    "${invitation.durationSeconds / 60} min$questions · closes ${formatWhen(invitation.closesAt)}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                if (submitted) {
                                    invitation.percentage?.let {
                                        Spacer(Modifier.height(6.dp))
                                        Text("You scored ${it.toInt()}%", style = MaterialTheme.typography.bodyMedium)
                                    }
                                } else if (unavailable) {
                                    Spacer(Modifier.height(6.dp))
                                    Text(
                                        screeningMessage("ASSESSMENT_UNAVAILABLE", ""),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                } else if (!closed) {
                                    Spacer(Modifier.height(10.dp))
                                    Button(onClick = {
                                        scope.launch {
                                            runCatching { Api.getScreeningBrief(context, invitation.id) }
                                                .onSuccess { result = null; notice = null; brief = it }
                                                .onFailure { notice = screeningMessage((it as? Api.ApiException)?.code, "That test could not be opened.") }
                                        }
                                    }) { Text(if (invitation.state == "STARTED") "Continue" else "Start") }
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }
}

/** What the test covers and the terms, read and agreed before the timer starts. */
@Composable
private fun ScreeningBriefPage(brief: ScreeningBriefDto, onBegin: () -> Unit, onBack: () -> Unit) {
    var agreed by remember { mutableStateOf(false) }
    val resuming = brief.attemptState == "IN_PROGRESS"
    val fullMinutes = brief.durationSeconds / 60
    androidx.activity.compose.BackHandler(enabled = true) { onBack() }

    OverlayScaffold(title = "Before you start", onClose = onBack) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            item {
                Spacer(Modifier.height(12.dp))
                PilotCard {
                    Column(Modifier.padding(16.dp)) {
                        Text(brief.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text(brief.employerName + " · " + brief.roleTitle, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(10.dp))
                        Text("What you are assessed on", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        val formats = brief.questionFormats.joinToString(", ") { "${it.count} ${formatLabels[it.questionType] ?: it.questionType.lowercase()}" }
                        Text(
                            "${brief.questionCount} ${if (brief.questionCount == 1) "question" else "questions"}, ${brief.totalMarks.toInt()} marks in total: $formats.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(Modifier.height(6.dp))
                        val minutes = brief.minutesAvailableIfStartedNow
                        Text(
                            "Time allowed: $fullMinutes minutes. " + when {
                                minutes == null -> "NA"
                                resuming -> "You have $minutes minutes left."
                                minutes < fullMinutes -> "The test closes soon, so if you start now you have $minutes minutes."
                                else -> "If you start now you have the full $minutes minutes."
                            },
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text("Closes ${formatWhen(brief.closesAt)}", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            item {
                Spacer(Modifier.height(12.dp))
                PilotCard {
                    Column(Modifier.padding(16.dp)) {
                        Text("Before you start", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        listOf(
                            "One sitting. There is no second attempt at this test.",
                            "The timer starts the moment you begin and does not pause if you leave the app.",
                            "No camera, microphone or screen capture is used, and nothing records switching apps.",
                            "Your result goes to ${brief.employerName} for this application only, while they can see your application.",
                            "It is not part of your academic record or your learning evidence, and it does not change your readiness.",
                        ).forEach { line ->
                            Spacer(Modifier.height(6.dp))
                            Text("• $line", style = MaterialTheme.typography.bodyMedium)
                        }
                        Spacer(Modifier.height(12.dp))
                        when {
                            brief.notOpenYet -> Text("This test opens ${formatWhen(brief.opensAt)}.", style = MaterialTheme.typography.bodyMedium)
                            !brief.available -> Text("This test is no longer available.", style = MaterialTheme.typography.bodyMedium)
                            else -> {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Checkbox(checked = agreed, onCheckedChange = { agreed = it })
                                    Text("I have read what this test covers and how it works.", style = MaterialTheme.typography.bodyMedium)
                                }
                                Spacer(Modifier.height(8.dp))
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Button(enabled = agreed, onClick = onBegin) { Text(if (resuming) "Continue the test" else "Begin the test") }
                                    OutlinedButton(onClick = onBack) { Text("Not now") }
                                }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(28.dp))
            }
        }
    }
}

@Composable
private fun ScreeningAttemptPage(
    attempt: ScreeningAttemptDto,
    onFinished: (ScreeningResultDto) -> Unit,
    onTimeOver: () -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val chosen = remember {
        mutableStateMapOf<String, List<String>>().apply {
            attempt.questions.forEach { put(it.questionId, it.selectedOptionKeys) }
        }
    }
    var confirming by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    val endsAt = remember { attempt.remainingSeconds?.let { System.currentTimeMillis() + it * 1000L } }
    var secondsLeft by remember { mutableStateOf(attempt.remainingSeconds) }

    LaunchedEffect(endsAt) {
        if (endsAt == null) return@LaunchedEffect
        while (true) {
            val left = ((endsAt - System.currentTimeMillis()) / 1000L).toInt().coerceAtLeast(0)
            secondsLeft = left
            if (left == 0) break
            delay(1000L)
        }
    }

    androidx.activity.compose.BackHandler(enabled = true) { onCancel() }

    OverlayScaffold(title = "Screening test", onClose = onCancel) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            secondsLeft?.let { left ->
                Spacer(Modifier.height(10.dp))
                Text(
                    "Time left: ${left / 60}:${(left % 60).toString().padStart(2, '0')}. ONE keeps the time; answers after it runs out are not saved.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            notice?.let {
                Spacer(Modifier.height(10.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            LazyColumn(Modifier.fillMaxSize()) {
                items(attempt.questions.size, key = { index -> attempt.questions[index].questionId }) { index ->
                    val question = attempt.questions[index]
                    val multiple = question.questionType == "MULTIPLE_SELECT"
                    val selected = chosen[question.questionId] ?: emptyList()
                    Spacer(Modifier.height(12.dp))
                    PilotCard {
                        Column(Modifier.padding(16.dp)) {
                            Text("Question ${question.displayOrder}", style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.height(4.dp))
                            Text(question.questionText, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Spacer(Modifier.height(8.dp))
                            question.options.forEach { option ->
                                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                    val isChosen = selected.contains(option.key)
                                    val toggle = {
                                        val next = if (multiple) {
                                            if (isChosen) selected - option.key else selected + option.key
                                        } else listOf(option.key)
                                        chosen[question.questionId] = next
                                        scope.launch {
                                            // Saved as they go: a dropped connection must not
                                            // cost the candidate the work they have done.
                                            runCatching { Api.saveScreeningAnswer(context, attempt.id, question.questionId, next) }
                                                .onFailure {
                                                    val code = (it as? Api.ApiException)?.code
                                                    if (code == "ATTEMPT_TIME_OVER") onTimeOver()
                                                    else notice = screeningMessage(code, "That answer could not be saved.")
                                                }
                                        }
                                        Unit
                                    }
                                    if (multiple) {
                                        Checkbox(checked = isChosen, onCheckedChange = { toggle() })
                                    } else {
                                        RadioButton(selected = isChosen, onClick = { toggle() })
                                    }
                                    Text(option.text, style = MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                    }
                }
                item {
                    Spacer(Modifier.height(16.dp))
                    if (confirming) {
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Text(
                                    "Submitting is final. You cannot change your answers afterwards, and there is no second attempt at this test.",
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                Spacer(Modifier.height(10.dp))
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Button(enabled = !submitting, onClick = {
                                        submitting = true
                                        scope.launch {
                                            runCatching { Api.submitScreeningAttempt(context, attempt.id) }
                                                .onSuccess { onFinished(it) }
                                                .onFailure { notice = screeningMessage((it as? Api.ApiException)?.code, "That test could not be submitted.") }
                                            submitting = false
                                        }
                                    }) { Text("Yes, submit") }
                                    OutlinedButton(onClick = { confirming = false }) { Text("Keep working") }
                                }
                            }
                        }
                    } else {
                        Button(onClick = { confirming = true }) { Text("Submit test") }
                    }
                    Spacer(Modifier.height(28.dp))
                }
            }
        }
    }
}
