package pro.ai8ht.one.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import pro.ai8ht.one.R

/**
 * The standard AI8HT wordmark — the same three alpha-keyed slices the web app
 * uses, tinted to ink on light surfaces and left silver-bright on dark, with
 * the 8 optionally spinning in place on its vertical axis exactly as it does
 * on the web (5.5s per revolution).
 */
@Composable
fun BrandWordmark(height: Dp, spinEight: Boolean = false, untinted: Boolean = false, modifier: Modifier = Modifier) {
    val dark = isSystemInDarkTheme()
    val tint = if (dark || untinted) null else ColorFilter.tint(MaterialTheme.colorScheme.onBackground)
    val rotation: Float = if (spinEight) {
        val transition = rememberInfiniteTransition(label = "brand-eight")
        val value by transition.animateFloat(
            initialValue = 0f,
            targetValue = 360f,
            animationSpec = infiniteRepeatable(animation = tween(5500, easing = LinearEasing)),
            label = "brand-eight-rotation",
        )
        value
    } else 0f

    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        Image(
            painter = painterResource(R.drawable.ai8ht_left),
            contentDescription = "AI",
            modifier = Modifier.height(height),
            contentScale = ContentScale.FillHeight,
            colorFilter = tint,
        )
        Image(
            painter = painterResource(R.drawable.ai8ht_eight),
            contentDescription = "8",
            modifier = Modifier
                .height(height)
                .graphicsLayer {
                    rotationY = rotation
                    cameraDistance = 12f * density
                },
            contentScale = ContentScale.FillHeight,
            colorFilter = tint,
        )
        Image(
            painter = painterResource(R.drawable.ai8ht_right),
            contentDescription = "HT",
            modifier = Modifier.height(height),
            contentScale = ContentScale.FillHeight,
            colorFilter = tint,
        )
    }
}
