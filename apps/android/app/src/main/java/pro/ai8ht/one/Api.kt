package pro.ai8ht.one

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.UUID

/**
 * The ONE API client. Same contracts the web app uses (/api/v1, Bearer JWT,
 * X-Correlation-Id) — the server treats both clients identically.
 */
object Api {
    private val http = OkHttpClient()
    private val json = Json { ignoreUnknownKeys = true }
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    fun baseUrl(context: Context): String =
        Session.apiOverride(context).ifBlank { BuildConfig.API_BASE_URL }

    class ApiException(val status: Int, val code: String?) :
        Exception("API request failed ($status${code?.let { ", $it" } ?: ""})")

    private suspend fun request(context: Context, method: String, path: String, body: String? = null): String =
        withContext(Dispatchers.IO) {
            val token = Session.token(context) ?: throw ApiException(401, "NO_TOKEN")
            val builder = Request.Builder()
                .url(baseUrl(context) + path)
                .header("Authorization", "Bearer $token")
                .header("Accept", "application/json")
                .header("X-Correlation-Id", "and-" + UUID.randomUUID())
                .header("X-Client", "one-android/" + BuildConfig.VERSION_NAME)
            when (method) {
                "GET" -> builder.get()
                "POST" -> builder.post((body ?: "{}").toRequestBody(jsonMedia))
            }
            http.newCall(builder.build()).execute().use { response ->
                val text = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    val code = runCatching {
                        json.decodeFromString<ErrorEnvelope>(text).error?.code
                    }.getOrNull()
                    throw ApiException(response.code, code)
                }
                text
            }
        }

    suspend fun listAssessments(context: Context): List<AssessmentDto> =
        json.decodeFromString<AssessmentsEnvelope>(request(context, "GET", "/api/v1/student/assessments")).assessments

    suspend fun listNotifications(context: Context): NotificationsEnvelope =
        json.decodeFromString(request(context, "GET", "/api/v1/me/notifications"))

    suspend fun markAllRead(context: Context) {
        request(context, "POST", "/api/v1/me/notifications/read-all")
    }

    suspend fun consentStatus(context: Context): ConsentStatusDto =
        json.decodeFromString(request(context, "GET", "/api/v1/me/consents/privacy-notice"))

    suspend fun grantConsent(context: Context, version: String) {
        request(context, "POST", "/api/v1/me/consents/privacy-notice", "{\"version\":\"$version\"}")
    }

    suspend fun registerDevice(context: Context, fcmToken: String) {
        request(context, "POST", "/api/v1/me/devices", "{\"platform\":\"ANDROID\",\"token\":\"$fcmToken\"}")
    }
}

@Serializable data class ErrorEnvelope(val error: ErrorBody? = null)
@Serializable data class ErrorBody(val code: String? = null)

@Serializable data class AssessmentsEnvelope(val assessments: List<AssessmentDto> = emptyList())
@Serializable data class AssessmentDto(
    val id: String,
    val title: String,
    val subjectName: String? = null,
    val institutionName: String? = null,
    val totalMarks: Double = 0.0,
    val durationSeconds: Int = 0,
    val startsAt: String,
    val endsAt: String,
    val attemptsAllowed: Int = 1,
    val attemptsUsed: Int = 0,
    val openAttemptId: String? = null,
    val latestResult: ResultDto? = null,
)
@Serializable data class ResultDto(val score: Double = 0.0, val maxScore: Double = 0.0, val percentage: Double = 0.0)

@Serializable data class NotificationsEnvelope(
    val notifications: List<NotificationDto> = emptyList(),
    val unreadCount: Int = 0,
)
@Serializable data class NotificationDto(
    val id: String,
    val kind: String,
    val title: String,
    val body: String,
    val createdAt: String,
    val readAt: String? = null,
)

@Serializable data class ConsentStatusDto(
    val requiredVersion: String? = null,
    val grantedVersion: String? = null,
    val required: Boolean = false,
)
