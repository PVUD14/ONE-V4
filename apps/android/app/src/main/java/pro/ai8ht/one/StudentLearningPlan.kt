package pro.ai8ht.one

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.Quiz
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.filled.Update
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import pro.ai8ht.one.ui.Tone

/**
 * The student learning experience on Android (ENG-18) — the same plan the web shows at the top of Learning,
 * placed at the top of the existing Learning tab (no navigation change).
 *
 * The placement test (after the onboarding question on the Career target screen), one next step with its
 * reasons in plain words, practice on that step with the hint ladder (and the warning that an answer after the
 * third hint counts as assisted), the path in skip / review / learn groups, and what is due for review. Labels,
 * reasons and counts only — never a readiness value, a score, a likelihood, a due date or any other model
 * number — and NA or a plain sentence wherever something is not available. Works with every AI flag off.
 * INST-16 adds "From your lecturer" (LearningActions.kt) above the next step: work a lecturer assigned or a next
 * step they chose is planned even before a target role is chosen.
 */

internal val learningReasonText = mapOf(
    "FACULTY_OVERRIDE" to "Your faculty set this step.",
    "DUE_REVIEW" to "It is due for review — a quick check that you still remember it.",
    "FACULTY_ASSIGNMENT" to "Your faculty assigned it.",
    "REPEATED_MISCONCEPTION" to "The same mistake has come up more than once.",
    "GAP_UNKNOWN" to "Nothing has measured this skill yet.",
    "GAP_MISSING" to "Your evidence does not meet this requirement yet.",
    "GAP_PARTIAL" to "Your evidence partly meets this requirement.",
    "REQUIREMENT_ESSENTIAL" to "Your target role lists it as essential.",
    "REQUIREMENT_IMPORTANT" to "Your target role lists it as important.",
    "REQUIREMENT_HELPFUL" to "Your target role lists it as helpful.",
    "SHORTER_ACTION_FOR_SESSION" to "It fits the time you have.",
    "SESSION_TIME_SHORT" to "Every step needs more time than you have; this is the shortest.",
    "NEW_SKILL" to "You have not practised it yet.",
    "NOT_ENOUGH_EVIDENCE" to "There is not enough evidence about it yet.",
    "NEAR_MASTERY" to "You are close to showing it.",
    "STUCK" to "You have tried it on more than one day without an unaided success.",
    "ACTIVE_MISCONCEPTION" to "A mistake pattern is still open on it.",
    "NO_APPLICABLE_STRATEGY" to "No published teaching approach fits yet, so this is plain practice.",
    "NON_ADAPTIVE_NO_CONSENT" to "Your plan follows your target role’s order; it does not adapt to your answers.",
    "NO_CAREER_TARGET" to "You have not chosen a target role yet.",
    "ALL_REQUIREMENTS_MET" to "Every requirement of your target role is met.",
    "ALREADY_MET" to "Already met by your evidence.",
    "PRACTISED_BEFORE" to "You have practised it before.",
)

private val actionLabel = mapOf(
    "REVIEW" to "Review", "REMEDIATE" to "Fix a mistake pattern", "PRACTICE" to "Practise", "LEARN" to "Learn",
    "FOLLOW_ASSIGNMENT" to "Assigned by faculty", "NONE" to "Nothing to do right now",
)

internal val learningBandLabel = mapOf(
    "NOT_ENOUGH_EVIDENCE" to "Not enough evidence", "DEVELOPING" to "Developing", "PROGRESSING" to "Progressing", "DEMONSTRATED" to "Demonstrated",
)

private val placementLevelLabel = mapOf(
    "AWARE" to "Aware", "GUIDED" to "Guided", "INDEPENDENT" to "Independent", "TROUBLESHOOT" to "Can troubleshoot",
    "NOT_ENOUGH_EVIDENCE" to "Not enough evidence",
)

private fun bandKind(band: String): ChipKind = when (band) {
    "DEMONSTRATED" -> ChipKind.Positive
    "PROGRESSING" -> ChipKind.Accent
    "DEVELOPING" -> ChipKind.Waiting
    else -> ChipKind.Muted
}

@Composable
private fun Muted(text: String, fontFamily: androidx.compose.ui.text.font.FontFamily? = null) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontFamily = fontFamily)
}

@Composable
private fun CardHead(title: String, chip: String, kind: ChipKind) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        StatusChip(chip, kind)
    }
    Spacer(Modifier.height(8.dp))
}

/** The whole plan, as cards for the Learning tab's list. [onOpenCareer] opens the Career target screen. */
@Composable
internal fun LearningPlanSection(onOpenCareer: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var path by remember { mutableStateOf<Load<LearningPathDto>>(Load.Loading) }
    var step by remember { mutableStateOf<LearningStepDto?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    // INST-16: what the student's lecturers set (assignments, sessions, a chosen next step).
    var lecturer by remember { mutableStateOf<Load<StudentLearningActionsDto>>(Load.Loading) }

    LaunchedEffect(reload) {
        lecturer = loadOf { Api.myLearningActions(context) }
        val loaded = loadOf { Api.learningPath(context) }
        path = loaded
        // A refresh after acting keeps the step the student is on; only the first load takes the latest one.
        if (step == null && loaded is Load.Ready) step = loaded.value.latestStep
    }

    val planNext: () -> Unit = {
        busy = true; notice = null
        scope.launch {
            runCatching { Api.startNextLearningStep(context) }
                .onSuccess { step = it; reload += 1 }
                .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Your next step could not be planned. Try again." }
            busy = false
        }
    }
    val lecturerWork = (lecturer as? Load.Ready)?.value?.hasLecturerWork() == true

    Column {
        Spacer(Modifier.height(10.dp))
        PlacementTestCard()
        Spacer(Modifier.height(12.dp))
        FromYourLecturerCard(lecturer, busy, planNext)
        Spacer(Modifier.height(12.dp))
        PilotCard {
            Column(Modifier.padding(16.dp)) {
                val current = step
                CardHead("Your next step", current?.let { actionLabel[it.action] ?: "Step" } ?: "NA", if (current == null) ChipKind.Muted else ChipKind.Accent)
                notice?.let { Muted(it); Spacer(Modifier.height(6.dp)) }
                when (val state = path) {
                    is Load.Loading -> Muted("Loading your plan…")
                    is Load.Failed -> Muted("NA — your learning plan could not be loaded right now.")
                    is Load.Ready -> if (state.value.target == null && !lecturerWork) {
                        Muted("Choose the job you want first. Your path and next steps are planned against it.")
                        Spacer(Modifier.height(8.dp))
                        Button(onClick = onOpenCareer) { Text("Choose a target role") }
                    } else {
                        if (state.value.target == null) {
                            Muted("Your lecturer’s work is planned now. Choose the job you want on Career target to plan the rest of your path.")
                            Spacer(Modifier.height(6.dp))
                        }
                        if (current != null) StepBody(current) { next -> step = next; reload += 1 } else Muted("No step planned yet.")
                        Spacer(Modifier.height(10.dp))
                        Button(enabled = !busy, onClick = planNext) { Text(if (current == null) "Plan my first step" else "Plan my next step") }
                    }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        PathGroupsCard(path)
        Spacer(Modifier.height(12.dp))
        DueReviewsCard(path)
    }
}

@Composable
private fun StepBody(step: LearningStepDto, onStep: (LearningStepDto) -> Unit) {
    Text(step.skill?.name ?: (actionLabel["NONE"] ?: ""), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(6.dp))
    Text("Why this step", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
    step.reasonCodes.forEach { code ->
        Text("• " + (learningReasonText[code] ?: "A rule of your plan chose it."), style = MaterialTheme.typography.bodySmall)
    }
    if (step.lessons.isNotEmpty()) {
        Spacer(Modifier.height(8.dp))
        Text("Lessons on this skill", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        // ENG-16: titled in the chosen lesson language where a published version exists.
        step.lessons.forEach { lesson -> Muted("• ${lesson.title} (listed with your modules below)", pro.ai8ht.one.ui.lessonFontFamily(lesson.language)) }
    }
    Spacer(Modifier.height(10.dp))
    StepPracticeBlock(step, onStep)
}

@Composable
private fun StepPracticeBlock(step: LearningStepDto, onStep: (LearningStepDto) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var choice by remember(step.decisionId) { mutableStateOf<String?>(null) }
    var feedback by remember(step.decisionId) { mutableStateOf<StepFeedbackDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val practice = step.practice

    feedback?.let { result ->
        StatusChip(
            (if (result.correct) "Right." else "Not quite.") + (if (result.assisted) " Counted as assisted: it does not count as solved on your own." else ""),
            if (result.correct) ChipKind.Positive else ChipKind.Waiting,
        )
        Spacer(Modifier.height(6.dp))
    }
    when (practice.status) {
        "NO_SKILL" -> Unit
        "NO_PRACTICE" -> Muted("No published practice for this skill yet. Your plan will use it as soon as questions are published.")
        "COMPLETED" -> Muted("Step finished: you answered ${practice.questionsAnswered} ${if (practice.questionsAnswered == 1) "question" else "questions"}. Plan your next step when you are ready.")
        else -> practice.question?.let { question ->
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp)) {
                Column(Modifier.fillMaxWidth().padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Question ${question.position}", Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                        StatusChip("${practice.questionsAnswered} answered", ChipKind.Muted)
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(question.prompt, style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(6.dp))
                    question.options.forEach { option ->
                        Row(
                            Modifier.fillMaxWidth().clickable { choice = option.id }.padding(vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = choice == option.id, onClick = { choice = option.id })
                            Text(option.text, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    val entries = hintEntries(question)
                    val pending = entries.any { it.state == "PENDING" }
                    val tutor = question.tutor
                    // The AI control appears only where the tutor is the student's to use (as on the web).
                    val showTutor = tutor != null && (tutor.available || tutor.reason in setOf("DAILY_LIMIT", "LANGUAGE_NOT_SUPPORTED", "PENDING"))
                    entries.forEach { entry ->
                        Spacer(Modifier.height(4.dp))
                        HintEntryRow(entry)
                    }
                    if (pending) {
                        // The hint is written by a job: re-read the step every two seconds, for up to a minute.
                        LaunchedEffect(step.decisionId, entries.size) {
                            repeat(TUTOR_POLL_LIMIT) {
                                delay(TUTOR_POLL_MS)
                                val next = runCatching { Api.learningStep(context, step.decisionId) }.getOrNull()
                                // Hand the step back only once nothing is being written (no reload every two seconds).
                                val stillPending = next?.practice?.question?.hintDetails?.any { it.state == "PENDING" } == true
                                if (next != null && !stillPending) {
                                    onStep(next)
                                    return@LaunchedEffect
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                    if (!question.hintsAvailable) Muted("No hints for this question.")
                    else if (question.hints.size in 2..3) Muted("The next hint shows a worked step: an answer after it counts as assisted, not as your own.")
                    error?.let { Muted(it) }
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(enabled = !busy && choice != null, onClick = {
                            val picked = choice ?: return@Button
                            busy = true; error = null
                            scope.launch {
                                runCatching { Api.answerStepQuestion(context, step.decisionId, question.id, picked) }
                                    .onSuccess { feedback = it.feedback; choice = null; onStep(it.step) }
                                    .onFailure { error = (it as? Api.ApiException)?.detail ?: "Your answer could not be checked. Try again." }
                                busy = false
                            }
                        }) { Text("Check answer") }
                        if (question.hintsAvailable && question.hints.size < 4) {
                            OutlinedButton(enabled = !busy && !pending, onClick = {
                                busy = true; error = null
                                scope.launch {
                                    runCatching { Api.revealStepHint(context, step.decisionId, question.id) }
                                        .onSuccess { onStep(it) }
                                        .onFailure { error = (it as? Api.ApiException)?.detail ?: "The hint could not be shown. Try again." }
                                    busy = false
                                }
                            }) { Text("Show " + hintLabel(question.hints.size).replaceFirst("Hint", "hint")) }
                        }
                    }
                    if (showTutor && tutor != null && question.hints.size < 4) {
                        Spacer(Modifier.height(6.dp))
                        OutlinedButton(enabled = !busy && !pending && tutor.available, onClick = {
                            busy = true; error = null
                            scope.launch {
                                runCatching { Api.requestTutorHint(context, step.decisionId, question.id) }
                                    .onSuccess { onStep(it) }
                                    .onFailure { error = (it as? Api.ApiException)?.detail ?: "The AI tutor could not be asked. Try again." }
                                busy = false
                            }
                        }) { Text("Ask the AI tutor for " + hintLabel(question.hints.size).replaceFirst("Hint", "hint")) }
                    }
                    if (showTutor && tutor != null) {
                        Spacer(Modifier.height(4.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            StatusChip("AI", ChipKind.Accent)
                            Spacer(Modifier.width(6.dp))
                            val sentence = TUTOR_REASON_TEXT[tutor.reason]
                                ?: "The AI tutor gives a hint at the next level, never the answer. It counts like a written hint."
                            Muted(sentence + (tutor.remainingToday?.let { " AI hints left today: $it." } ?: ""))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PathGroupsCard(path: Load<LearningPathDto>) {
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            val ready = (path as? Load.Ready)?.value
            CardHead("Your path", ready?.target?.title ?: "NA", ChipKind.Muted)
            when {
                path is Load.Loading -> Muted("Loading…")
                ready == null -> Muted("NA — your learning plan could not be loaded right now.")
                ready.target == null -> Muted("NA — choose your target role to see what to skip, review and learn.")
                else -> {
                    val counts = ready.requirements
                    Muted(if (counts != null) "${counts.met} of ${counts.total} requirements met · ${counts.notMeasured} not measured yet" else "Requirements: NA — not measured yet.")
                    listOf(
                        Triple("Review", ready.groups.review, "Nothing to review."),
                        Triple("Learn", ready.groups.learn, "Nothing new to learn."),
                        Triple("Skip", ready.groups.skip, "Nothing to skip yet."),
                    ).forEach { (title, entries, empty) ->
                        Spacer(Modifier.height(10.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            StatusChip("${entries.size}", ChipKind.Muted)
                        }
                        if (entries.isEmpty()) Muted(empty)
                        entries.forEach { entry -> PathEntryRow(entry, title) }
                    }
                }
            }
        }
    }
}

@Composable
private fun PathEntryRow(entry: PathEntryDto, group: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        IconBubble(
            when (group) { "Review" -> Icons.Filled.Update; "Skip" -> Icons.Filled.TaskAlt; else -> Icons.Filled.MenuBook },
            when (group) { "Review" -> Tone.Accent; "Skip" -> Tone.Green; else -> Tone.Violet },
            size = 34.dp,
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(entry.skillName, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Muted(entry.reasonCodes.joinToString(" ") { learningReasonText[it] ?: prettify(it) })
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                StatusChip(learningBandLabel[entry.band] ?: "Not enough evidence", bandKind(entry.band))
                if (entry.due) StatusChip("Due for review", ChipKind.Accent)
            }
        }
    }
}

@Composable
private fun DueReviewsCard(path: Load<LearningPathDto>) {
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            val ready = (path as? Load.Ready)?.value
            CardHead(
                "Due for review",
                if (ready?.adaptive == true) (if (ready.dueReviews.isEmpty()) "Nothing due" else "Due now") else "NA",
                if (ready?.adaptive == true) ChipKind.Accent else ChipKind.Muted,
            )
            when {
                path is Load.Loading -> Muted("Loading…")
                ready == null -> Muted("NA — your learning plan could not be loaded right now.")
                !ready.adaptive -> Muted("NA — reviews are scheduled from your answers once adaptive learning is available to you.")
                ready.dueReviews.isEmpty() -> Muted("Nothing is due for review right now.")
                else -> ready.dueReviews.forEach { review ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconBubble(Icons.Filled.Update, Tone.Accent, size = 34.dp)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(review.skillName, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Muted("Due for review")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PlacementTestCard() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var placement by remember { mutableStateOf<Load<PlacementDto>>(Load.Loading) }
    var choice by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { placement = loadOf { Api.placementTest(context) } }

    fun act(block: suspend () -> PlacementDto) {
        busy = true; error = null
        scope.launch {
            runCatching { block() }
                .onSuccess { placement = Load.Ready(it); choice = null }
                .onFailure { error = (it as? Api.ApiException)?.detail ?: "That could not be saved. Try again." }
            busy = false
        }
    }

    PilotCard {
        Column(Modifier.padding(16.dp)) {
            val ready = (placement as? Load.Ready)?.value
            CardHead(
                "Placement test",
                when (ready?.status) { "COMPLETED" -> "Done"; "IN_PROGRESS" -> "In progress"; else -> "Aptitude" },
                if (ready?.status == "COMPLETED") ChipKind.Positive else ChipKind.Muted,
            )
            when {
                placement is Load.Loading -> Muted("Loading…")
                ready == null -> Muted("NA — the placement test could not be loaded right now.")
                ready.status == "NOT_AVAILABLE" -> Muted(
                    if (ready.reason == "CONSENT_REQUIRED") "Not open yet — the placement test adapts to your answers, and adaptive learning is not available to you yet."
                    else "Not open yet — there are not enough published aptitude questions for a placement test.",
                )
                ready.status == "NOT_STARTED" -> {
                    Muted("Up to 25 questions and 25 minutes. It places you at a level so your plan starts in the right place. It does not count toward readiness.")
                    Spacer(Modifier.height(8.dp))
                    Button(enabled = !busy, onClick = { act { Api.startPlacementTest(context) } }) { Text("Start the placement test") }
                }
                ready.status == "COMPLETED" -> Text(
                    "Your placement level: ${placementLevelLabel[ready.placementLevel] ?: "Not enough evidence"} (${ready.questionsAnswered} questions answered).",
                    style = MaterialTheme.typography.bodyMedium,
                )
                else -> {
                    val question = ready.question
                    val testId = ready.placementTestId
                    if (question == null || testId == null) {
                        Muted("NA — the placement test could not be loaded right now.")
                    } else {
                        Muted("Question ${question.position} of up to ${ready.maxQuestions}" + (ready.deadlineAt?.let { " · ends ${formatWhen(it)}" } ?: ""))
                        Spacer(Modifier.height(6.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            IconBubble(Icons.Filled.Quiz, Tone.Violet, size = 30.dp)
                            Spacer(Modifier.width(8.dp))
                            Text(question.prompt, style = MaterialTheme.typography.bodyMedium)
                        }
                        question.options.forEach { option ->
                            Row(
                                Modifier.fillMaxWidth().clickable { choice = option.id }.padding(vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = choice == option.id, onClick = { choice = option.id })
                                Text(option.text, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                        Button(enabled = !busy && choice != null, onClick = {
                            val picked = choice ?: return@Button
                            act { Api.answerPlacementQuestion(context, testId, question.id, picked) }
                        }) { Text("Next") }
                    }
                }
            }
            error?.let { Spacer(Modifier.height(6.dp)); Muted(it) }
        }
    }
}

/** ENG-22: what an AI hint is, said wherever one is shown (the same words as the web). */
internal const val AI_HINT_NOTE = "Written by the AI tutor and checked by ONE’s rules — not reviewed by a person."
private val AI_FALLBACK_TEXT = mapOf(
    "CHECKS_FAILED" to "The AI hint did not pass ONE’s checks, so this is the written hint for this level.",
    "UNAVAILABLE" to "The AI tutor could not answer, so this is the written hint for this level.",
    "TIMED_OUT" to "The AI tutor took too long, so this is the written hint for this level.",
    "NOT_A_HINT" to "The AI tutor did not give a hint, so this is the written hint for this level.",
)
private val TUTOR_REASON_TEXT = mapOf(
    "LANGUAGE_NOT_SUPPORTED" to "The AI tutor does not write in your language yet. The written hints still work.",
    "DAILY_LIMIT" to "You have used today’s AI hints. The written hints still work.",
    "PENDING" to "The AI tutor is writing your hint…",
)
private const val TUTOR_POLL_MS = 2_000L
private const val TUTOR_POLL_LIMIT = 30

/** The shown hints as entries; an older API without `hintDetails` gives written hints. */
private fun hintEntries(question: StepQuestionDto): List<StepHintDto> =
    question.hintDetails ?: question.hints.mapIndexed { index, text -> StepHintDto(level = index + 1, source = "LADDER", state = "SHOWN", text = text) }

/** One shown hint level, the AI tutor's labelled as AI (ENG-22). */
@Composable
private fun HintEntryRow(entry: StepHintDto) {
    Column {
        Row(verticalAlignment = Alignment.Top) {
            StatusChip(hintLabel(entry.level - 1), ChipKind.Waiting)
            if (entry.source == "AI_TUTOR" && entry.state != "FALLBACK") {
                Spacer(Modifier.width(6.dp))
                StatusChip("AI hint", ChipKind.Accent)
            }
            Spacer(Modifier.width(6.dp))
            Text(
                if (entry.state == "PENDING") "The AI tutor is writing this hint…" else entry.text.orEmpty(),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        when {
            entry.source == "AI_TUTOR" && entry.state == "SHOWN" -> Muted(AI_HINT_NOTE)
            entry.source == "AI_TUTOR" && entry.state == "FALLBACK" -> Muted(AI_FALLBACK_TEXT[entry.fallback] ?: AI_FALLBACK_TEXT.getValue("UNAVAILABLE"))
        }
    }
}

/** The four hint levels by name (ENG-15), as on the web. Levels 3 and 4 make a right answer assisted. */
private val HINT_LEVEL_NAMES = listOf("Nudge", "Strategy", "Worked step", "Near solution")

private fun hintLabel(index: Int): String = "Hint ${index + 1} · ${HINT_LEVEL_NAMES.getOrElse(index) { "" }}"
