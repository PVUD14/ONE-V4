package pro.ai8ht.one.ui

import androidx.compose.material3.Typography
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import pro.ai8ht.one.R

/** Inter — the same face the web app uses, so both clients read as one product. */
val InterFamily = FontFamily(
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
    Font(R.font.inter_bold, FontWeight.Bold),
)

/**
 * Noto Sans Telugu (SIL Open Font License 1.1; licence text in apps/web/public/fonts/NotoSansTelugu-OFL.txt)
 * for lesson text in Telugu (ENG-16). Inter has no Telugu glyphs; the system fallback usually has
 * them, but a lesson a student chose to read in Telugu should never depend on the handset.
 */
val TeluguFamily = FontFamily(
    Font(R.font.noto_sans_telugu_regular, FontWeight.Normal),
    Font(R.font.noto_sans_telugu_bold, FontWeight.Bold),
)

/** The font for lesson text in [language]; null keeps the theme's Inter. */
fun lessonFontFamily(language: String?): FontFamily? = if (language == "te") TeluguFamily else null

/** Material3 defaults with Inter applied across every role. */
fun oneTypography(): Typography {
    val base = Typography()
    fun apply(style: androidx.compose.ui.text.TextStyle) = style.copy(fontFamily = InterFamily)
    return Typography(
        displayLarge = apply(base.displayLarge),
        displayMedium = apply(base.displayMedium),
        displaySmall = apply(base.displaySmall),
        headlineLarge = apply(base.headlineLarge),
        headlineMedium = apply(base.headlineMedium),
        headlineSmall = apply(base.headlineSmall),
        titleLarge = apply(base.titleLarge),
        titleMedium = apply(base.titleMedium),
        titleSmall = apply(base.titleSmall),
        bodyLarge = apply(base.bodyLarge),
        bodyMedium = apply(base.bodyMedium),
        bodySmall = apply(base.bodySmall),
        labelLarge = apply(base.labelLarge),
        labelMedium = apply(base.labelMedium),
        labelSmall = apply(base.labelSmall),
    )
}
