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

    class ApiException(val status: Int, val code: String?, val detail: String? = null) :
        Exception(detail ?: "API request failed ($status${code?.let { ", $it" } ?: ""})")

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
                    val parsed = runCatching { json.decodeFromString<ErrorEnvelope>(text).error }.getOrNull()
                    throw ApiException(response.code, parsed?.code, parsed?.message)
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

    suspend fun studentMe(context: Context): StudentDto =
        json.decodeFromString<StudentEnvelope>(request(context, "GET", "/api/v1/students/me")).student

    suspend fun learnerState(context: Context): LearnerStateDto =
        json.decodeFromString(request(context, "GET", "/api/v1/career-readiness/me"))

    suspend fun completeLesson(context: Context, lessonVersionId: String) {
        request(context, "POST", "/api/v1/career-readiness/lessons/$lessonVersionId/complete")
    }
}

@Serializable data class ErrorEnvelope(val error: ErrorBody? = null)
@Serializable data class ErrorBody(val code: String? = null, val message: String? = null)

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

// --- Student identity ---------------------------------------------------------

@Serializable data class StudentEnvelope(val student: StudentDto)
@Serializable data class StudentDto(
    val userId: String,
    val fullName: String = "",
    val verifiedEmail: String? = null,
    val institutionStudentId: String = "",
    val academicStatus: String = "",
    val department: String? = null,
    val program: String? = null,
    val batch: String? = null,
)

// --- Career readiness / learning ---------------------------------------------

@Serializable data class LearnerStateDto(
    val catalog: CatalogDto = CatalogDto(),
    val progress: List<ProgressDto> = emptyList(),
    val readiness: ReadinessDto? = null,
    val roadmap: List<RoadmapDto> = emptyList(),
)
@Serializable data class CatalogDto(val modules: List<ModuleDto> = emptyList())
@Serializable data class ModuleDto(
    val id: String,
    val title: String = "",
    val description: String = "",
    val lessons: List<LessonDto> = emptyList(),
)
@Serializable data class LessonDto(
    val id: String,
    val title: String = "",
    val prerequisiteLessonIds: List<String> = emptyList(),
)
@Serializable data class ProgressDto(val lessonVersionId: String, val state: String = "")
@Serializable data class ReadinessDto(val band: String = "")
@Serializable data class RoadmapDto(
    val id: String,
    val actionCode: String = "",
    val reasonCode: String = "",
    val state: String = "",
)

