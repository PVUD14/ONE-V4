package pro.ai8ht.one.ui

import android.app.Activity
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

// Kept for legacy references.
val OneBlue = Color(0xFF1F55E5)
val OneBlueDeep = Color(0xFF0A2B68)
val OneInk = Color(0xFF101828)
val OneMuted = Color(0xFF667085)
val OneCanvas = Color(0xFFF6F8FB)
val OneLine = Color(0xFFE4E7EC)

/**
 * Applies the selected palette: Material color scheme, Inter typography, the
 * LocalOnePalette used by all custom components, and the status bar treatment
 * matching the band at the top of every screen.
 */
@Composable
fun OneTheme(paletteId: String, content: @Composable () -> Unit) {
    val palette = paletteById(paletteId)
    val scheme = if (palette.dark) {
        darkColorScheme(
            primary = palette.accent, onPrimary = palette.onAccent,
            primaryContainer = palette.accentSoft, onPrimaryContainer = palette.onAccentSoft,
            background = palette.sheet, onBackground = palette.ink,
            surface = palette.card, onSurface = palette.ink,
            surfaceVariant = palette.accentSoft, onSurfaceVariant = palette.muted,
            outline = palette.outline,
            error = Color(0xFFF87171),
        )
    } else {
        lightColorScheme(
            primary = palette.accent, onPrimary = palette.onAccent,
            primaryContainer = palette.accentSoft, onPrimaryContainer = palette.onAccentSoft,
            background = palette.sheet, onBackground = palette.ink,
            surface = palette.card, onSurface = palette.ink,
            surfaceVariant = Color(0xFFEDF0F5), onSurfaceVariant = palette.muted,
            outline = palette.outline,
            error = Color(0xFFB42318),
        )
    }

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = palette.bandTop.toArgb()
            window.navigationBarColor = palette.navBg.toArgb()
            val controller = WindowCompat.getInsetsController(window, view)
            // Light band (Lumina) needs dark status icons; dark/vivid bands need light ones.
            controller.isAppearanceLightStatusBars = !palette.dark && palette.bandTop == Color(0xFFFFFFFF)
            controller.isAppearanceLightNavigationBars = !palette.dark
        }
    }

    CompositionLocalProvider(LocalOnePalette provides palette) {
        MaterialTheme(colorScheme = scheme, typography = oneTypography(), content = content)
    }
}
