package pro.ai8ht.one

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import pro.ai8ht.one.ui.LocalOnePalette
import pro.ai8ht.one.ui.Tone
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Shared building blocks, all painted from the active OnePalette. */

internal enum class ChipKind { Positive, Accent, Waiting, Muted, OnDark }

@Composable
internal fun StatusChip(text: String, kind: ChipKind) {
    val palette = LocalOnePalette.current
    val (bg, fg) = when (kind) {
        ChipKind.Positive -> palette.soft(Tone.Green)
        ChipKind.Accent -> palette.soft(Tone.Accent)
        ChipKind.Waiting -> palette.soft(Tone.Amber)
        ChipKind.Muted -> palette.soft(Tone.Gray)
        // On the band: glassy on colored/dark bands, soft grey on the white band.
        ChipKind.OnDark ->
            if (palette.bandTop == Color(0xFFFFFFFF)) Color(0xFFF1F4F9) to Color(0xFF475569)
            else Color(0x33FFFFFF) to Color.White
    }
    Surface(color = bg, contentColor = fg, shape = RoundedCornerShape(999.dp)) {
        Text(text, Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
internal fun PilotCard(modifier: Modifier = Modifier, glow: Boolean = false, content: @Composable () -> Unit) {
    val palette = LocalOnePalette.current
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = if (glow) palette.accentSoft else palette.card),
        border = when {
            glow -> BorderStroke(1.dp, palette.accent.copy(alpha = .45f))
            palette.cardBorder != null -> BorderStroke(1.dp, palette.cardBorder)
            else -> null
        },
        elevation = CardDefaults.cardElevation(defaultElevation = if (palette.cardBorder == null) 3.dp else 0.dp),
    ) { content() }
}

/** The brand band opening every screen, in the active palette's world. */
@Composable
internal fun BrandBand(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    val palette = LocalOnePalette.current
    Column(
        Modifier
            .fillMaxWidth()
            .background(palette.bandBrush)
            .statusBarsPadding()
            .padding(start = 20.dp, end = 12.dp, top = 6.dp, bottom = 22.dp),
        content = content,
    )
}

/** Rounded content sheet under the band. */
@Composable
internal fun BandSheet(content: @Composable () -> Unit) {
    val palette = LocalOnePalette.current
    Surface(
        color = palette.sheet,
        contentColor = palette.ink,
        shape = RoundedCornerShape(topStart = 26.dp, topEnd = 26.dp),
        modifier = Modifier.fillMaxSize(),
    ) { Box(Modifier.padding(top = 8.dp)) { content() } }
}

@Composable
internal fun SectionTitle(text: String, trailing: String? = null, onTrailing: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        if (trailing != null) {
            val palette = LocalOnePalette.current
            Text(
                trailing,
                if (onTrailing != null) Modifier.clickable(onClick = onTrailing) else Modifier,
                style = MaterialTheme.typography.labelMedium,
                color = if (palette.dark) palette.onAccentSoft else palette.accent,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

internal fun prettify(code: String): String =
    code.lowercase().replace('_', ' ').replaceFirstChar { it.uppercase() }

private val whenFormat = DateTimeFormatter.ofPattern("d MMM yyyy, h:mm a")

/**
 * Render a server timestamp for a person.
 *
 * `Instant.parse` only accepts the strict ISO instant form, and not every route hands
 * that back: the institution assessment list returns the column as Postgres prints it,
 * `2026-08-25 13:13:05.569371+00`, with a space instead of the `T` and a two-digit
 * offset. That threw, the old fallback returned the input unchanged, and a placement
 * officer read a raw database timestamp with microseconds on it.
 *
 * The shapes are normalised here rather than in one caller, because any route can send
 * either and a screen should never be the thing that decides whether a date is legible.
 */
internal fun formatWhen(iso: String): String {
    if (iso.isBlank()) return iso
    val normalised = iso.trim()
        .replaceFirst(' ', 'T')
        // "+00" and "+0530" are valid Postgres output and invalid ISO offsets.
        .replace(Regex("([+-])(\\d{2})$"), "$1$2:00")
        .replace(Regex("([+-])(\\d{2})(\\d{2})$"), "$1$2:$3")
    return runCatching { whenFormat.withZone(ZoneId.systemDefault()).format(Instant.parse(normalised)) }
        .recoverCatching { whenFormat.format(OffsetDateTime.parse(normalised).atZoneSameInstant(ZoneId.systemDefault())) }
        // No offset at all: read it as local time rather than inventing a zone.
        .recoverCatching { whenFormat.format(LocalDateTime.parse(normalised).atZone(ZoneId.systemDefault())) }
        .getOrDefault(iso)
}

@Composable
internal fun LoadingSpinner() {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
internal fun CenteredNote(text: String) {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
    }
}

@Composable
internal fun IconBubble(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tone: Tone,
    size: Dp = 38.dp,
) {
    val (bg, fg) = LocalOnePalette.current.soft(tone)
    Box(Modifier.size(size).background(bg, CircleShape), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(size / 2))
    }
}

// --- Loading skeletons & empty states ------------------------------------------

@Composable
internal fun ShimmerBox(modifier: Modifier, corner: Dp = 12.dp) {
    val transition = rememberInfiniteTransition(label = "shimmer")
    val progress by transition.animateFloat(
        initialValue = -1f, targetValue = 2f,
        animationSpec = infiniteRepeatable(animation = tween(1100, easing = LinearEasing)),
        label = "shimmer-x",
    )
    val palette = LocalOnePalette.current
    val base = if (palette.dark) Color(0x14FFFFFF) else Color(0xFFE9EDF3)
    val glint = if (palette.dark) Color(0x28FFFFFF) else Color(0xFFF8FAFC)
    Box(
        modifier
            .clip(RoundedCornerShape(corner))
            .drawBehind {
                drawRect(base)
                val width = size.width
                drawRect(
                    brush = androidx.compose.ui.graphics.Brush.linearGradient(
                        colors = listOf(base, glint, base),
                        start = androidx.compose.ui.geometry.Offset(width * progress, 0f),
                        end = androidx.compose.ui.geometry.Offset(width * (progress + 1f), 0f),
                    ),
                )
            },
    )
}

@Composable
internal fun HomeSkeleton() {
    Column(Modifier.fillMaxSize().padding(18.dp)) {
        ShimmerBox(Modifier.fillMaxWidth().height(120.dp), corner = 18.dp)
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ShimmerBox(Modifier.weight(1f).height(78.dp))
            ShimmerBox(Modifier.weight(1f).height(78.dp))
            ShimmerBox(Modifier.weight(1f).height(78.dp))
            ShimmerBox(Modifier.weight(1f).height(78.dp))
        }
        Spacer(Modifier.height(14.dp))
        ShimmerBox(Modifier.fillMaxWidth().height(84.dp))
        Spacer(Modifier.height(14.dp))
        ShimmerBox(Modifier.fillMaxWidth(0.4f).height(18.dp), corner = 6.dp)
        Spacer(Modifier.height(10.dp))
        ShimmerBox(Modifier.fillMaxWidth().height(170.dp))
    }
}

@Composable
internal fun EmptyState(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tone: Tone,
    title: String,
    body: String,
) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        IconBubble(icon, tone, size = 64.dp)
        Spacer(Modifier.padding(top = 14.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        Spacer(Modifier.padding(top = 4.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

/** Entrance animation for full-screen overlay pages (slide in from the right). */
@Composable
internal fun SlideIn(content: @Composable () -> Unit) {
    val state = androidx.compose.runtime.remember {
        androidx.compose.animation.core.MutableTransitionState(false).apply { targetState = true }
    }
    androidx.compose.animation.AnimatedVisibility(
        visibleState = state,
        enter = androidx.compose.animation.slideInHorizontally(
            animationSpec = tween(240),
            initialOffsetX = { it / 3 },
        ) + androidx.compose.animation.fadeIn(tween(200)),
        exit = androidx.compose.animation.fadeOut(),
    ) { content() }
}
