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

/** The verdict sits beside the opportunity in the response, not inside it (EMP-06). */
@Serializable data class OpportunityDetailEnvelope(
    val opportunity: OpportunityDetailDto,
    val eligibility: EligibilityDto? = null,
    /** EMP-11: beside the opportunity too, like the verdict. */
    val campusDrives: List<StudentCampusDriveDto> = emptyList(),
)

/**
 * EMP-11: a campus drive through which this job reaches the student, the placement policy their
 * college has in force for it, and whether that policy stops this student applying.
 */
@Serializable data class StudentCampusDriveDto(
    val institutionName: String = "",
    val state: String = "",
    val scheduledStartAt: String? = null,
    val scheduledEndAt: String? = null,
    val venueMode: String? = null,
    val offerHoldersEligible: Boolean = false,
    val placementPolicy: StudentPlacementPolicyDto? = null,
    val blocksYou: Boolean = false,
)
@Serializable data class StudentPlacementPolicyDto(
    val policyType: String = "",
    val allowDriveExceptions: Boolean = false,
    val note: String? = null,
)

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
    /** Filled from the envelope by [Api.opportunityDetail]. */
    val eligibility: EligibilityDto? = null,
    /** EMP-06: objects, not strings — decoding them as strings failed once employers set skills. */
    val skills: List<OpportunitySkillDto> = emptyList(),
    val selectionStages: List<SelectionStageDto> = emptyList(),
    /** EMP-04: the hiring company's verified profile. Absent from older API responses. */
    val company: OpportunityCompanyDto? = null,
    /** Filled from the envelope by [Api.opportunityDetail] (EMP-11). */
    val campusDrives: List<StudentCampusDriveDto> = emptyList(),
)

/** What a student sees about the company behind a job (EMP-04). Unfilled fields are null. */
@Serializable data class OpportunityCompanyDto(
    val displayName: String? = null,
    val industry: String? = null,
    val companySizeBand: String? = null,
    val about: String? = null,
    val websiteUrl: String? = null,
    val careersPageUrl: String? = null,
    val city: String? = null,
    val stateOrProvince: String? = null,
    val countryCode: String? = null,
)

/** A skill a job asks for; `catalogue` when picked from the ONE skill catalogue (EMP-06). */
@Serializable data class OpportunitySkillDto(
    val name: String = "",
    val level: String = "REQUIRED",
    val catalogue: Boolean = false,
)

/** One step of a job's selection process, in order. */
@Serializable data class SelectionStageDto(
    val order: Int = 0,
    val kind: String = "",
    val label: String = "",
    val detail: String? = null,
    val applicationState: String? = null,
)

/**
 * The eligibility verdict, as the API sends it (EMP-06).
 *
 * "Cannot be confirmed" is not a soft "not eligible". The engine fails closed on a fact
 * nobody has recorded — most often a CGPA with no academic term behind it — and telling a
 * student they are ineligible when the truth is "we cannot tell yet" would be a lie they can
 * do something about.
 */
@Serializable data class EligibilityDto(
    val eligible: Boolean = false,
    val blockingFailures: List<String> = emptyList(),
    val advisoryFailures: List<String> = emptyList(),
    val needsMoreInformation: List<String> = emptyList(),
    val rules: List<EligibilityRuleOutcomeDto> = emptyList(),
)

/** One rule: met or not, on what basis, and the student's own value. */
@Serializable data class EligibilityRuleOutcomeDto(
    val ruleType: String = "",
    val comparator: String = "",
    val valueNumeric: Double? = null,
    val valueText: String? = null,
    val displayValue: String? = null,
    val isBlocking: Boolean = true,
    val outcome: String = "UNKNOWN",
    val basis: String? = null,
    val unknownReason: String? = null,
    val yourValue: String? = null,
)

@Serializable data class OffersEnvelope(val offers: List<OfferDto> = emptyList())

@Serializable data class OfferDto(
    val id: String,
    val applicationId: String = "",
    val employerName: String = "",
    val title: String = "",
    val state: String = "",
    val respondBy: String? = null,
    /** The API names the deadline offerExpiresAt; respondBy was never sent, so the date never showed. */
    val offerExpiresAt: String? = null,
    val extendedAt: String? = null,
)

/**
 * EMP-08: one of the student's own interviews. Where and how to join arrive only while it is
 * still ahead; the employer's cancellation reason and panel are never sent.
 */
@Serializable data class StudentInterviewsEnvelope(val interviews: List<StudentInterviewDto> = emptyList())

@Serializable data class StudentInterviewDto(
    val id: String,
    val employerName: String = "",
    val title: String = "",
    val roundNumber: Int = 1,
    val stageLabel: String? = null,
    val applicationState: String = "",
    val mode: String = "",
    val state: String = "",
    val upcoming: Boolean = false,
    val scheduledStart: String? = null,
    val scheduledEnd: String? = null,
    val locationDetail: String? = null,
    val joiningLink: String? = null,
    val preparationNote: String? = null,
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

/** The API answers `{ actions: [...] }` with `note`, `version` and `canComplete` (staff-actions.controller.ts). */
@Serializable data class StaffActionsEnvelope(val actions: List<StaffActionDto> = emptyList())

@Serializable data class StaffActionDto(
    val id: String,
    val actionType: String = "",
    val title: String = "",
    val note: String? = null,
    val state: String = "",
    val dueAt: String? = null,
    val version: Int = 1,
    val canComplete: Boolean = false,
)

/** INST-11: a counselling note the student's college chose to share. Staff-only notes never reach this read. */
@Serializable data class SharedCounsellingNotesEnvelope(val notes: List<SharedCounsellingNoteDto> = emptyList())

@Serializable data class SharedCounsellingNoteDto(
    val id: String,
    val title: String = "",
    val note: String = "",
    val createdAt: String? = null,
    val authorRole: String = "",
)

@Serializable data class CareerRolesEnvelope(val careerRoles: List<CareerRoleDto> = emptyList())

@Serializable data class CareerRoleDto(
    val id: String,
    val code: String = "",
    val title: String = "",
    val family: String = "",
    val summary: String? = null,
    val requirementCount: Int = 0,
    // OPS-08: set only while the full job-role catalogue is open to this student (the
    // career-catalogue.selectable-roles flag); null otherwise, when only starter roles are offered.
    val releaseLabel: String? = null,
    val catalogueCode: String? = null,
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

// --- Public profile and photo -------------------------------------------------

@Serializable data class ShareSectionsDto(
    val showPhoto: Boolean = false,
    val showHeadline: Boolean = true,
    val showCity: Boolean = true,
    val showInstitution: Boolean = true,
    val showEducation: Boolean = true,
    val showSelfReported: Boolean = true,
    val showAssessments: Boolean = false,
    val showLearning: Boolean = true,
    val showCertificates: Boolean = true,
    val showSkills: Boolean = true,
    val showPortfolio: Boolean = true,
)

@Serializable data class ShareLinkDto(
    val id: String = "",
    val coverKey: String = "MIDNIGHT",
    val sections: ShareSectionsDto = ShareSectionsDto(),
    val expiresAt: String = "",
    val lastViewedAt: String? = null,
    val expired: Boolean = false,
    /** Returned once, when the link is created. Never available again. */
    val token: String? = null,
)

@Serializable data class ShareLinkEnvelope(val link: ShareLinkDto? = null, val hasPhoto: Boolean = false)

// --- Learner content ----------------------------------------------------------

@Serializable data class LearnerContentEnvelope(val items: List<LearnerContentItemDto> = emptyList())

@Serializable data class LearnerContentItemDto(
    val id: String = "",
    val contentType: String = "",
    val title: String = "",
    val summary: String? = null,
    val publishedAt: String? = null,
)

// --- Employer screening tests -------------------------------------------------

@Serializable data class ScreeningInvitationsEnvelope(val invitations: List<ScreeningInvitationDto> = emptyList())

@Serializable data class ScreeningInvitationDto(
    val id: String = "",
    val state: String = "",
    val opensAt: String = "",
    val closesAt: String = "",
    val title: String = "",
    val durationSeconds: Int = 0,
    val employerName: String = "",
    val roleTitle: String = "",
    val attemptId: String? = null,
    val attemptState: String? = null,
    val percentage: Double? = null,
    /** EMP-12: can be started or continued now (employer in good standing, application shared, window open). */
    val available: Boolean = true,
    val questionCount: Int = 0,
    val totalMarks: Double = 0.0,
    val remainingSeconds: Int? = null,
)

/** EMP-12: what the candidate is about to be assessed on, read before starting. */
@Serializable data class ScreeningBriefEnvelope(val assessment: ScreeningBriefDto)

@Serializable data class ScreeningBriefDto(
    val id: String = "",
    val title: String = "",
    val employerName: String = "",
    val roleTitle: String = "",
    val state: String = "",
    val attemptState: String? = null,
    val opensAt: String = "",
    val closesAt: String = "",
    val notOpenYet: Boolean = false,
    val durationSeconds: Int = 0,
    val totalMarks: Double = 0.0,
    val questionCount: Int = 0,
    val questionFormats: List<ScreeningFormatDto> = emptyList(),
    val minutesAvailableIfStartedNow: Int? = null,
    val available: Boolean = false,
)

@Serializable data class ScreeningFormatDto(val questionType: String = "", val count: Int = 0)

@Serializable data class ScreeningAttemptEnvelope(val attempt: ScreeningAttemptDto)

@Serializable data class ScreeningAttemptDto(
    val id: String = "",
    val title: String? = null,
    /** Seconds left by the server's clock when the paper was sent; the server enforces it. */
    val remainingSeconds: Int? = null,
    val questions: List<ScreeningQuestionDto> = emptyList(),
)

@Serializable data class ScreeningQuestionDto(
    val questionId: String = "",
    val displayOrder: Int = 0,
    val questionText: String = "",
    val questionType: String = "",
    val marks: Double = 0.0,
    /** In this candidate's own key order. Nothing here says which is correct. */
    val options: List<ScreeningOptionDto> = emptyList(),
    val selectedOptionKeys: List<String> = emptyList(),
)

@Serializable data class ScreeningOptionDto(val key: String = "", val text: String = "")

@Serializable data class ScreeningResultEnvelope(val result: ScreeningResultDto)

@Serializable data class ScreeningResultDto(
    val score: Double = 0.0,
    val maxScore: Double = 0.0,
    val percentage: Double = 0.0,
)

@Serializable data class InstitutionDirectoryEnvelope(val institutions: List<DirectoryInstitutionDto> = emptyList())

@Serializable data class DirectoryInstitutionDto(
    val id: String = "",
    val name: String = "",
    val city: String? = null,
    val stateOrProvince: String? = null,
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
    /** INSTITUTION_IMPORTED when the college recorded it in a results upload (INST-04). */
    val source: String = "STUDENT_DECLARED",
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
    ).let { envelope -> envelope.opportunity.copy(eligibility = envelope.eligibility, campusDrives = envelope.campusDrives) }

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

// EMP-05: the employer changed a term the student applied under. The student sees what they
// applied under and what the job says now, and accepts or declines; declining withdraws.

@Serializable data class TermsChangeEnvelope(val termsChange: TermsChangeDto? = null)

@Serializable data class TermsChangeDto(
    val toVersionId: String,
    val employerName: String = "",
    val changedTerms: List<String> = emptyList(),
    val appliedTerms: StudentTermsDto = StudentTermsDto(),
    val newTerms: StudentTermsDto = StudentTermsDto(),
)

@Serializable data class StudentTermsDto(
    val title: String = "",
    val employmentType: String = "",
    val workMode: String = "",
    val locationCity: String? = null,
    val durationMonths: Int? = null,
    val compensation: TermsCompensationDto? = null,
    val joiningConditions: String? = null,
    val applicationDeadline: String? = null,
    /** EMP-06: the rules under those terms; a college is named, never identified. */
    val eligibility: List<TermsEligibilityRuleDto> = emptyList(),
)

@Serializable data class TermsEligibilityRuleDto(
    val ruleType: String = "",
    val comparator: String = "",
    val valueNumeric: Double? = null,
    val valueText: String? = null,
    val isBlocking: Boolean = true,
    val displayValue: String? = null,
)

@Serializable data class TermsCompensationDto(
    val currency: String = "",
    val min: String = "",
    val max: String? = null,
    val period: String = "",
)

/** Null when nothing is waiting for the student's answer on this application. */
suspend fun Api.termsChange(context: Context, applicationId: String): TermsChangeDto? =
    json.decodeFromString<TermsChangeEnvelope>(
        request(context, "GET", "/api/v1/students/me/applications/$applicationId/terms-change"),
    ).termsChange

/** Answers for the exact version shown; the server refuses it if the job changed again meanwhile. */
suspend fun Api.respondToTermsChange(context: Context, applicationId: String, accept: Boolean, toVersionId: String) {
    val decision = if (accept) "acknowledge" else "decline"
    request(
        context, "POST", "/api/v1/students/me/applications/$applicationId/terms-change/$decision",
        buildJson("toVersionId" to quoted(toVersionId)),
    )
}

suspend fun Api.withdrawApplication(context: Context, applicationId: String) {
    request(context, "POST", "/api/v1/students/me/applications/$applicationId/withdraw")
}

/** INST-09: share an application with the student's college after applying; revocable at any time. */
suspend fun Api.grantInstitutionVisibility(context: Context, applicationId: String) {
    request(context, "POST", "/api/v1/students/me/applications/$applicationId/institution-visibility/grant")
}

suspend fun Api.revokeInstitutionVisibility(context: Context, applicationId: String) {
    request(context, "POST", "/api/v1/students/me/applications/$applicationId/institution-visibility/revoke")
}

/** EMP-08: the student's interviews, upcoming first (soonest first), then past. */
suspend fun Api.listStudentInterviews(context: Context): List<StudentInterviewDto> =
    json.decodeFromString<StudentInterviewsEnvelope>(request(context, "GET", "/api/v1/students/me/interviews")).interviews

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
    ).actions

/** Completion names the version the student saw, so a changed item is refused rather than overwritten. */
suspend fun Api.completeStaffAction(context: Context, actionId: String, version: Int, note: String) {
    request(
        context, "POST", "/api/v1/students/me/staff-actions/$actionId/complete",
        buildJson("version" to version.toString(), "responseNote" to quoted(note)),
    )
}

suspend fun Api.listSharedCounsellingNotes(context: Context, institutionId: String): List<SharedCounsellingNoteDto> =
    json.decodeFromString<SharedCounsellingNotesEnvelope>(
        request(context, "GET", "/api/v1/students/me/counselling-notes?institutionId=$institutionId"),
    ).notes

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

// --- Goals and onboarding (ENG-19) --------------------------------------------
// The same contract as the web: live goals, whether the student is still onboarding, the skills the goals
// need (each once), goal options searched by name and synonym, and "Not sure yet". Statuses and reasons
// only; never a readiness value or a score.

@Serializable data class GoalRoleRefDto(
    val careerRoleId: String = "",
    val targetId: String = "",
    val code: String = "",
    val title: String = "",
    val family: String = "",
    val releaseLabel: String? = null,
)

@Serializable data class GoalTopicRefDto(val topicId: String = "", val name: String = "")

@Serializable data class GoalCatalogueRefDto(val code: String = "", val title: String = "", val release: String = "")

@Serializable data class LearnerGoalDto(
    val id: String,
    val goalType: String = "",
    val priority: String = "SECONDARY",
    val origin: String = "",
    val role: GoalRoleRefDto? = null,
    val topic: GoalTopicRefDto? = null,
    val catalogueGoal: GoalCatalogueRefDto? = null,
) {
    val title: String get() = role?.title ?: topic?.name ?: catalogueGoal?.title ?: "Exploring roles"
}

@Serializable data class GoalSkillLinkDto(val goalId: String = "", val goalType: String = "", val status: String? = null)

@Serializable data class GoalSkillDto(val topicId: String = "", val topicTitle: String? = null, val goals: List<GoalSkillLinkDto> = emptyList())

@Serializable data class GoalSkillsDto(val skills: List<GoalSkillDto> = emptyList())

@Serializable data class LearnerGoalsDto(
    val onboarding: Boolean = true,
    val catalogueOpen: Boolean = false,
    val goals: List<LearnerGoalDto> = emptyList(),
    val skills: GoalSkillsDto = GoalSkillsDto(),
)

@Serializable data class GoalRoleOptionDto(
    val id: String,
    val code: String = "",
    val title: String = "",
    val family: String = "",
    val summary: String? = null,
    val releaseLabel: String? = null,
    val catalogueCode: String? = null,
    val matchedSynonym: String? = null,
)

@Serializable data class GoalTopicOptionDto(val id: String, val name: String = "")

@Serializable data class GoalCatalogueOptionDto(val code: String, val title: String = "", val goalType: String = "", val release: String = "")

@Serializable data class GoalOptionsDto(
    val catalogueOpen: Boolean = false,
    val roles: List<GoalRoleOptionDto> = emptyList(),
    val topics: List<GoalTopicOptionDto> = emptyList(),
    val catalogueGoals: List<GoalCatalogueOptionDto> = emptyList(),
)

@Serializable data class SurveyChoiceDto(val code: String, val label: String = "")

@Serializable data class DiscoverySurveyDto(
    val interests: List<SurveyChoiceDto> = emptyList(),
    val strengths: List<SurveyChoiceDto> = emptyList(),
    val branches: List<String> = emptyList(),
)

@Serializable data class DiscoveryAnswersDto(
    val interests: List<String> = emptyList(),
    val strengths: List<String> = emptyList(),
    val branch: String = "",
)

@Serializable data class DiscoveryReasonDto(val code: String = "", val detail: String? = null)

@Serializable data class DiscoverySuggestionDto(val role: GoalRoleOptionDto, val reasons: List<DiscoveryReasonDto> = emptyList())

@Serializable data class DiscoveryResultDto(
    val suggestions: List<DiscoverySuggestionDto> = emptyList(),
    val usedShownSkills: Boolean = false,
    val fewerThanMinimum: Boolean = false,
)

@Serializable data class CareerDiscoveryDto(
    val survey: DiscoverySurveyDto = DiscoverySurveyDto(),
    val answers: DiscoveryAnswersDto? = null,
    val result: DiscoveryResultDto? = null,
)

@Serializable data class CareerDiscoveryEnvelope(val discovery: CareerDiscoveryDto = CareerDiscoveryDto())

private fun jsonStrings(values: List<String>): String = values.joinToString(prefix = "[", postfix = "]") { quoted(it) }

suspend fun Api.learnerGoals(context: Context): LearnerGoalsDto =
    json.decodeFromString<LearnerGoalsDto>(request(context, "GET", "/api/v1/students/me/goals"))

suspend fun Api.goalOptions(context: Context, query: String): GoalOptionsDto =
    json.decodeFromString<GoalOptionsDto>(
        request(context, "GET", "/api/v1/students/me/goals/options?q=" + java.net.URLEncoder.encode(query.trim(), "UTF-8")),
    )

suspend fun Api.setRoleGoal(context: Context, careerRoleId: String, primary: Boolean, origin: String): LearnerGoalsDto =
    json.decodeFromString<LearnerGoalsDto>(
        request(
            context, "POST", "/api/v1/students/me/goals",
            buildJson(
                "goalType" to quoted("ROLE"), "careerRoleId" to quoted(careerRoleId),
                "priority" to quoted(if (primary) "PRIMARY" else "SECONDARY"), "origin" to quoted(origin),
            ),
        ),
    )

suspend fun Api.setTopicGoal(context: Context, topicId: String): LearnerGoalsDto =
    json.decodeFromString<LearnerGoalsDto>(
        request(
            context, "POST", "/api/v1/students/me/goals",
            buildJson("goalType" to quoted("TOPIC"), "topicId" to quoted(topicId), "origin" to quoted("GOALS")),
        ),
    )

suspend fun Api.setCatalogueGoal(context: Context, goalType: String, code: String): LearnerGoalsDto =
    json.decodeFromString<LearnerGoalsDto>(
        request(
            context, "POST", "/api/v1/students/me/goals",
            buildJson("goalType" to quoted(goalType), "catalogueGoalCode" to quoted(code), "origin" to quoted("GOALS")),
        ),
    )

suspend fun Api.endGoal(context: Context, goalId: String, status: String): LearnerGoalsDto =
    json.decodeFromString<LearnerGoalsDto>(
        request(context, "POST", "/api/v1/students/me/goals/$goalId/end", buildJson("status" to quoted(status))),
    )

suspend fun Api.careerDiscovery(context: Context): CareerDiscoveryDto =
    json.decodeFromString<CareerDiscoveryEnvelope>(request(context, "GET", "/api/v1/students/me/goals/discovery")).discovery

suspend fun Api.submitCareerDiscovery(
    context: Context, interests: List<String>, strengths: List<String>, branch: String, origin: String,
): CareerDiscoveryDto =
    json.decodeFromString<CareerDiscoveryEnvelope>(
        request(
            context, "POST", "/api/v1/students/me/goals/discovery",
            buildJson(
                "interests" to jsonStrings(interests), "strengths" to jsonStrings(strengths),
                "branch" to quoted(branch), "origin" to quoted(origin),
            ),
        ),
    ).discovery

suspend fun Api.transitionRoadmapAction(context: Context, actionId: String, toState: String) {
    request(
        context, "POST", "/api/v1/students/me/roadmap-actions/$actionId/transition",
        buildJson("toState" to quoted(toState)),
    )
}

/**
 * Institutions a student can name as the issuer of a qualification.
 *
 * Verified institutions only -- an unverified organization cannot meaningfully confirm
 * anything, so listing it would only produce a request nobody can answer.
 */
/** Published learner content. Empty until somebody publishes something, which is honest. */
suspend fun Api.readShareLink(context: Context): ShareLinkEnvelope =
    json.decodeFromString(request(context, "GET", "/api/v1/students/me/public-profile"))

suspend fun Api.publishShareLink(context: Context): ShareLinkDto =
    json.decodeFromString<ShareLinkEnvelope>(
        request(context, "POST", "/api/v1/students/me/public-profile", "{}")).link
        ?: throw Api.ApiException(500, "NO_LINK")

suspend fun Api.updateShareSections(context: Context, key: String, value: Boolean): ShareLinkDto =
    json.decodeFromString<ShareLinkEnvelope>(
        request(
            context, "POST", "/api/v1/students/me/public-profile/settings",
            "{\"sections\":{\"" + key + "\":" + value + "}}",
        ),
    ).link ?: throw Api.ApiException(500, "NO_LINK")

suspend fun Api.extendShareLink(context: Context, days: Int): ShareLinkDto =
    json.decodeFromString<ShareLinkEnvelope>(
        request(context, "POST", "/api/v1/students/me/public-profile/settings", "{\"days\":" + days + "}"),
    ).link ?: throw Api.ApiException(500, "NO_LINK")

suspend fun Api.revokeShareLink(context: Context) {
    request(context, "DELETE", "/api/v1/students/me/public-profile")
}

/**
 * Uploads the photo to the platform rather than the device, so the web app and a
 * reinstalled phone see the same face. Replaces the local-only file this app used to keep.
 */
suspend fun Api.uploadProfilePhoto(context: Context, contentType: String, base64: String) {
    request(
        context, "POST", "/api/v1/students/me/profile-photo",
        buildJson("contentType" to quoted(contentType), "data" to quoted(base64)),
    )
}

suspend fun Api.listLearnerContent(context: Context, contentType: String): List<LearnerContentItemDto> =
    json.decodeFromString<LearnerContentEnvelope>(
        request(context, "GET", "/api/v1/learner-content?contentType=" + contentType)).items

suspend fun Api.listScreeningInvitations(context: Context): List<ScreeningInvitationDto> =
    json.decodeFromString<ScreeningInvitationsEnvelope>(
        request(context, "GET", "/api/v1/students/me/screening-assessments")).invitations

suspend fun Api.getScreeningBrief(context: Context, invitationId: String): ScreeningBriefDto =
    json.decodeFromString<ScreeningBriefEnvelope>(
        request(context, "GET", "/api/v1/students/me/screening-assessments/$invitationId")).assessment

/** EMP-12: starting records that the candidate read the brief and accepts its terms. */
suspend fun Api.startScreeningAttempt(context: Context, invitationId: String): ScreeningAttemptDto =
    json.decodeFromString<ScreeningAttemptEnvelope>(
        request(context, "POST", "/api/v1/students/me/screening-assessments/$invitationId/start",
            buildJson("acknowledged" to "true"))).attempt

suspend fun Api.saveScreeningAnswer(context: Context, attemptId: String, questionId: String, keys: List<String>) {
    val encoded = keys.joinToString(",") { quoted(it) }
    request(
        context, "POST", "/api/v1/students/me/screening-attempts/$attemptId/answers",
        buildJson("questionId" to quoted(questionId), "selectedOptionKeys" to "[$encoded]"),
    )
}

suspend fun Api.submitScreeningAttempt(context: Context, attemptId: String): ScreeningResultDto =
    json.decodeFromString<ScreeningResultEnvelope>(
        request(context, "POST", "/api/v1/students/me/screening-attempts/$attemptId/submit")).result

suspend fun Api.searchInstitutions(context: Context, query: String): List<DirectoryInstitutionDto> =
    json.decodeFromString<InstitutionDirectoryEnvelope>(
        request(context, "GET", "/api/v1/institutions/directory?q=" + java.net.URLEncoder.encode(query, "UTF-8"))
    ).institutions

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
