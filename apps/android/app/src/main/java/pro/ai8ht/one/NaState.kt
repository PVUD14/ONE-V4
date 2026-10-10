/*
 * ONE · How a missing or withheld figure looks, on every Android screen.
 *
 * The product rule is that a widget never disappears because its data is missing: its slot
 * says NA (no source yet), "<5" (a group too small to show), "Withheld" (a total that would
 * reveal a small group) or "Too few answers". Drawn as big bold values those slots read as a
 * broken page. These pieces keep every slot and its exact text but present it calmly, the
 * same way the web app's naState.tsx does:
 *
 *  - NaValueText / NaReason: a missing value in a muted, smaller style with a one-line reason;
 *  - NaSlotStrip: a group whose slots are all missing collapses into one compact strip that
 *    still names every slot ("Target progress · NA") above a single explanation line;
 *  - StatGrid: the staff dashboards' KPI tiles, two to a row, which become one strip when
 *    every tile is missing;
 *  - SuppressedChartNote: what a chart frame shows instead of a line when any point is
 *    missing, because a withheld point drawn as zero is a false figure.
 *
 * Nothing here computes or invents a figure: callers pass the text the server sent, and a
 * suppressed count is never turned back into a number.
 */
package pro.ai8ht.one

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import pro.ai8ht.one.ui.LocalOnePalette
import pro.ai8ht.one.ui.Tone

internal enum class MissingKind { Na, Suppressed, Withheld, Few }

private val suppressedShape = Regex("^<\\s?\\d.*")

/** Which kind of missing figure a rendered value is, or null when it is a real value. */
internal fun missingKind(value: String?): MissingKind? {
    if (value == null) return MissingKind.Na
    val text = value.trim()
    return when {
        text == "NA" -> MissingKind.Na
        suppressedShape.matches(text) -> MissingKind.Suppressed
        text == "Withheld" -> MissingKind.Withheld
        text.startsWith("Too few ") -> MissingKind.Few
        else -> null
    }
}

internal fun isMissingFigure(value: String?): Boolean = missingKind(value) != null

/** True when there is at least one value and every one of them is missing. */
internal fun allMissingFigures(values: List<String?>): Boolean = values.isNotEmpty() && values.all(::isMissingFigure)

/** A chart is drawn only when it has points and every one of them is a shown number. */
internal fun chartDrawable(points: List<Int?>?): Boolean = !points.isNullOrEmpty() && points.all { it != null }

/** A value as sent; a missing one is muted and keeps its exact text. */
@Composable
internal fun NaValueText(value: String?, style: TextStyle = MaterialTheme.typography.bodyMedium) {
    if (isMissingFigure(value)) {
        Text(value ?: "NA", style = style, fontWeight = FontWeight.Medium, color = LocalOnePalette.current.muted)
    } else {
        Text(value.orEmpty(), style = style, fontWeight = FontWeight.SemiBold)
    }
}

/** The one muted line that says why a slot is empty. */
@Composable
internal fun NaReason(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, style = MaterialTheme.typography.labelSmall, color = LocalOnePalette.current.muted)
}

/** One labelled slot as a chip: "Target progress · NA". */
@Composable
private fun NaSlotChip(label: String, value: String) {
    val palette = LocalOnePalette.current
    val (bg, _) = palette.soft(Tone.Gray)
    Surface(color = bg, shape = RoundedCornerShape(999.dp)) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = palette.ink)
            Box(Modifier.padding(horizontal = 6.dp).size(3.dp).background(palette.muted, CircleShape))
            Text(value, style = MaterialTheme.typography.labelMedium, color = palette.muted)
        }
    }
}

/**
 * A group of slots with nothing to show, as one compact strip: every slot stays visible and
 * labelled, and one line explains why. With [title] it carries a heading and an NA chip;
 * with [card] false it sits inside a card the caller already has.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun NaSlotStrip(
    slots: List<Pair<String, String?>>,
    reason: String,
    modifier: Modifier = Modifier,
    title: String? = null,
    card: Boolean = true,
) {
    val body: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().padding(if (card) 14.dp else 0.dp)) {
            if (title != null) {
                Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    StatusChip("NA", ChipKind.Muted)
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                slots.forEach { (label, value) -> NaSlotChip(label, value ?: "NA") }
            }
            Spacer(Modifier.height(8.dp))
            NaReason(reason)
        }
    }
    if (card) PilotCard(modifier.fillMaxWidth()) { body() } else Box(modifier) { body() }
}

/** One KPI tile for [StatGrid]. */
internal data class StatSpec(val value: String, val label: String, val tone: Tone, val icon: ImageVector, val reason: String? = null)

/**
 * KPI tiles two to a row. When every tile is a missing figure the row of empty tiles would
 * read as a broken page, so the group becomes one [NaSlotStrip] that names each slot.
 */
@Composable
internal fun StatGrid(cells: List<StatSpec>, emptyReason: String, modifier: Modifier = Modifier) {
    if (allMissingFigures(cells.map { it.value })) {
        NaSlotStrip(cells.map { it.label to it.value }, emptyReason, modifier)
        return
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        cells.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                pair.forEach { StatCell(it.value, it.label, it.tone, it.icon, Modifier.weight(1f), reason = it.reason) }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

/**
 * What a chart frame shows when it cannot draw honestly: the frame keeps its height and a
 * baseline, and says why, instead of a flat line that would read as zero.
 */
@Composable
internal fun SuppressedChartNote(note: String, height: androidx.compose.ui.unit.Dp = 72.dp) {
    val palette = LocalOnePalette.current
    Column(Modifier.fillMaxWidth().heightIn(min = height), verticalArrangement = Arrangement.Center) {
        Text(note, style = MaterialTheme.typography.labelMedium, color = palette.muted)
        Spacer(Modifier.height(10.dp))
        Box(Modifier.fillMaxWidth().height(1.dp).background(palette.outline))
    }
}
