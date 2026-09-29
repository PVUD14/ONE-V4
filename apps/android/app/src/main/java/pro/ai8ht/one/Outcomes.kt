package pro.ai8ht.one

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/**
 * "After college" on the phone's Profile (INST-13), matching the web.
 *
 * Colleges report their graduates' outcomes for accreditation. ONE knows a placement only from
 * applications a student shared, and nothing about higher studies or a venture unless the student
 * says so. Here the student tells a college they study at or graduated from, changes it or withdraws
 * it. The college never sees who: it appears only as a count in the college's accreditation export,
 * any group under 5 hidden, labelled self-reported. The export itself is a desk task on the web and
 * is not on the phone.
 */

@Serializable data class OutcomeDeclarationDto(val id: String, val outcome: String, val declaredAt: String? = null)
@Serializable data class OutcomeCollegeDto(
    val institutionId: String,
    val institutionName: String = "",
    /** CURRENT while studying there; GRADUATED once a graduation is recorded. */
    val relationship: String = "CURRENT",
    val graduatedOn: String? = null,
    val declaration: OutcomeDeclarationDto? = null,
)
@Serializable data class OutcomeCollegesEnvelope(val colleges: List<OutcomeCollegeDto> = emptyList())
@Serializable private data class ShareOutcomeRequest(val institutionId: String, val outcome: String)

suspend fun Api.listMyOutcomeDeclarations(context: Context): List<OutcomeCollegeDto> =
    json.decodeFromString<OutcomeCollegesEnvelope>(request(context, "GET", "/api/v1/students/me/outcome-declarations")).colleges

suspend fun Api.shareOutcomeDeclaration(context: Context, institutionId: String, outcome: String): List<OutcomeCollegeDto> =
    json.decodeFromString<OutcomeCollegesEnvelope>(request(
        context, "POST", "/api/v1/students/me/outcome-declarations", json.encodeToString(ShareOutcomeRequest(institutionId, outcome)),
    )).colleges

suspend fun Api.withdrawOutcomeDeclaration(context: Context, declarationId: String): List<OutcomeCollegeDto> =
    json.decodeFromString<OutcomeCollegesEnvelope>(request(
        context, "POST", "/api/v1/students/me/outcome-declarations/$declarationId/withdraw", "{}",
    )).colleges

private val outcomeLabels = linkedMapOf(
    "HIGHER_STUDIES" to "Higher studies",
    "ENTREPRENEURSHIP" to "My own business or venture",
)

private fun outcomeError(error: Throwable, fallback: String): String = when ((error as? Api.ApiException)?.code) {
    "OUTCOME_COLLEGE_NOT_ELIGIBLE" -> "You can share this only with a college you study at or graduated from."
    else -> fallback
}

/** The card on Profile. Nothing is drawn for a person with no college in ONE. */
@Composable
internal fun StudentOutcomesSection() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var colleges by remember { mutableStateOf<List<OutcomeCollegeDto>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    val chosen = remember { mutableStateMapOf<String, String>() }
    LaunchedEffect(Unit) {
        runCatching { Api.listMyOutcomeDeclarations(context) }
            .onSuccess { colleges = it }
            .onFailure { failed = true }
    }
    if (!failed && colleges.isNullOrEmpty()) return

    SectionTitle("After college")
    PilotCard {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text("Tell your college what you did after graduating. Your college never sees your name next to this: " +
                "it appears only as a count in its accreditation reports, and any group of fewer than 5 people is hidden. " +
                "It is marked as self-reported. Nothing is shared unless you choose, and you can withdraw it at any time.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            notice?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
            }
            if (failed) {
                Spacer(Modifier.height(8.dp))
                Text("Your outcome sharing could not be loaded right now.", style = MaterialTheme.typography.bodySmall)
            }
            colleges.orEmpty().forEachIndexed { index, college ->
                if (index > 0) HorizontalDivider(Modifier.padding(vertical = 10.dp), color = MaterialTheme.colorScheme.outline)
                Spacer(Modifier.height(10.dp))
                Text(college.institutionName, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    if (college.relationship == "GRADUATED") "Graduated ${college.graduatedOn ?: "NA"}"
                    else "Studying here now — counted once your graduation is recorded",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    college.declaration?.let { "Shared: ${outcomeLabels[it.outcome] ?: "NA"} · since ${it.declaredAt?.take(10) ?: "NA"}" } ?: "Nothing shared",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(6.dp))
                val selected = chosen[college.institutionId] ?: college.declaration?.outcome
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    outcomeLabels.forEach { (key, label) ->
                        FilterChip(selected = selected == key, enabled = !busy,
                            onClick = { chosen[college.institutionId] = key }, label = { Text(label) })
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        enabled = !busy && selected != null && selected != college.declaration?.outcome,
                        shape = RoundedCornerShape(10.dp),
                        onClick = {
                            val outcome = selected ?: return@Button
                            scope.launch {
                                busy = true
                                runCatching { Api.shareOutcomeDeclaration(context, college.institutionId, outcome) }
                                    .onSuccess {
                                        colleges = it
                                        notice = "Shared with ${college.institutionName}. It is counted from the start of next month, only as a number alongside other graduates."
                                    }
                                    .onFailure { notice = outcomeError(it, "That could not be shared.") }
                                busy = false
                            }
                        },
                    ) { Text(if (college.declaration != null) "Update" else "Share") }
                    college.declaration?.let { declaration ->
                        OutlinedButton(enabled = !busy, shape = RoundedCornerShape(10.dp), onClick = {
                            scope.launch {
                                busy = true
                                runCatching { Api.withdrawOutcomeDeclaration(context, declaration.id) }
                                    .onSuccess {
                                        colleges = it
                                        chosen.remove(college.institutionId)
                                        notice = "Withdrawn. ${college.institutionName} no longer counts it from its next export."
                                    }
                                    .onFailure { notice = outcomeError(it, "That could not be withdrawn.") }
                                busy = false
                            }
                        }) { Text("Withdraw") }
                    }
                }
            }
        }
    }
}
