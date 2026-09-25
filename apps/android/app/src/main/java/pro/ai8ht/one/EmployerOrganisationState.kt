package pro.ai8ht.one

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.HourglassTop
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable
import pro.ai8ht.one.ui.Tone

/**
 * The employer organisation's own state, and what the app shows because of it (EMP-03).
 *
 * The API now refuses a suspended or rejected employer everything except reading its own
 * status, and an unverified employer everything that publishes or touches candidates.
 * Without this the employer app would fill with failed loads; instead it shows the same
 * plain status the web portal shows. Display only: the server stays the authority, and
 * if the status cannot be read the app behaves as before.
 */

@Serializable data class EmployerOrganisationStatusEnvelope(val organisation: EmployerOrganisationStatusDto)

// No defaults on purpose: a response missing a field fails to decode and is treated as
// "status unknown" (the app behaves as before), never read as a refusal.
@Serializable data class EmployerOrganisationStatusDto(
    val verificationState: String,
    val active: Boolean,
    val canDraft: Boolean,
    val canPublish: Boolean,
    val canReachCandidates: Boolean,
)

suspend fun Api.employerOrganisationStatus(context: Context, employerId: String): EmployerOrganisationStatusDto =
    json.decodeFromString<EmployerOrganisationStatusEnvelope>(
        request(context, "GET", "/api/v1/employers/$employerId/organisation-status"),
    ).organisation

/** Suspended, rejected or inactive: the one screen such an employer sees on Home and Roles. */
@Composable
internal fun EmployerOrganisationStatusPanel(status: EmployerOrganisationStatusDto) {
    val rejected = status.verificationState == "REJECTED"
    val title = when {
        rejected -> "Your organisation was not verified"
        status.verificationState == "SUSPENDED" -> "Your organisation is suspended"
        else -> "Your organisation is not active"
    }
    val body = if (rejected) {
        "AI8HT operations did not verify this employer organisation, so it cannot publish jobs or see candidates. " +
            "If you think this is a mistake, contact AI8HT operations."
    } else {
        "AI8HT operations has suspended this employer organisation. While it is suspended you cannot publish jobs " +
            "or see candidates, and your published jobs are paused so students no longer see them. When the " +
            "suspension is lifted your jobs stay paused until you publish them again."
    }
    EmptyState(Icons.Filled.Block, Tone.Amber, title, body)
}

/** Pending or under review: drafts are fine, publishing and candidates wait for verification. */
@Composable
internal fun EmployerVerificationNotice() {
    Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(12.dp))
        PilotCard {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                IconBubble(Icons.Filled.HourglassTop, Tone.Amber)
                Spacer(Modifier.height(8.dp))
                Text("Awaiting verification", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                Text(
                    "AI8HT operations is reviewing your organisation. You can prepare draft jobs now; " +
                        "publishing and candidates open once it is verified.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
