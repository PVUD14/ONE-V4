/*
 * ONE · Support code
 *
 * When a request fails, ONE keeps its correlation id so support can find it in the logs.
 * A person should never be shown a raw UUID, so a failure shows the same short support code
 * the web app shows — the first eight letters and digits of the id, enough to find the
 * request — with a button to copy it.
 */
package pro.ai8ht.one

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import pro.ai8ht.one.ui.LocalOnePalette

private const val SUPPORT_CODE_LENGTH = 8
private val notAlphanumeric = Regex("[^A-Za-z0-9]")

/** The short code for a correlation id, or "" when there is none. */
internal fun supportCode(reference: String?): String =
    reference?.replace(notAlphanumeric, "")?.take(SUPPORT_CODE_LENGTH)?.lowercase().orEmpty()

/** " Support code: ab12cd34." for appending to a message; "" when there is no reference. */
internal fun supportCodeSuffix(reference: String?): String =
    supportCode(reference).let { if (it.isEmpty()) "" else " Support code: $it." }

/** Small muted "Support code: ab12cd34" with a copy action, for error and not-permitted states. */
@Composable
internal fun SupportCode(reference: String?) {
    val code = supportCode(reference)
    if (code.isEmpty()) return
    val clipboard = LocalClipboardManager.current
    val palette = LocalOnePalette.current
    var copied by remember(code) { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Support code: $code", style = MaterialTheme.typography.labelSmall, color = palette.muted)
        Spacer(Modifier.width(4.dp))
        TextButton(onClick = { clipboard.setText(AnnotatedString(code)); copied = true }) {
            Text(if (copied) "Copied" else "Copy support code", style = MaterialTheme.typography.labelSmall, color = if (palette.dark) palette.onAccentSoft else palette.accent)
        }
    }
}
