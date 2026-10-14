package pro.ai8ht.one

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Gavel
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable
import pro.ai8ht.one.ui.Tone

/**
 * The employer's terms, what ONE keeps, and trust cases about the organisation — read-only (EMP-16).
 *
 * The web Settings screen lets an owner accept the current employer terms and lets an owner or
 * admin respond to a trust case or appeal a decision. The phone shows the same facts: the terms
 * with their legal-review state (a draft always says it is a draft), whether the organisation has
 * accepted them, what ONE keeps about candidates from the values the server enforces, and the
 * cases operations has disclosed with what they shared and what the organisation answered. Accepting,
 * responding and appealing stay on the web, like publishing and team changes, because each is a
 * considered, recorded act. A suspended or rejected employer still sees its cases here (answering
 * a case is the one thing it may still do); a recruiter is told cases are answered by the owner or
 * admin. Nothing is invented: a missing value says NA.
 */

@Serializable data class EmployerSettingsEnvelope(val settings: EmployerSettingsDto)

@Serializable data class EmployerSettingsDto(
    val terms: EmployerTermsStatusDto,
    val retention: EmployerRetentionDto,
)

@Serializable data class EmployerTermsStatusDto(
    val status: String = "",
    val current: EmployerTermsVersionDto? = null,
    val latestAcceptance: EmployerTermsAcceptanceDto? = null,
    val currentVersionAccepted: Boolean = false,
    val canAccept: Boolean = false,
)

@Serializable data class EmployerTermsVersionDto(
    val version: String = "",
    val title: String = "",
    val body: String = "",
    val legalReviewState: String = "",
    val legalReviewReference: String? = null,
    val changeSummary: String? = null,
    val publishedAt: String? = null,
)

@Serializable data class EmployerTermsAcceptanceDto(val version: String = "", val acceptedAt: String? = null, val acceptedBy: String? = null)

@Serializable data class EmployerRetentionDto(
    val resumeLinkSeconds: Int = 0,
    val messageRetentionDaysAfterAccessEnds: Int = 0,
    val candidateDeletionGraceDays: Int = 0,
    val heldForOpenTrustCasesAndLegalHolds: Boolean = false,
)

@Serializable data class EmployerTrustCasesEnvelope(val cases: List<EmployerTrustCaseDto> = emptyList())
@Serializable data class EmployerTrustCaseEnvelope(val case: EmployerTrustCaseDto)

@Serializable data class EmployerTrustCaseDto(
    val id: String,
    val caseType: String = "",
    val status: String = "",
    val subject: EmployerTrustCaseSubjectDto = EmployerTrustCaseSubjectDto(),
    val responseRequestedAt: String? = null,
    val decidedAt: String? = null,
    val canRespond: Boolean = false,
    val canAppeal: Boolean = false,
    val statements: List<EmployerTrustStatementDto> = emptyList(),
    val actions: List<EmployerTrustActionDto> = emptyList(),
)

@Serializable data class EmployerTrustCaseSubjectDto(val kind: String = "ORGANIZATION", val jobTitle: String? = null, val jobVersion: Int? = null)
@Serializable data class EmployerTrustStatementDto(val kind: String = "", val body: String = "", val createdAt: String? = null)
@Serializable data class EmployerTrustActionDto(val action: String = "", val effectiveFrom: String? = null, val effectiveTo: String? = null, val reversed: Boolean = false)

suspend fun Api.employerSettings(context: Context, employerId: String): EmployerSettingsDto =
    json.decodeFromString<EmployerSettingsEnvelope>(request(context, "GET", "/api/v1/employers/$employerId/settings")).settings

suspend fun Api.employerTrustCases(context: Context, employerId: String): List<EmployerTrustCaseDto> =
    json.decodeFromString<EmployerTrustCasesEnvelope>(request(context, "GET", "/api/v1/employers/$employerId/trust-cases")).cases

suspend fun Api.employerTrustCase(context: Context, employerId: String, caseId: String): EmployerTrustCaseDto =
    json.decodeFromString<EmployerTrustCaseEnvelope>(request(context, "GET", "/api/v1/employers/$employerId/trust-cases/$caseId")).case

private fun termsStatusLabel(status: String): String = when (status) {
    "NO_TERMS_PUBLISHED" -> "None published"
    "ACCEPTED" -> "Accepted"
    "ACCEPTANCE_REQUIRED" -> "Acceptance needed"
    else -> "NA"
}

private fun caseStatusLabel(status: String): String = when (status) {
    "UNDER_REVIEW" -> "Under review"
    "RESPONSE_REQUESTED" -> "Your response is requested"
    "DECIDED" -> "Decided"
    "APPEAL_UNDER_REVIEW" -> "Appeal under review"
    "CLOSED" -> "Closed"
    "CLOSED_NO_ACTION" -> "Closed without action"
    else -> "NA"
}

private fun caseTypeLabel(type: String): String = when (type) {
    "EMPLOYER_ACCOUNTABILITY" -> "Employer conduct"
    "OPPORTUNITY_MODERATION" -> "Job posting"
    else -> prettify(type)
}

private fun statementLabel(kind: String): String = when (kind) {
    "ALLEGATION_SUMMARY" -> "What AI8HT operations shared"
    "DECISION_SUMMARY" -> "Decision"
    "EMPLOYER_RESPONSE" -> "Your response"
    "EMPLOYER_APPEAL" -> "Your appeal"
    else -> prettify(kind)
}

private fun day(value: String?): String = formatDate(value)

private sealed interface Loaded<out T> {
    data object Loading : Loaded<Nothing>
    data class Ready<T>(val value: T) : Loaded<T>
    data class Refused(val code: String?) : Loaded<Nothing>
    data object Failed : Loaded<Nothing>
}

private suspend fun <T> loadOrRefusal(block: suspend () -> T): Loaded<T> = runCatching { block() }.fold(
    onSuccess = { Loaded.Ready(it) },
    onFailure = { error -> (error as? Api.ApiException)?.takeIf { it.status == 403 }?.let { Loaded.Refused(it.code) } ?: Loaded.Failed },
)

@Composable
internal fun EmployerTermsTrustPage(employerId: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var settings by remember { mutableStateOf<Loaded<EmployerSettingsDto>>(Loaded.Loading) }
    LaunchedEffect(employerId) { settings = loadOrRefusal { Api.employerSettings(context, employerId) } }

    OverlayScaffold(title = "Terms and trust", onClose = onClose) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(12.dp))
            when (val current = settings) {
                Loaded.Loading -> LoadingSpinner()
                is Loaded.Refused -> NoticeCard("Your employer account is suspended or was not approved, so the terms are not available. Trust and safety cases are below.")
                Loaded.Failed -> NoticeCard("We could not load your settings. Check your connection and try again.")
                is Loaded.Ready -> TermsAndRetention(current.value)
            }
            EmployerTrustCasesSection(employerId)
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun NoticeCard(text: String) {
    PilotCard(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
        Text(text, Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun TermsAndRetention(settings: EmployerSettingsDto) {
    val terms = settings.terms
    val retention = settings.retention
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        StatCell(termsStatusLabel(terms.status), "Employer terms", Tone.Accent, Icons.Filled.Description, Modifier.weight(1f))
        StatCell("${retention.messageRetentionDaysAfterAccessEnds} days", "Messages kept after access ends", Tone.Amber, Icons.Filled.Schedule, Modifier.weight(1f))
    }

    SectionTitle("Employer terms")
    PilotCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            val version = terms.current
            if (version == null) {
                Text("AI8HT has not published employer terms yet, so there is nothing to accept.", style = MaterialTheme.typography.bodyMedium)
            } else {
                Text(version.title.ifBlank { "Employer terms" }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StatusChip("Version ${version.version}", ChipKind.Muted)
                    if (version.legalReviewState == "DRAFT_FOR_LEGAL_REVIEW") StatusChip("Draft — pending legal review", ChipKind.Waiting)
                    else StatusChip("Reviewed", ChipKind.Positive)
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    if (version.legalReviewState == "DRAFT_FOR_LEGAL_REVIEW") "This text is a draft that has not finished legal review. It is not final."
                    else "Legal review: ${version.legalReviewReference ?: "NA"}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                version.changeSummary?.let { Text("What changed: $it", style = MaterialTheme.typography.bodySmall) }
                Spacer(Modifier.height(8.dp))
                Text(version.body, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(8.dp))
                Text(
                    if (terms.status == "ACCEPTED") "Your organisation has accepted the terms it needs to."
                    else "An owner of your organisation must accept these terms before your organisation publishes another job. Jobs already live stay live.",
                    style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold,
                )
                Text(
                    terms.latestAcceptance?.let { "Last accepted: version ${it.version} on ${day(it.acceptedAt)} by ${it.acceptedBy ?: "NA"}." } ?: "Not accepted yet.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (terms.canAccept) {
                    Text("Accept the terms on the web at oneby8.com, under Settings.", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }

    SectionTitle("What ONE keeps about candidates")
    PilotCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            listOfNotNull(
                "You see a candidate only while their application gives you access. It ends when you hire or reject them, they withdraw, they ask ONE to delete their account, or an access period set for the application runs out.",
                "Résumé downloads are single-use links that expire after ${retention.resumeLinkSeconds} seconds.",
                "Message text is erased ${retention.messageRetentionDaysAfterAccessEnds} days after your access to that candidate ends.",
                "A candidate who asks to delete their account has ${retention.candidateDeletionGraceDays} days to change their mind; you lose access as soon as they ask.",
                if (retention.heldForOpenTrustCasesAndLegalHolds) "Nothing is erased while an open trust and safety case or a legal hold needs it." else null,
            ).forEach { line ->
                Text("• $line", Modifier.padding(vertical = 3.dp), style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** Trust cases about the organisation; also shown to a suspended or rejected employer. */
@Composable
internal fun EmployerTrustCasesSection(employerId: String) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var cases by remember { mutableStateOf<Loaded<List<EmployerTrustCaseDto>>>(Loaded.Loading) }
    var open by remember { mutableStateOf<EmployerTrustCaseDto?>(null) }
    var openFailed by remember { mutableStateOf(false) }
    var openId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(employerId) { cases = loadOrRefusal { Api.employerTrustCases(context, employerId) } }
    LaunchedEffect(openId) {
        val id = openId ?: return@LaunchedEffect
        openFailed = false
        open = runCatching { Api.employerTrustCase(context, employerId, id) }.getOrNull()
        if (open == null) openFailed = true
    }

    SectionTitle("Trust and safety cases")
    PilotCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(
                "A report about your organisation opens a case; it is not a penalty. You see a case once AI8HT operations asks you to respond or decides it. You are never told who reported it.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            when (val current = cases) {
                Loaded.Loading -> Text("Loading cases…", style = MaterialTheme.typography.bodySmall)
                is Loaded.Refused -> Text("Trust and safety cases are answered by your employer's owner or admin.", style = MaterialTheme.typography.bodyMedium)
                Loaded.Failed -> Text("We could not load the cases. Check your connection and try again.", style = MaterialTheme.typography.bodyMedium)
                is Loaded.Ready -> if (current.value.isEmpty()) {
                    Text("There are no trust and safety cases about your organisation.", style = MaterialTheme.typography.bodyMedium)
                } else {
                    current.value.forEach { record ->
                        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                            Text(
                                "${caseTypeLabel(record.caseType)} · " + if (record.subject.kind == "JOB") "Job: ${record.subject.jobTitle ?: "NA"}" else "Your organisation",
                                style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                StatusChip(caseStatusLabel(record.status), if (record.status == "RESPONSE_REQUESTED") ChipKind.Waiting else ChipKind.Muted)
                            }
                            Text("Response requested ${day(record.responseRequestedAt)} · Decided ${day(record.decidedAt)}",
                                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            TextButton(onClick = { openId = record.id }) { Text("View") }
                        }
                    }
                }
            }
            if (openFailed) Text("We could not load that case.", style = MaterialTheme.typography.bodySmall)
            open?.let { detail -> TrustCaseDetail(detail) }
        }
    }
}

@Composable
private fun TrustCaseDetail(detail: EmployerTrustCaseDto) {
    Spacer(Modifier.height(10.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        IconBubble(Icons.Filled.Gavel, Tone.Violet)
        Text(caseStatusLabel(detail.status), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
    }
    detail.statements.forEach { statement ->
        Spacer(Modifier.height(6.dp))
        Text("${statementLabel(statement.kind)} · ${day(statement.createdAt)}", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        Text(statement.body, style = MaterialTheme.typography.bodySmall)
    }
    Spacer(Modifier.height(6.dp))
    Text(
        "Actions: " + if (detail.actions.isEmpty()) "None" else detail.actions.joinToString("; ") {
            "${prettify(it.action)} from ${day(it.effectiveFrom)}" + (it.effectiveTo?.let { to -> " to ${day(to)}" } ?: "") + if (it.reversed) " (reversed)" else ""
        },
        style = MaterialTheme.typography.bodySmall,
    )
    if (detail.canRespond || detail.canAppeal) {
        Text(
            if (detail.canRespond) "Respond on the web at oneby8.com, under Settings." else "You can appeal this decision once, on the web at oneby8.com, under Settings.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary,
        )
    }
}
