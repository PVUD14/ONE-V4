package pro.ai8ht.one

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Quiz
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import pro.ai8ht.one.ui.Tone
import java.util.UUID

/**
 * Career-readiness assessments on the phone.
 *
 * Institution exams stay off mobile by policy — proctored, timed, integrity telemetry —
 * but these are short multiple-choice sets that feed the advisory band, and making a
 * student find a laptop for one was never the intent of that rule.
 *
 * The submission key is generated once when the attempt starts, not at the moment of
 * submitting. A retry over a dropped connection then carries the same key and cannot be
 * counted as a second submission against the definition's attempt limit.
 */
@Composable
internal fun ReadinessAssessmentPage(onClose: () -> Unit, onSubmitted: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var catalog by remember { mutableStateOf<List<ReadinessAssessmentDto>?>(null) }
    var attempt by remember { mutableStateOf<ReadinessAttemptDto?>(null) }
    var submissionKey by remember { mutableStateOf("") }
    val answers = remember { mutableStateMapOf<String, String>() }
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { catalog = runCatching { Api.readinessCatalog(context) }.getOrNull() ?: emptyList() }

    OverlayScaffold(title = "Readiness check", onClose = onClose) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            notice?.let {
                Spacer(Modifier.height(10.dp))
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                    Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
            val live = attempt
            when {
                live != null -> AttemptBody(
                    attempt = live,
                    answers = answers,
                    busy = busy,
                    onSelect = { question, option -> answers[question] = option },
                    onSubmit = {
                        busy = true
                        notice = null
                        scope.launch {
                            runCatching {
                                Api.submitReadinessAttempt(context, live.attemptId, answers.toMap(), submissionKey)
                            }
                                .onSuccess { onSubmitted(); onClose() }
                                .onFailure {
                                    notice = (it as? Api.ApiException)?.detail ?: "Could not submit just now. Try again."
                                }
                            busy = false
                        }
                    },
                )
                catalog == null -> LoadingSpinner()
                catalog!!.isEmpty() -> EmptyState(
                    Icons.Filled.Quiz, Tone.Accent, "No readiness checks available",
                    "When your institution publishes a readiness assessment it appears here.",
                )
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        Spacer(Modifier.height(12.dp))
                        Text(
                            "A short set of questions. What you demonstrate feeds your readiness band — " +
                                "which is advisory guidance for you and your college, and is never shown to employers.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    items(catalog!!, key = { it.id }) { assessment ->
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Text(assessment.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                Text("${assessment.selectionCount} questions",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Spacer(Modifier.height(10.dp))
                                Button(
                                    onClick = {
                                        busy = true
                                        notice = null
                                        scope.launch {
                                            runCatching { Api.startReadinessAttempt(context, assessment.id) }
                                                .onSuccess {
                                                    // Minted here, at the start, so a retry of the
                                                    // submission carries the same key.
                                                    submissionKey = "and-" + UUID.randomUUID()
                                                    answers.clear()
                                                    attempt = it
                                                    if (it.resumed) {
                                                        notice = "Picking up the attempt you already had open. " +
                                                            "Its time has been running since you started it."
                                                    }
                                                }
                                                .onFailure {
                                                    notice = (it as? Api.ApiException)?.detail
                                                        ?: "Could not start this assessment."
                                                }
                                            busy = false
                                        }
                                    },
                                    enabled = !busy,
                                    shape = RoundedCornerShape(10.dp),
                                ) { Text("Start") }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }
}

@Composable
private fun AttemptBody(
    attempt: ReadinessAttemptDto,
    answers: Map<String, String>,
    busy: Boolean,
    onSelect: (String, String) -> Unit,
    onSubmit: () -> Unit,
) {
    val answered = attempt.questions.count { answers.containsKey(it.id) }
    LazyColumn(Modifier.fillMaxSize()) {
        item {
            Spacer(Modifier.height(12.dp))
            Text("$answered of ${attempt.questions.size} answered", style = MaterialTheme.typography.titleSmall)
        }
        items(attempt.questions, key = { it.id }) { question ->
            Spacer(Modifier.height(12.dp))
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text(question.prompt, style = MaterialTheme.typography.bodyLarge)
                    Spacer(Modifier.height(8.dp))
                    question.options.forEach { option ->
                        Row(
                            Modifier.fillMaxWidth().clickable { onSelect(question.id, option.id) }.padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = answers[question.id] == option.id,
                                onClick = { onSelect(question.id, option.id) },
                            )
                            Text(option.text, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
        }
        item {
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = onSubmit,
                // Every question answered, because the server scores the whole set and a
                // partial submission would understate what the student actually knows.
                enabled = !busy && answered == attempt.questions.size && attempt.questions.isNotEmpty(),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (busy) "Submitting…" else "Submit") }
            Spacer(Modifier.height(8.dp))
            Text(
                "You can submit once. ONE scores your answers after you submit.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(24.dp))
        }
    }
}
