package pro.ai8ht.one

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
    internal val json = Json { ignoreUnknownKeys = true }
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    fun baseUrl(context: Context): String =
        Session.apiOverride(context).ifBlank { BuildConfig.API_BASE_URL }

    class ApiException(val status: Int, val code: String?, val detail: String? = null) :
        Exception(detail ?: "API request failed ($status${code?.let { ", $it" } ?: ""})")

    /**
     * @param idempotencyKey sent as Idempotency-Key where the route requires one. A retry
     *   over a dropped mobile connection must not be able to count as a second submission.
     */
    internal suspend fun request(
        context: Context,
        method: String,
        path: String,
        body: String? = null,
        idempotencyKey: String? = null,
    ): String =
        withContext(Dispatchers.IO) {
            val token = Session.token(context) ?: throw ApiException(401, "NO_TOKEN")
            val builder = Request.Builder()
                .url(baseUrl(context) + path)
                .header("Accept", "application/json")
                .header("X-Correlation-Id", "and-" + UUID.randomUUID())
                .header("X-Client", "one-android/" + BuildConfig.VERSION_NAME)
            if (idempotencyKey != null) builder.header("Idempotency-Key", idempotencyKey)
            when (method) {
                "GET" -> builder.get()
                "POST" -> builder.post((body ?: "{}").toRequestBody(jsonMedia))
                "PUT" -> builder.put((body ?: "{}").toRequestBody(jsonMedia))
                "PATCH" -> builder.patch((body ?: "{}").toRequestBody(jsonMedia))
                "DELETE" -> builder.delete()
            }
            fun run(tokenValue: String): Pair<Int, String> {
                val request = builder.header("Authorization", "Bearer " + tokenValue).build()
                http.newCall(request).execute().use { response ->
                    return response.code to (response.body?.string() ?: "")
                }
            }
            var (code, text) = run(token)
            if (code == 401) {
                // The access token lives one hour; a stored refresh token buys a
                // new one silently before we give up and sign the user out.
                val refreshed = refreshSession(context)
                if (refreshed != null) {
                    val retried = run(refreshed)
                    code = retried.first
                    text = retried.second
                }
            }
            if (code !in 200..299) {
                val parsed = runCatching { json.decodeFromString<ErrorEnvelope>(text).error }.getOrNull()
                throw ApiException(code, parsed?.code, parsed?.message)
            }
            text
        }

    /**
     * A binary response (a résumé PDF): the same headers, token refresh and error envelope as [request],
     * with the body kept as bytes.
     */
    internal suspend fun requestBytes(context: Context, path: String): ByteArray =
        withContext(Dispatchers.IO) {
            val token = Session.token(context) ?: throw ApiException(401, "NO_TOKEN")
            val builder = Request.Builder()
                .url(baseUrl(context) + path)
                .header("Accept", "application/pdf, application/json")
                .header("X-Correlation-Id", "and-" + UUID.randomUUID())
                .header("X-Client", "one-android/" + BuildConfig.VERSION_NAME)
                .get()
            fun run(tokenValue: String): Triple<Int, ByteArray, String> {
                val request = builder.header("Authorization", "Bearer " + tokenValue).build()
                http.newCall(request).execute().use { response ->
                    val bytes = response.body?.bytes() ?: ByteArray(0)
                    return Triple(response.code, bytes, if (response.isSuccessful) "" else bytes.toString(Charsets.UTF_8))
                }
            }
            var result = run(token)
            if (result.first == 401) refreshSession(context)?.let { result = run(it) }
            if (result.first !in 200..299) {
                val parsed = runCatching { json.decodeFromString<ErrorEnvelope>(result.third).error }.getOrNull()
                throw ApiException(result.first, parsed?.code, parsed?.message)
            }
            result.second
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

    /** ENG-16: choose the language lessons are shown in; the server accepts only an offered one. */
    suspend fun setLessonLanguage(context: Context, language: String): LessonLanguageDto =
        json.decodeFromString<LessonLanguageEnvelope>(
            request(context, "PUT", "/api/v1/career-readiness/me/lesson-language", "{\"language\":${quoted(language)}}"),
        ).lessonLanguage

    suspend fun completeLesson(context: Context, lessonVersionId: String) {
        request(context, "POST", "/api/v1/career-readiness/lessons/$lessonVersionId/complete")
    }

    suspend fun listOpportunities(context: Context): List<OpportunityDto> =
        json.decodeFromString<OpportunitiesEnvelope>(request(context, "GET", "/api/v1/opportunities")).opportunities

    suspend fun listApplications(context: Context): List<ApplicationDto> =
        json.decodeFromString<ApplicationsEnvelope>(request(context, "GET", "/api/v1/students/me/applications")).applications

    /** EMP-13: the same list, with whether sharing skill evidence is on at all. */
    suspend fun listApplicationsWithEvidence(context: Context): ApplicationsEnvelope =
        json.decodeFromString<ApplicationsEnvelope>(request(context, "GET", "/api/v1/students/me/applications"))

    /** Null when the employer shared nothing, or withdrew it between the list and this read. */
    suspend fun applicationFeedback(context: Context, applicationId: String): ApplicationFeedbackDto? =
        json.decodeFromString<ApplicationFeedbackEnvelope>(
            request(context, "GET", "/api/v1/students/me/applications/$applicationId/feedback")).feedback

    suspend fun listCalendar(context: Context): List<CalendarEntryDto> =
        json.decodeFromString<CalendarEnvelope>(request(context, "GET", "/api/v1/me/calendar")).entries

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

    suspend fun helpArticles(context: Context): List<HelpArticleDto> =
        json.decodeFromString<HelpEnvelope>(request(context, "GET", "/api/v1/help")).articles

    suspend fun studentActivity(context: Context): StudentActivityDto =
        json.decodeFromString(request(context, "GET", "/api/v1/student/activity"))

    suspend fun securityContext(context: Context): SecurityContextDto =
        json.decodeFromString(request(context, "GET", "/api/v1/security/context"))

    /**
     * GROWTH-01 (ADR-040): the signed-in growth person's own role, teams (with manager) and
     * staff type. The only facts the Growth home has until later growth goals are built.
     */
    suspend fun growthMe(context: Context): GrowthMeDto =
        json.decodeFromString(request(context, "GET", "/api/v1/growth/me"))

    /**
     * GROWTH-02: the regions the signed-in growth person works today, with their areas and people
     * (a manager sees everyone assigned; an executive sees the region's managers). Read-only.
     */
    suspend fun growthTerritory(context: Context): GrowthTerritoryDto =
        json.decodeFromString(request(context, "GET", "/api/v1/growth/territory"))

    // GROWTH-03: the lead register. The server decides scope and masking: contacts arrive in full
    // only on the person's own leads, so nothing else can be cached on the phone.
    suspend fun growthLeadVocabulary(context: Context): GrowthLeadVocabularyDto =
        json.decodeFromString(request(context, "GET", "/api/v1/growth/leads/vocabulary"))

    suspend fun growthLeads(context: Context, kind: String, view: String): GrowthLeadPageDto =
        json.decodeFromString(request(context, "GET", "/api/v1/growth/leads?kind=$kind&view=$view"))

    suspend fun growthLead(context: Context, leadId: String): GrowthLeadDetailDto =
        json.decodeFromString<GrowthLeadEnvelope>(request(context, "GET", "/api/v1/growth/leads/$leadId")).lead

    suspend fun createGrowthLead(
        context: Context, kind: String, name: String, stateCode: String?, city: String?, aisheCode: String?, websiteDomain: String?, source: String,
    ): GrowthLeadDetailDto {
        val body = kotlinx.serialization.json.buildJsonObject {
            put("kind", kotlinx.serialization.json.JsonPrimitive(kind))
            put("name", kotlinx.serialization.json.JsonPrimitive(name))
            put("stateCode", kotlinx.serialization.json.JsonPrimitive(stateCode))
            put("city", kotlinx.serialization.json.JsonPrimitive(city))
            put("aisheCode", kotlinx.serialization.json.JsonPrimitive(aisheCode))
            put("websiteDomain", kotlinx.serialization.json.JsonPrimitive(websiteDomain))
            put("source", kotlinx.serialization.json.JsonPrimitive(source))
        }.toString()
        return json.decodeFromString<GrowthLeadEnvelope>(request(context, "POST", "/api/v1/growth/leads", body)).lead
    }

    suspend fun claimGrowthLead(context: Context, leadId: String): GrowthLeadDetailDto =
        json.decodeFromString<GrowthLeadEnvelope>(request(context, "POST", "/api/v1/growth/leads/$leadId/claim")).lead

    suspend fun addGrowthContact(
        context: Context, leadId: String, role: String, fullName: String, email: String?, phone: String?,
        permissionBasis: String, source: String, noticeGiven: Boolean,
    ): GrowthLeadDetailDto {
        val body = kotlinx.serialization.json.buildJsonObject {
            put("role", kotlinx.serialization.json.JsonPrimitive(role))
            put("fullName", kotlinx.serialization.json.JsonPrimitive(fullName))
            put("email", kotlinx.serialization.json.JsonPrimitive(email))
            put("phone", kotlinx.serialization.json.JsonPrimitive(phone))
            put("permissionBasis", kotlinx.serialization.json.JsonPrimitive(permissionBasis))
            put("source", kotlinx.serialization.json.JsonPrimitive(source))
            put("noticeGiven", kotlinx.serialization.json.JsonPrimitive(noticeGiven))
        }.toString()
        return json.decodeFromString<GrowthLeadEnvelope>(request(context, "POST", "/api/v1/growth/leads/$leadId/contacts", body)).lead
    }

    suspend fun recordGrowthContactNotice(context: Context, leadId: String, contactId: String): GrowthLeadDetailDto =
        json.decodeFromString<GrowthLeadEnvelope>(request(context, "POST", "/api/v1/growth/leads/$leadId/contacts/$contactId/notice")).lead

    // GROWTH-06: field work. Reads return the raw body too, so the screens can keep a copy for
    // offline use; every write goes through GrowthQueue with an Idempotency-Key.
    suspend fun growthFieldRaw(context: Context, view: String): String = request(context, "GET", "/api/v1/growth/field?view=$view")

    suspend fun growthLeadFieldRaw(context: Context, leadId: String): String = request(context, "GET", "/api/v1/growth/leads/$leadId/field")

    suspend fun removeGrowthActivityLocation(context: Context, activityId: String): GrowthActivityDto =
        json.decodeFromString<GrowthActivityEnvelope>(request(context, "POST", "/api/v1/growth/activities/$activityId/remove-location")).activity

    internal fun growthActivityBody(kind: String, outcome: String?, contactId: String?, notes: String?, occurredAtIso: String, location: CoarseFix?): String =
        kotlinx.serialization.json.buildJsonObject {
            put("kind", kotlinx.serialization.json.JsonPrimitive(kind))
            if (outcome != null) put("outcome", kotlinx.serialization.json.JsonPrimitive(outcome))
            if (contactId != null) put("contactId", kotlinx.serialization.json.JsonPrimitive(contactId))
            if (notes != null) put("notes", kotlinx.serialization.json.JsonPrimitive(notes))
            put("occurredAt", kotlinx.serialization.json.JsonPrimitive(occurredAtIso))
            if (location != null) put("location", kotlinx.serialization.json.buildJsonObject {
                put("latitude", kotlinx.serialization.json.JsonPrimitive(location.latitude))
                put("longitude", kotlinx.serialization.json.JsonPrimitive(location.longitude))
                put("accuracyM", kotlinx.serialization.json.JsonPrimitive(location.accuracyM))
            })
        }.toString()

    // GROWTH-04: the college pipeline. Reads keep a saved copy; moves and the handoff go through GrowthQueue.
    suspend fun growthLeadPipelineRaw(context: Context, leadId: String): String = request(context, "GET", "/api/v1/growth/leads/$leadId/pipeline")

    // GROWTH-05: employer referral links. The list keeps a saved copy (sharing works offline); creating
    // and revoking need a signal, because the server generates the code.
    suspend fun growthReferralCodesRaw(context: Context): String = request(context, "GET", "/api/v1/growth/referral-codes")

    // GROWTH-07: what is credited to the person and the disputes they are party to (read-only on the phone).
    suspend fun growthAttributionsRaw(context: Context): String = request(context, "GET", "/api/v1/growth/attributions")

    suspend fun createGrowthReferralCode(context: Context, idempotencyKey: String): String =
        request(context, "POST", "/api/v1/growth/referral-codes", "{}", idempotencyKey)

    suspend fun revokeGrowthReferralCode(context: Context, codeId: String): String =
        request(context, "POST", "/api/v1/growth/referral-codes/$codeId/revoke", "{}")

    fun growthStageBody(fromStage: String, toStage: String, reasonCode: String?): String = kotlinx.serialization.json.buildJsonObject {
        put("fromStage", kotlinx.serialization.json.JsonPrimitive(fromStage))
        put("toStage", kotlinx.serialization.json.JsonPrimitive(toStage))
        if (reasonCode != null) put("reasonCode", kotlinx.serialization.json.JsonPrimitive(reasonCode))
    }.toString()

    fun growthHandoffBody(contractReference: String, contactIds: List<String>): String = kotlinx.serialization.json.buildJsonObject {
        put("contractReference", kotlinx.serialization.json.JsonPrimitive(contractReference))
        put("contactIds", kotlinx.serialization.json.JsonArray(contactIds.map { kotlinx.serialization.json.JsonPrimitive(it) }))
    }.toString()

    fun growthFollowUpBody(title: String, dueOn: String): String = kotlinx.serialization.json.buildJsonObject {
        put("title", kotlinx.serialization.json.JsonPrimitive(title))
        put("dueOn", kotlinx.serialization.json.JsonPrimitive(dueOn))
    }.toString()

    fun growthCancelBody(reasonCode: String): String = kotlinx.serialization.json.buildJsonObject {
        put("reasonCode", kotlinx.serialization.json.JsonPrimitive(reasonCode))
    }.toString()

    fun growthLeadBody(kind: String, name: String, city: String?, aisheCode: String?, websiteDomain: String?, source: String): String =
        kotlinx.serialization.json.buildJsonObject {
            put("kind", kotlinx.serialization.json.JsonPrimitive(kind))
            put("name", kotlinx.serialization.json.JsonPrimitive(name))
            put("city", kotlinx.serialization.json.JsonPrimitive(city))
            put("aisheCode", kotlinx.serialization.json.JsonPrimitive(aisheCode))
            put("websiteDomain", kotlinx.serialization.json.JsonPrimitive(websiteDomain))
            put("source", kotlinx.serialization.json.JsonPrimitive(source))
        }.toString()

    suspend fun listInstitutionExams(context: Context, institutionId: String): List<InstitutionExamDto> =
        json.decodeFromString<InstitutionExamsEnvelope>(
            request(context, "GET", "/api/v1/institutions/$institutionId/assessments"),
        ).assessments

    suspend fun listSubjects(context: Context, institutionId: String): List<SubjectDto> =
        json.decodeFromString<SubjectsEnvelope>(
            request(context, "GET", "/api/v1/institutions/$institutionId/assessment-subjects"),
        ).subjects

    suspend fun countQuestions(context: Context, institutionId: String, status: String): Int =
        json.decodeFromString<QuestionsEnvelope>(
            request(context, "GET", "/api/v1/institutions/$institutionId/assessment-questions?status=$status"),
        ).questions.size

    /**
     * Invitation activation counts for the institution's roster (INST-01). The same
     * server-computed summary the web Dashboard shows, so the phone and the web agree.
     */
    suspend fun institutionActivationSummary(context: Context, institutionId: String): Map<String, Int>? =
        json.decodeFromString<RosterActivationEnvelope>(
            request(context, "GET", "/api/v1/institutions/$institutionId/students"),
        ).activationSummary

    /**
     * Faculty "My Students" (INST-03): the students of the lecturer's active teaching
     * assignments, scoped by the server exactly as the web page is. A 403 means the caller
     * holds no faculty role in this institution.
     */
    /** INST-06: the caller's announcements (403 when the caller cannot send any). */
    suspend fun institutionAnnouncements(context: Context, institutionId: String): AnnouncementsEnvelope =
        json.decodeFromString(
            request(context, "GET", "/api/v1/institutions/$institutionId/announcements?limit=20"),
        )

    suspend fun myStudents(context: Context, institutionId: String): MyStudentsEnvelope =
        json.decodeFromString(
            request(context, "GET", "/api/v1/institutions/$institutionId/my-students?limit=50"),
        )

    /**
     * The college's academic calendar (INST-05): current and upcoming terms, examination
     * periods and breaks, read by every institution staff role. Editing stays on the web.
     */
    suspend fun academicTerms(context: Context, institutionId: String, from: String): List<CalendarTermDto> =
        json.decodeFromString<CalendarTermsEnvelope>(
            request(context, "GET", "/api/v1/institutions/$institutionId/academic-terms?from=$from&limit=20"),
        ).terms

    suspend fun examResults(context: Context, institutionId: String, definitionId: String): ExamResultsDto =
        json.decodeFromString(
            request(context, "GET", "/api/v1/institutions/$institutionId/assessments/$definitionId/results"),
        )

    /**
     * The Operations Overview (OPS-03): one server-side summary whose counts are computed
     * in bounded SQL. It replaces fetching the organisation and invitation lists (each
     * capped at 200 rows) and counting them on the phone. A section the caller's
     * capabilities do not cover arrives as null and is shown as NA.
     */
    suspend fun operationsOverview(context: Context): OpsOverviewDto =
        json.decodeFromString<OpsOverviewEnvelope>(
            request(context, "GET", "/api/v1/operations/overview"),
        ).overview

    suspend fun listEmployerOpportunities(context: Context, employerId: String): List<EmployerOpportunityDto> =
        json.decodeFromString<EmployerOpportunitiesEnvelope>(
            request(context, "GET", "/api/v1/employers/$employerId/opportunities"),
        ).opportunities

    /** Streams an assistant answer; onDelta receives each text chunk as it arrives. */
    suspend fun listEmployerApplicants(context: Context, employerId: String, opportunityId: String): List<EmployerApplicantDto> =
        json.decodeFromString<EmployerApplicantsEnvelope>(
            request(context, "GET", "/api/v1/employers/$employerId/opportunities/$opportunityId/applications"),
        ).let { envelope -> envelope.applications.map { it.copy(stages = envelope.stages) } }

    /** EMP-06: what a role's current version asks for, read-only (edits stay on the web). */
    suspend fun employerOpportunityRequirements(context: Context, employerId: String, opportunityId: String): OpportunityRequirementsDto? =
        json.decodeFromString<EmployerOpportunityDetailEnvelope>(
            request(context, "GET", "/api/v1/employers/$employerId/opportunities/$opportunityId"),
        ).currentVersion?.requirements

    suspend fun assistantChat(
        context: Context,
        messages: List<Pair<String, String>>,
        persona: String = "student",
        onDelta: (String) -> Unit,
    ): String = withContext(Dispatchers.IO) {
        val token = Session.token(context) ?: throw ApiException(401, "NO_TOKEN")
        val payload = buildString {
            append("{\"persona\":")
            append(json.encodeToString(kotlinx.serialization.serializer<String>(), persona))
            append(",\"messages\":[")
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

    // --- Cognito password sign-in (UAT-friendly; production adds Hosted UI) ---

    private fun cognitoUrl() = "https://cognito-idp." + BuildConfig.COGNITO_REGION + ".amazonaws.com/"

    class SignInException(message: String) : Exception(message)

    /** Signs in with email+password via SRP — the same flow the web app uses,
     *  so it works against the existing Cognito client with no console changes.
     *  Stores access+refresh tokens on success. */
    suspend fun passwordSignIn(context: Context, email: String, password: String): Unit =
        kotlinx.coroutines.suspendCancellableCoroutine { continuation ->
            val pool = userPool(context)
            val handler = object : com.amazonaws.mobileconnectors.cognitoidentityprovider.handlers.AuthenticationHandler {
                override fun onSuccess(
                    session: com.amazonaws.mobileconnectors.cognitoidentityprovider.CognitoUserSession,
                    newDevice: com.amazonaws.mobileconnectors.cognitoidentityprovider.CognitoDevice?,
                ) {
                    Session.setTokens(context, session.accessToken.jwtToken, session.refreshToken.token)
                    Session.setEmail(context, email)
                    continuation.resumeWith(Result.success(Unit))
                }
                override fun getAuthenticationDetails(
                    continuationAuth: com.amazonaws.mobileconnectors.cognitoidentityprovider.continuations.AuthenticationContinuation,
                    userId: String?,
                ) {
                    continuationAuth.setAuthenticationDetails(
                        com.amazonaws.mobileconnectors.cognitoidentityprovider.continuations.AuthenticationDetails(email.trim(), password, null),
                    )
                    continuationAuth.continueTask()
                }
                override fun getMFACode(mfa: com.amazonaws.mobileconnectors.cognitoidentityprovider.continuations.MultiFactorAuthenticationContinuation) {
                    continuation.resumeWith(Result.failure(SignInException("Multi-factor sign-in is not supported in the app yet - sign in on the web.")))
                }
                override fun authenticationChallenge(challenge: com.amazonaws.mobileconnectors.cognitoidentityprovider.continuations.ChallengeContinuation?) {
                    continuation.resumeWith(Result.failure(SignInException("Your password must be changed first - sign in once on the web at oneby8.com, then try again.")))
                }
                override fun onFailure(exception: Exception) {
                    val name = exception.javaClass.simpleName
                    continuation.resumeWith(Result.failure(SignInException(when {
                        name.contains("NotAuthorized") || name.contains("UserNotFound") -> "Incorrect email or password."
                        name.contains("PasswordResetRequired") -> "Your password needs to be reset. Use Forgot password? to set a new one."
                        name.contains("UserNotConfirmed") -> "This account is not confirmed yet - contact your placement cell."
                        else -> "Sign-in failed. Check your connection and try again."
                    })))
                }
            }
            pool.getUser(email.trim()).getSessionInBackground(handler)
        }

    private fun userPool(context: Context) = com.amazonaws.mobileconnectors.cognitoidentityprovider.CognitoUserPool(
        context.applicationContext,
        "ap-south-1_nPl3qFkvB",
        BuildConfig.COGNITO_SPA_CLIENT_ID,
        null,
        com.amazonaws.regions.Regions.AP_SOUTH_1,
    )

    /**
     * Self-service password reset, the same two steps the web reset page runs: the user pool
     * emails a one-time code, then the code and a new password are confirmed. "No such
     * account" collapses into the same answer as success, so the reset screen never tells
     * anyone which addresses have accounts on ONE. Neither the code nor the password is
     * logged or stored; they live only in the screen's memory until the call returns.
     */
    enum class PasswordReset { CodeSent, Reset, CodeInvalid, CodeExpired, PasswordRejected, RateLimited, Failed }

    suspend fun requestPasswordReset(context: Context, email: String): PasswordReset =
        kotlinx.coroutines.suspendCancellableCoroutine { continuation ->
            fun finish(result: PasswordReset) { if (continuation.isActive) continuation.resumeWith(Result.success(result)) }
            userPool(context).getUser(email.trim()).forgotPasswordInBackground(object :
                com.amazonaws.mobileconnectors.cognitoidentityprovider.handlers.ForgotPasswordHandler {
                override fun onSuccess() = finish(PasswordReset.CodeSent)
                // The code is on its way; the second step confirms it statelessly, so this
                // continuation is deliberately left unfinished.
                override fun getResetCode(
                    resetContinuation: com.amazonaws.mobileconnectors.cognitoidentityprovider.continuations.ForgotPasswordContinuation?,
                ) = finish(PasswordReset.CodeSent)
                override fun onFailure(exception: Exception?) = finish(passwordResetFailure(exception, PasswordReset.CodeSent))
            })
        }

    suspend fun confirmPasswordReset(context: Context, email: String, code: String, newPassword: String): PasswordReset =
        kotlinx.coroutines.suspendCancellableCoroutine { continuation ->
            fun finish(result: PasswordReset) { if (continuation.isActive) continuation.resumeWith(Result.success(result)) }
            userPool(context).getUser(email.trim()).confirmPasswordInBackground(code.trim(), newPassword, object :
                com.amazonaws.mobileconnectors.cognitoidentityprovider.handlers.ForgotPasswordHandler {
                override fun onSuccess() = finish(PasswordReset.Reset)
                override fun getResetCode(
                    resetContinuation: com.amazonaws.mobileconnectors.cognitoidentityprovider.continuations.ForgotPasswordContinuation?,
                ) = Unit
                override fun onFailure(exception: Exception?) = finish(passwordResetFailure(exception, PasswordReset.CodeInvalid))
            })
        }

    private fun passwordResetFailure(exception: Exception?, unknownAccount: PasswordReset): PasswordReset {
        val names = generateSequence(exception as Throwable?) { it.cause }.take(4).map { it.javaClass.simpleName }.toList()
        fun any(vararg candidates: String) = names.any { name -> candidates.any { name.contains(it) } }
        return when {
            any("UserNotFound", "NotAuthorized") -> unknownAccount
            any("CodeMismatch") -> PasswordReset.CodeInvalid
            any("ExpiredCode") -> PasswordReset.CodeExpired
            any("InvalidPassword") -> PasswordReset.PasswordRejected
            any("LimitExceeded", "TooManyRequests", "TooManyFailedAttempts") -> PasswordReset.RateLimited
            else -> PasswordReset.Failed
        }
    }

    /** Exchanges the stored refresh token for a fresh access token; null if unavailable. */
    fun refreshSession(context: Context): String? {
        val refresh = Session.refreshToken(context) ?: return null
        val payload = kotlinx.serialization.json.buildJsonObject {
            put("AuthFlow", kotlinx.serialization.json.JsonPrimitive("REFRESH_TOKEN_AUTH"))
            put("ClientId", kotlinx.serialization.json.JsonPrimitive(BuildConfig.COGNITO_SPA_CLIENT_ID))
            put("AuthParameters", kotlinx.serialization.json.buildJsonObject {
                put("REFRESH_TOKEN", kotlinx.serialization.json.JsonPrimitive(refresh))
            })
        }.toString()
        val request = Request.Builder()
            .url(cognitoUrl())
            .header("Content-Type", "application/x-amz-json-1.1")
            .header("X-Amz-Target", "AWSCognitoIdentityProviderService.InitiateAuth")
            .post(payload.toRequestBody("application/x-amz-json-1.1".toMediaType()))
            .build()
        return runCatching {
            http.newCall(request).execute().use { response ->
                val text = response.body?.string() ?: ""
                val access = json.parseToJsonElement(text).jsonObject["AuthenticationResult"]
                    ?.jsonObject?.get("AccessToken")?.jsonPrimitive?.content
                if (access != null) Session.setTokens(context, access, null)
                access
            }
        }.getOrNull()
    }
}

@Serializable data class ErrorEnvelope(val error: ErrorBody? = null)
/** Only the summary is read; the roster rows themselves stay on the web Students page. */
@Serializable data class RosterActivationEnvelope(val activationSummary: Map<String, Int>? = null)
@Serializable data class ErrorBody(val code: String? = null, val message: String? = null)

/** The college academic calendar (INST-05). */
@Serializable data class CalendarTermsEnvelope(val terms: List<CalendarTermDto> = emptyList())
@Serializable data class CalendarTermDto(
    val id: String = "",
    val name: String = "",
    /** TERM, EXAMINATIONS or BREAK. */
    val kind: String = "TERM",
    val startsOn: String = "",
    val endsOn: String = "",
    val unit: CalendarTermUnitDto? = null,
    val current: Boolean = false,
)
@Serializable data class CalendarTermUnitDto(val id: String = "", val kind: String = "", val name: String = "")
@Serializable data class MyStudentsEnvelope(
    /** ASSIGNMENTS: scope comes from teaching assignments; MEMBERSHIP: the college has not started assigning. */
    val mode: String = "MEMBERSHIP",
    val assignments: List<TeachingAssignmentDto> = emptyList(),
    val students: List<MyStudentDto> = emptyList(),
    val nextCursor: String? = null,
)
@Serializable data class TeachingAssignmentDto(
    val id: String = "",
    val unit: TeachingUnitDto = TeachingUnitDto(),
    val subject: TeachingSubjectDto? = null,
    val subjectCode: String? = null,
    val academicTerm: String = "",
)
@Serializable data class TeachingUnitDto(val id: String = "", val kind: String = "", val name: String = "")
@Serializable data class TeachingSubjectDto(val id: String = "", val name: String = "", val code: String? = null)
@Serializable data class MyStudentDto(
    val profileId: String = "",
    val fullName: String = "",
    val institutionStudentId: String = "",
    val units: MyStudentUnitsDto = MyStudentUnitsDto(),
    val activation: MyStudentActivationDto? = null,
    val openTasks: Int = 0,
    val recentAssessments: MyStudentAssessmentsDto = MyStudentAssessmentsDto(),
)
@Serializable data class MyStudentUnitsDto(val section: String? = null, val batch: String? = null)
@Serializable data class MyStudentActivationDto(val state: String = "")
@Serializable data class MyStudentAssessmentsDto(val submitted: Int = 0, val latestTitle: String? = null)

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
    /** INST-06: an ANNOUNCEMENT carries institutionName, from and audience. */
    val data: Map<String, String> = emptyMap(),
)

/** "From your faculty · Section X, Local College" — only what the server sent. */
internal fun NotificationDto.announcementSource(): String {
    val institution = data["institutionName"]
    val audience = data["audience"]
    val where = listOfNotNull(audience, institution?.takeIf { it != audience }).joinToString(", ")
    return listOfNotNull(data["from"]?.let { "From $it" }, where.ifBlank { null }).joinToString(" · ").ifBlank { "From your college" }
}

/** OPS-16: a service status notice comes from AI8HT to an organisation's admins, not from the college. */
internal fun NotificationDto.statusNoticeSource(): String? =
    if (kind != "STATUS_NOTICE") null
    else listOfNotNull("Service status notice from AI8HT", data["organizationName"]?.let { "for $it" }).joinToString(" ")

// --- Cohort announcements (INST-06) ---------------------------------------------

@Serializable data class AnnouncementAudienceDto(val unitId: String? = null, val kind: String = "", val name: String? = null)
@Serializable data class AnnouncementEmailDto(
    val sent: Int = 0, val notConfigured: Int = 0, val failed: Int = 0, val bounced: Int = 0, val skipped: Int = 0, val pending: Int = 0,
)
@Serializable data class AnnouncementDeliveryDto(val recipients: Int = 0, val email: AnnouncementEmailDto = AnnouncementEmailDto())
@Serializable data class InstitutionAnnouncementDto(
    val id: String,
    val title: String,
    val body: String,
    val audience: AnnouncementAudienceDto = AnnouncementAudienceDto(),
    val channels: List<String> = emptyList(),
    val state: String,
    val scheduledFor: String? = null,
    val sentAt: String? = null,
    val delivery: AnnouncementDeliveryDto? = null,
)
@Serializable data class AnnouncementsEnvelope(
    val announcements: List<InstitutionAnnouncementDto> = emptyList(),
    val canSend: Boolean = false,
    val emailConfigured: Boolean = false,
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
    /** INST-10: the college's name, and whether the student has left it (graduated, transferred or ended). */
    val institutionName: String? = null,
    val formerStudent: Boolean = false,
    val relationship: StudentRelationshipWindowDto? = null,
)
@Serializable data class StudentRelationshipWindowDto(val state: String = "", val effectiveTo: String? = null)

private val alumniDate = java.time.format.DateTimeFormatter.ofPattern("d MMMM yyyy", java.util.Locale.ENGLISH)

/**
 * INST-10: "Graduated from Local College on 31 May 2026" for someone who has left their college,
 * or null for a current student. The date is read in India time, as the college set it.
 */
internal fun StudentDto.formerStudentLine(): String? {
    if (!formerStudent) return null
    val college = institutionName?.takeIf { it.isNotBlank() } ?: "your college"
    val verb = when (relationship?.state ?: academicStatus) {
        "GRADUATED" -> "Graduated from"
        "TRANSFERRED" -> "Transferred from"
        else -> "Left"
    }
    val date = relationship?.effectiveTo?.let { iso ->
        runCatching { java.time.Instant.parse(iso).atZone(java.time.ZoneId.of("Asia/Kolkata")).format(alumniDate) }.getOrNull()
    }
    return if (date != null) "$verb $college on $date" else "$verb $college"
}

// --- Career readiness / learning ---------------------------------------------

@Serializable data class LearnerStateDto(
    val catalog: CatalogDto = CatalogDto(),
    val progress: List<ProgressDto> = emptyList(),
    val readiness: ReadinessDto? = null,
    val roadmap: List<RoadmapDto> = emptyList(),
    // The server has always returned these; the app never read them, and drew five
    // hardcoded NA rings over the top of real per-topic bands.
    val mastery: List<MasteryDto> = emptyList(),
    // ENG-16: the language the learner reads lessons in, and the languages they may choose.
    val lessonLanguage: LessonLanguageDto? = null,
)
@Serializable data class LessonLanguageDto(
    val selected: String = "en",
    val offered: List<LessonLanguageOptionDto> = emptyList(),
)
@Serializable data class LessonLanguageOptionDto(val language: String, val name: String = "", val nativeName: String = "")
@Serializable data class LessonLanguageEnvelope(val lessonLanguage: LessonLanguageDto = LessonLanguageDto())
@Serializable data class MasteryDto(val topicId: String = "", val band: String = "")
@Serializable data class TopicDto(val id: String, val name: String = "")
@Serializable data class CatalogDto(
    val modules: List<ModuleDto> = emptyList(),
    val topics: List<TopicDto> = emptyList(),
)
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
    val body: LessonBodyDto = LessonBodyDto(),
    // ENG-16: the language the words are in, and why it is not the chosen one
    // (TRANSLATION_MISSING: shown in English; TRANSLATION_OUTDATED: the English changed since).
    val language: String = "en",
    val languageNotice: String? = null,
)
@Serializable data class LessonBodyDto(val summary: String? = null, val practice: String? = null)
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
    /** EMP-11: live campus drives at the student's college through which this job reaches them. */
    val campusDrives: List<ListedCampusDriveDto> = emptyList(),
    /** EMP-14: listed because an employer invited the student from the talent pool (invite-only job). */
    val invitedFromTalentPool: Boolean = false,
)
@Serializable data class ListedCampusDriveDto(
    val institutionName: String = "",
    val state: String = "",
    val scheduledStartAt: String? = null,
)
@Serializable data class ApplicationsEnvelope(
    val applications: List<ApplicationDto> = emptyList(),
    /** EMP-13: whether students can share verified skill evidence with employers (off until HG-4). */
    val evidenceSharingAvailable: Boolean = false,
)
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
    /** True when the employer chose to tell this candidate why. The detail is a separate read. */
    val feedbackReleased: Boolean = false,
    /** EMP-05: the employer changed a term this student applied under; they must accept or decline. */
    val termsAcknowledgementPending: Boolean = false,
    /** ADR-019 / INST-09: when the student shared this application with their college, and when they stopped. */
    val institutionVisibilityGrantedAt: String? = null,
    val institutionVisibilityRevokedAt: String? = null,
    /** EMP-10: the employer started a conversation, and how many of its messages are unread. */
    val conversationStarted: Boolean = false,
    val unreadMessages: Int = 0,
    /** EMP-11: the college whose campus drive this application came through, if any. */
    val campusDrive: CampusDriveRefDto? = null,
    /** INST-14: made by opting in to this college's placement-office nomination. */
    val nominatedBy: CampusDriveRefDto? = null,
    /** EMP-13: verified skill evidence is shared with this employer now. */
    val evidenceShared: Boolean = false,
)
@Serializable data class CampusDriveRefDto(val institutionName: String = "")

// --- Candidate feedback -------------------------------------------------------

@Serializable data class ApplicationFeedbackEnvelope(val feedback: ApplicationFeedbackDto? = null)

@Serializable data class ApplicationFeedbackDto(
    val id: String = "",
    val employerName: String = "",
    val title: String = "",
    val releasedAt: String? = null,
    val note: String? = null,
    val reasons: List<FeedbackReasonDto> = emptyList(),
)

@Serializable data class FeedbackReasonDto(
    val code: String = "",
    val studentLabel: String = "",
    val category: String = "",
    /** Empty when nothing a student studies addresses this reason. Never filled with a guess. */
    val topics: List<FeedbackTopicDto> = emptyList(),
)

@Serializable data class FeedbackTopicDto(val topicId: String = "", val name: String = "")

// --- Calendar -----------------------------------------------------------------

@Serializable data class CalendarEnvelope(val entries: List<CalendarEntryDto> = emptyList())

@Serializable data class CalendarEntryDto(
    val id: String = "",
    val kind: String = "",
    val title: String = "",
    val detail: String? = null,
    val startsAt: String = "",
    val endsAt: String? = null,
    val location: String? = null,
    val joinUrl: String? = null,
    val audience: String = "",
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
    /** When an institution decided; null unless a recorded verifier exists (0107). */
    val verifiedAt: String? = null,
)

/**
 * What a document's verification chip says. "Verified" needs a real institution decision (VERIFIED
 * with a decision time); a student can only self-report or ask, so anything else reads self-reported.
 */
internal fun documentVerificationLabel(doc: DocumentDto): String = when {
    doc.verificationState == "VERIFIED" && !doc.verifiedAt.isNullOrBlank() -> "Verified"
    doc.verificationState == "REJECTED" && !doc.verifiedAt.isNullOrBlank() -> "Not verified"
    doc.verificationState == "PENDING_VERIFICATION" -> "Verification requested"
    else -> "Self-reported"
}

// --- Security context & staff -------------------------------------------------

@Serializable data class SecurityContextDto(
    val userId: String = "",
    val memberships: List<MembershipDto> = emptyList(),
    val studentRelationships: List<StudentRelationshipDto> = emptyList(),
    /** INST-10: relationships left by graduating, transferring or ending; the person keeps the student workspace. */
    val formerStudentRelationships: List<StudentRelationshipDto> = emptyList(),
)
@Serializable data class MembershipDto(val organizationId: String = "", val role: String = "")

/** GROWTH-01: `GET /api/v1/growth/me`. No amount, lead or student is part of it. */
@Serializable data class GrowthMeDto(
    /** GROWTH-03: open leads the person owns; null from an older server. */
    val openLeads: Int? = null,
    /** GROWTH-06: the person's visits this IST month, and open follow-ups due today or earlier; null from an older server. */
    val visitsThisMonth: Int? = null,
    val followUpsDue: Int? = null,
    val role: String = "",
    val staffType: String? = null,
    val teams: List<GrowthTeamDto> = emptyList(),
)
@Serializable data class GrowthTeamDto(val team: String = "", val joinedAt: String = "", val manager: GrowthManagerDto? = null)
@Serializable data class GrowthManagerDto(val email: String = "")
/** GROWTH-02: `GET /api/v1/growth/territory`. Regions, areas and work emails only. */
@Serializable data class GrowthTerritoryDto(val role: String = "", val regions: List<GrowthRegionDto> = emptyList())
@Serializable data class GrowthRegionDto(
    /** GROWTH-03: open, unowned, contactable leads in the region; null from an older server. */
    val unownedLeads: Int? = null,
    val id: String = "",
    val name: String = "",
    val myRole: String = "EXECUTIVE",
    val since: String? = null,
    val areas: List<GrowthAreaDto> = emptyList(),
    val people: List<GrowthRegionPersonDto> = emptyList(),
)
@Serializable data class GrowthAreaDto(val stateCode: String = "", val stateName: String = "", val districtCode: Int? = null, val districtName: String? = null)
/** GROWTH-03: the lead register. Contacts are masked by the server unless the person owns the lead. */
@Serializable data class GrowthLeadVocabularyDto(
    val sources: List<String> = emptyList(),
    val contactRoles: List<String> = emptyList(),
    val contactSourcesByBasis: Map<String, List<String>> = emptyMap(),
    val contactLimit: Int = 10,
    val purpose: String = "",
    val notice: GrowthNoticeDto = GrowthNoticeDto(),
)
@Serializable data class GrowthNoticeDto(val version: String = "", val status: String = "", val text: List<String> = emptyList())
@Serializable data class GrowthLeadPageDto(val leads: List<GrowthLeadSummaryDto> = emptyList(), val nextCursor: String? = null)
@Serializable data class GrowthLeadAreaDto(val stateCode: String? = null, val stateName: String? = null, val districtName: String? = null, val city: String? = null)
@Serializable data class GrowthLeadOwnerDto(val email: String? = null, val isMe: Boolean = false)
@Serializable data class GrowthDoNotContactDto(val at: String? = null, val reasonCode: String? = null)
@Serializable data class GrowthLeadSummaryDto(
    val id: String = "",
    val kind: String = "",
    val name: String = "",
    val area: GrowthLeadAreaDto = GrowthLeadAreaDto(),
    val owner: GrowthLeadOwnerDto? = null,
    val needsNewOwner: Boolean = false,
    val stage: String = "",
    val doNotContact: GrowthDoNotContactDto? = null,
    val handedOff: Boolean = false,
    val liveContacts: Int = 0,
    val stale: Boolean = false,
)
@Serializable data class GrowthLeadEnvelope(val lead: GrowthLeadDetailDto = GrowthLeadDetailDto())
@Serializable data class GrowthLeadDetailDto(
    val id: String = "",
    val kind: String = "",
    val name: String = "",
    val area: GrowthLeadAreaDto = GrowthLeadAreaDto(),
    val aisheCode: String? = null,
    val websiteDomain: String? = null,
    val owner: GrowthLeadOwnerDto? = null,
    val needsNewOwner: Boolean = false,
    val stage: String = "",
    val source: String = "",
    val possibleDuplicate: Boolean = false,
    val doNotContact: GrowthDoNotContactDto? = null,
    val handedOff: Boolean = false,
    val stale: Boolean = false,
    val contacts: List<GrowthContactDto> = emptyList(),
    val removedContacts: Int = 0,
)
@Serializable data class GrowthContactNoticeDto(val givenAt: String? = null, val version: String? = null)
@Serializable data class GrowthContactDto(
    val id: String = "",
    val role: String = "",
    val fullName: String = "",
    val email: String? = null,
    val phone: String? = null,
    val masked: Boolean = true,
    val permissionBasis: String = "",
    val source: String = "",
    val notice: GrowthContactNoticeDto? = null,
)
/** GROWTH-06: field work. `location` is present only for the author and their manager. */
@Serializable data class GrowthActivityContactDto(val id: String = "", val role: String? = null, val fullName: String? = null)
@Serializable data class GrowthLocationDto(val latitude: Double = 0.0, val longitude: Double = 0.0, val accuracyM: Int = 0)
@Serializable data class GrowthLocationRemovedDto(val at: String? = null, val reasonCode: String = "")
@Serializable data class GrowthPersonRefDto(val email: String = "", val isMe: Boolean = false)
@Serializable data class GrowthActivityDto(
    val id: String = "",
    val leadId: String = "",
    val leadName: String = "",
    val kind: String = "",
    val outcome: String? = null,
    val contact: GrowthActivityContactDto? = null,
    val notes: String? = null,
    val notesErased: Boolean = false,
    val author: GrowthPersonRefDto = GrowthPersonRefDto(),
    val occurredAt: String? = null,
    val receivedAt: String? = null,
    val location: GrowthLocationDto? = null,
    val locationRemoved: GrowthLocationRemovedDto? = null,
)
@Serializable data class GrowthActivityEnvelope(val activity: GrowthActivityDto = GrowthActivityDto())
@Serializable data class GrowthFollowUpDto(
    val id: String = "",
    val leadId: String = "",
    val leadName: String = "",
    val title: String? = null,
    val titleErased: Boolean = false,
    val dueOn: String = "",
    val state: String = "",
    val overdue: Boolean = false,
    val dueToday: Boolean = false,
    val assignee: GrowthPersonRefDto = GrowthPersonRefDto(),
)
@Serializable data class GrowthLocationNoticeDto(val version: String = "", val status: String = "", val text: List<String> = emptyList())
@Serializable data class GrowthFieldVocabularyDto(
    val kinds: List<String> = emptyList(),
    val outcomes: List<String> = emptyList(),
    val cancelReasons: List<String> = emptyList(),
    val notesMax: Int = 2000,
    val titleMax: Int = 280,
    val reportMaxAgeDays: Int = 7,
    val locationRetentionDays: Int = 180,
    val locationNotice: GrowthLocationNoticeDto = GrowthLocationNoticeDto(),
)
@Serializable data class GrowthFieldCountsDto(
    val visitsThisMonth: Int = 0, val activitiesThisMonth: Int = 0, val metThisMonth: Int = 0,
    val followUpsOverdue: Int = 0, val followUpsDueToday: Int = 0, val followUpsOpen: Int = 0,
)
@Serializable data class GrowthFieldDto(
    val view: String = "MINE",
    val canSeeTeam: Boolean = false,
    val today: String = "",
    val counts: GrowthFieldCountsDto? = null,
    val followUps: List<GrowthFollowUpDto> = emptyList(),
    val activities: List<GrowthActivityDto> = emptyList(),
    val vocabulary: GrowthFieldVocabularyDto = GrowthFieldVocabularyDto(),
)
@Serializable data class GrowthLeadFieldDto(
    val leadId: String = "",
    val canLog: Boolean = false,
    val activities: List<GrowthActivityDto> = emptyList(),
    val followUps: List<GrowthFollowUpDto> = emptyList(),
    val vocabulary: GrowthFieldVocabularyDto = GrowthFieldVocabularyDto(),
)
/** GROWTH-04: `GET /api/v1/growth/leads/{id}/pipeline`. Milestones are null until operations links the college. */
@Serializable data class GrowthSuppressedCountDto(val suppressed: Boolean = true, val value: Int? = null)
@Serializable data class GrowthMilestoneDto(
    val code: String = "", val state: String = "NA", val at: String? = null, val note: String? = null, val count: GrowthSuppressedCountDto? = null,
    /** GROWTH-05, employer leads: PUBLISHED_NOW on FIRST_JOB_PUBLISHED, a count per drive state on CAMPUS_DRIVE. Records, never people. */
    val counts: Map<String, Int> = emptyMap(),
)
/** GROWTH-05: an access request linked to an employer lead — time, state and whose referral ("YOU" / "ANOTHER_TEAM_MEMBER"). */
@Serializable data class GrowthLeadAccessRequestDto(val receivedAt: String? = null, val state: String = "", val referral: String? = null)
/** GROWTH-05: `GET /api/v1/growth/referral-codes`. The link is the public form path and a random code. */
@Serializable data class GrowthReferralCountsDto(val pending: Int = 0, val onboarded: Int = 0, val closed: Int = 0)
@Serializable data class GrowthReferralCodeDto(
    val id: String = "", val code: String = "", val linkPath: String = "", val createdAt: String? = null,
    val revokedAt: String? = null, val revokedReasonCode: String? = null, val referrals: GrowthReferralCountsDto = GrowthReferralCountsDto(),
)
@Serializable data class GrowthReferralLimitsDto(val liveCodesPerPerson: Int = 3, val createdPerDay: Int = 5)
// GROWTH-07: credit and disputes. No amount field exists: commission amounts are not built, and
// employer commission is on hold (D11).
@Serializable data class GrowthCreditDto(
    val attributionId: String = "", val organizationId: String = "", val organizationName: String = "", val organizationKind: String = "",
    val basis: String = "", val since: String? = null, val endedAt: String? = null, val endedReasonCode: String? = null,
    val disputeOpen: Boolean = false, val commission: String = "NOT_BUILT",
)
@Serializable data class GrowthMyDisputeDto(
    val disputeId: String = "", val organizationName: String = "", val organizationKind: String = "", val origin: String = "",
    val state: String = "", val role: String? = null, val openedAt: String? = null, val decidedAt: String? = null, val statement: String? = null,
)
@Serializable data class GrowthAttributionsDto(
    val credited: List<GrowthCreditDto> = emptyList(), val disputes: List<GrowthMyDisputeDto> = emptyList(), val windowDays: Int = 90,
)
@Serializable data class GrowthReferralCodesDto(val eligible: Boolean = false, val codes: List<GrowthReferralCodeDto> = emptyList(), val limits: GrowthReferralLimitsDto = GrowthReferralLimitsDto())
@Serializable data class GrowthHandoffRequestDto(
    val id: String = "", val state: String = "", val requestedAt: String? = null, val contractReferenceReported: String = "",
    val decidedAt: String? = null, val declineReasonCode: String? = null, val contactsCarried: Int? = null,
)
@Serializable data class GrowthStageReasonsDto(val backward: List<String> = emptyList(), val hold: List<String> = emptyList(), val lost: List<String> = emptyList())
@Serializable data class GrowthPipelineVocabularyDto(val reasons: GrowthStageReasonsDto = GrowthStageReasonsDto())
@Serializable data class GrowthLeadPipelineDto(
    val leadId: String = "",
    val kind: String = "",
    val stage: String = "",
    val lostReasonCode: String? = null,
    val canMove: Boolean = false,
    val nextStages: List<String> = emptyList(),
    val canRequestHandoff: Boolean = false,
    val handoffRequests: List<GrowthHandoffRequestDto> = emptyList(),
    val milestones: List<GrowthMilestoneDto>? = null,
    val accessRequests: List<GrowthLeadAccessRequestDto> = emptyList(),
    val vocabulary: GrowthPipelineVocabularyDto = GrowthPipelineVocabularyDto(),
)
@Serializable data class GrowthRegionPersonDto(val email: String = "", val role: String = "", val since: String = "")
@Serializable data class StudentRelationshipDto(val institutionId: String = "", val state: String = "")

@Serializable data class InstitutionExamsEnvelope(val assessments: List<InstitutionExamDto> = emptyList())
@Serializable data class InstitutionExamDto(
    val id: String,
    val title: String = "",
    val subjectName: String = "",
    val lifecycleState: String = "",
    val totalMarks: Double = 0.0,
    val durationSeconds: Int = 0,
    val startsAt: String = "",
    val endsAt: String = "",
    val attemptsAllowed: Int = 1,
    val assignedCount: Int = 0,
    val completedAttempts: Int = 0,
)
@Serializable data class SubjectsEnvelope(val subjects: List<SubjectDto> = emptyList())
@Serializable data class SubjectDto(val id: String, val name: String = "")
@Serializable data class QuestionsEnvelope(val questions: List<QuestionIdDto> = emptyList())
@Serializable data class QuestionIdDto(val id: String = "")

@Serializable data class ExamResultsDto(
    val results: List<ExamResultRowDto> = emptyList(),
    val notAttempted: List<NotAttemptedDto> = emptyList(),
    val summary: ExamResultsSummaryDto = ExamResultsSummaryDto(),
)
@Serializable data class ExamResultRowDto(
    val studentName: String = "",
    val percentage: Double = 0.0,
    val score: Double = 0.0,
    val maxScore: Double = 0.0,
    val attemptNumber: Int = 0,
    val autoSubmitted: Boolean = false,
)
@Serializable data class NotAttemptedDto(val studentName: String = "", val inProgress: Boolean = false)
@Serializable data class ExamResultsSummaryDto(
    val attempts: Int = 0,
    val averagePercentage: Double = 0.0,
    val assigned: Int = 0,
    val notAttemptedCount: Int = 0,
)

@Serializable data class EmployerOpportunitiesEnvelope(val opportunities: List<EmployerOpportunityDto> = emptyList())
@Serializable data class EmployerOpportunityDto(
    val id: String,
    val referenceCode: String = "",
    val lifecycleState: String = "",
    val title: String? = null,
    val employmentType: String? = null,
    val workMode: String? = null,
    val locationCity: String? = null,
    val applicationDeadline: String? = null,
    val publishedAt: String? = null,
    /** EMP-05: when the role was closed or withdrawn, and its current version number. */
    val closedAt: String? = null,
    val versionNumber: Int? = null,
    val applicationCount: Int = 0,
    val openApplicationCount: Int = 0,
)

// Operations Overview (OPS-03). Every count is bounded on the server: `capped` means the
// real number is larger than `value`. A null section is one the caller cannot access.
@Serializable data class OpsCountDto(val value: Int = 0, val capped: Boolean = false)
@Serializable data class OpsKindCountsDto(
    val total: OpsCountDto = OpsCountDto(),
    val byVerification: Map<String, OpsCountDto> = emptyMap(),
)
@Serializable data class OpsRecentOrganizationDto(
    val id: String,
    val kind: String = "",
    val name: String = "",
    val verificationState: String = "",
    val active: Boolean = true,
)
@Serializable data class OpsOrganizationsSectionDto(
    val total: OpsCountDto = OpsCountDto(),
    val active: OpsCountDto = OpsCountDto(),
    val institutions: OpsKindCountsDto = OpsKindCountsDto(),
    val employers: OpsKindCountsDto = OpsKindCountsDto(),
    val recent: List<OpsRecentOrganizationDto> = emptyList(),
)
@Serializable data class OpsVerificationSectionDto(val awaitingDecision: OpsCountDto = OpsCountDto(), val underReview: OpsCountDto = OpsCountDto())
@Serializable data class OpsAccessRequestsSectionDto(val pending: OpsCountDto = OpsCountDto())
@Serializable data class OpsStaffInvitationsDto(
    val total: OpsCountDto = OpsCountDto(),
    val accepted: OpsCountDto = OpsCountDto(),
    val pending: OpsCountDto = OpsCountDto(),
    val pendingOver72Hours: OpsCountDto = OpsCountDto(),
    val expiredUnaccepted: OpsCountDto = OpsCountDto(),
)
@Serializable data class OpsStudentInvitationsDto(
    val pending: OpsCountDto = OpsCountDto(),
    val pendingOver72Hours: OpsCountDto = OpsCountDto(),
    val notDelivered: OpsCountDto = OpsCountDto(),
)
@Serializable data class OpsInvitationsSectionDto(
    val staff: OpsStaffInvitationsDto = OpsStaffInvitationsDto(),
    val student: OpsStudentInvitationsDto = OpsStudentInvitationsDto(),
)
@Serializable data class OpsTrustSectionDto(
    val open: OpsCountDto = OpsCountDto(),
    val unassigned: OpsCountDto = OpsCountDto(),
    val bySeverity: Map<String, OpsCountDto> = emptyMap(),
)
@Serializable data class OpsJobsSectionDto(val failedEvents: OpsCountDto = OpsCountDto(), val openAlerts: OpsCountDto = OpsCountDto())
@Serializable data class OpsPrivacyRequestsSectionDto(
    val open: OpsCountDto = OpsCountDto(),
    val deletionsDueWithin7Days: OpsCountDto = OpsCountDto(),
    val failed: OpsCountDto = OpsCountDto(),
)
@Serializable data class OpsPrivacyHoldsSectionDto(val active: OpsCountDto = OpsCountDto())
@Serializable data class OpsApprovalsSectionDto(val pending: OpsCountDto = OpsCountDto(), val awaitingExecution: OpsCountDto = OpsCountDto())
@Serializable data class OpsSupportSectionDto(
    val open: OpsCountDto = OpsCountDto(),
    val overdue: OpsCountDto = OpsCountDto(),
    val unassigned: OpsCountDto = OpsCountDto(),
)
@Serializable data class OpsOverviewDto(
    val organizations: OpsOrganizationsSectionDto? = null,
    val verification: OpsVerificationSectionDto? = null,
    val employerAccessRequests: OpsAccessRequestsSectionDto? = null,
    val invitations: OpsInvitationsSectionDto? = null,
    val trustSafety: OpsTrustSectionDto? = null,
    val jobs: OpsJobsSectionDto? = null,
    val privacyRequests: OpsPrivacyRequestsSectionDto? = null,
    val privacyHolds: OpsPrivacyHoldsSectionDto? = null,
    val approvals: OpsApprovalsSectionDto? = null,
    val support: OpsSupportSectionDto? = null,
)
@Serializable data class OpsOverviewEnvelope(val overview: OpsOverviewDto)

@Serializable data class HelpEnvelope(val articles: List<HelpArticleDto> = emptyList())
@Serializable data class HelpArticleDto(
    val id: String,
    val personas: List<String> = emptyList(),
    val title: String = "",
    val keywords: List<String> = emptyList(),
    val body: String = "",
)

@Serializable data class StudentActivityDto(
    val today: String = "",
    val currentStreakDays: Int = 0,
    val activeDaysLast7: Int = 0,
    val last7: List<ActivityDayDto> = emptyList(),
    val days: List<ActivityDayDto> = emptyList(),
)
@Serializable data class ActivityDayDto(val date: String = "", val count: Int = 0)
@Serializable data class EmployerApplicantsEnvelope(
    val applications: List<EmployerApplicantDto> = emptyList(),
    /** EMP-06: the job's selection stages, in order — the pipeline's template. */
    val stages: List<SelectionStageDto> = emptyList(),
)
@Serializable data class EmployerApplicantDto(
    val id: String,
    val state: String = "",
    val candidateName: String? = null,
    val consentRevoked: Boolean = false,
    val candidateAccess: Boolean = true,
    val interviewCount: Int = 0,
    val offerState: String? = null,
    /** EMP-06: eligibility as frozen at apply — outcome and basis only; null when withheld or no rules. */
    val eligibility: ApplicantEligibilityDto? = null,
    /** INST-14: PLACEMENT_OFFICE_NOMINATION when the student opted in to their college's nomination. */
    val source: String = "DIRECT",
    /** Copied from the envelope by [Api.listEmployerApplicants]; not part of the row. */
    val stages: List<SelectionStageDto> = emptyList(),
)

@Serializable data class ApplicantEligibilityDto(
    val eligible: Boolean = false,
    val flagCount: Int = 0,
    val selfReportedCount: Int = 0,
    val versionNumber: Int? = null,
    val outcomes: List<ApplicantEligibilityOutcomeDto> = emptyList(),
)

@Serializable data class ApplicantEligibilityOutcomeDto(
    val ruleType: String = "",
    val comparator: String = "",
    val valueNumeric: Double? = null,
    val valueText: String? = null,
    val isBlocking: Boolean = true,
    val outcome: String = "",
    val basis: String? = null,
    val flagged: Boolean = false,
)

@Serializable data class EmployerOpportunityDetailEnvelope(val currentVersion: EmployerOpportunityVersionDto? = null)
@Serializable data class EmployerOpportunityVersionDto(val requirements: OpportunityRequirementsDto? = null)
@Serializable data class OpportunityRequirementsDto(
    val eligibilityRules: List<TermsEligibilityRuleDto> = emptyList(),
    val skills: List<OpportunitySkillDto> = emptyList(),
    val stages: List<SelectionStageDto> = emptyList(),
    val careerRole: CareerRoleRefDto? = null,
)
@Serializable data class CareerRoleRefDto(val id: String = "", val code: String = "", val title: String = "")
