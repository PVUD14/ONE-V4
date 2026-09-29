package pro.ai8ht.one

/*
 * Placement statistics on the phone (INST-12): the same season figures the web shows on the
 * admin's Placement page, the placement officer's Dashboard and the department head's Placement
 * Pipeline — eligible, applied, shortlisted, with an offer, placed, the placement percentage over
 * students who shared, and offers per placed student, as of the end of the last full month, by
 * department and batch. Read-only: categories and the register's detail stay on the web.
 *
 * The server decides scope and suppression; a group under five reads <5, a student who shared
 * nothing is "Not shared" and never unplaced, and offer pay is never part of it. A 403 (faculty,
 * who have no placement role) leaves the card out; any other failure reads NA.
 */

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.School
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable
import pro.ai8ht.one.ui.Tone

@Serializable data class PlacementAsOfDto(val month: String = "", val lastDay: String = "")
@Serializable data class PlacementUnitRefDto(val id: String = "", val name: String = "")
@Serializable data class PlacementStatisticsRowDto(
    val department: PlacementUnitRefDto? = null,
    val batch: PlacementUnitRefDto? = null,
    val eligible: SuppressedCountDto = SuppressedCountDto(),
    val notShared: SuppressedCountDto = SuppressedCountDto(),
    val applied: SuppressedCountDto = SuppressedCountDto(),
    val shortlisted: SuppressedCountDto = SuppressedCountDto(),
    val withOffer: SuppressedCountDto = SuppressedCountDto(),
    val placed: SuppressedCountDto = SuppressedCountDto(),
    val placementPercentage: Double? = null,
    val offersPerPlacedStudent: Double? = null,
)
@Serializable data class PlacementMonthDto(val month: String = "", val offers: SuppressedCountDto = SuppressedCountDto())
@Serializable data class PlacementStatisticsDto(
    val asOf: PlacementAsOfDto = PlacementAsOfDto(),
    val overall: PlacementStatisticsRowDto = PlacementStatisticsRowDto(),
    val groups: List<PlacementStatisticsRowDto> = emptyList(),
    val offersByMonth: List<PlacementMonthDto> = emptyList(),
)

/** INST-12: season statistics for the reader's scope (403 for faculty-only callers). */
suspend fun Api.placementStatistics(context: Context, institutionId: String): PlacementStatisticsDto =
    json.decodeFromString(request(context, "GET", "/api/v1/institutions/$institutionId/placement-statistics"))

internal fun countText(count: SuppressedCountDto?): String = when {
    count == null -> "NA"
    count.suppressed || count.value == null -> "<5"
    else -> count.value.toString()
}

private fun percentText(row: PlacementStatisticsRowDto): String = row.placementPercentage?.let { "${formatNumber(it)}%" }
    ?: if (row.placed.suppressed || row.applied.suppressed) "<5" else "NA"

private fun ratioText(row: PlacementStatisticsRowDto): String = row.offersPerPlacedStudent?.let(::formatNumber)
    ?: if (row.placed.suppressed) "<5" else "NA"

private fun formatNumber(value: Double): String = if (value % 1.0 == 0.0) value.toLong().toString() else value.toString()

/** Students placed, for the home KPI row: <5 when withheld, NA without a source. */
internal fun placedKpi(statistics: ScopedView<PlacementStatisticsDto>): String =
    (statistics as? ScopedView.Loaded)?.value?.overall?.placed?.let(::countText) ?: "NA"

/** The season statistics card; left out for a caller with no placement role. */
@Composable
internal fun PlacementStatisticsSection(statistics: ScopedView<PlacementStatisticsDto>) {
    if (statistics is ScopedView.NotForRole) return
    val data = (statistics as? ScopedView.Loaded)?.value
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    SectionTitle("Placement statistics")
    PilotCard {
        Column(Modifier.padding(14.dp)) {
            if (data == null) {
                Text("NA — placement statistics could not be loaded right now.", style = MaterialTheme.typography.bodySmall, color = muted)
                return@Column
            }
            Text("As of ${data.asOf.lastDay}", style = MaterialTheme.typography.labelMedium, color = muted)
            Spacer(Modifier.height(8.dp))
            Row {
                StatCell(countText(data.overall.eligible), "Eligible", Tone.Accent, Icons.Filled.School, Modifier.weight(1f))
                Spacer(Modifier.width(10.dp))
                StatCell(countText(data.overall.placed), "Placed", Tone.Green, Icons.Filled.School, Modifier.weight(1f))
            }
            Spacer(Modifier.height(8.dp))
            listOf(
                "Not shared" to countText(data.overall.notShared),
                "Applied (shared)" to countText(data.overall.applied),
                "Shortlisted" to countText(data.overall.shortlisted),
                "With an offer" to countText(data.overall.withOffer),
                "Placed, of students sharing" to percentText(data.overall),
                "Offers per placed student" to ratioText(data.overall),
            ).forEach { (label, value) ->
                Row(Modifier.padding(vertical = 3.dp)) {
                    Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    Text(value, style = MaterialTheme.typography.bodySmall, color = muted)
                }
            }
            if (data.groups.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Text("By department and batch", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                data.groups.forEach { group ->
                    Spacer(Modifier.height(6.dp))
                    Text("${group.department?.name ?: "No department"} · ${group.batch?.name ?: "No batch"}",
                        style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    Text("Eligible ${countText(group.eligible)} · Not shared ${countText(group.notShared)} · Applied ${countText(group.applied)} · " +
                        "With an offer ${countText(group.withOffer)} · Placed ${countText(group.placed)} · ${percentText(group)} of students sharing",
                        style = MaterialTheme.typography.bodySmall, color = muted)
                }
            }
            if (data.offersByMonth.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Text("Offers made by month", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                Text(data.offersByMonth.joinToString(" · ") { "${it.month}: ${countText(it.offers)}" },
                    style = MaterialTheme.typography.bodySmall, color = muted)
            }
            Spacer(Modifier.height(8.dp))
            Text("From applications students chose to share with the college. A student who shared nothing is \"Not shared\" — never counted as unplaced. Any group under five reads <5; offer pay is never shown. The register and drive categories are on the web.",
                style = MaterialTheme.typography.bodySmall, color = muted)
        }
    }
}
