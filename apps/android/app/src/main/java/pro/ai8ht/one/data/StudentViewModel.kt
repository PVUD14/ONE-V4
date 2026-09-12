package pro.ai8ht.one.data

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import pro.ai8ht.one.Api
import pro.ai8ht.one.AssessmentDto
import pro.ai8ht.one.AssessmentsEnvelope
import pro.ai8ht.one.LearnerStateDto
import pro.ai8ht.one.NotificationsEnvelope
import pro.ai8ht.one.OpportunitiesEnvelope
import pro.ai8ht.one.OpportunityDto
import pro.ai8ht.one.StudentActivityDto
import pro.ai8ht.one.StudentDto
import pro.ai8ht.one.StudentEnvelope

/**
 * State for the student tabs, held above the composables that draw them.
 *
 * Screen state used to live in `remember { mutableStateOf }` inside each composable,
 * which meant every tab switch threw the data away and re-fetched it. That is the
 * difference between an app that feels instant and one that shows a spinner every time
 * you press Back — and it is worse on the connection most of these students have.
 *
 * Surviving configuration change is the other half: a rotation no longer restarts four
 * requests.
 */
class StudentViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = Repository.get(application)

    private val _student = MutableStateFlow<Repository.State<StudentDto>>(Repository.State.Loading)
    val student: StateFlow<Repository.State<StudentDto>> = _student.asStateFlow()

    private val _assessments = MutableStateFlow<Repository.State<List<AssessmentDto>>>(Repository.State.Loading)
    val assessments: StateFlow<Repository.State<List<AssessmentDto>>> = _assessments.asStateFlow()

    private val _learner = MutableStateFlow<Repository.State<LearnerStateDto>>(Repository.State.Loading)
    val learner: StateFlow<Repository.State<LearnerStateDto>> = _learner.asStateFlow()

    private val _opportunities = MutableStateFlow<Repository.State<List<OpportunityDto>>>(Repository.State.Loading)
    val opportunities: StateFlow<Repository.State<List<OpportunityDto>>> = _opportunities.asStateFlow()

    private val _notifications = MutableStateFlow<Repository.State<NotificationsEnvelope>>(Repository.State.Loading)
    val notifications: StateFlow<Repository.State<NotificationsEnvelope>> = _notifications.asStateFlow()

    private val _activity = MutableStateFlow<Repository.State<StudentActivityDto>>(Repository.State.Loading)
    val activity: StateFlow<Repository.State<StudentActivityDto>> = _activity.asStateFlow()

    /** Set when any load reports the session has ended, so the shell can sign out. */
    private val _sessionEnded = MutableStateFlow(false)
    val sessionEnded: StateFlow<Boolean> = _sessionEnded.asStateFlow()

    private var started = false

    /** Idempotent: calling this on every composition is intended and cheap. */
    fun start() {
        if (started) return
        started = true
        refresh()
    }

    fun refresh() {
        val context = getApplication<Application>()
        viewModelScope.launch {
            repository.load(
                key = "/api/v1/students/me",
                decode = { Api.json.decodeFromString<StudentEnvelope>(it).student },
                fetch = { Api.request(context, "GET", "/api/v1/students/me") },
                emit = { if (it is Repository.State.Unauthenticated) _sessionEnded.value = true else _student.value = it },
            )
        }
        viewModelScope.launch {
            repository.load(
                key = "/api/v1/student/assessments",
                decode = { Api.json.decodeFromString<AssessmentsEnvelope>(it).assessments },
                fetch = { Api.request(context, "GET", "/api/v1/student/assessments") },
                emit = { if (it is Repository.State.Unauthenticated) _sessionEnded.value = true else _assessments.value = it },
            )
        }
        viewModelScope.launch {
            repository.load(
                key = "/api/v1/career-readiness/me",
                decode = { Api.json.decodeFromString<LearnerStateDto>(it) },
                fetch = { Api.request(context, "GET", "/api/v1/career-readiness/me") },
                emit = { if (it is Repository.State.Unauthenticated) _sessionEnded.value = true else _learner.value = it },
            )
        }
        viewModelScope.launch {
            repository.load(
                key = "/api/v1/opportunities",
                decode = { Api.json.decodeFromString<OpportunitiesEnvelope>(it).opportunities },
                fetch = { Api.request(context, "GET", "/api/v1/opportunities") },
                emit = { if (it is Repository.State.Unauthenticated) _sessionEnded.value = true else _opportunities.value = it },
            )
        }
        viewModelScope.launch {
            repository.load(
                key = "/api/v1/me/notifications",
                decode = { Api.json.decodeFromString<NotificationsEnvelope>(it) },
                fetch = { Api.request(context, "GET", "/api/v1/me/notifications") },
                emit = { if (it is Repository.State.Unauthenticated) _sessionEnded.value = true else _notifications.value = it },
            )
        }
        viewModelScope.launch {
            repository.load(
                key = "/api/v1/student/activity",
                decode = { Api.json.decodeFromString<StudentActivityDto>(it) },
                fetch = { Api.request(context, "GET", "/api/v1/student/activity") },
                emit = { if (it is Repository.State.Unauthenticated) _sessionEnded.value = true else _activity.value = it },
            )
        }
    }

    /** Sign-out empties the cache: a shared phone must not keep the last student's data. */
    fun clearOnSignOut() {
        viewModelScope.launch { repository.clearCache() }
    }
}

/** Convenience for screens that only care about the value, not the state around it. */
fun <T> Repository.State<T>.valueOrNull(): T? =
    (this as? Repository.State.Loaded)?.value

fun <T> Repository.State<T>.isStale(): Boolean =
    (this as? Repository.State.Loaded)?.stale == true
