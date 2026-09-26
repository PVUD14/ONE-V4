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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.WorkOutline
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
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

/**
 * The student's side of hiring, beyond a list of jobs.
 *
 * Two things here are not cosmetic. Applying now asks whether the institution may see
 * the application, because that is a distinct revocable consent (ADR-019) and the
 * previous one-tap apply answered it for the student. And eligibility distinguishes
 * "not eligible" from "we cannot tell yet" — the engine fails closed on facts nobody has
 * recorded, and showing that as a rejection would be a lie the student can act on.
 */

// ---------------------------------------------------------------------------
// Opportunity detail
// ---------------------------------------------------------------------------

@Composable
internal fun OpportunityDetailPage(
    opportunityId: String,
    onClose: () -> Unit,
    onApplied: () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var detail by remember { mutableStateOf<OpportunityDetailDto?>(null) }
    var failed by remember { mutableStateOf(false) }
    var shareWithInstitution by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(opportunityId) {
        runCatching { Api.opportunityDetail(context, opportunityId) }
            .onSuccess { detail = it }
            .onFailure { failed = true }
    }

    OverlayScaffold(title = "Opportunity", onClose = onClose) {
        val record = detail
        when {
            failed -> EmptyState(
                Icons.Filled.WorkOutline, Tone.Violet, "We could not load this role",
                "Check your connection and open it again.",
            )
            record == null -> LoadingSpinner()
            else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
                item {
                    Spacer(Modifier.height(12.dp))
                    PilotCard {
                        Column(Modifier.padding(16.dp)) {
                            Text(record.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                            Text(record.employerName, style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.height(8.dp))
                            Text(
                                listOfNotNull(prettify(record.employmentType), prettify(record.workMode), record.locationCity)
                                    .joinToString("  ·  "),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            record.applicationDeadline?.let {
                                Spacer(Modifier.height(6.dp))
                                Text("Apply by ${formatWhen(it)}", style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.primary)
                            }
                            record.compensationSummary?.takeIf { it.isNotBlank() }?.let {
                                Spacer(Modifier.height(6.dp))
                                Text(it, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }

                record.eligibility?.let { eligibility ->
                    item {
                        Spacer(Modifier.height(12.dp))
                        EligibilityCard(eligibility)
                    }
                }

                // EMP-04: the company behind the job, as its verified profile describes it.
                // Nothing is guessed: a company without a description says so.
                item {
                    Spacer(Modifier.height(12.dp))
                    SectionCard("About ${record.company?.displayName ?: record.employerName}", companySummary(record.company, record.employerName))
                }

                record.summary?.takeIf { it.isNotBlank() }?.let { summary ->
                    item { Spacer(Modifier.height(12.dp)); SectionCard("About this role", summary) }
                }
                record.responsibilities?.takeIf { it.isNotBlank() }?.let { text ->
                    item { Spacer(Modifier.height(12.dp)); SectionCard("What you would do", text) }
                }
                if (record.skills.isNotEmpty()) {
                    item {
                        Spacer(Modifier.height(12.dp))
                        SectionCard("Skills asked for", record.skills.joinToString("  ·  ") { skill ->
                            skill.name + if (skill.level == "PREFERRED") " (preferred)" else ""
                        })
                    }
                }
                item {
                    Spacer(Modifier.height(12.dp))
                    SectionCard("Selection process", if (record.selectionStages.isEmpty()) "The employer has not listed its selection stages."
                        else record.selectionStages.sortedBy { it.order }.mapIndexed { index, stage ->
                            "${index + 1}. ${stage.label}" + (stage.detail?.takeIf { it.isNotBlank() }?.let { " — $it" } ?: "")
                        }.joinToString("\n"))
                }

                item {
                    Spacer(Modifier.height(12.dp))
                    notice?.let {
                        Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                            Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onPrimaryContainer)
                        }
                        Spacer(Modifier.height(12.dp))
                    }
                    if (record.alreadyApplied) {
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                StatusChip("Applied", ChipKind.Positive)
                                Spacer(Modifier.height(8.dp))
                                Text("You have already applied. Track its progress under My applications.",
                                    style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    } else {
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Text("Before you apply", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                                Spacer(Modifier.height(8.dp))
                                Text(
                                    "Applying shares your profile with this employer so they can consider you.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Spacer(Modifier.height(10.dp))
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Checkbox(checked = shareWithInstitution, onCheckedChange = { shareWithInstitution = it })
                                    Column(Modifier.weight(1f)) {
                                        Text("Also let my institution see this application",
                                            style = MaterialTheme.typography.bodyMedium)
                                        // Said plainly, because it is a separate permission and the
                                        // student can take it back later.
                                        Text("Optional. You can withdraw this at any time, and your college never sees the pay.",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                                Spacer(Modifier.height(12.dp))
                                Button(
                                    onClick = {
                                        busy = true
                                        notice = null
                                        scope.launch {
                                            runCatching { Api.applyToOpportunity(context, opportunityId, shareWithInstitution) }
                                                .onSuccess { onApplied(); onClose() }
                                                .onFailure {
                                                    // EMP-06: name the rule, and refresh the verdict so it is on screen.
                                                    val code = (it as? Api.ApiException)?.code
                                                    notice = when (code) {
                                                        "ELIGIBILITY_NOT_MET" -> "You do not meet a rule this employer requires. It is marked under Eligibility above."
                                                        "ELIGIBILITY_UNKNOWN" -> "ONE cannot confirm a rule this employer requires, because that information is not on your record yet."
                                                        else -> (it as? Api.ApiException)?.detail ?: "Could not apply just now. Try again."
                                                    }
                                                    if (code?.startsWith("ELIGIBILITY_") == true) {
                                                        runCatching { Api.opportunityDetail(context, opportunityId) }.onSuccess { refreshed -> detail = refreshed }
                                                    }
                                                }
                                            busy = false
                                        }
                                    },
                                    enabled = !busy,
                                    shape = RoundedCornerShape(10.dp),
                                    modifier = Modifier.fillMaxWidth(),
                                ) { Text(if (busy) "Applying…" else "Apply") }
                            }
                        }
                    }
                    Spacer(Modifier.height(24.dp))
                }
            }
        }
    }
}

@Composable
private fun EligibilityCard(eligibility: EligibilityDto) {
    // EMP-06: rule by rule. "Cannot be confirmed" gets its own treatment on purpose: the engine
    // fails closed on a fact nobody has recorded, and presenting that as "not eligible" tells a
    // student they failed when the truth is that the information is missing.
    val (chipText, kind) = when {
        eligibility.rules.isEmpty() -> "No eligibility rules" to ChipKind.Positive
        eligibility.eligible -> "You meet every rule" to ChipKind.Positive
        eligibility.blockingFailures.isNotEmpty() -> "You do not meet a rule" to ChipKind.Muted
        else -> "We cannot tell yet" to ChipKind.Waiting
    }
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            Text("Eligibility", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            StatusChip(chipText, kind)
            if (eligibility.rules.isEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text("The employer has set no eligibility rules for this role.", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            eligibility.rules.forEach { rule ->
                Spacer(Modifier.height(10.dp))
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(describeEligibilityRule(rule), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    val (label, chip) = when (rule.outcome) {
                        "MET" -> "You meet this" to ChipKind.Positive
                        "NOT_MET" -> (if (rule.isBlocking) "You don't meet this" else "Preferred") to ChipKind.Muted
                        "NOT_EVALUATED" -> "Employer decides" to ChipKind.Waiting
                        else -> "Not confirmed" to ChipKind.Waiting
                    }
                    StatusChip(label, chip)
                }
                val notes = listOfNotNull(
                    rule.yourValue?.let { value -> "Your record: $value" + (rule.basis?.let { " (${basisLabel(it)})" } ?: "") },
                    if (rule.outcome == "UNKNOWN") unknownReasonText(rule.unknownReason) else null,
                    if (rule.outcome == "NOT_EVALUATED") "The employer will consider this with you; it does not stop you applying." else null,
                    if (rule.basis == "SELF_REPORTED") "The employer sees that this rests on your own declaration." else null,
                )
                notes.forEach {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

/** The same wording as the web app for a rule (apps/web/src/hiringEligibility.ts). */
internal fun describeEligibilityRule(rule: EligibilityRuleOutcomeDto): String =
    describeEligibilityRule(rule.ruleType, rule.comparator, rule.valueNumeric, rule.valueText, rule.displayValue)

internal fun describeEligibilityRule(ruleType: String, comparator: String, valueNumeric: Double?, valueText: String?, displayValue: String?): String {
    val number = valueNumeric?.let { if (it % 1.0 == 0.0) it.toLong().toString() else it.toString() }
    val value = displayValue ?: number ?: valueText ?: ""
    val not = comparator == "NOT_IN"
    return when (ruleType) {
        "MIN_CGPA" -> "Minimum CGPA $value (10-point scale)"
        "MAX_BACKLOGS" -> if (valueNumeric == 0.0) "No active backlogs" else "At most $value active backlog" + if (valueNumeric == 1.0) "" else "s"
        "GRADUATION_YEAR" -> when (comparator) {
            "GTE" -> "Graduating in $value or later"
            "LTE" -> "Graduated in $value or earlier"
            else -> (if (not) "Not graduating in " else "Graduating in ") + value
        }
        "DEPARTMENT" -> (if (not) "Department not: " else "Department: ") + value
        "PROGRAM" -> (if (not) "Programme not: " else "Programme: ") + value
        "INSTITUTION" -> (if (not) "College not: " else "College: ") + value
        "WORK_AUTHORIZATION" -> "Work authorisation: $value"
        else -> value
    }
}

internal fun basisLabel(basis: String): String = when (basis) {
    "VERIFIED" -> "verified by the college"
    "INSTITUTION_RECORD" -> "from the college record"
    "SELF_REPORTED" -> "self-reported"
    else -> prettify(basis)
}

private fun unknownReasonText(reason: String?): String = when (reason) {
    "SCALE_NOT_COMPARABLE" -> "Your results are letter grades or pass/fail, which cannot be compared with this rule."
    "NOT_RECORDED_BY_ONE" -> "ONE does not record this; the employer will check it with you."
    else -> "This is not on your record yet. Add your results under More › Academic record, or ask your college."
}

/** The company block of a job, as plain lines: registered name and facts, description, links. */
internal fun companySummary(company: OpportunityCompanyDto?, employerName: String): String {
    val facts = listOfNotNull(
        "Registered as $employerName",
        company?.industry?.let { companyIndustryLabel(it) },
        company?.companySizeBand?.let { "$it employees" },
        listOfNotNull(company?.city, company?.stateOrProvince, company?.countryCode).joinToString(", ").takeIf { it.isNotBlank() },
    ).joinToString("  ·  ")
    val links = listOfNotNull(company?.websiteUrl?.let { "Website: $it" }, company?.careersPageUrl?.let { "Careers: $it" })
    return listOfNotNull(
        facts,
        company?.about?.takeIf { it.isNotBlank() } ?: "The company has not added a description yet.",
        links.joinToString("\n").takeIf { it.isNotBlank() },
    ).joinToString("\n\n")
}

@Composable
private fun SectionCard(title: String, body: String) {
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            Text(body, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

// ---------------------------------------------------------------------------
// Interviews (EMP-08)
// ---------------------------------------------------------------------------

private val interviewModeLabels = mapOf("VIDEO" to "Video", "PHONE" to "Phone", "ONSITE" to "On site")

/**
 * One of the student's interviews, as the web shows it under Applications: when, how, where or the
 * joining link and what to prepare while it is ahead; past and cancelled ones without the link.
 */
@Composable
internal fun StudentInterviewCard(item: StudentInterviewDto) {
    val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(item.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(
                        listOf(item.employerName, item.stageLabel ?: "Round ${item.roundNumber}", interviewModeLabels[item.mode] ?: prettify(item.mode))
                            .joinToString("  ·  "),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                StatusChip(prettify(item.state), when {
                    item.upcoming -> ChipKind.Accent
                    item.state == "COMPLETED" -> ChipKind.Positive
                    else -> ChipKind.Muted
                })
            }
            Spacer(Modifier.height(6.dp))
            Text(
                item.scheduledStart?.let { start -> formatWhen(start) + (item.scheduledEnd?.let { " to ${formatWhen(it)}" } ?: "") } ?: "Time to be confirmed",
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary,
            )
            item.locationDetail?.let {
                Spacer(Modifier.height(6.dp))
                Text((if (item.mode == "ONSITE") "Where: " else "Arrangements: ") + it, style = MaterialTheme.typography.bodySmall)
            }
            item.joiningLink?.let { link ->
                Spacer(Modifier.height(4.dp))
                TextButton(onClick = { runCatching { uriHandler.openUri(link) } }) { Text("Open joining link") }
            }
            if (item.upcoming) {
                Spacer(Modifier.height(6.dp))
                Text("What to prepare", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                Text(item.preparationNote ?: "NA — the employer has not added anything to prepare.", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

@Composable
internal fun OffersPage(onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var offers by remember { mutableStateOf<List<OfferDto>?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var notice by remember { mutableStateOf<String?>(null) }
    var confirming by remember { mutableStateOf<Pair<OfferDto, Boolean>?>(null) }

    LaunchedEffect(reload) { offers = runCatching { Api.listOffers(context) }.getOrNull() ?: emptyList() }

    OverlayScaffold(title = "Offers", onClose = onClose) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            notice?.let {
                Spacer(Modifier.height(10.dp))
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                    Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
            when {
                offers == null -> LoadingSpinner()
                offers!!.isEmpty() -> EmptyState(
                    Icons.Filled.WorkOutline, Tone.Green, "No offers yet",
                    "When an employer makes you an offer it appears here, with the date you need to respond by.",
                )
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(offers!!, key = { it.id }) { offer ->
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Row(verticalAlignment = Alignment.Top) {
                                    Column(Modifier.weight(1f)) {
                                        Text(offer.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                        Text(offer.employerName, style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    StatusChip(prettify(offer.state), when (offer.state) {
                                        "ACCEPTED" -> ChipKind.Positive
                                        "DECLINED", "WITHDRAWN", "EXPIRED" -> ChipKind.Muted
                                        else -> ChipKind.Waiting
                                    })
                                }
                                (offer.respondBy ?: offer.offerExpiresAt)?.let {
                                    Spacer(Modifier.height(6.dp))
                                    Text("Respond by ${formatWhen(it)}", style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.primary)
                                }
                                if (offer.state == "EXTENDED") {
                                    Spacer(Modifier.height(12.dp))
                                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                        Button(onClick = { confirming = offer to true }, shape = RoundedCornerShape(10.dp)) {
                                            Text("Accept")
                                        }
                                        OutlinedButton(onClick = { confirming = offer to false }, shape = RoundedCornerShape(10.dp)) {
                                            Text("Decline")
                                        }
                                    }
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }

    // Accepting or declining an offer is the least reversible thing a student can do in
    // this app, so it does not happen on a single tap.
    confirming?.let { (offer, accept) ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text(if (accept) "Accept this offer?" else "Decline this offer?") },
            text = {
                Text(
                    if (accept) {
                        "You are accepting ${offer.title} at ${offer.employerName}. Your institution will see that you accepted, but never the pay."
                    } else {
                        "You are declining ${offer.title} at ${offer.employerName}. This cannot be undone from the app."
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val target = offer
                    confirming = null
                    scope.launch {
                        runCatching { Api.respondToOffer(context, target.id, accept) }
                            .onSuccess {
                                notice = if (accept) "Offer accepted." else "Offer declined."
                                reload += 1
                            }
                            .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not record your response." }
                    }
                }) { Text(if (accept) "Accept" else "Decline") }
            },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text("Cancel") } },
        )
    }
}

// ---------------------------------------------------------------------------
// Saved opportunities
// ---------------------------------------------------------------------------

@Composable
internal fun SavedOpportunitiesPage(onClose: () -> Unit, onOpen: (String) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var saved by remember { mutableStateOf<List<SavedOpportunityDto>?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) { saved = runCatching { Api.listSavedOpportunities(context) }.getOrNull() ?: emptyList() }

    OverlayScaffold(title = "Saved", onClose = onClose) {
        when {
            saved == null -> LoadingSpinner()
            saved!!.isEmpty() -> EmptyState(
                Icons.Filled.BookmarkBorder, Tone.Accent, "Nothing saved yet",
                "Save a role from its page and it waits here until you are ready to apply.",
            )
            else -> LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
                items(saved!!, key = { it.id }) { entry ->
                    Spacer(Modifier.height(12.dp))
                    PilotCard {
                        Row(Modifier.fillMaxWidth().clickable { onOpen(entry.opportunityId) }.padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(entry.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                Text(entry.employerName, style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            TextButton(onClick = {
                                scope.launch {
                                    runCatching { Api.unsaveOpportunity(context, entry.id) }
                                    reload += 1
                                }
                            }) { Text("Remove") }
                        }
                    }
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Applications made elsewhere
// ---------------------------------------------------------------------------

@Composable
internal fun ExternalApplicationsPage(onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var entries by remember { mutableStateOf<List<ExternalApplicationDto>?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var adding by remember { mutableStateOf(false) }
    var company by remember { mutableStateOf("") }
    var role by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(reload) { entries = runCatching { Api.listExternalApplications(context) }.getOrNull() ?: emptyList() }

    OverlayScaffold(
        title = "Applied elsewhere",
        onClose = onClose,
        actions = { TextButton(onClick = { adding = !adding }) { Text(if (adding) "Cancel" else "Add") } },
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            notice?.let {
                Spacer(Modifier.height(10.dp))
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                    Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
            if (adding) {
                Spacer(Modifier.height(12.dp))
                PilotCard {
                    Column(Modifier.padding(16.dp)) {
                        OutlinedTextField(company, { company = it }, label = { Text("Company") },
                            singleLine = true, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(role, { role = it }, label = { Text("Role") },
                            singleLine = true, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(url, { url = it }, label = { Text("Link (optional)") },
                            singleLine = true, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(12.dp))
                        Button(
                            onClick = {
                                scope.launch {
                                    runCatching { Api.createExternalApplication(context, company.trim(), role.trim(), url.trim()) }
                                        .onSuccess {
                                            company = ""; role = ""; url = ""; adding = false; reload += 1
                                        }
                                        .onFailure { notice = (it as? Api.ApiException)?.detail ?: "Could not save that." }
                                }
                            },
                            enabled = company.isNotBlank() && role.isNotBlank(),
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Save") }
                    }
                }
            }
            when {
                entries == null -> LoadingSpinner()
                entries!!.isEmpty() && !adding -> EmptyState(
                    Icons.Filled.OpenInNew, Tone.Violet, "Track applications you made elsewhere",
                    "Add a job you applied for on another site and your whole search stays in one place.",
                )
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(entries!!, key = { it.id }) { entry ->
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Row(verticalAlignment = Alignment.Top) {
                                    Column(Modifier.weight(1f)) {
                                        Text(entry.roleTitle, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                        Text(entry.companyName, style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    StatusChip(prettify(entry.stage), ChipKind.Accent)
                                }
                                Spacer(Modifier.height(10.dp))
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Checkbox(
                                        checked = entry.institutionVisible,
                                        onCheckedChange = { visible ->
                                            scope.launch {
                                                runCatching { Api.setExternalApplicationVisibility(context, entry.id, visible) }
                                                reload += 1
                                            }
                                        },
                                    )
                                    Text("Let my institution see this", Modifier.weight(1f),
                                        style = MaterialTheme.typography.bodySmall)
                                    TextButton(onClick = {
                                        scope.launch {
                                            runCatching { Api.deleteExternalApplication(context, entry.id) }
                                            reload += 1
                                        }
                                    }) { Text("Remove") }
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

/** The three hiring sub-pages reachable from the Jobs tab. */
internal enum class JobsOverlay { Offers, Saved, External }

@Composable
internal fun JobsQuickLink(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(10.dp),
        modifier = modifier.clickable { onClick() },
    ) {
        Text(
            label,
            Modifier.padding(vertical = 10.dp, horizontal = 8.dp).fillMaxWidth(),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

/**
 * What an employer chose to say to a candidate they rejected, and what to do about it.
 *
 * Reached only from an application the employer actually released feedback on. A reason
 * with no mapped topic shows the reason alone -- nothing here invents a next step, and
 * nothing here shows a readiness band.
 */
@Composable
internal fun FeedbackPage(feedback: ApplicationFeedbackDto, onClose: () -> Unit) {
    OverlayScaffold(title = "Why this didn't go further", onClose = onClose) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(10.dp))
            PilotCard {
                Column(Modifier.padding(16.dp)) {
                    Text(feedback.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(
                        feedback.employerName + (feedback.releasedAt?.let { " · shared ${formatWhen(it)}" } ?: ""),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            LazyColumn(Modifier.fillMaxSize()) {
                items(feedback.reasons, key = { it.code }) { reason ->
                    Spacer(Modifier.height(12.dp))
                    PilotCard {
                        Column(Modifier.padding(16.dp)) {
                            Text(reason.studentLabel, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            if (reason.topics.isNotEmpty()) {
                                Spacer(Modifier.height(8.dp))
                                Text(
                                    "Worth working on: " + reason.topics.joinToString(", ") { it.name },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
                feedback.note?.takeIf { it.isNotBlank() }?.let { note ->
                    item {
                        Spacer(Modifier.height(12.dp))
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                Text("From the employer", style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Spacer(Modifier.height(6.dp))
                                Text(note, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
                item {
                    Spacer(Modifier.height(12.dp))
                    Text(
                        "Only you can see this. It is not shown to your institution or to other employers, and it does not affect your readiness.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(24.dp))
                }
            }
        }
    }
}
