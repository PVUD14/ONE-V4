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
                "PATCH" -> builder.patch((body ?: "{}").toRequestBody(jsonMedia))
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

    suspend fun listOpportunities(context: Context): List<OpportunityDto> =
        json.decodeFromString<OpportunitiesEnvelope>(request(context, "GET", "/api/v1/opportunities")).opportunities

    suspend fun applyToOpportunity(context: Context, opportunityId: String) {
        request(context, "POST", "/api/v1/students/me/applications",
            "{\"opportunityId\":\"$opportunityId\",\"consentGranted\":true}")
    }

    suspend fun listApplications(context: Context): List<ApplicationDto> =
        json.decodeFromString<ApplicationsEnvelope>(request(context, "GET", "/api/v1/students/me/applications")).applications

    suspend fun getProfile(context: Context): ProfileDto =
        json.decodeFromString<ProfileEnvelope>(request(context, "GET", "/api/v1/students/me/profile")).profile

    suspend fun updateProfile(context: Context, bodyJson: String): ProfileDto =
        json.decodeFromString<ProfileEnvelope>(request(context, "PATCH", "/api/v1/students/me/profile", bodyJson)).profile

    suspend fun privacyRequests(context: Context): List<PrivacyRequestDto> =
        json.decodeFromString<PrivacyRequestsEnvelope>(request(context, "GET", "/api/v1/students/me/privacy/requests")).requests

    suspend fun requestDataExport(context: Context) {
        request(context, "POST", "/api/v1/students/me/privacy/exports")
    }

    suspend fun listDocuments(context: Context): List<DocumentDto> =
        json.decodeFromString<DocumentsEnvelope>(request(context, "GET", "/api/v1/students/me/documents")).documents

    /** Streams an assistant answer; onDelta receives each text chunk as it arrives. */
    suspend fun assistantChat(
        context: Context,
        messages: List<Pair<String, String>>,
        onDelta: (String) -> Unit,
    ): String = withContext(Dispatchers.IO) {
        val token = Session.token(context) ?: throw ApiException(401, "NO_TOKEN")
        val payload = buildString {
            append("{\"persona\":\"student\",\"messages\":[")
            messages.forEachIndexed { index, (role, content) ->
                if (index > 0) append(',')
                append("{\"role\":")
                append(json.encodeToString(kotlinx.serialization.serializer<String>(), role))
                append(",\"content\":")
                append(json.encodeToString(kotlinx.serialization.serializer<String>(), content))
                append('}')
            }
            append("]}")
        }
        val call = http.newCall(
            Request.Builder()
                .url(baseUrl(context) + "/api/v1/assistant/chat")
                .header("Authorization", "Bearer $token")
                .header("X-Correlation-Id", "and-" + UUID.randomUUID())
                .header("X-Client", "one-android/" + BuildConfig.VERSION_NAME)
                .post(payload.toRequestBody(jsonMedia))
                .build(),
        )
        call.execute().use { response ->
            if (!response.isSuccessful) {
                val text = response.body?.string() ?: ""
                val parsed = runCatching { json.decodeFromString<ErrorEnvelope>(text).error }.getOrNull()
                throw ApiException(response.code, parsed?.code, parsed?.message)
            }
            val source = response.body?.source() ?: return@use ""
            val full = StringBuilder()
            val buffer = okio.Buffer()
            while (true) {
                val read = source.read(buffer, 8192)
                if (read == -1L) break
                val chunk = buffer.readUtf8()
                if (chunk.isNotEmpty()) {
                    full.append(chunk)
                    onDelta(chunk)
                }
            }
            full.toString()
        }
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


// --- Hiring -------------------------------------------------------------------

@Serializable data class OpportunitiesEnvelope(val opportunities: List<OpportunityDto> = emptyList())
@Serializable data class OpportunityDto(
    val id: String,
    val employerName: String = "",
    val title: String = "",
    val summary: String? = null,
    val employmentType: String = "",
    val workMode: String = "",
    val locationCity: String? = null,
    val applicationDeadline: String? = null,
    val alreadyApplied: Boolean = false,
)
@Serializable data class ApplicationsEnvelope(val applications: List<ApplicationDto> = emptyList())
@Serializable data class ApplicationDto(
    val id: String,
    val state: String = "",
    val opportunityId: String = "",
    val employerName: String = "",
    val title: String = "",
    val employmentType: String = "",
    val workMode: String = "",
    val locationCity: String? = null,
    val submittedAt: String? = null,
)

// --- Profile ------------------------------------------------------------------

@Serializable data class ProfileEnvelope(val profile: ProfileDto)
@Serializable data class ProfileDto(
    val targetCareer: String? = null,
    val careerInterests: List<String> = emptyList(),
    val profileHeadline: String? = null,
    val profileSummary: String? = null,
    val portfolioUrl: String? = null,
    val visibilityState: String = "PRIVATE",
    val employerDiscoveryEnabled: Boolean = false,
)

// --- Privacy & documents ------------------------------------------------------

@Serializable data class PrivacyRequestsEnvelope(val requests: List<PrivacyRequestDto> = emptyList())
@Serializable data class PrivacyRequestDto(
    val id: String,
    val requestType: String = "",
    val state: String = "",
    val requestedAt: String = "",
    val completedAt: String? = null,
)
@Serializable data class DocumentsEnvelope(val documents: List<DocumentDto> = emptyList())
@Serializable data class DocumentDto(
    val id: String,
    val title: String = "",
    val documentType: String = "",
    val verificationState: String = "",
)
