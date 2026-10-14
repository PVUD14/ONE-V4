package pro.ai8ht.one.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * A small disk cache, so the app has something to show before the network answers.
 *
 * ONE's users are students on Indian mobile networks, where "connected" frequently means
 * a request that takes eight seconds or never resolves. Every screen previously
 * re-fetched from scratch on each visit and showed a spinner until it succeeded, which
 * made the app feel broken on exactly the connection most of its users have.
 *
 * Deliberately not a database. What is cached is the JSON the API already returned, so
 * there is one shape rather than a parallel schema to keep in step — and nothing to
 * migrate when a DTO gains a field.
 *
 * **Cleared on sign-out.** The cache holds a student's own record, so it lives for the
 * session and not beyond it; a shared phone must not show the previous user's data.
 */
class Store(context: Context) {
    private val directory = File(context.cacheDir, "one-api-cache").apply { mkdirs() }

    private fun fileFor(key: String): File = File(directory, key.hashCode().toString() + ".json")

    /** Cached body, or null when nothing has been stored for this key. */
    suspend fun read(key: String): String? = withContext(Dispatchers.IO) {
        val file = fileFor(key)
        if (file.exists()) runCatching { file.readText() }.getOrNull() else null
    }

    suspend fun write(key: String, body: String) {
        withContext(Dispatchers.IO) {
            // Best effort. A cache that fails to write is a slower app, not a broken one,
            // so a failure here must never surface to the caller.
            runCatching { fileFor(key).writeText(body) }
        }
    }

    /** How long ago this key was written, or null if it never was. */
    suspend fun ageMillis(key: String): Long? = withContext(Dispatchers.IO) {
        val file = fileFor(key)
        if (file.exists()) System.currentTimeMillis() - file.lastModified() else null
    }

    suspend fun clear() {
        withContext(Dispatchers.IO) {
            runCatching { directory.listFiles()?.forEach { it.delete() } }
        }
    }
}
