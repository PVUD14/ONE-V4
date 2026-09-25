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
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
 * The employer's company profile, read-only (EMP-04).
 *
 * The web portal's Company Profile screen lets an owner or admin describe the company —
 * about, industry, size band, careers page — and shows the details AI8HT operations verified
 * the company against (legal name, display name, website, address, contact email) read-only.
 * The phone shows the same profile: how students see the company, and those verified details.
 * Editing stays on the web, like the team and posting roles, so the description is written
 * where it is previewed. Every employer role may read it; a suspended or rejected employer is
 * told the profile is unavailable, as on the web. Nothing is invented: unfilled fields say
 * "Not provided".
 */

@Serializable data class EmployerCompanyProfileEnvelope(val companyProfile: EmployerCompanyProfileDto)

@Serializable data class EmployerCompanyProfileDto(
    val legalName: String = "",
    val verificationState: String = "",
    val displayName: String? = null,
    val websiteUrl: String? = null,
    val countryCode: String? = null,
    val stateOrProvince: String? = null,
    val city: String? = null,
    val primaryContactEmail: String? = null,
    val about: String? = null,
    val industry: String? = null,
    val companySizeBand: String? = null,
    val careersPageUrl: String? = null,
    val canEdit: Boolean = false,
)

suspend fun Api.employerCompanyProfile(context: Context, employerId: String): EmployerCompanyProfileDto =
    json.decodeFromString<EmployerCompanyProfileEnvelope>(
        request(context, "GET", "/api/v1/employers/$employerId/company-profile"),
    ).companyProfile

/** Labels for the server's fixed industry list; the same wording as the web. */
internal fun companyIndustryLabel(code: String): String = when (code) {
    "SOFTWARE_AND_IT_SERVICES" -> "Software and IT services"
    "FINANCIAL_SERVICES" -> "Financial services"
    "MANUFACTURING" -> "Manufacturing"
    "ENGINEERING_AND_CONSTRUCTION" -> "Engineering and construction"
    "HEALTHCARE_AND_LIFE_SCIENCES" -> "Healthcare and life sciences"
    "CONSULTING_AND_PROFESSIONAL_SERVICES" -> "Consulting and professional services"
    "RETAIL_AND_CONSUMER" -> "Retail and consumer"
    "EDUCATION" -> "Education"
    "MEDIA_AND_COMMUNICATIONS" -> "Media and communications"
    "ENERGY_AND_UTILITIES" -> "Energy and utilities"
    "LOGISTICS_AND_TRANSPORT" -> "Logistics and transport"
    "GOVERNMENT_AND_PUBLIC_SECTOR" -> "Government and public sector"
    "NON_PROFIT" -> "Non-profit"
    "OTHER" -> "Other"
    else -> prettify(code)
}

private fun verificationLabel(state: String): String = when (state) {
    "PENDING" -> "Awaiting review"
    "UNDER_REVIEW" -> "Under review"
    "VERIFIED" -> "Verified"
    "REJECTED" -> "Not approved"
    "SUSPENDED" -> "Suspended"
    else -> "NA"
}

private sealed interface CompanyProfileLoad {
    data object Loading : CompanyProfileLoad
    data class Loaded(val profile: EmployerCompanyProfileDto) : CompanyProfileLoad
    data object Unavailable : CompanyProfileLoad
    data object Failed : CompanyProfileLoad
}

@Composable
internal fun EmployerCompanyProfilePage(employerId: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var load by remember { mutableStateOf<CompanyProfileLoad>(CompanyProfileLoad.Loading) }

    LaunchedEffect(employerId) {
        load = runCatching { Api.employerCompanyProfile(context, employerId) }.fold(
            onSuccess = { CompanyProfileLoad.Loaded(it) },
            onFailure = {
                if ((it as? Api.ApiException)?.code == "EMPLOYER_ORGANISATION_INACTIVE") CompanyProfileLoad.Unavailable
                else CompanyProfileLoad.Failed
            },
        )
    }

    OverlayScaffold(title = "Company Profile", onClose = onClose) {
        when (val current = load) {
            CompanyProfileLoad.Loading -> LoadingSpinner()
            CompanyProfileLoad.Unavailable -> EmptyState(
                Icons.Filled.Lock, Tone.Violet, "Company profile unavailable",
                "Your employer account is suspended or was not approved, so the company profile is not available.",
            )
            CompanyProfileLoad.Failed -> EmptyState(
                Icons.Filled.Business, Tone.Violet, "We could not load your company profile",
                "Check your connection and try again.",
            )
            is CompanyProfileLoad.Loaded -> CompanyProfileContent(current.profile)
        }
    }
}

@Composable
private fun CompanyProfileContent(profile: EmployerCompanyProfileDto) {
    val notProvided = "Not provided"
    val place = listOfNotNull(profile.city, profile.stateOrProvince, profile.countryCode).joinToString(", ").ifBlank { notProvided }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCell(verificationLabel(profile.verificationState), "Verification", Tone.Accent, Icons.Filled.VerifiedUser, Modifier.weight(1f))
            StatCell(profile.companySizeBand ?: "NA", "Company size", Tone.Amber, Icons.Filled.Groups, Modifier.weight(1f))
        }

        SectionTitle("How students see you")
        PilotCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text(profile.displayName ?: profile.legalName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(
                    listOfNotNull(profile.industry?.let { companyIndustryLabel(it) }, profile.companySizeBand?.let { "$it employees" })
                        .joinToString("  ·  ").ifBlank { "Industry and size not provided" },
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                Text(profile.about ?: "No description yet.", style = MaterialTheme.typography.bodyMedium)
                profile.careersPageUrl?.let {
                    Spacer(Modifier.height(6.dp))
                    Text("Careers: $it", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                }
                if (profile.verificationState != "VERIFIED") {
                    Spacer(Modifier.height(6.dp))
                    Text("Students see this profile only once AI8HT operations has verified your company.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        PilotCard {
            Text(
                if (profile.canEdit) "Edit the description, industry, size and careers page on the web at one.ai8ht.pro."
                else "Recruiters see the company profile but do not change it. Ask your owner or admin.",
                Modifier.padding(14.dp), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        SectionTitle("Verified details")
        PilotCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Managed by AI8HT operations. These are what your company was verified against, so they change only through operations.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                DetailLine("Legal name", profile.legalName.ifBlank { notProvided })
                DetailLine("Display name", profile.displayName ?: notProvided)
                DetailLine("Website", profile.websiteUrl ?: notProvided)
                DetailLine("Location", place)
                DetailLine("Contact email", profile.primaryContactEmail ?: notProvided)
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun DetailLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, Modifier.weight(0.4f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, Modifier.weight(0.6f), style = MaterialTheme.typography.bodyMedium)
    }
}
