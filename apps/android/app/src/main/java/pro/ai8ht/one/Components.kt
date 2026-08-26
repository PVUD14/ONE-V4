package pro.ai8ht.one

import androidx.compose.animation.core.animateFloat
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.getValue
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Shared pilot-design building blocks used across all app screens. */

internal enum class ChipKind { Positive, Accent, Waiting, Muted, OnDark }

@Composable
internal fun StatusChip(text: String, kind: ChipKind) {
    val dark = isSystemInDarkTheme()
    val (bg, fg) = when (kind) {
        ChipKind.Positive -> if (dark) Color(0xFF16281D) to Color(0xFF7FD1A0) else Color(0xFFEAF4EE) to Color(0xFF2E6B46)
        ChipKind.Accent -> if (dark) Color(0xFF15203A) to Color(0xFF8FB0FF) else Color(0xFFEEF4FF) to Color(0xFF1F55E5)
        ChipKind.Waiting -> if (dark) Color(0xFF2A2310) to Color(0xFFE3CF8E) else Color(0xFFFDF6E0) to Color(0xFF8A6400)
        ChipKind.Muted -> if (dark) Color(0xFF1B1E24) to Color(0xFF8E939C) else Color(0xFFF2F4F7) to Color(0xFF667085)
        ChipKind.OnDark -> Color(0x33FFFFFF) to Color.White
    }
    Surface(color = bg, contentColor = fg, shape = RoundedCornerShape(999.dp)) {
        Text(text, Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
internal fun PilotCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 3.dp),
    ) { content() }
}

/** The brand band: black-to-navy gradient carrying silver content; every screen
 *  opens with one, continuing the splash identity. */
@Composable
internal fun BrandBand(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(
                androidx.compose.ui.graphics.Brush.verticalGradient(
                    listOf(Color(0xFF0B0C0F), Color(0xFF152238)),
                ),
            )
            .statusBarsPadding()
            .padding(start = 20.dp, end = 12.dp, top = 6.dp, bottom = 22.dp),
        content = content,
    )
}

/** Light rounded sheet that overlaps the band above it. */
@Composable
internal fun BandSheet(content: @Composable () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.background,
        shape = RoundedCornerShape(topStart = 26.dp, topEnd = 26.dp),
        modifier = Modifier.fillMaxSize(),
    ) { Box(Modifier.padding(top = 8.dp)) { content() } }
}

internal val Silver = Color(0xFFD9DCE1)
internal val SilverMuted = Color(0xFF9AA2AF)

@Composable
internal fun SectionTitle(text: String) {
    Text(text, Modifier.padding(top = 20.dp, bottom = 8.dp),
        style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
}

internal fun prettify(code: String): String =
    code.lowercase().replace('_', ' ').replaceFirstChar { it.uppercase() }

internal fun formatWhen(iso: String): String = runCatching {
    DateTimeFormatter.ofPattern("d MMM, h:mm a").withZone(ZoneId.systemDefault()).format(Instant.parse(iso))
}.getOrDefault(iso)

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
    bg: Color,
    fg: Color,
    size: androidx.compose.ui.unit.Dp = 38.dp,
) {
    Box(Modifier.size(size).background(bg, CircleShape), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(size / 2))
    }
}

// --- Loading skeletons & empty states ------------------------------------------

@Composable
internal fun ShimmerBox(modifier: Modifier, corner: androidx.compose.ui.unit.Dp = 12.dp) {
    val transition = androidx.compose.animation.core.rememberInfiniteTransition(label = "shimmer")
    val progress by transition.animateFloat(
        initialValue = -1f, targetValue = 2f,
        animationSpec = androidx.compose.animation.core.infiniteRepeatable(
            animation = androidx.compose.animation.core.tween(1100, easing = androidx.compose.animation.core.LinearEasing),
        ),
        label = "shimmer-x",
    )
    val base = MaterialTheme.colorScheme.surfaceVariant
    val glint = MaterialTheme.colorScheme.surface
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

/** Home-shaped loading placeholder: hero, stat grid, list block. */
@Composable
internal fun HomeSkeleton() {
    Column(Modifier.fillMaxSize().padding(18.dp)) {
        ShimmerBox(Modifier.fillMaxWidth().height(150.dp), corner = 18.dp)
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ShimmerBox(Modifier.weight(1f).height(72.dp))
            ShimmerBox(Modifier.weight(1f).height(72.dp))
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ShimmerBox(Modifier.weight(1f).height(72.dp))
            ShimmerBox(Modifier.weight(1f).height(72.dp))
        }
        Spacer(Modifier.height(20.dp))
        ShimmerBox(Modifier.fillMaxWidth(0.4f).height(20.dp), corner = 6.dp)
        Spacer(Modifier.height(10.dp))
        ShimmerBox(Modifier.fillMaxWidth().height(190.dp))
    }
}

/** Friendly empty state: icon bubble, title, body, all centered. */
@Composable
internal fun EmptyState(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    iconBg: Color,
    iconFg: Color,
    title: String,
    body: String,
) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        IconBubble(icon, iconBg, iconFg, size = 64.dp)
        Spacer(Modifier.padding(top = 14.dp))
        Text(title, style = MaterialTheme.typography.titleMedium,
            fontWeight = androidx.compose.ui.text.font.FontWeight.Bold, textAlign = TextAlign.Center)
        Spacer(Modifier.padding(top = 4.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
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
            animationSpec = androidx.compose.animation.core.tween(240),
            initialOffsetX = { it / 3 },
        ) + androidx.compose.animation.fadeIn(androidx.compose.animation.core.tween(200)),
        exit = androidx.compose.animation.fadeOut(),
    ) { content() }
}
