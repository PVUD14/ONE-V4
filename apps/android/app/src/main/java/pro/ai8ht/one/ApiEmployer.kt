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
    val candidateName: String = "",
    val opportunityTitle: String = "",
    val stage: String = "",
    val state: String = "",
    val scheduledStart: String? = null,
    val scheduledEnd: String? = null,
    val mode: String? = null,
    val location: String? = null,
)

@Serializable data class InterviewBriefEnvelope(val interview: InterviewBriefDto)

@Serializable data class InterviewBriefDto(
    val id: String,
    val candidateName: String = "",
    val candidateEmail: String? = null,
    val opportunityTitle: String = "",
    val opportunitySummary: String? = null,
    val responsibilities: String? = null,
    val stage: String = "",
    val state: String = "",
    val scheduledStart: String? = null,
    val outcomeRecorded: Boolean = false,
)

@Serializable data class EmployerOffersEnvelope(val offers: List<EmployerOfferDto> = emptyList())

@Serializable data class EmployerOfferDto(
    val id: String,
    val applicationId: String = "",
    val candidateName: String = "",
    val opportunityTitle: String = "",
    val state: String = "",
    val respondBy: String? = null,
)

@Serializable data class HiringAnalyticsDto(
    val opportunitiesOpen: Int = 0,
    val applicationsTotal: Int = 0,
    val shortlisted: Int = 0,
    val interviewsScheduled: Int = 0,
    val offersExtended: Int = 0,
    val offersAccepted: Int = 0,
)

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
) {
    request(
        context, "POST", "/api/v1/employers/$employerId/my-interviews/$interviewId/outcome",
        buildJson(
            "recommendation" to quoted(recommendation),
            *(if (overallRating == null) emptyArray() else arrayOf("overallRating" to overallRating.toString())),
            "strengths" to quoted(strengths),
            "concerns" to quoted(concerns),
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

suspend fun Api.hiringAnalytics(context: Context, employerId: String): HiringAnalyticsDto =
    json.decodeFromString(request(context, "GET", "/api/v1/employers/$employerId/hiring-analytics"))
