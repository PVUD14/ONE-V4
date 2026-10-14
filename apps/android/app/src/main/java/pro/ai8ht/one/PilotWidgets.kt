package pro.ai8ht.one

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import pro.ai8ht.one.ui.LocalOnePalette

/**
 * The pilot preview's signature widgets, in Compose, for the pilot-parity
 * dashboards. Rule: real value when an engine exists, an explicit NA in the
 * same slot when it does not - never invented, never dropped.
 */

@Composable
fun PilotRing(percent: Float?, center: String, caption: String, size: Int = 96, stroke: Float = 10f) {
    val palette = LocalOnePalette.current
    val track = Color(0xFFEDF1F7)
    Box(contentAlignment = Alignment.Center, modifier = Modifier.size(size.dp)) {
        Canvas(Modifier.size(size.dp)) {
            val inset = stroke.dp.toPx() / 2
            drawArc(track, -90f, 360f, false, topLeft = Offset(inset, inset),
                size = androidx.compose.ui.geometry.Size(this.size.width - inset * 2, this.size.height - inset * 2),
                style = Stroke(stroke.dp.toPx(), cap = StrokeCap.Round))
            if (percent != null && percent > 0f) {
                drawArc(palette.accent, -90f, 360f * percent.coerceIn(0f, 1f), false,
                    topLeft = Offset(inset, inset),
                    size = androidx.compose.ui.geometry.Size(this.size.width - inset * 2, this.size.height - inset * 2),
                    style = Stroke(stroke.dp.toPx(), cap = StrokeCap.Round))
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(center, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold,
                color = if (percent == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
            Text(caption, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * One topic's mastery band.
 *
 * Replaces a card that drew a ring, "NA/100" and an "NA" chip for five hardcoded
 * category names. Those numbers never existed: mastery is a band, and the server was
 * already returning a real one per topic while this drew placeholders over the top.
 */
@Composable
fun TopicBandCard(label: String, band: String, modifier: Modifier = Modifier) {
    PilotCard(modifier) {
        Column(Modifier.padding(12.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, maxLines = 2)
            Spacer(Modifier.height(10.dp))
            StatusChip(
                prettify(band),
                when (band) {
                    "DEMONSTRATED" -> ChipKind.Positive
                    "PROGRESSING" -> ChipKind.Accent
                    "DEVELOPING" -> ChipKind.Waiting
                    else -> ChipKind.Muted
                },
            )
            if (band == "NOT_ENOUGH_EVIDENCE") {
                Spacer(Modifier.height(6.dp))
                Text(
                    "Nothing measured yet",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** Streak dots: one per day, check when active. */
@Composable
fun StreakDots(active: List<Boolean>, letters: List<String>) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        active.forEachIndexed { index, on ->
            val palette = LocalOnePalette.current
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier.size(28.dp)
                    .background(
                        color = if (on) Color(0xFFE4F6EE) else Color(0xFFEEF1F6),
                        shape = CircleShape,
                    ),
            ) {
                Text(if (on) "✓" else (letters.getOrNull(index) ?: "·"),
                    style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold,
                    color = if (on) Color(0xFF0D6B4F) else MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/**
 * Weekly progress spark: filled polyline over the last-7 counts. With no counts to draw
 * (the activity could not be read) the frame says so rather than drawing a flat line, which
 * would read as seven days of nothing.
 */
@Composable
fun WeekSpark(points: List<Int>?, modifier: Modifier = Modifier) {
    val palette = LocalOnePalette.current
    if (points == null || !chartDrawable(points)) {
        Box(modifier.fillMaxWidth()) { SuppressedChartNote("Not enough data yet") }
        return
    }
    Canvas(modifier.fillMaxWidth().height(72.dp)) {
        val max = (points.maxOrNull() ?: 0).coerceAtLeast(1).toFloat()
        val stepX = size.width / (points.size - 1).coerceAtLeast(1)
        val coords = points.mapIndexed { index, value ->
            Offset(index * stepX, size.height - 10f - (value / max) * (size.height - 24f))
        }
        val fill = Path().apply {
            moveTo(0f, size.height)
            coords.forEach { lineTo(it.x, it.y) }
            lineTo(size.width, size.height)
            close()
        }
        drawPath(fill, palette.accent.copy(alpha = 0.10f))
        for (i in 0 until coords.size - 1) {
            drawLine(palette.accent, coords[i], coords[i + 1], strokeWidth = 5f, cap = StrokeCap.Round)
        }
        coords.forEach { drawCircle(Color.White, 5f, it); drawCircle(palette.accent, 5f, it, style = Stroke(4f)) }
    }
}

/** Pilot funnel row: label, bar, value (or NA). */
@Composable
fun FunnelRow(label: String, value: Int?, max: Int) {
    val palette = LocalOnePalette.current
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.width(88.dp), style = MaterialTheme.typography.labelMedium)
        Box(Modifier.weight(1f).height(7.dp)
            .background(Color(0xFFEDF1F7), RoundedCornerShape(99.dp))) {
            val fraction = if (value != null && max > 0) (value.toFloat() / max).coerceIn(0f, 1f) else 0f
            if (fraction > 0f) {
                Box(Modifier.fillMaxWidth(fraction).height(7.dp)
                    .background(palette.accent, RoundedCornerShape(99.dp)))
            }
        }
        Spacer(Modifier.width(10.dp))
        Text(value?.toString() ?: "NA", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
            color = if (value == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
    }
}
