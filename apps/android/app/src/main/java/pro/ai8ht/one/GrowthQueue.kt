package pro.ai8ht.one

// The growth field-write queue (GROWTH-06; design §14.2, growth-field-work-table-design.md §5).
//
// Field visits happen where the network is poor. Every field write — a visit, call, meeting or
// note, a follow-up, closing one, a new lead — is written here first and then sent, so a write made
// with a signal and one made without take the same path. Each item carries a uuid that is its
// Idempotency-Key for life: the server records the key in the write's own transaction, so a resend
// after a timeout lands once and answers with what the first send produced.
//
// The queue is sent in capture order. A network failure or a server error (5xx) stops the run and
// keeps the item for the next try. A refusal (4xx: the lead was reassigned, became do-not-contact,
// the report is now more than 7 days old) is kept with the server's reason until the person
// dismisses it — nothing is dropped silently.
//
// Stored in the app's no-backup private storage, encrypted with AES-256-GCM under a key that lives
// in the Android Keystore and never leaves it. Bound to the person who queued it: a different
// person signing in on this phone finds it discarded unread. Sign-out clears it (after a warning).

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import java.io.File
import java.io.IOException
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Serializable
internal data class QueuedGrowthWrite(
    /** A uuid: the Idempotency-Key the server records, for every resend of this write. */
    val id: String,
    val kind: String,
    val method: String,
    val path: String,
    val body: String,
    /** What the person sees in the "Waiting to send" list, e.g. "Visit · Vidya College". */
    val label: String,
    val createdAtMillis: Long,
    val state: String = STATE_PENDING,
    val refusalCode: String? = null,
    val refusalMessage: String? = null,
    val attempts: Int = 0,
) {
    companion object {
        const val STATE_PENDING = "PENDING"
        const val STATE_REFUSED = "REFUSED"
    }
}

@Serializable
private data class GrowthQueueFile(val owner: String, val items: List<QueuedGrowthWrite> = emptyList())

/** What one run sent: the server's answer for every write that landed, and the refusals. */
internal data class GrowthFlushReport(
    val sent: Map<String, String>,
    val refused: Map<String, QueuedGrowthWrite>,
    val stoppedOffline: Boolean,
)

internal object GrowthQueue {
    private const val KEY_ALIAS = "one_growth_field_queue_v1"
    private const val FILE_NAME = "growth-field-queue.bin"
    private const val GCM_TAG_BITS = 128
    private val mutex = Mutex()
    private val _items = MutableStateFlow<List<QueuedGrowthWrite>>(emptyList())

    /** The queue as the screens show it: pending first, in order, then refused items. */
    val items: StateFlow<List<QueuedGrowthWrite>> = _items.asStateFlow()

    fun newId(): String = UUID.randomUUID().toString()

    private fun file(context: Context) = File(context.noBackupFilesDir, FILE_NAME)

    private fun keystoreKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keystoreKey())
        val iv = cipher.iv
        return byteArrayOf(iv.size.toByte()) + iv + cipher.doFinal(plain)
    }

    private fun decrypt(data: ByteArray): ByteArray {
        val ivLength = data[0].toInt()
        val iv = data.copyOfRange(1, 1 + ivLength)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
        return cipher.doFinal(data.copyOfRange(1 + ivLength, data.size))
    }

    private fun owner(context: Context): String = Session.email(context)?.lowercase() ?: ""

    /** Reads the queue. Another person's queue, or one that cannot be decrypted, is discarded unread. */
    private fun readLocked(context: Context): List<QueuedGrowthWrite> {
        val target = file(context)
        if (!target.exists()) return emptyList()
        val parsed = runCatching { Api.json.decodeFromString<GrowthQueueFile>(decrypt(target.readBytes()).decodeToString()) }.getOrNull()
        if (parsed == null || parsed.owner != owner(context) || parsed.owner.isEmpty()) {
            target.delete()
            return emptyList()
        }
        return parsed.items
    }

    private fun writeLocked(context: Context, items: List<QueuedGrowthWrite>) {
        val target = file(context)
        if (items.isEmpty()) {
            target.delete()
        } else {
            val bytes = encrypt(Api.json.encodeToString(GrowthQueueFile.serializer(), GrowthQueueFile(owner(context), items)).toByteArray())
            val temp = File(target.parentFile, "$FILE_NAME.tmp")
            temp.writeBytes(bytes)
            if (!temp.renameTo(target)) { target.delete(); temp.renameTo(target) }
        }
        _items.value = items
    }

    suspend fun load(context: Context) = withContext(Dispatchers.IO) {
        mutex.withLock { _items.value = readLocked(context) }
    }

    suspend fun enqueue(context: Context, item: QueuedGrowthWrite) = withContext(Dispatchers.IO) {
        mutex.withLock { writeLocked(context, readLocked(context) + item) }
    }

    suspend fun dismiss(context: Context, id: String) = withContext(Dispatchers.IO) {
        mutex.withLock { writeLocked(context, readLocked(context).filterNot { it.id == id }) }
    }

    /** Items not yet accepted by the server (pending or refused): what sign-out would lose. */
    fun unsentCount(): Int = _items.value.size

    /** Sign-out: the queue file is deleted. The Keystore key stays (it encrypts nothing any more). */
    suspend fun clear(context: Context) = withContext(Dispatchers.IO) {
        mutex.withLock {
            file(context).delete()
            File(context.noBackupFilesDir, "$FILE_NAME.tmp").delete()
            _items.value = emptyList()
        }
    }

    /**
     * Sends pending items in order. Stops at the first network failure or server error, so the
     * order holds; marks a refusal and carries on. One run at a time.
     */
    suspend fun flush(context: Context): GrowthFlushReport = withContext(Dispatchers.IO) {
        mutex.withLock {
            val sent = mutableMapOf<String, String>()
            val refused = mutableMapOf<String, QueuedGrowthWrite>()
            var offline = false
            var items = readLocked(context)
            for (item in items.filter { it.state == QueuedGrowthWrite.STATE_PENDING }) {
                val outcome = runCatching { Api.request(context, item.method, item.path, item.body, idempotencyKey = item.id) }
                val failure = outcome.exceptionOrNull()
                when {
                    failure == null -> {
                        sent[item.id] = outcome.getOrThrow()
                        items = items.filterNot { it.id == item.id }
                    }
                    failure is Api.ApiException && failure.status in 400..499 && failure.status != 401 && failure.status != 408 && failure.status != 429 -> {
                        val marked = item.copy(state = QueuedGrowthWrite.STATE_REFUSED, refusalCode = failure.code,
                            refusalMessage = growthRefusalText(failure.code), attempts = item.attempts + 1)
                        refused[item.id] = marked
                        items = items.map { if (it.id == item.id) marked else it }
                    }
                    else -> {
                        // Offline, timed out, signed-out token, or the server is having a bad moment:
                        // keep it at the head and try again later.
                        offline = failure is IOException || (failure is Api.ApiException && failure.status == 401)
                        items = items.map { if (it.id == item.id) it.copy(attempts = it.attempts + 1) else it }
                        break
                    }
                }
            }
            writeLocked(context, items)
            GrowthFlushReport(sent, refused, offline)
        }
    }
}

/** The words for a refusal the person may read later, out of context, on the "Not sent" list. */
internal fun growthRefusalText(code: String?): String = when (code) {
    "GROWTH_REPORT_TOO_OLD" -> "It was more than 7 days old when it reached the server, so it was not recorded."
    "GROWTH_REPORT_IN_FUTURE" -> "The phone's clock put it in the future. Check the phone's date and time."
    "GROWTH_LEAD_DO_NOT_CONTACT" -> "The organisation asked not to be contacted, so no work can be logged on it."
    "GROWTH_LEAD_CLOSED" -> "The lead was closed (lost or handed off) before this arrived."
    "GROWTH_NOT_LEAD_OWNER" -> "The lead is no longer yours (it was reassigned), so this was not recorded."
    "GROWTH_LEAD_NOT_FOUND" -> "You can no longer see this lead (it was reassigned or your region changed)."
    "GROWTH_FOLLOW_UP_ALREADY_CLOSED" -> "The follow-up was already closed."
    "GROWTH_FOLLOW_UP_NOT_FOUND" -> "The follow-up is no longer yours to close."
    "GROWTH_FOLLOW_UP_DUE_TOO_EARLY", "GROWTH_FOLLOW_UP_DUE_TOO_LATE", "GROWTH_FOLLOW_UP_DUE_OUT_OF_RANGE" ->
        "The due date was out of range (a week back to a year ahead) when it arrived."
    "GROWTH_LEAD_DUPLICATE" -> "Another team member already registered this organisation. Ask your manager."
    "GROWTH_ORGANIZATION_ALREADY_ON_ONE" -> "This employer is already on ONE."
    "GROWTH_TEAM_MISMATCH" -> "You are not on the team that works this kind of lead."
    "IDEMPOTENCY_KEY_REUSED" -> "This item changed after it was first sent, so it was not recorded twice."
    // GROWTH-04: stage moves and the handoff request.
    "GROWTH_STAGE_CHANGED" -> "The lead's stage changed before this arrived, so this move was not applied. Open the lead and choose again."
    "GROWTH_STAGE_REASON_REQUIRED" -> "This move needs a reason."
    "GROWTH_STAGE_IN_HANDOFF" -> "The lead is with operations for onboarding; its stage moves only when they decide."
    "GROWTH_HANDOFF_NEEDS_AGREEMENT" -> "Report the agreement signed before asking for the handoff."
    "GROWTH_CONTRACT_REFERENCE_INVALID" -> "The agreement reference was not in the expected form (letters, digits and / _ . : - only)."
    "GROWTH_HANDOFF_ALREADY_OPEN" -> "A handoff request for this lead is already open."
    else -> "The server did not accept it."
}
