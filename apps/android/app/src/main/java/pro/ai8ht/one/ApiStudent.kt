package pro.ai8ht.one

import android.content.Context
import kotlinx.serialization.Serializable

/**
 * The rest of the student API — everything the web app can do that the phone could not.
 *
 * Split from Api.kt, which was already long, rather than grown further. These are
 * extensions on the same object and go through the same `request`, so headers, token
 * refresh and error mapping are unchanged.
 */

// ---------------------------------------------------------------------------
// Opportunities, applications, offers
// ---------------------------------------------------------------------------

@Serializable data class OpportunityDetailEnvelope(val opportunity: OpportunityDetailDto)

@Serializable data class OpportunityDetailDto(
    val id: String,
    val employerName: String = "",
    val title: String = "",
    val summary: String? = null,
    val responsibilities: String? = null,
    val employmentType: String = "",
    val workMode: String = "",
    val locationCity: String? = null,
    val applicationDeadline: String? = null,
    val alreadyApplied: Boolean = false,
    val compensationSummary: String? = null,
    val eligibility: EligibilityDto? = null,
    val skills: List<String> = emptyList(),
    val selectionStages: List<String> = emptyList(),
)

/**
 * The eligibility verdict.
 *
 * `UNKNOWN` is not a soft `FAIL`. The engine fails closed on a fact nobody has recorded —
 * most often a CGPA with no verified academic term behind it — and telling a student they
 * are ineligible when the truth is "we cannot tell yet" would be a lie they can do
 * something about.
 */
@Serializable data class EligibilityDto(
    val outcome: String = "UNKNOWN",
    val reasons: List<EligibilityReasonDto> = emptyList(),
)

@Serializable data class EligibilityReasonDto(
    val rule: String = "",
    val outcome: String = "",
    val detail: String? = null,
)

@Serializable data class OffersEnvelope(val offers: List<OfferDto> = emptyList())

@Serializable data class OfferDto(
    val id: String,
    val applicationId: String = "",
    val employerName: String = "",
    val title: String = "",
    val state: String = "",
    val respondBy: String? = null,
    val extendedAt: String? = null,
)

@Serializable data class SavedOpportunitiesEnvelope(
    val savedOpportunities: List<SavedOpportunityDto> = emptyList(),
)

@Serializable data class SavedOpportunityDto(
    val id: String,
    val opportunityId: String = "",
    val title: String = "",
    val employerName: String = "",
    val savedAt: String? = null,
)

@Serializable data class ExternalApplicationsEnvelope(
    val externalApplications: List<ExternalApplicationDto> = emptyList(),
)

@Serializable data class ExternalApplicationDto(
    val id: String,
    val companyName: String = "",
    val roleTitle: String = "",
    val stage: String = "",
    val sourceUrl: String? = null,
    val appliedOn: String? = null,
    val institutionVisible: Boolean = false,
)

// ---------------------------------------------------------------------------
// Support tasks, career targets, academic records
// ---------------------------------------------------------------------------

@Serializable data class StaffActionsEnvelope(val staffActions: List<StaffActionDto> = emptyList())

@Serializable data class StaffActionDto(
    val id: String,
    val actionType: String = "",
    val title: String = "",
    val detail: String? = null,
    val state: String = "",
    val dueAt: String? = null,
)

@Serializable data class CareerRolesEnvelope(val careerRoles: List<CareerRoleDto> = emptyList())

@Serializable data class CareerRoleDto(
    val id: String,
    val code: String = "",
    val title: String = "",
    val family: String = "",
    val summary: String? = null,
    val requirementCount: Int = 0,
)

@Serializable data class CareerTargetsEnvelope(val targets: List<CareerTargetDto> = emptyList())

@Serializable data class CareerTargetDto(
    val id: String,
    val careerRoleId: String = "",
    val title: String = "",
    val family: String = "",
    val priority: String = "",
    val gap: CareerGapDto? = null,
)

@Serializable data class CareerGapDto(
    val requirementsTotal: Int = 0,
    val requirementsMet: Int = 0,
    val requirementsUnknown: Int = 0,
    val items: List<CareerGapItemDto> = emptyList(),
    val progress: CareerProgressDto? = null,
)

@Serializable data class CareerGapItemDto(
    val topicId: String = "",
    val topicTitle: String? = null,
    val requirementLevel: String = "",
    val status: String = "",
    val priorityRank: Int = 0,
)

/**
 * Progress toward a chosen career, over requirements that could actually be measured.
 *
 * This is not readiness and must never be labelled as such on screen. Readiness is an
 * advisory band with no number (ADR-020); this is a count of met requirements with its
 * own denominator, and `percentOfEvaluated` is null when nothing has been measured yet.
 */
@Serializable data class CareerProgressDto(
    val evaluated: Int = 0,
    val met: Int = 0,
    val unknown: Int = 0,
    val percentOfEvaluated: Int? = null,
)

@Serializable data class AcademicRecordsDto(
    val qualifications: List<QualificationDto> = emptyList(),
    val eligibilityFacts: EligibilityFactsDto? = null,
)

@Serializable data class QualificationDto(
    val id: String,
    val institutionName: String? = null,
    val institutionNameDeclared: String? = null,
    val qualificationType: String = "",
    val programmeName: String = "",
    val startedOn: String? = null,
    val completedOn: String? = null,
    val awarded: Boolean = false,
    val verificationState: String = "SELF_REPORTED",
    val terms: List<AcademicTermDto> = emptyList(),
)

@Serializable data class AcademicTermDto(
    val id: String,
    val sequence: Int = 1,
    val label: String = "",
    val resultValue: String? = null,
    val resultScale: String? = null,
    val resultLetter: String? = null,
    val backlogCount: Int? = null,
    val verificationState: String = "SELF_REPORTED",
)

@Serializable data class EligibilityFactsDto(
    val cgpa10: Double? = null,
    val cumulativeBacklogs: Int? = null,
    val hasVerifiedRecord: Boolean = false,
    val termLabel: String? = null,
)

@Serializable data class DocumentEnvelope(val document: DocumentDto)

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

suspend fun Api.opportunityDetail(context: Context, opportunityId: String): OpportunityDetailDto =
    json.decodeFromString<OpportunityDetailEnvelope>(
        request(context, "GET", "/api/v1/opportunities/$opportunityId"),
    ).opportunity

/**
 * Applying carries a consent decision, because it is one.
 *
 * The web app asks whether the student's institution may see this application, and that
 * is a distinct, revocable consent (ADR-019) rather than a side effect of applying. The
 * call this replaces hardcoded consent to true and never asked, which made a privacy
 * choice on the student's behalf.
 */
suspend fun Api.applyToOpportunity(
    context: Context,
    opportunityId: String,
    institutionVisibility: Boolean,
) {
    request(
        context, "POST", "/api/v1/students/me/applications",
        buildJson(
            "opportunityId" to quoted(opportunityId),
            "consentGranted" to "true",
            "institutionVisibilityGranted" to institutionVisibility.toString(),
        ),
    )
}

suspend fun Api.withdrawApplication(context: Context, applicationId: String) {
    request(context, "POST", "/api/v1/students/me/applications/$applicationId/withdraw")
}

suspend fun Api.revokeInstitutionVisibility(context: Context, applicationId: String) {
    request(context, "POST", "/api/v1/students/me/applications/$applicationId/institution-visibility/revoke")
}

suspend fun Api.listOffers(context: Context): List<OfferDto> =
    json.decodeFromString<OffersEnvelope>(request(context, "GET", "/api/v1/students/me/offers")).offers

/** Accepting or declining an offer is the most consequential action in the app. */
suspend fun Api.respondToOffer(context: Context, offerId: String, accept: Boolean) {
    val decision = if (accept) "ACCEPTED" else "DECLINED"
    request(
        context, "POST", "/api/v1/students/me/offers/$offerId/respond",
        buildJson("response" to quoted(decision)),
    )
}

suspend fun Api.listSavedOpportunities(context: Context): List<SavedOpportunityDto> =
    json.decodeFromString<SavedOpportunitiesEnvelope>(
        request(context, "GET", "/api/v1/students/me/saved-opportunities"),
    ).savedOpportunities

suspend fun Api.saveOpportunity(context: Context, opportunityId: String) {
    request(
        context, "POST", "/api/v1/students/me/saved-opportunities",
        buildJson("opportunityId" to quoted(opportunityId)),
    )
}

suspend fun Api.unsaveOpportunity(context: Context, savedOpportunityId: String) {
    request(context, "DELETE", "/api/v1/students/me/saved-opportunities/$savedOpportunityId")
}

suspend fun Api.listExternalApplications(context: Context): List<ExternalApplicationDto> =
    json.decodeFromString<ExternalApplicationsEnvelope>(
        request(context, "GET", "/api/v1/students/me/external-applications"),
    ).externalApplications

suspend fun Api.createExternalApplication(
    context: Context,
    companyName: String,
    roleTitle: String,
    sourceUrl: String?,
) {
    request(
        context, "POST", "/api/v1/students/me/external-applications",
        buildJson(
            "companyName" to quoted(companyName),
            "roleTitle" to quoted(roleTitle),
            "stage" to quoted("APPLIED"),
            *(if (sourceUrl.isNullOrBlank()) emptyArray() else arrayOf("sourceUrl" to quoted(sourceUrl))),
        ),
    )
}

suspend fun Api.deleteExternalApplication(context: Context, id: String) {
    request(context, "DELETE", "/api/v1/students/me/external-applications/$id")
}

/** Institution visibility on a self-declared application is again its own consent. */
suspend fun Api.setExternalApplicationVisibility(context: Context, id: String, visible: Boolean) {
    val action = if (visible) "grant" else "revoke"
    request(context, "POST", "/api/v1/students/me/external-applications/$id/institution-visibility/$action")
}

suspend fun Api.listStaffActions(context: Context, institutionId: String): List<StaffActionDto> =
    json.decodeFromString<StaffActionsEnvelope>(
        request(context, "GET", "/api/v1/students/me/staff-actions?institutionId=$institutionId"),
    ).staffActions

suspend fun Api.completeStaffAction(context: Context, actionId: String, note: String) {
    request(
        context, "POST", "/api/v1/students/me/staff-actions/$actionId/complete",
        buildJson("note" to quoted(note)),
    )
}

suspend fun Api.careerRoleCatalog(context: Context): List<CareerRoleDto> =
    json.decodeFromString<CareerRolesEnvelope>(
        request(context, "GET", "/api/v1/career-targets/catalog"),
    ).careerRoles

suspend fun Api.careerTargets(context: Context): List<CareerTargetDto> =
    json.decodeFromString<CareerTargetsEnvelope>(
        request(context, "GET", "/api/v1/students/me/career-targets"),
    ).targets

suspend fun Api.setCareerTarget(context: Context, careerRoleId: String) {
    request(
        context, "POST", "/api/v1/students/me/career-targets",
        buildJson("careerRoleId" to quoted(careerRoleId), "priority" to quoted("PRIMARY")),
    )
}

suspend fun Api.clearCareerTarget(context: Context, targetId: String) {
    request(context, "DELETE", "/api/v1/students/me/career-targets/$targetId")
}

suspend fun Api.transitionRoadmapAction(context: Context, actionId: String, toState: String) {
    request(
        context, "POST", "/api/v1/students/me/roadmap-actions/$actionId/transition",
        buildJson("toState" to quoted(toState)),
    )
}

suspend fun Api.academicRecords(context: Context): AcademicRecordsDto =
    json.decodeFromString(request(context, "GET", "/api/v1/students/me/academic-records"))

suspend fun Api.declareQualification(
    context: Context,
    institutionId: String?,
    institutionNameDeclared: String?,
    qualificationType: String,
    programmeName: String,
) {
    request(
        context, "POST", "/api/v1/students/me/academic-records/qualifications",
        buildJson(
            *(if (institutionId.isNullOrBlank()) {
                arrayOf("institutionNameDeclared" to quoted(institutionNameDeclared ?: ""))
            } else {
                arrayOf("institutionId" to quoted(institutionId))
            }),
            "qualificationType" to quoted(qualificationType),
            "programmeName" to quoted(programmeName),
        ),
    )
}

suspend fun Api.declareTerm(
    context: Context,
    qualificationId: String,
    sequence: Int,
    label: String,
    resultValue: String?,
    resultScale: String?,
    backlogCount: Int?,
) {
    request(
        context, "POST", "/api/v1/students/me/academic-records/qualifications/$qualificationId/terms",
        buildJson(
            "sequence" to sequence.toString(),
            "label" to quoted(label),
            *(if (resultValue.isNullOrBlank() || resultScale.isNullOrBlank()) {
                emptyArray()
            } else {
                arrayOf("resultValue" to resultValue, "resultScale" to quoted(resultScale))
            }),
            *(if (backlogCount == null) emptyArray() else arrayOf("backlogCount" to backlogCount.toString())),
        ),
    )
}

suspend fun Api.submitTermForVerification(context: Context, termId: String) {
    request(context, "POST", "/api/v1/students/me/academic-records/terms/$termId/submit")
}

suspend fun Api.requestDeletion(context: Context) {
    request(context, "POST", "/api/v1/students/me/privacy/deletions")
}

suspend fun Api.cancelPrivacyRequest(context: Context, requestId: String) {
    request(context, "POST", "/api/v1/students/me/privacy/requests/$requestId/cancel")
}

suspend fun Api.createDocument(
    context: Context,
    documentType: String,
    title: String,
): DocumentDto =
    json.decodeFromString<DocumentEnvelope>(
        request(
            context, "POST", "/api/v1/students/me/documents",
            buildJson("documentType" to quoted(documentType), "title" to quoted(title)),
        ),
    ).document

suspend fun Api.archiveDocument(context: Context, documentId: String) {
    request(context, "DELETE", "/api/v1/students/me/documents/$documentId")
}

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

/**
 * Build a flat JSON object from already-encoded values.
 *
 * String interpolation into JSON is how a stray quote in a company name becomes a 400,
 * so every string value goes through `quoted`, which escapes properly. Numbers and
 * booleans are passed through as-is by the caller.
 */
internal fun buildJson(vararg pairs: Pair<String, String>): String =
    pairs.joinToString(prefix = "{", postfix = "}") { (key, value) -> "\"$key\":$value" }

/** JSON string escaping. A resume titled `My "best" CV` must not break the request. */
internal fun quoted(value: String): String {
    val escaped = StringBuilder(value.length + 2)
    for (character in value) {
        when (character) {
            '"' -> escaped.append("\\\"")
            '\\' -> escaped.append("\\\\")
            '\n' -> escaped.append("\\n")
            '\r' -> escaped.append("\\r")
            '\t' -> escaped.append("\\t")
            else -> if (character < ' ') escaped.append("\\u%04x".format(character.code)) else escaped.append(character)
        }
    }
    return "\"$escaped\""
}

// ---------------------------------------------------------------------------
// Career-readiness assessments
// ---------------------------------------------------------------------------
//
// Distinct from institution exams, which stay off mobile by policy
// (MOBILE_FOUNDATION.md): those are proctored, timed and carry integrity telemetry.
// These are short, untimed multiple-choice sets that feed the readiness band, and
// there is no reason a student should have to find a laptop for one.

@Serializable data class ReadinessCatalogDto(
    val assessments: List<ReadinessAssessmentDto> = emptyList(),
)

@Serializable data class ReadinessAssessmentDto(
    val id: String,
    val title: String = "",
    val selectionCount: Int = 0,
    val timeLimitSeconds: Int = 0,
)

@Serializable data class ReadinessAttemptDto(
    val attemptId: String,
    val expiresAt: String = "",
    val questions: List<ReadinessQuestionDto> = emptyList(),
    // True when the server handed back an attempt that was already open rather than
    // starting a fresh one. The clock has been running since it was first started, so
    // the student is told instead of quietly being given less time than they expect.
    val resumed: Boolean = false,
)

@Serializable data class ReadinessQuestionDto(
    val id: String,
    val prompt: String = "",
    val options: List<ReadinessOptionDto> = emptyList(),
)

@Serializable data class ReadinessOptionDto(val id: String, val text: String = "")

suspend fun Api.readinessCatalog(context: Context): List<ReadinessAssessmentDto> =
    json.decodeFromString<ReadinessCatalogDto>(
        request(context, "GET", "/api/v1/career-readiness/catalog"),
    ).assessments

suspend fun Api.startReadinessAttempt(context: Context, assessmentId: String): ReadinessAttemptDto =
    json.decodeFromString(
        request(context, "POST", "/api/v1/career-readiness/assessments/$assessmentId/attempts"),
    )

/**
 * Submit an attempt.
 *
 * The server requires an Idempotency-Key on this route, because a retry on a flaky
 * mobile connection must not be able to submit twice — and on this route a second
 * submission would be a second attempt against a one-attempt-per-blueprint limit.
 */
suspend fun Api.submitReadinessAttempt(
    context: Context,
    attemptId: String,
    selectedOptions: Map<String, String>,
    idempotencyKey: String,
) {
    val answers = selectedOptions.entries.joinToString(prefix = "{", postfix = "}") { (question, option) ->
        "${quoted(question)}:${quoted(option)}"
    }
    request(
        context, "POST", "/api/v1/career-readiness/attempts/$attemptId/submit",
        """{"selectedOptions":$answers}""", idempotencyKey,
    )
}
