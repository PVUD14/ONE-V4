package pro.ai8ht.one

// "Credited to you" on the phone (GROWTH-07; design §18: Android read-only). The colleges and
// employers credited to the growth person, and the disputes they are party to, with a saved copy for
// offline. No amount appears: commission amounts are not built and no rate has been set, so the card
// says NA; employers say "Employer commission on hold — not decided" (D11). Opening a dispute is a
// desk task on the web, and the card says so. A respondent is told a dispute exists, never what it says.

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.School
import androidx.compose.material.icons.filled.WorkOutline
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import pro.ai8ht.one.ui.Tone

private fun creditBasisLabel(basis: String): String = when (basis) {
    "LEAD_OWNER_AT_HANDOFF" -> "You owned the lead at handoff"
    "REFERRAL_LINK" -> "Your referral link"
    "DISPUTE_DECISION" -> "Decided on a dispute"
    "MANUAL_CORRECTION" -> "Reassigned by operations"
    else -> basis
}

private fun disputeStateLabel(state: String): String = when (state) {
    "OPEN" -> "Open"
    "UPHELD" -> "Upheld"
    "REJECTED" -> "Rejected"
    else -> state
}

private const val CREDIT_NA = "NA"

private fun shortDate(value: String?): String = value?.take(10) ?: CREDIT_NA

@Composable
internal fun GrowthCreditCard() {
    val context = LocalContext.current
    var data by remember { mutableStateOf<GrowthAttributionsDto?>(null) }
    var stale by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        val result = runCatching { growthCachedRead(context, "growth:attributions") { Api.growthAttributionsRaw(context) } }.getOrNull()
        data = result?.first?.let { runCatching { Api.json.decodeFromString<GrowthAttributionsDto>(it) }.getOrNull() }
        stale = result?.second == true
        failed = data == null
    }

    SectionTitle("Credited to you", trailing = if (stale) "Saved copy" else null)
    val loaded = data
    PilotCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            when {
                loaded == null && failed -> Text("NA — your credit could not be loaded. It appears once you have opened this with a signal.",
                    style = MaterialTheme.typography.bodySmall)
                loaded == null -> Text("Loading…", style = MaterialTheme.typography.bodySmall)
                else -> {
                    val live = loaded.credited.filter { it.endedAt == null }
                    if (live.isEmpty()) {
                        Text("Nothing is credited to you yet. A college is credited to its lead's owner when operations link its handoff; an employer to the referral link, else the lead owner.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    live.forEach { credit ->
                        Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            IconBubble(
                                if (credit.organizationKind == "INSTITUTION") Icons.Filled.School else Icons.Filled.WorkOutline,
                                if (credit.organizationKind == "INSTITUTION") Tone.Green else Tone.Violet, size = 30.dp,
                            )
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(credit.organizationName, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                Text("${creditBasisLabel(credit.basis)} · since ${shortDate(credit.since)}",
                                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(if (credit.commission == "EMPLOYER_ON_HOLD") "Employer commission on hold — not decided" else "Commission: $CREDIT_NA — not built yet; no rate has been set",
                                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (credit.disputeOpen) StatusChip("Dispute open", ChipKind.Waiting)
                        }
                    }
                    if (loaded.disputes.isNotEmpty()) {
                        Text("Your disputes", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 12.dp))
                        loaded.disputes.forEach { dispute ->
                            Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(dispute.organizationName, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                    Text(if (dispute.role == "CLAIMANT") "You claimed this credit · opened ${shortDate(dispute.openedAt)}"
                                        else "Someone disputes credit for this organisation · opened ${shortDate(dispute.openedAt)}",
                                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                StatusChip(disputeStateLabel(dispute.state), if (dispute.state == "OPEN") ChipKind.Waiting else if (dispute.state == "UPHELD") ChipKind.Positive else ChipKind.Muted)
                            }
                        }
                    }
                    Text("Read-only here. To dispute a credit (within ${loaded.windowDays} days of a handoff), use Commission in the Growth workspace on the web.",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp))
                }
            }
        }
    }
}
