package pro.ai8ht.one

import android.content.Context
import kotlinx.serialization.Serializable

/**
 * The employer side: moving a candidate along, interviews, offers, and the scorecard an
 * interviewer fills in.
 *
 * The app could previously only read an employer's roles and applicants. Everything that
 * changes a candidate's situation happened on a laptop, which is the wrong place for it —
 * a recruiter moving someone to shortlist, or an interviewer writing up a panel they have
 * just left, is doing it between other things and usually not at a desk.
 */

@Serializable data class InterviewsEnvelope(val interviews: List<InterviewDto> = emptyList())

@Serializable data class InterviewDto(
    val id: String,
    val applicationId: String = "",
    val candidateName: String? = null,
    val consentRevoked: Boolean = false,
    val candidateAccess: Boolean = true,
    val opportunityTitle: String = "",
    val stage: String = "",
    val state: String = "",
    val scheduledStart: String? = null,
    val scheduledEnd: String? = null,
    val mode: String? = null,
    val location: String? = null,
    // What the API sends; `opportunityTitle` stays for older callers.
    val title: String = "",
    val roundNumber: Int = 1,
    // EMP-09: the job stage, its scorecard template, and the latest change with its reason.
    val stageLabel: String? = null,
    val scorecardTemplate: ScorecardTemplateRefDto? = null,
    val lastChange: InterviewLastChangeDto? = null,
    val outcomeCount: Int = 0,
    val closedAt: String? = null,
) {
    val displayTitle: String get() = title.ifBlank { opportunityTitle }
}

@Serializable data class InterviewBriefEnvelope(val interview: InterviewBriefDto)

@Serializable data class InterviewBriefDto(
    val id: String,
    val candidateName: String? = null,
    val consentRevoked: Boolean = false,
    val candidateAccess: Boolean = true,
    val candidateEmail: String? = null,
    val opportunityTitle: String = "",
    val opportunitySummary: String? = null,
    val responsibilities: String? = null,
    val stage: String = "",
    val state: String = "",
    val scheduledStart: String? = null,
    val outcomeRecorded: Boolean = false,
    // What the API sends for the brief (EMP-08/EMP-09).
    val title: String = "",
    val summary: String? = null,
    val scheduledEnd: String? = null,
    val mode: String? = null,
    val roundNumber: Int = 1,
    val locationDetail: String? = null,
    val joiningLink: String? = null,
    val canRecordOutcome: Boolean = false,
    val stageLabel: String? = null,
    val scorecardTemplate: ScorecardTemplateDto? = null,
)

@Serializable data class EmployerOffersEnvelope(val offers: List<EmployerOfferDto> = emptyList())

@Serializable data class EmployerOfferDto(
    val id: String,
    val applicationId: String = "",
    val candidateName: String? = null,
    val consentRevoked: Boolean = false,
    val candidateAccess: Boolean = true,
    val opportunityTitle: String = "",
    val state: String = "",
    val respondBy: String? = null,
)

/**
 * What to show where a candidate's name goes. The server withholds the person once they
 * withdraw or once their applicant-access grant ends (the application closed, the grant
 * expired, or their account is being deleted); the row stays so the pipeline adds up, and
 * the label says plainly why the name is missing.
 */
fun candidateLabel(name: String?, consentRevoked: Boolean, candidateAccess: Boolean): String = when {
    consentRevoked -> "Withdrawn — details no longer shared"
    !candidateAccess -> "Details no longer shared"
    else -> name ?: "Candidate"
}

/**
 * EMP-15: the Dashboard's figures, computed by the server in one read. Each is a count of rows the
 * employer's own lists already show, so they are exact; `null` in the app means "could not be
 * read" and every slot then reads NA.
 */
@Serializable data class EmployerSummaryEnvelope(val summary: EmployerSummaryDto)
@Serializable data class EmployerSummaryDto(
    val openJobs: Int = 0,
    val newApplicantsLast7Days: Int = 0,
    val interviewsThisWeek: Int = 0,
    val offersPending: Int = 0,
    val drivesAwaitingApproval: Int = 0,
    val drivesChangesRequested: Int = 0,
    val applicationsTotal: Int = 0,
    val openApplications: Int = 0,
    val hires: Int = 0,
    val currentStages: Map<String, Int> = emptyMap(),
)

/**
 * EMP-15 reports. Figures about people arrive already suppressed: a withheld one has no value and
 * reads "<5"; a withheld total reads "Withheld". The app never adds withheld cells together.
 */
@Serializable data class ReportCountDto(val suppressed: Boolean = true, val value: Int? = null)
@Serializable data class ReportCellDto(val key: String, val count: Int? = null, val suppressed: Boolean = true)
@Serializable data class ReportTableDto(
    val suppressed: Boolean = true,
    val total: ReportCountDto = ReportCountDto(),
    val cells: List<ReportCellDto> = emptyList(),
)
@Serializable data class ReportJobDto(val opportunityId: String, val referenceCode: String? = null, val title: String? = null, val table: ReportTableDto = ReportTableDto())
@Serializable data class ReportCollegeDto(val collegeName: String? = null, val table: ReportTableDto = ReportTableDto())
@Serializable data class ReportDriveDto(val driveId: String, val opportunityTitle: String? = null, val institutionName: String = "", val state: String = "", val table: ReportTableDto = ReportTableDto())
@Serializable data class ReportDurationDto(val metric: String, val applications: ReportCountDto = ReportCountDto(), val medianDays: Double? = null)
@Serializable data class ReportOffersDto(val table: ReportTableDto = ReportTableDto(), val acceptanceRate: Double? = null)
@Serializable data class EmployerReportsDto(
    val threshold: Int = 5,
    val overall: ReportTableDto = ReportTableDto(),
    val byJob: List<ReportJobDto> = emptyList(),
    val byCollege: List<ReportCollegeDto> = emptyList(),
    val byDrive: List<ReportDriveDto> = emptyList(),
    val timeToStage: List<ReportDurationDto> = emptyList(),
    val offers: ReportOffersDto = ReportOffersDto(),
)
@Serializable data class EmployerReportsEnvelope(val reports: EmployerReportsDto)

/** A report figure as it is shown: the value, or "<5" when withheld. */
fun ReportCountDto.label(): String = if (suppressed || value == null) "<5" else value.toString()
fun ReportTableDto.totalLabel(): String = when {
    suppressed -> "<5"
    total.suppressed || total.value == null -> "Withheld"
    else -> total.value.toString()
}
fun ReportTableDto.cellLabel(key: String): String = cells.firstOrNull { it.key == key }
    ?.let { if (it.suppressed || it.count == null) "<5" else it.count.toString() } ?: "<5"

/**
 * Move an application to the next stage.
 *
 * The server owns the state machine and rejects a transition it does not allow, so this
 * sends the intent and reports the refusal rather than trying to mirror those rules on
 * the client where they would drift.
 */
suspend fun Api.transitionApplication(
    context: Context,
    employerId: String,
    applicationId: String,
    toState: String,
) {
    request(
        context, "POST", "/api/v1/employers/$employerId/applications/$applicationId/transition",
        buildJson("toState" to quoted(toState)),
    )
}

suspend fun Api.listEmployerInterviews(context: Context, employerId: String): List<InterviewDto> =
    json.decodeFromString<InterviewsEnvelope>(
        request(context, "GET", "/api/v1/employers/$employerId/interviews"),
    ).interviews

/** The interviews this person is a panellist on, which is not all of an employer's. */
suspend fun Api.listMyInterviews(context: Context, employerId: String): List<InterviewDto> =
    json.decodeFromString<InterviewsEnvelope>(
        request(context, "GET", "/api/v1/employers/$employerId/my-interviews"),
    ).interviews

suspend fun Api.myInterviewBrief(context: Context, employerId: String, interviewId: String): InterviewBriefDto =
    json.decodeFromString<InterviewBriefEnvelope>(
        request(context, "GET", "/api/v1/employers/$employerId/my-interviews/$interviewId"),
    ).interview

/**
 * Submit a scorecard.
 *
 * A recommendation is required and a rating is not: a panellist who cannot put a number
 * on someone can still say what they think, and forcing a score would produce invented
 * precision. Strengths and concerns are free text and go to the hiring team, never to
 * the candidate.
 */
suspend fun Api.submitInterviewOutcome(
    context: Context,
    employerId: String,
    interviewId: String,
    recommendation: String,
    overallRating: Int?,
    strengths: String,
    concerns: String,
    // EMP-09: one rating (1-5) per criterion of the stage's scorecard template, when it has one.
    criteria: Map<String, Int> = emptyMap(),
) {
    val ratings = criteria.entries.joinToString(prefix = "[", postfix = "]") { (id, rating) ->
        buildJson("criterionId" to quoted(id), "rating" to rating.toString())
    }
    request(
        context, "POST", "/api/v1/employers/$employerId/my-interviews/$interviewId/outcome",
        buildJson(
            "recommendation" to quoted(recommendation),
            *(if (overallRating == null) emptyArray() else arrayOf("overallRating" to overallRating.toString())),
            "strengths" to quoted(strengths),
            "concerns" to quoted(concerns),
            *(if (criteria.isEmpty()) emptyArray() else arrayOf("criteria" to ratings)),
        ),
    )
}

suspend fun Api.setInterviewState(
    context: Context,
    employerId: String,
    interviewId: String,
    toState: String,
) {
    request(
        context, "POST", "/api/v1/employers/$employerId/interviews/$interviewId/state",
        buildJson("toState" to quoted(toState)),
    )
}

suspend fun Api.listEmployerOffers(context: Context, employerId: String): List<EmployerOfferDto> =
    json.decodeFromString<EmployerOffersEnvelope>(
        request(context, "GET", "/api/v1/employers/$employerId/offers"),
    ).offers

suspend fun Api.withdrawOffer(context: Context, employerId: String, offerId: String, reason: String) {
    request(
        context, "POST", "/api/v1/employers/$employerId/offers/$offerId/withdraw",
        buildJson("reasonCode" to quoted("EMPLOYER_WITHDRAWN"), "detail" to quoted(reason)),
    )
}

suspend fun Api.employerSummary(context: Context, employerId: String): EmployerSummaryDto =
    json.decodeFromString<EmployerSummaryEnvelope>(request(context, "GET", "/api/v1/employers/$employerId/summary")).summary

suspend fun Api.employerReports(context: Context, employerId: String): EmployerReportsDto =
    json.decodeFromString<EmployerReportsEnvelope>(request(context, "GET", "/api/v1/employers/$employerId/reports")).reports

// --- EMP-12: one candidate's results on this employer's screening tests (read only) ---------

@Serializable data class CandidateAssessmentsEnvelope(val assessments: List<CandidateAssessmentDto> = emptyList())

@Serializable data class CandidateAssessmentDto(
    val invitationId: String = "",
    val title: String = "",
    val durationSeconds: Int = 0,
    val opensAt: String = "",
    val closesAt: String = "",
    val state: String = "",
    val submittedAt: String? = null,
    /** CANDIDATE when they submitted, TIME_LIMIT when the time or window ran out. */
    val endedBy: String? = null,
    val score: Double? = null,
    val maxScore: Double? = null,
    val percentage: Double? = null,
    val questions: List<CandidateAssessmentQuestionDto> = emptyList(),
)

@Serializable data class CandidateAssessmentQuestionDto(
    val displayOrder: Int = 0,
    val questionText: String = "",
    val marks: Double = 0.0,
    val marksAwarded: Double = 0.0,
    val answered: Boolean = false,
)

/** Needs the candidate's live applicant-access grant; the server refuses (403) otherwise, and records every read. */
suspend fun Api.listCandidateAssessments(context: Context, employerId: String, applicationId: String): List<CandidateAssessmentDto> =
    json.decodeFromString<CandidateAssessmentsEnvelope>(
        request(context, "GET", "/api/v1/employers/$employerId/applications/$applicationId/assessment-results")).assessments
