package pro.ai8ht.one

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Lock
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable
import pro.ai8ht.one.ui.Tone

/**
 * The employer's team, read-only (EMP-02).
 *
 * The web portal's Team screen lets an owner or admin invite admins and recruiters, revoke or
 * resend invitations and end memberships. The phone shows the same team — who is on it, in
 * which role, and which invitations are still open, with the delivery state the server
 * recorded — so an owner can check it between other things. Changing the team stays on the
 * web, like posting and publishing roles: each change needs a confirmation and a reason code,
 * and ending someone's access is not something to do from a notification shade.
 *
 * Authority is the server's. A recruiter gets 403 from the team API and sees that Team is
 * managed by the owner or admin, exactly as on the web.
 */

@Serializable data class EmployerTeamEnvelope(val team: EmployerTeamDto)

@Serializable data class EmployerTeamDto(
    val actorRole: String = "",
    val deliveryConfigured: Boolean = false,
    val members: List<EmployerTeamMemberDto> = emptyList(),
    val nextCursor: String? = null,
    val invitations: List<EmployerTeamInvitationDto> = emptyList(),
)

@Serializable data class EmployerTeamMemberDto(
    val membershipId: String,
    val email: String = "",
    val role: String = "",
    val state: String = "",
    val since: String? = null,
    val isSelf: Boolean = false,
)

@Serializable data class EmployerTeamDeliveryDto(val state: String = "", val sendCount: Int = 0, val lastSentAt: String? = null)

@Serializable data class EmployerTeamInvitationDto(
    val id: String,
    val email: String = "",
    val role: String = "",
    val state: String = "",
    val expiresAt: String? = null,
    val delivery: EmployerTeamDeliveryDto = EmployerTeamDeliveryDto(),
)

suspend fun Api.employerTeam(context: Context, employerId: String): EmployerTeamDto =
    json.decodeFromString<EmployerTeamEnvelope>(
        request(context, "GET", "/api/v1/employers/$employerId/team"),
    ).team

internal fun employerTeamRoleLabel(role: String): String = when (role) {
    "EMPLOYER_OWNER" -> "Owner"
    "EMPLOYER_ADMIN" -> "Admin"
    "RECRUITER" -> "Recruiter"
    else -> roleLabel(role)
}

internal fun employerTeamDeliveryLabel(state: String): String = when (state) {
    "SENT" -> "Email sent"
    "NOT_CONFIGURED" -> "Not emailed: email delivery is not set up yet"
    "FAILED" -> "Sending failed: resend it on the web"
    "BOUNCED" -> "Bounced: check the address"
    "NOT_SENT" -> "Not emailed yet"
    else -> "NA"
}

private sealed interface TeamLoad {
    data object Loading : TeamLoad
    data class Loaded(val team: EmployerTeamDto) : TeamLoad
    data object ManagedByOwner : TeamLoad
    data object Failed : TeamLoad
}

@Composable
internal fun EmployerTeamPage(employerId: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var load by remember { mutableStateOf<TeamLoad>(TeamLoad.Loading) }

    LaunchedEffect(employerId) {
        load = runCatching { Api.employerTeam(context, employerId) }.fold(
            onSuccess = { TeamLoad.Loaded(it) },
            onFailure = { if ((it as? Api.ApiException)?.status == 403 && it.code == "FORBIDDEN") TeamLoad.ManagedByOwner else TeamLoad.Failed },
        )
    }

    OverlayScaffold(title = "Team", onClose = onClose) {
        when (val current = load) {
            TeamLoad.Loading -> LoadingSpinner()
            TeamLoad.ManagedByOwner -> EmptyState(
                Icons.Filled.Lock, Tone.Violet, "Managed by your owner or admin",
                "Recruiters do not change the team. Ask your employer's owner or admin if something here needs to change.",
            )
            TeamLoad.Failed -> EmptyState(
                Icons.Filled.Group, Tone.Violet, "We could not load your team",
                "Check your connection and try again.",
            )
            is TeamLoad.Loaded -> TeamContent(current.team)
        }
    }
}

@Composable
private fun TeamContent(team: EmployerTeamDto) {
    val pending = team.invitations.count { it.state == "PENDING" }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        item {
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(10.dp)) {
                StatCell("${team.members.count { it.state == "ACTIVE" }}", "Active members", Tone.Accent, Icons.Filled.Group, Modifier.weight(1f))
                StatCell("$pending", "Pending invitations", Tone.Amber, Icons.Filled.Group, Modifier.weight(1f))
            }
            Spacer(Modifier.height(10.dp))
            PilotCard {
                Text(
                    "Invite admins and recruiters, resend or revoke invitations and end memberships on the web at " +
                        "oneby8.com. Interviewers join as recruiters and see only the interviews they are assigned to.",
                    Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            SectionTitle("Members")
        }
        if (team.members.isEmpty()) {
            item { PilotCard { Text("No members yet.", Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall) } }
        }
        items(team.members, key = { it.membershipId }) { member ->
            PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(member.email + if (member.isSelf) " (you)" else "", style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold)
                        Text(if (member.state == "ACTIVE") "Active" else "Suspended", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    StatusChip(employerTeamRoleLabel(member.role), if (member.role == "RECRUITER") ChipKind.Muted else ChipKind.Accent)
                }
            }
        }
        if (team.nextCursor != null) {
            item {
                Text("More members are listed on the web.", Modifier.padding(vertical = 6.dp),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        item { SectionTitle("Invitations") }
        if (team.invitations.isEmpty()) {
            item { PilotCard { Text("No pending invitations.", Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall) } }
        }
        items(team.invitations, key = { it.id }) { invitation ->
            PilotCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                Column(Modifier.padding(14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(invitation.email, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        StatusChip(if (invitation.state == "EXPIRED") "Expired" else "Pending",
                            if (invitation.state == "EXPIRED") ChipKind.Muted else ChipKind.Waiting)
                    }
                    Text("${employerTeamRoleLabel(invitation.role)} · ${employerTeamDeliveryLabel(invitation.delivery.state)}",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    invitation.expiresAt?.let {
                        Text("Expires ${formatWhen(it)}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}
