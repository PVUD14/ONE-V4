package pro.ai8ht.one

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Career target, goals and onboarding (ENG-19) — the Android side of the web's My Career goals panel.
 *
 * The first thing ONE asks a new student, or a graduate who has already left college, is "What job do you
 * want?": a search over the roles offered to them (names and synonyms), or "Not sure yet" with a short survey
 * and 3–5 suggested roles, each with the reasons it was suggested. After that the page shows the chosen
 * target and its gap (as before), every live goal, a way to add topics (and exams or company preparation where
 * the catalogue is open), and the skills the goals need, each listed once. Statuses and reasons only — never a
 * readiness value or a score — and NA wherever something could not be loaded. The screen keeps its existing
 * entry and title; no navigation changes.
 */

private val goalTypeLabel = mapOf(
    "ROLE" to "Role", "TOPIC" to "Topic", "EXAM" to "Exam", "COMPANY" to "Company prep", "DISCOVERY" to "Not sure yet",
)

private val skillStatusLabel = mapOf(
    "MET" to "Met", "PARTIAL" to "Partly met", "MISSING" to "Not met yet", "UNKNOWN" to "Not measured yet",
)

@Composable
private fun ReleaseChip(label: String?) {
    when (label) {
        "VERIFIED" -> StatusChip("Verified", ChipKind.Positive)
        "SELECTABLE" -> StatusChip("Not yet verified", ChipKind.Muted)
        else -> Unit
    }
}

@Composable
private fun Hint(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
internal fun CareerTargetPage(onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var goals by remember { mutableStateOf<Load<LearnerGoalsDto>>(Load.Loading) }
    var targets by remember { mutableStateOf<List<CareerTargetDto>>(emptyList()) }
    var reload by remember { mutableIntStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }
    var choosing by remember { mutableStateOf(false) }

    LaunchedEffect(reload) {
        goals = loadOf { Api.learnerGoals(context) }
        // The gap cards are extra detail on the role goal; failing to load them leaves the goals usable.
        targets = runCatching { Api.careerTargets(context) }.getOrNull() ?: emptyList()
    }

    fun act(done: String, block: suspend () -> LearnerGoalsDto) {
        scope.launch {
            runCatching { block() }
                .onSuccess { goals = Load.Ready(it); notice = done; choosing = false; reload += 1 }
                .onFailure { notice = (it as? Api.ApiException)?.detail ?: "That could not be saved. Try again." }
        }
    }

    val ready = (goals as? Load.Ready)?.value
    OverlayScaffold(
        title = "Career target",
        onClose = onClose,
        actions = {
            if (ready != null && ready.goals.any { it.priority == "PRIMARY" }) {
                TextButton(onClick = { choosing = !choosing }) { Text(if (choosing) "Cancel" else "Change") }
            }
        },
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            notice?.let {
                Spacer(Modifier.height(10.dp))
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                    Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
            when (val state = goals) {
                is Load.Loading -> LoadingSpinner()
                is Load.Failed -> FailedState(state.message) { reload += 1 }
                is Load.Ready -> {
                    val data = state.value
                    val hasPrimary = data.goals.any { it.priority == "PRIMARY" }
                    val origin = if (data.onboarding) "ONBOARDING" else "GOALS"
                    LazyColumn(Modifier.fillMaxSize()) {
                        if (data.onboarding || !hasPrimary || choosing) item {
                            OnboardingCard(
                                origin = origin,
                                onRole = { role -> act("${role.title} is now your main goal.") { Api.setRoleGoal(context, role.id, true, origin) } },
                                onSuggested = { role -> act("${role.title} is now your main goal.") { Api.setRoleGoal(context, role.id, true, "DISCOVERY_SUGGESTION") } },
                            )
                        }
                        if (!data.onboarding) {
                            items(targets, key = { it.id }) { target -> TargetGapCard(target) }
                            item {
                                GoalsCard(data) { goal, status ->
                                    act(if (status == "ACHIEVED") "Marked “${goal.title}” as achieved." else "Removed “${goal.title}” from your goals.") {
                                        Api.endGoal(context, goal.id, status)
                                    }
                                }
                            }
                            item {
                                AddGoalCard(
                                    catalogueOpen = data.catalogueOpen,
                                    onRole = { role -> act("Added ${role.title}.") { Api.setRoleGoal(context, role.id, !hasPrimary, "GOALS") } },
                                    onTopic = { topic -> act("Added ${topic.name}.") { Api.setTopicGoal(context, topic.id) } },
                                    onCatalogue = { goal -> act("Added ${goal.title}.") { Api.setCatalogueGoal(context, goal.goalType, goal.code) } },
                                )
                            }
                            item { SharedSkillsCard(data) }
                        }
                        item { Spacer(Modifier.height(24.dp)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun OnboardingCard(origin: String, onRole: (GoalRoleOptionDto) -> Unit, onSuggested: (GoalRoleOptionDto) -> Unit) {
    var discovery by remember { mutableStateOf(false) }
    Spacer(Modifier.height(12.dp))
    PilotCard(glow = true) {
        Column(Modifier.padding(16.dp)) {
            Text("What job do you want?", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(4.dp))
            Hint("Pick the role you are aiming at. Your gaps and next steps are measured against it. " +
                "Whether you are studying now or finished college already, this works the same.")
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (discovery) OutlinedButton(onClick = { discovery = false }) { Text("Search roles") }
                else Button(onClick = {}, shape = RoundedCornerShape(10.dp)) { Text("Search roles") }
                if (discovery) Button(onClick = {}, shape = RoundedCornerShape(10.dp)) { Text("Not sure yet") }
                else OutlinedButton(onClick = { discovery = true }) { Text("Not sure yet") }
            }
            Spacer(Modifier.height(12.dp))
            if (discovery) DiscoverySection(origin, onSuggested) else GoalSearch(rolesOnly = true, catalogueOpen = false, onRole = onRole)
        }
    }
}

@Composable
private fun GoalSearch(
    rolesOnly: Boolean,
    catalogueOpen: Boolean,
    onRole: (GoalRoleOptionDto) -> Unit,
    onTopic: ((GoalTopicOptionDto) -> Unit)? = null,
    onCatalogue: ((GoalCatalogueOptionDto) -> Unit)? = null,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var query by remember { mutableStateOf("") }
    var options by remember { mutableStateOf<Load<GoalOptionsDto>>(Load.Loading) }
    LaunchedEffect(query) {
        if (query.isNotEmpty()) delay(250)
        options = loadOf { Api.goalOptions(context, query.take(80)) }
    }
    OutlinedTextField(
        query, { query = it.take(80) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
        label = { Text(if (rolesOnly) "Search by job title" else if (catalogueOpen) "Search roles, topics and exams" else "Search roles and topics") },
    )
    Spacer(Modifier.height(8.dp))
    when (val state = options) {
        is Load.Loading -> Hint("Loading…")
        is Load.Failed -> Hint("NA — the list could not be loaded right now.")
        is Load.Ready -> {
            val found = state.value
            val topics = if (rolesOnly) emptyList() else found.topics
            val catalogue = if (rolesOnly) emptyList() else found.catalogueGoals
            if (found.roles.isEmpty() && topics.isEmpty() && catalogue.isEmpty()) {
                Hint(if (query.isBlank()) "Nothing is available to choose yet." else "Nothing matches “${query.trim()}”.")
            }
            found.roles.forEach { role ->
                OptionRow(
                    title = role.title,
                    detail = listOfNotNull(role.catalogueCode, role.family).joinToString(" · ") +
                        (role.matchedSynonym?.let { " · also called “$it”" } ?: ""),
                    label = role.releaseLabel,
                    action = "Choose",
                ) { onRole(role) }
            }
            if (onTopic != null) topics.forEach { topic -> OptionRow(topic.name, "Topic", null, "Add") { onTopic(topic) } }
            if (onCatalogue != null) catalogue.forEach { goal ->
                OptionRow(goal.title, if (goal.goalType == "EXAM") "Exam" else "Company prep", "SELECTABLE", "Add") { onCatalogue(goal) }
            }
        }
    }
}

@Composable
private fun OptionRow(title: String, detail: String, label: String?, action: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            if (detail.isNotBlank()) Hint(detail)
        }
        ReleaseChip(label)
        Spacer(Modifier.width(6.dp))
        TextButton(onClick = onClick) { Text(action) }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun DiscoverySection(origin: String, onChoose: (GoalRoleOptionDto) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var discovery by remember { mutableStateOf<Load<CareerDiscoveryDto>>(Load.Loading) }
    val interests = remember { mutableStateListOf<String>() }
    val strengths = remember { mutableStateListOf<String>() }
    var branch by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        discovery = loadOf { Api.careerDiscovery(context) }
        (discovery as? Load.Ready)?.value?.answers?.let { answers ->
            interests.addAll(answers.interests); strengths.addAll(answers.strengths); branch = answers.branch
        }
    }

    val loaded = when (val state = discovery) {
        is Load.Loading -> { Hint("Loading…"); return }
        is Load.Failed -> { Hint("NA — the survey could not be loaded right now."); return }
        is Load.Ready -> state.value
    }

    fun toggle(list: MutableList<String>, code: String) {
        if (list.contains(code)) list.remove(code) else if (list.size < 3) list.add(code)
    }

    Text("What kind of work interests you? (up to three)", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    loaded.survey.interests.forEach { choice ->
        Row(Modifier.fillMaxWidth().clickable { toggle(interests, choice.code) }, verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = interests.contains(choice.code), onCheckedChange = { toggle(interests, choice.code) })
            Text(choice.label, style = MaterialTheme.typography.bodyMedium)
        }
    }
    Spacer(Modifier.height(8.dp))
    Text("What are you good at? (optional, up to three)", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    loaded.survey.strengths.forEach { choice ->
        Row(Modifier.fillMaxWidth().clickable { toggle(strengths, choice.code) }, verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = strengths.contains(choice.code), onCheckedChange = { toggle(strengths, choice.code) })
            Text(choice.label, style = MaterialTheme.typography.bodyMedium)
        }
    }
    Spacer(Modifier.height(8.dp))
    Text("Which branch or degree did you study?", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(4.dp))
    // The catalogue's own branch list, then "Not listed" — a chip row keeps it one tap per choice.
    androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        loaded.survey.branches.forEach { value ->
            val text = if (value == "NOT_LISTED") "Not listed" else value
            if (branch == value) Button(onClick = {}, shape = RoundedCornerShape(10.dp)) { Text(text) }
            else OutlinedButton(onClick = { branch = value }) { Text(text) }
        }
    }
    error?.let { Spacer(Modifier.height(6.dp)); Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    Spacer(Modifier.height(10.dp))
    Button(
        onClick = {
            when {
                interests.isEmpty() -> error = "Choose at least one kind of work."
                branch.isBlank() -> error = "Choose your branch or degree, or “Not listed”."
                else -> scope.launch {
                    runCatching { Api.submitCareerDiscovery(context, interests.toList(), strengths.toList(), branch, origin) }
                        .onSuccess { discovery = Load.Ready(it); error = null }
                        .onFailure { error = (it as? Api.ApiException)?.detail ?: "Your answers could not be saved. Try again." }
                }
            }
        },
        shape = RoundedCornerShape(10.dp),
    ) { Text("Show suggestions") }

    loaded.result?.let { result ->
        Spacer(Modifier.height(14.dp))
        Text("Roles to consider", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Hint(if (result.usedShownSkills) "From your answers and the skills you have shown." else "From your answers only — your learning history was not used.")
        if (result.suggestions.isEmpty()) {
            Spacer(Modifier.height(6.dp))
            Hint("No roles are available to suggest yet. Search by job title instead.")
        }
        result.suggestions.forEach { suggestion ->
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(suggestion.role.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    suggestion.reasons.forEach { reason -> Hint("• " + reasonText(reason, loaded.survey)) }
                }
                ReleaseChip(suggestion.role.releaseLabel)
                TextButton(onClick = { onChoose(suggestion.role) }) { Text("Choose") }
            }
        }
        if (result.fewerThanMinimum && result.suggestions.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Hint(if (result.suggestions.size == 1) "Only one role is available to suggest right now." else "Only ${result.suggestions.size} roles are available to suggest right now.")
        }
    }
}

private fun reasonText(reason: DiscoveryReasonDto, survey: DiscoverySurveyDto): String {
    fun label(list: List<SurveyChoiceDto>) = list.firstOrNull { it.code == reason.detail }?.label?.lowercase() ?: ""
    return when (reason.code) {
        "INTEREST_MATCH" -> "Matches your interest: ${label(survey.interests)}"
        "STRENGTH_MATCH" -> "Uses a strength you named: ${label(survey.strengths)}"
        "BRANCH_MATCH" -> "Named for your branch (${reason.detail ?: ""})"
        "SHOWN_SKILLS" -> "Builds on skills you have already shown"
        "OPEN_TO_YOUR_BRANCH" -> "Open to your branch (${reason.detail ?: ""})"
        else -> "Open to every branch"
    }
}

@Composable
private fun TargetGapCard(target: CareerTargetDto) {
    Spacer(Modifier.height(12.dp))
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            Text(target.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Hint(target.family)
            val gap = target.gap
            Spacer(Modifier.height(10.dp))
            if (gap == null) {
                Text("NA", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Hint("Nothing has been measured against this target yet.")
            } else {
                // Deliberately not called readiness. Readiness is an advisory band with no number
                // (ADR-020); this is a count of met requirements, with its own denominator.
                Text("${gap.requirementsMet} of ${gap.requirementsTotal} requirements met", style = MaterialTheme.typography.titleSmall)
                if (gap.requirementsUnknown > 0) Hint("${gap.requirementsUnknown} not measured yet")
                Spacer(Modifier.height(10.dp))
                gap.items.take(5).forEach { item ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(item.topicTitle ?: "Topic", style = MaterialTheme.typography.bodyMedium)
                            Hint(prettify(item.requirementLevel))
                        }
                        StatusChip(prettify(item.status), when (item.status) {
                            "MET" -> ChipKind.Positive
                            "UNKNOWN" -> ChipKind.Waiting
                            else -> ChipKind.Muted
                        })
                    }
                }
            }
        }
    }
}

@Composable
private fun GoalsCard(data: LearnerGoalsDto, onEnd: (LearnerGoalDto, String) -> Unit) {
    Spacer(Modifier.height(12.dp))
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            Text("Your goals", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            data.goals.forEach { goal ->
                Spacer(Modifier.height(10.dp))
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(goal.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Hint((goalTypeLabel[goal.goalType] ?: prettify(goal.goalType)) + (goal.role?.family?.let { " · $it" } ?: ""))
                    }
                    if (goal.priority == "PRIMARY") StatusChip("Main goal", ChipKind.Accent)
                    goal.role?.let { ReleaseChip(it.releaseLabel) }
                    if (goal.catalogueGoal != null) StatusChip("Not yet verified", ChipKind.Muted)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (goal.goalType != "ROLE" && goal.goalType != "DISCOVERY") {
                        TextButton(onClick = { onEnd(goal, "ACHIEVED") }) { Text("Mark achieved") }
                    }
                    TextButton(onClick = { onEnd(goal, "WITHDRAWN") }) { Text("Remove") }
                }
            }
        }
    }
}

@Composable
private fun AddGoalCard(
    catalogueOpen: Boolean,
    onRole: (GoalRoleOptionDto) -> Unit,
    onTopic: (GoalTopicOptionDto) -> Unit,
    onCatalogue: (GoalCatalogueOptionDto) -> Unit,
) {
    Spacer(Modifier.height(12.dp))
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            Text("Add a goal", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Hint("Add topics you want to learn" + (if (catalogueOpen) ", exams or company preparation" else "") +
                ", or another role to keep in view. Work on a topic counts toward every role that needs it.")
            Spacer(Modifier.height(10.dp))
            GoalSearch(rolesOnly = false, catalogueOpen = catalogueOpen, onRole = onRole, onTopic = onTopic, onCatalogue = onCatalogue)
        }
    }
}

@Composable
private fun SharedSkillsCard(data: LearnerGoalsDto) {
    Spacer(Modifier.height(12.dp))
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            Text("Skills across your goals", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Hint("Each skill is listed once, however many goals need it.")
            if (data.skills.skills.isEmpty()) {
                Spacer(Modifier.height(8.dp))
                Hint("NA — none of your goals lists skills yet. Exam and company goals get skills when their tracks are published.")
            }
            data.skills.skills.forEach { skill ->
                Spacer(Modifier.height(10.dp))
                Text(skill.topicTitle ?: "Topic", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Hint(if (skill.goals.size == 1) "Needed by one of your goals" else "Needed by ${skill.goals.size} of your goals")
                skill.goals.forEach { link ->
                    val owner = data.goals.firstOrNull { it.id == link.goalId }?.title
                    val status = link.status?.let { skillStatusLabel[it] ?: prettify(it) } ?: "Your topic goal"
                    Spacer(Modifier.height(4.dp))
                    StatusChip((owner?.let { "$it: " } ?: "") + status, when (link.status) {
                        "MET" -> ChipKind.Positive
                        "PARTIAL", "MISSING" -> ChipKind.Waiting
                        else -> ChipKind.Muted
                    })
                }
            }
        }
    }
}
