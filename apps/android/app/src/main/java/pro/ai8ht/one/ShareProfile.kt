package pro.ai8ht.one

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import pro.ai8ht.one.ui.Tone

/**
 * The student's control over their public profile, on the phone.
 *
 * Decision in docs/architecture/ADR-031-public-profile-share-links.md.
 *
 * Mirrors the web screen deliberately, including the two things it says rather than merely
 * does: readiness and applications appear as **locked**, not as switches that happen to be
 * off, because they are not choices; and the raw link is shown once, because only its
 * digest is stored and there is no second chance to copy it.
 */
private val SECTIONS = listOf(
    Triple("showPhoto", "Show my photo", "Off by default. People you apply to still see it."),
    Triple("showHeadline", "Headline and summary", "The few lines you wrote about yourself"),
    Triple("showCity", "My city", "Nothing more precise than a city"),
    Triple("showInstitution", "My institution", "Where you study, and when you graduate"),
    Triple("showEducation", "Academic record", "Verified items keep their badge"),
    Triple("showSelfReported", "Self-reported qualifications", "Shown, clearly marked as unconfirmed"),
    Triple("showAssessments", "Assessment results", "Off by default. Scores from tests we administered."),
    Triple("showLearning", "Learning completed", "Lessons and modules you finished here"),
    Triple("showCertificates", "Certificate titles", "Titles only - the files stay private"),
    Triple("showSkills", "Skills", "The list you wrote yourself"),
    Triple("showPortfolio", "Portfolio link", "Shown with a note that we do not check it"),
)

private fun flagOf(sections: ShareSectionsDto, key: String): Boolean = when (key) {
    "showPhoto" -> sections.showPhoto
    "showHeadline" -> sections.showHeadline
    "showCity" -> sections.showCity
    "showInstitution" -> sections.showInstitution
    "showEducation" -> sections.showEducation
    "showSelfReported" -> sections.showSelfReported
    "showAssessments" -> sections.showAssessments
    "showLearning" -> sections.showLearning
    "showCertificates" -> sections.showCertificates
    "showSkills" -> sections.showSkills
    else -> sections.showPortfolio
}

@Composable
internal fun ShareProfilePage(onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var envelope by remember { mutableStateOf<ShareLinkEnvelope?>(null) }
    var failed by remember { mutableStateOf(false) }
    var freshToken by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        runCatching { Api.readShareLink(context) }
            .onSuccess { envelope = it; failed = false }
            .onFailure { failed = true }
    }

    OverlayScaffold(title = "Public profile", onClose = onClose) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
            notice?.let {
                Spacer(Modifier.height(10.dp))
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(10.dp)) {
                    Text(it, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }

            when {
                failed -> EmptyState(
                    Icons.Filled.Lock, Tone.Amber, "Your sharing settings could not be loaded",
                    "Check your connection and try again.")
                envelope == null -> LoadingSpinner()
                else -> {
                    val link = envelope!!.link
                    Spacer(Modifier.height(12.dp))
                    PilotCard {
                        Column(Modifier.padding(16.dp)) {
                            Text("Your public profile", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                            Text(
                                "One link, yours to switch off. Nothing is shared until you turn it on.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            freshToken?.let { token ->
                                Spacer(Modifier.height(10.dp))
                                Text("oneby8.com/p/$token", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                Text(
                                    "Copy this now. We store only a fingerprint of it, so we cannot show it again - if you lose it, create a new link.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Spacer(Modifier.height(12.dp))
                            if (link == null) {
                                Button(enabled = !busy, onClick = {
                                    busy = true
                                    scope.launch {
                                        runCatching { Api.publishShareLink(context) }
                                            .onSuccess { freshToken = it.token; notice = "Your profile is live."; reload += 1 }
                                            .onFailure { notice = (it as? Api.ApiException)?.detail ?: "That link could not be created." }
                                        busy = false
                                    }
                                }) { Text("Create my public link") }
                            } else {
                                Text(
                                    if (link.expired) "This link has expired. Extend it to make it live again."
                                    else "Live - expires " + formatWhen(link.expiresAt),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Spacer(Modifier.height(10.dp))
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedButton(enabled = !busy, onClick = {
                                        busy = true
                                        scope.launch {
                                            runCatching { Api.extendShareLink(context, 90) }
                                                .onSuccess { notice = "Extended."; reload += 1 }
                                                .onFailure { notice = "That could not be extended." }
                                            busy = false
                                        }
                                    }) { Text("Extend 90 days") }
                                    TextButton(enabled = !busy, onClick = {
                                        busy = true
                                        scope.launch {
                                            runCatching { Api.revokeShareLink(context) }
                                                .onSuccess { freshToken = null; notice = "Switched off. It no longer works for anyone who had it."; reload += 1 }
                                                .onFailure { notice = "That could not be switched off." }
                                            busy = false
                                        }
                                    }) { Text("Switch off") }
                                }
                            }
                        }
                    }

                    if (link != null) {
                        Spacer(Modifier.height(14.dp))
                        Text("What your link shows", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(8.dp))
                        PilotCard {
                            Column(Modifier.padding(vertical = 4.dp)) {
                                SECTIONS.forEachIndexed { index, (key, label, detail) ->
                                    if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                                    Row(
                                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Column(Modifier.weight(1f)) {
                                            Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                            Text(detail, style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                        Switch(
                                            checked = flagOf(link.sections, key),
                                            enabled = !busy,
                                            onCheckedChange = { value ->
                                                busy = true
                                                scope.launch {
                                                    runCatching { Api.updateShareSections(context, key, value) }
                                                        .onSuccess { reload += 1 }
                                                        .onFailure { notice = "That change could not be saved." }
                                                    busy = false
                                                }
                                            },
                                        )
                                    }
                                }
                            }
                        }

                        Spacer(Modifier.height(14.dp))
                        Text("Never shared, whatever you choose", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(8.dp))
                        PilotCard {
                            Column(Modifier.padding(16.dp)) {
                                // Locked, not switched off: these are not choices a student
                                // could make differently, and offering them as switches
                                // would imply they were.
                                listOf(
                                    "Readiness guidance" to "Advice for you. The database will not let it be made public.",
                                    "Job applications and outcomes" to "Yours alone.",
                                    "Feedback employers gave you" to "Yours alone.",
                                    "Your uploaded files" to "Certificate and transcript files never leave your account.",
                                    "Your email address" to "Nobody gets it from the page.",
                                ).forEach { (title, detail) ->
                                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Column(Modifier.weight(1f)) {
                                            Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                                            Text(detail, style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                        StatusChip("Locked", ChipKind.Muted)
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
}
