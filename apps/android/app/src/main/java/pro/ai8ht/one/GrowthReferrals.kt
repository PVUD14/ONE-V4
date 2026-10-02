package pro.ai8ht.one

// "Your employer referral links" on the phone (GROWTH-05; design §7.2, §10 of
// growth-employer-pipeline-table-design.md). A growth person on the employer partnerships team
// shares a link with a company through the Android share sheet; the link is the public "Request
// employer access" page with a random code and carries nothing about the person. The list keeps a
// saved copy, so a link can be shared with no signal (sharing is local). Creating and revoking a
// link need a signal and say so: the server generates the code, so a queued creation would only
// hand the person a link that does not exist yet. Counts are of requests by state, never companies.

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Link
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import pro.ai8ht.one.ui.Tone
import java.io.IOException
import java.util.UUID

private fun referralError(error: Throwable): String = when ((error as? Api.ApiException)?.code) {
    "GROWTH_REFERRAL_CODE_LIMIT" -> "You already have the most live links allowed. Revoke one you no longer share first."
    "GROWTH_REFERRAL_CODE_DAILY_LIMIT" -> "You have created the most links allowed today. Try again tomorrow."
    "GROWTH_TEAM_MISMATCH" -> "Referral links are for the employer partnerships team."
    else -> if (error is IOException) "No signal. Creating or revoking a link needs a connection; sharing an existing link does not."
    else "That change could not be saved."
}

@Composable
internal fun GrowthReferralLinksCard() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<GrowthReferralCodesDto?>(null) }
    var stale by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var reload by remember { mutableStateOf(0) }
    var createKey by remember { mutableStateOf(UUID.randomUUID().toString()) }

    LaunchedEffect(reload) {
        val result = runCatching { growthCachedRead(context, "growth:referral-codes") { Api.growthReferralCodesRaw(context) } }.getOrNull()
        data = result?.first?.let { runCatching { Api.json.decodeFromString<GrowthReferralCodesDto>(it) }.getOrNull() }
        stale = result?.second == true
        failed = data == null
    }

    fun change(action: suspend () -> Unit, done: String) {
        busy = true
        scope.launch {
            message = runCatching { action() }.fold({ createKey = UUID.randomUUID().toString(); done }, ::referralError)
            busy = false
            reload++
        }
    }

    fun share(code: GrowthReferralCodeDto) {
        val link = Api.baseUrl(context) + code.linkPath
        val send = Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, "Hire on ONE by AI8HT")
            .putExtra(Intent.EXTRA_TEXT, "Request employer access to ONE by AI8HT: $link")
        context.startActivity(Intent.createChooser(send, "Share your referral link"))
    }

    SectionTitle("Your employer referral links", trailing = if (stale) "Saved copy" else null)
    val loaded = data
    PilotCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text("Share a link with a company you are working. It opens the public request form; operations see that the request came through your link. It carries a random code and nothing about you.",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 6.dp)) }
            when {
                loaded == null && failed -> Text("NA — your links could not be loaded. They appear once you have opened this with a signal.",
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
                loaded == null -> Text("Loading…", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
                !loaded.eligible && loaded.codes.isEmpty() -> Text("Referral links are for the employer partnerships team.",
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
                else -> {
                    val live = loaded.codes.filter { it.revokedAt == null }
                    if (live.isEmpty()) Text("No live link yet.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
                    live.forEach { code ->
                        Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            IconBubble(Icons.Filled.Link, Tone.Accent, size = 30.dp)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(code.code, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                Text("${code.referrals.pending} waiting · ${code.referrals.onboarded} onboarded · ${code.referrals.closed} closed",
                                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                            Button(onClick = { share(code) }) { Text("Share") }
                            OutlinedButton(enabled = !busy, onClick = {
                                change({ Api.revokeGrowthReferralCode(context, code.id) }, "Link ${code.code} revoked. A company that opens it can still send a request; it will not be marked as yours.")
                            }) { Text("Revoke") }
                        }
                    }
                    if (loaded.eligible) {
                        Spacer(Modifier.height(10.dp))
                        Button(enabled = !busy && live.size < loaded.limits.liveCodesPerPerson, onClick = {
                            val key = createKey
                            change({ Api.createGrowthReferralCode(context, key) }, "New referral link created.")
                        }) { Text("New referral link") }
                    }
                    Text("Up to ${loaded.limits.liveCodesPerPerson} live links and ${loaded.limits.createdPerDay} new links a day. Links stop working if you leave the employer team. Creating or revoking needs a signal; sharing does not.",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                }
            }
        }
    }
}
