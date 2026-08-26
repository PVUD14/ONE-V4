package pro.ai8ht.one

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) { content() }
}

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
