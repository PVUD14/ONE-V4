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

                record.summary?.takeIf { it.isNotBlank() }?.let { summary ->
                    item { Spacer(Modifier.height(12.dp)); SectionCard("About this role", summary) }
                }
                record.responsibilities?.takeIf { it.isNotBlank() }?.let { text ->
                    item { Spacer(Modifier.height(12.dp)); SectionCard("What you would do", text) }
                }
                if (record.skills.isNotEmpty()) {
                    item { Spacer(Modifier.height(12.dp)); SectionCard("Skills asked for", record.skills.joinToString("  ·  ")) }
                }
                if (record.selectionStages.isNotEmpty()) {
                    item {
                        Spacer(Modifier.height(12.dp))
                        SectionCard("Selection process", record.selectionStages.mapIndexed { index, stage ->
                            "${index + 1}. ${prettify(stage)}"
                        }.joinToString("\n"))
                    }
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
                                                    notice = (it as? Api.ApiException)?.detail
                                                        ?: "Could not apply just now. Try again."
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
    // UNKNOWN gets its own treatment on purpose. The eligibility engine fails closed on
    // a fact nobody has recorded -- usually a CGPA with no verified term behind it -- and
    // presenting that as "not eligible" tells a student they failed when the truth is
    // that their college has not verified their marks yet.
    val (chipText, kind) = when (eligibility.outcome) {
        "ELIGIBLE" -> "You meet the criteria" to ChipKind.Positive
        "NOT_ELIGIBLE" -> "You do not meet the criteria" to ChipKind.Muted
        else -> "We cannot tell yet" to ChipKind.Waiting
    }
    PilotCard {
        Column(Modifier.padding(16.dp)) {
            StatusChip(chipText, kind)
            if (eligibility.outcome == "UNKNOWN") {
                Spacer(Modifier.height(8.dp))
                Text(
                    "Some of what this employer asks for has not been verified on your record yet. " +
                        "Add your academic results under Profile and ask your institution to verify them.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            eligibility.reasons.takeIf { it.isNotEmpty() }?.let { reasons ->
                Spacer(Modifier.height(10.dp))
                reasons.forEach { reason ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                        Text(prettify(reason.rule), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        Text(prettify(reason.outcome), style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    reason.detail?.takeIf { it.isNotBlank() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
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
                                offer.respondBy?.let {
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
