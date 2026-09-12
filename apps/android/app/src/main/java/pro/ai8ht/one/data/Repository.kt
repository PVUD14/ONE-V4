package pro.ai8ht.one.data

import android.content.Context
import pro.ai8ht.one.Api

/**
 * One place that knows how to fetch, cache and refresh.
 *
 * The pattern is cache-then-network: hand back whatever was stored so the screen paints
 * immediately, then fetch and hand back the fresh answer. A screen therefore has three
 * honest states rather than two — *nothing yet*, *this is what we had*, and *this is
 * current* — and a student on a bad connection sees their data instead of a spinner.
 *
 * A failed refresh is not an error when there is cached content. It is stale data, which
 * is what the `stale` flag on [Loaded] says, and the screen can decide whether that
 * matters. A failed refresh with nothing cached is a real failure and is reported as one.
 */
class Repository(private val context: Context, private val store: Store) {

    sealed interface State<out T> {
        /** Nothing cached and the first fetch has not answered yet. */
        data object Loading : State<Nothing>

        data class Loaded<T>(val value: T, val stale: Boolean) : State<T>

        /** Nothing cached and the fetch failed. The only state worth an error screen. */
        data class Failed(val message: String) : State<Nothing>
    }

    /**
     * Fetch with a cache behind it.
     *
     * @param key cache identity, normally the API path.
     * @param decode parses a stored or fetched body. Kept out of the cache so a DTO can
     *   gain a field without invalidating everything already written.
     * @param emit called once with cached content when there is any, and again with the
     *   fresh result. Callers that only want the final answer can ignore the first.
     */
    suspend fun <T> load(
        key: String,
        decode: (String) -> T,
        fetch: suspend () -> String,
        emit: (State<T>) -> Unit,
    ) {
        val cached = store.read(key)
        if (cached != null) {
            // A cache that no longer parses is a cache from an older build. Drop it
            // rather than showing an error for data we can simply fetch again.
            runCatching { decode(cached) }
                .onSuccess { emit(State.Loaded(it, stale = true)) }
                .onFailure { store.write(key, "") }
        } else {
            emit(State.Loading)
        }

        runCatching { fetch() }
            .onSuccess { body ->
                runCatching { decode(body) }
                    .onSuccess {
                        store.write(key, body)
                        emit(State.Loaded(it, stale = false))
                    }
                    .onFailure { emit(failure(cached, "We could not read that just now.")) }
            }
            .onFailure { cause ->
                val message = (cause as? Api.ApiException)?.detail ?: "You appear to be offline."
                // Only a failure when there was nothing to show. With cached content the
                // screen keeps what it had and is told it is stale.
                if (cached == null) emit(State.Failed(message))
            }
    }

    private fun <T> failure(cached: String?, message: String): State<T> =
        if (cached == null) State.Failed(message) else State.Failed(message)

    suspend fun clearCache() = store.clear()

    companion object {
        @Volatile
        private var instance: Repository? = null

        /**
         * Manual singleton rather than a DI framework.
         *
         * At this size Hilt would be more ceremony than it removes — one graph, one
         * scope, no test doubles yet. If the app grows a second data source or needs
         * per-screen scoping, this is the seam to replace.
         */
        fun get(context: Context): Repository =
            instance ?: synchronized(this) {
                instance ?: Repository(context.applicationContext, Store(context.applicationContext))
                    .also { instance = it }
            }
    }
}
