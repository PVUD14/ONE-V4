package pro.ai8ht.one

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * Three honest outcomes for a screen that loads something.
 *
 * The pages built before this existed all used `runCatching { ... }.getOrNull()` and then
 * branched on null or on an empty list, which quietly merged two different situations
 * into one. A screen would either spin forever because a failed request left its state
 * null, or — worse — state a reason it had no way to know: Career target answered a
 * failed request with "The career catalogue has not been published for your institution
 * yet." That is invented data in the only place it really matters, an explanation of
 * why something is missing, and a student would act on it by waiting for their college.
 *
 * The `Repository` used by the main tabs already draws this distinction. This is the
 * same idea for the overlay pages, which hold their own state and do not go through it.
 */
internal sealed interface Load<out T> {
    data object Loading : Load<Nothing>

    data class Ready<T>(val value: T) : Load<T>

    /**
     * The request failed. [message] is already safe to show a user; [reference] is the
     * request's correlation id, shown only as a short support code.
     */
    data class Failed(val message: String, val reference: String? = null) : Load<Nothing>
}

/**
 * Run [block] and capture failure instead of discarding it.
 *
 * [Api.ApiException] carries a message the server wrote for an end user, so it is shown
 * as-is; anything else is a transport problem and gets the offline wording, because the
 * exception text for those is a stack-trace-shaped string no user should read.
 */
internal suspend fun <T> loadOf(block: suspend () -> T): Load<T> =
    runCatching { block() }.fold(
        onSuccess = { Load.Ready(it) },
        onFailure = { cause ->
            val failure = cause as? Api.ApiException
            Load.Failed(
                failure?.detail
                    // A 404 is worth its own wording. The app ships ahead of the server
                    // often enough that "check your connection" would send a student
                    // chasing a problem that is not theirs.
                    ?: if (failure?.status == 404) "This is not available on ONE yet."
                    else "We could not reach ONE. Check your connection and try again.",
                failure?.correlationId,
            )
        },
    )

/** What a screen shows when its data could not be loaded at all. */
@Composable
internal fun FailedState(message: String, reference: String? = null, onRetry: (() -> Unit)? = null) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            "We could not load this",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        SupportCode(reference)
        if (onRetry != null) {
            Spacer(Modifier.height(16.dp))
            Button(onClick = onRetry) { Text("Try again") }
        }
    }
}
