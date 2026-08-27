package pro.ai8ht.one.ui

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/** Semantic tones used by bubbles, chips and accents across every theme. */
enum class Tone { Accent, Green, Violet, Amber, Gray }

/**
 * One visual world. Every color the app paints comes from here, so the six
 * user-selectable themes stay coherent without per-screen special cases.
 */
data class OnePalette(
    val id: String,
    val displayName: String,
    val dark: Boolean,
    // The brand band at the top of every screen.
    val bandTop: Color,
    val bandBottom: Color,
    val bandInk: Color,
    val bandMuted: Color,
    /** Tint for the wordmark on the band; null = keep the silver slices as-is. */
    val wordmarkTint: Color?,
    // The content sheet under the band.
    val sheet: Color,
    val card: Color,
    val cardBorder: Color?,
    val ink: Color,
    val muted: Color,
    val outline: Color,
    // Accent pair (gradient ends) and its soft container.
    val accent: Color,
    val accentDeep: Color,
    val onAccent: Color,
    val accentSoft: Color,
    val onAccentSoft: Color,
    // Bottom navigation.
    val navBg: Color,
    val navSelected: Color,
) {
    val bandBrush: Brush get() = Brush.verticalGradient(listOf(bandTop, bandBottom))
    val accentBrush: Brush get() = Brush.linearGradient(listOf(accent, accentDeep))

    /** Soft bubble/chip colors (background to foreground) per semantic tone. */
    fun soft(tone: Tone): Pair<Color, Color> = if (dark) when (tone) {
        Tone.Accent -> accentSoft to onAccentSoft
        Tone.Green -> Color(0xFF16281D) to Color(0xFF7FD1A0)
        Tone.Violet -> Color(0xFF241639) to Color(0xFFC2A8FF)
        Tone.Amber -> Color(0xFF2A2310) to Color(0xFFE3CF8E)
        Tone.Gray -> Color(0x1FFFFFFF) to muted
    } else when (tone) {
        Tone.Accent -> accentSoft to onAccentSoft
        Tone.Green -> Color(0xFFEAF4EE) to Color(0xFF2E6B46)
        Tone.Violet -> Color(0xFFF3EEFF) to Color(0xFF6941C6)
        Tone.Amber -> Color(0xFFFDF6E0) to Color(0xFF8A6400)
        Tone.Gray -> Color(0xFFF2F4F7) to Color(0xFF667085)
    }
}

val NexusDark = OnePalette(
    id = "nexus", displayName = "Nexus Dark", dark = true,
    bandTop = Color(0xFF0B0C0F), bandBottom = Color(0xFF152238),
    bandInk = Color(0xFFE8EAEF), bandMuted = Color(0xFF8E939C), wordmarkTint = null,
    sheet = Color(0xFF0E1523), card = Color(0xFF141C2E), cardBorder = Color(0xFF223048),
    ink = Color(0xFFE8EAEF), muted = Color(0xFF8E939C), outline = Color(0xFF223048),
    accent = Color(0xFF4D7DFF), accentDeep = Color(0xFF1F55E5), onAccent = Color.White,
    accentSoft = Color(0xFF16233F), onAccentSoft = Color(0xFF8FB0FF),
    navBg = Color(0xFF0B101C), navSelected = Color(0xFF8FB0FF),
)

val AuroraViolet = OnePalette(
    id = "aurora", displayName = "Aurora Violet", dark = true,
    bandTop = Color(0xFF2A1058), bandBottom = Color(0xFF0B0714),
    bandInk = Color(0xFFEDE9F7), bandMuted = Color(0xFFB4A8CE), wordmarkTint = null,
    sheet = Color(0xFF120A24), card = Color(0xFF1A1030), cardBorder = Color(0xFF33205C),
    ink = Color(0xFFEDE9F7), muted = Color(0xFF9C90B8), outline = Color(0xFF33205C),
    accent = Color(0xFFA855F7), accentDeep = Color(0xFFD946EF), onAccent = Color.White,
    accentSoft = Color(0xFF2A1848), onAccentSoft = Color(0xFFD3B6FF),
    navBg = Color(0xFF0E081C), navSelected = Color(0xFFD3B6FF),
)

val LuminaLight = OnePalette(
    id = "lumina", displayName = "Lumina Light", dark = false,
    bandTop = Color(0xFFFFFFFF), bandBottom = Color(0xFFFFFFFF),
    bandInk = Color(0xFF0F172A), bandMuted = Color(0xFF64748B), wordmarkTint = Color(0xFF1A2233),
    sheet = Color(0xFFF6F8FB), card = Color(0xFFFFFFFF), cardBorder = null,
    ink = Color(0xFF0F172A), muted = Color(0xFF64748B), outline = Color(0xFFE7EBF0),
    accent = Color(0xFF1F55E5), accentDeep = Color(0xFF0A2B68), onAccent = Color.White,
    accentSoft = Color(0xFFEEF4FF), onAccentSoft = Color(0xFF1F55E5),
    navBg = Color(0xFFFFFFFF), navSelected = Color(0xFF1F55E5),
)

val SilverLux = OnePalette(
    id = "silver", displayName = "Silver Lux", dark = true,
    bandTop = Color(0xFF0B0B0D), bandBottom = Color(0xFF101013),
    bandInk = Color(0xFFDDDEE3), bandMuted = Color(0xFF8E8F98), wordmarkTint = null,
    sheet = Color(0xFF0E0E10), card = Color(0xFF131316), cardBorder = Color(0xFF26262C),
    ink = Color(0xFFDDDEE3), muted = Color(0xFF8E8F98), outline = Color(0xFF26262C),
    accent = Color(0xFFE8E8EC), accentDeep = Color(0xFFA9AAB3), onAccent = Color(0xFF0B0B0D),
    accentSoft = Color(0xFF1E1E24), onAccentSoft = Color(0xFFC9CAD1),
    navBg = Color(0xFF0E0E10), navSelected = Color(0xFFF2F2F5),
)

val SunsetEmber = OnePalette(
    id = "ember", displayName = "Sunset Ember", dark = true,
    bandTop = Color(0xFF14100A), bandBottom = Color(0xFF1D130A),
    bandInk = Color(0xFFF3EBE0), bandMuted = Color(0xFFB8A88E), wordmarkTint = null,
    sheet = Color(0xFF16110B), card = Color(0xFF1D1710), cardBorder = Color(0xFF3A2B14),
    ink = Color(0xFFF3EBE0), muted = Color(0xFFB8A88E), outline = Color(0xFF3A2B14),
    accent = Color(0xFFF59E0B), accentDeep = Color(0xFFF97316), onAccent = Color(0xFF1A1206),
    accentSoft = Color(0xFF2A2010), onAccentSoft = Color(0xFFFBD38D),
    navBg = Color(0xFF100B06), navSelected = Color(0xFFFBD38D),
)

val OceanGradient = OnePalette(
    id = "ocean", displayName = "Ocean Gradient", dark = false,
    bandTop = Color(0xFF1F55E5), bandBottom = Color(0xFF38BDF8),
    bandInk = Color(0xFFFFFFFF), bandMuted = Color(0xCCFFFFFF), wordmarkTint = null,
    sheet = Color(0xFFF2F7FF), card = Color(0xFFFFFFFF), cardBorder = null,
    ink = Color(0xFF0F172A), muted = Color(0xFF64748B), outline = Color(0xFFE3ECFB),
    accent = Color(0xFF1F55E5), accentDeep = Color(0xFF38BDF8), onAccent = Color.White,
    accentSoft = Color(0xFFEEF4FF), onAccentSoft = Color(0xFF1F55E5),
    navBg = Color(0xFFFFFFFF), navSelected = Color(0xFF1F55E5),
)

val AllPalettes: List<OnePalette> = listOf(NexusDark, AuroraViolet, LuminaLight, SilverLux, SunsetEmber, OceanGradient)

fun paletteById(id: String?): OnePalette = AllPalettes.firstOrNull { it.id == id } ?: NexusDark

val LocalOnePalette = staticCompositionLocalOf { NexusDark }
