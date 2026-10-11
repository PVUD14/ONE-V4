package pro.ai8ht.one.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import pro.ai8ht.one.R

/**
 * The ONE logo — the app's brand mark (Divakar's instruction, 2026-09-30). ONE is
 * the product and AI8HT the organisation, so the lockup reads "one by ai8ht" and
 * is announced as "ONE by AI8HT". The drawables are generated from the master art
 * by scripts/brand/make_brand_assets.py, the same source as the web app's assets.
 *
 * The art is brushed silver and blue, so it is chosen per surface rather than
 * tinted: [LogoSurface.Dark] is the original metal, [LogoSurface.Light] renders the
 * silver as graphite for white bands, and [LogoSurface.Mono] is a single-colour
 * silhouette (ring, dot and letters as ink, the o's recess left open) for
 * saturated bands (Ocean) where neither metal nor graphite reads.
 */
enum class LogoSurface { Dark, Light, Mono }

const val BRAND_NAME = "ONE by AI8HT"

@Composable
fun BrandLogo(
    height: Dp,
    surface: LogoSurface = LogoSurface.Dark,
    monoColor: Color = Color.White,
    modifier: Modifier = Modifier,
) {
    Image(
        painter = painterResource(
            when (surface) {
                LogoSurface.Dark -> R.drawable.one_logo_dark
                LogoSurface.Light -> R.drawable.one_logo_light
                LogoSurface.Mono -> R.drawable.one_logo_mono
            },
        ),
        contentDescription = BRAND_NAME,
        modifier = modifier.height(height),
        contentScale = ContentScale.FillHeight,
        colorFilter = if (surface == LogoSurface.Mono) ColorFilter.tint(monoColor) else null,
    )
}

/** The logo for a surface that follows the palette's light/dark content (cards, sheets). */
fun logoSurfaceFor(palette: OnePalette): LogoSurface = if (palette.dark) LogoSurface.Dark else LogoSurface.Light

/**
 * The "o" mark alone. With [pulse], the ring's blue centre dot breathes — a soft
 * glow screened over it — as the splash's loading cue, replacing the AI8HT
 * spinning 8.
 */
@Composable
fun BrandMark(size: Dp, pulse: Boolean = false, modifier: Modifier = Modifier) {
    val glow: Float = if (pulse) {
        val transition = rememberInfiniteTransition(label = "brand-dot")
        val value by transition.animateFloat(
            initialValue = 0.1f,
            targetValue = 0.7f,
            animationSpec = infiniteRepeatable(
                animation = tween(1400, easing = FastOutSlowInEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "brand-dot-glow",
        )
        value
    } else 0f

    Image(
        painter = painterResource(R.drawable.one_mark_dark),
        contentDescription = BRAND_NAME,
        modifier = modifier
            .size(size)
            .drawWithContent {
                drawContent()
                if (glow > 0f) {
                    // Dot centre and radius as fractions of the mark's square,
                    // measured from the asset script's geometry.
                    val centre = Offset(this.size.width * 0.489f, this.size.height * 0.527f)
                    val radius = this.size.minDimension * (0.13f + 0.08f * glow)
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(Color(0xFF4FA3FF).copy(alpha = glow), Color.Transparent),
                            center = centre,
                            radius = radius,
                        ),
                        radius = radius,
                        center = centre,
                        blendMode = BlendMode.Screen,
                    )
                }
            },
        contentScale = ContentScale.Fit,
    )
}
