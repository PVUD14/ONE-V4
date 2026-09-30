package pro.ai8ht.one

import android.content.Context
import kotlinx.serialization.Serializable

/**
 * The student learning experience (ENG-18) and the placement test (ENG-14) — the Android side of the web's
 * `api/learning.ts`, over the same routes.
 *
 * The path in skip / review / learn groups, due reviews, the next step with its reason codes, practice on the
 * step with the hint ladder, and the placement test. Responses carry labels, reason codes and question text
 * only: never an answer key, the correct option, a model number (likelihood, stability, ability) or a
 * readiness value. Unions from the API are flattened into one class with a `status` and nullable fields.
 */

@Serializable data class PathEntryDto(
    val skillId: String = "",
    val skillName: String = "",
    val requirementLevel: String = "",
    val gapStatus: String = "",
    val band: String = "NOT_ENOUGH_EVIDENCE",
    val due: Boolean = false,
    val reasonCodes: List<String> = emptyList(),
)

@Serializable data class PathGroupsDto(
    val policyVersion: String = "",
    val skip: List<PathEntryDto> = emptyList(),
    val review: List<PathEntryDto> = emptyList(),
    val learn: List<PathEntryDto> = emptyList(),
)

@Serializable data class LearningTargetDto(val careerRoleId: String = "", val title: String = "")

/** Counts of the target's requirements — facts with their own denominator, never a percentage. */
@Serializable data class RequirementCountsDto(val total: Int = 0, val met: Int = 0, val notMeasured: Int = 0)

@Serializable data class NamedSkillDto(val skillId: String = "", val skillName: String = "")

@Serializable data class ChoiceDto(val id: String = "", val text: String = "")

@Serializable data class StepQuestionDto(
    val id: String = "",
    val prompt: String = "",
    val options: List<ChoiceDto> = emptyList(),
    val position: Int = 1,
    val hintsAvailable: Boolean = false,
    val hints: List<String> = emptyList(),
)

/** NO_SKILL, NO_PRACTICE, IN_PROGRESS (with a question) or COMPLETED. */
@Serializable data class StepPracticeDto(
    val status: String = "NO_SKILL",
    val question: StepQuestionDto? = null,
    val questionsAnswered: Int = 0,
)

@Serializable data class StepSkillDto(val id: String = "", val name: String = "")

@Serializable data class StepLessonDto(val id: String = "", val title: String = "", val language: String = "en")

@Serializable data class LearningStepDto(
    val decisionId: String = "",
    val decidedAt: String = "",
    val action: String = "NONE",
    val skill: StepSkillDto? = null,
    val strategyKind: String? = null,
    val reasonCodes: List<String> = emptyList(),
    val adaptive: Boolean = false,
    val lessons: List<StepLessonDto> = emptyList(),
    val practice: StepPracticeDto = StepPracticeDto(),
)

@Serializable data class LearningPathDto(
    val adaptive: Boolean = false,
    val target: LearningTargetDto? = null,
    val requirements: RequirementCountsDto? = null,
    val groups: PathGroupsDto = PathGroupsDto(),
    val dueReviews: List<NamedSkillDto> = emptyList(),
    val latestStep: LearningStepDto? = null,
)

@Serializable data class LearningPathEnvelope(val path: LearningPathDto = LearningPathDto())

@Serializable data class LearningStepEnvelope(val step: LearningStepDto = LearningStepDto())

@Serializable data class StepFeedbackDto(val questionId: String = "", val correct: Boolean = false, val assisted: Boolean = false)

@Serializable data class StepAnswerDto(val feedback: StepFeedbackDto = StepFeedbackDto(), val step: LearningStepDto = LearningStepDto())

@Serializable data class PlacementQuestionDto(
    val id: String = "",
    val prompt: String = "",
    val options: List<ChoiceDto> = emptyList(),
    val position: Int = 1,
)

/** NOT_AVAILABLE (with a reason), NOT_STARTED, IN_PROGRESS (with a question) or COMPLETED (with a level). */
@Serializable data class PlacementDto(
    val status: String = "NOT_AVAILABLE",
    val reason: String? = null,
    val placementTestId: String? = null,
    val question: PlacementQuestionDto? = null,
    val questionsAnswered: Int = 0,
    val maxQuestions: Int = 25,
    val deadlineAt: String? = null,
    val placementLevel: String? = null,
)

@Serializable data class PlacementEnvelope(val placement: PlacementDto = PlacementDto())

suspend fun Api.learningPath(context: Context): LearningPathDto =
    json.decodeFromString<LearningPathEnvelope>(request(context, "GET", "/api/v1/learning/path")).path

suspend fun Api.startNextLearningStep(context: Context): LearningStepDto =
    json.decodeFromString<LearningStepEnvelope>(
        request(context, "POST", "/api/v1/learning/next-step", buildJson("sessionMinutes" to "null")),
    ).step

suspend fun Api.revealStepHint(context: Context, decisionId: String, questionId: String): LearningStepDto =
    json.decodeFromString<LearningStepEnvelope>(
        request(context, "POST", "/api/v1/learning/steps/$decisionId/hints", buildJson("questionId" to quoted(questionId))),
    ).step

suspend fun Api.answerStepQuestion(context: Context, decisionId: String, questionId: String, optionId: String): StepAnswerDto =
    json.decodeFromString<StepAnswerDto>(
        request(
            context, "POST", "/api/v1/learning/steps/$decisionId/answers",
            buildJson("questionId" to quoted(questionId), "selectedOptionId" to quoted(optionId)),
        ),
    )

suspend fun Api.placementTest(context: Context): PlacementDto =
    json.decodeFromString<PlacementEnvelope>(request(context, "GET", "/api/v1/learning/placement-test")).placement

suspend fun Api.startPlacementTest(context: Context): PlacementDto =
    json.decodeFromString<PlacementEnvelope>(request(context, "POST", "/api/v1/learning/placement-test")).placement

suspend fun Api.answerPlacementQuestion(context: Context, placementTestId: String, questionId: String, optionId: String): PlacementDto =
    json.decodeFromString<PlacementEnvelope>(
        request(
            context, "POST", "/api/v1/learning/placement-test/$placementTestId/answers",
            buildJson("questionId" to quoted(questionId), "selectedOptionId" to quoted(optionId)),
        ),
    ).placement
