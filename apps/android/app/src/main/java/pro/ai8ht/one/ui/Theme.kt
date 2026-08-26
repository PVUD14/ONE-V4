package pro.ai8ht.one.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The pilot design language, translated: white surfaces, ONE blue accent,
// calm neutrals. Dark scheme mirrors the brand's silver-on-black wordmark.
val OneBlue = Color(0xFF1F55E5)
val OneBlueDeep = Color(0xFF0A2B68)
val OneInk = Color(0xFF101828)
val OneMuted = Color(0xFF667085)
val OneCanvas = Color(0xFFF6F8FB)
val OneLine = Color(0xFFE4E7EC)

private val LightScheme = lightColorScheme(
    primary = OneBlue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEEF4FF),
    onPrimaryContainer = OneBlueDeep,
    background = OneCanvas,
    onBackground = OneInk,
    surface = Color.White,
    onSurface = OneInk,
    surfaceVariant = OneCanvas,
    onSurfaceVariant = OneMuted,
    outline = OneLine,
)

private val DarkScheme = darkColorScheme(
    primary = Color(0xFF8FB0FF),
    onPrimary = Color(0xFF0A1A3D),
    background = Color(0xFF0B0C0F),
    onBackground = Color(0xFFD9DCE1),
    surface = Color(0xFF14161B),
    onSurface = Color(0xFFD9DCE1),
    surfaceVariant = Color(0xFF1B1E24),
    onSurfaceVariant = Color(0xFF8E939C),
    outline = Color(0xFF2A2E36),
)

@Composable
fun OneTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkScheme else LightScheme,
        typography = oneTypography(),
        content = content,
    )
}
