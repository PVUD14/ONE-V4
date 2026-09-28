package pro.ai8ht.one

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/**
 * Application-bound messages on the phone (EMP-10), matching the web.
 *
 * One conversation per application between the candidate and the employer's team. A recruiter reads
 * and writes it on the applicant's page while the candidate still shares their details, and may start
 * it once the candidate is shortlisted; a student reads it from My applications, replies while the
 * application is open, mutes its notices and reports an employer's message. Text only (up to 2,000
 * characters), shown as plain text — never a tappable link — and a message that carries a link is
 * flagged, with a warning for the student. The employer is never told about a mute or a report.
 * Design: docs/architecture/application-messages-table-design.md.
 */

const val MESSAGE_MAX_LENGTH = 2000

@Serializable data class ConversationMessageDto(
    val id: String,
    val from: String,
    val mine: Boolean = false,
    val body: String? = null,
    val containsLink: Boolean = false,
    val sentAt: String,
    val readAt: String? = null,
    val erased: Boolean = false,
    val reportedAt: String? = null,
)
@Serializable data class EmployerConversationDto(
    val applicationState: String = "",
    val title: String = "",
    val started: Boolean = false,
    val canSend: Boolean = false,
    val sendBlockedReason: String? = null,
    val messages: List<ConversationMessageDto> = emptyList(),
)
@Serializable data class StudentConversationDto(
    val employerName: String = "",
    val title: String = "",
    val started: Boolean = false,
    val muted: Boolean = false,
    val canReply: Boolean = false,
    val replyBlockedReason: String? = null,
    val messages: List<ConversationMessageDto> = emptyList(),
)
@Serializable private data class EmployerConversationEnvelope(val conversation: EmployerConversationDto)
@Serializable private data class StudentConversationEnvelope(val conversation: StudentConversationDto)
@Serializable private data class MessageBody(val body: String)
@Serializable private data class MuteBody(val muted: Boolean)
@Serializable private data class ReportBody(val reasonCode: String, val statement: String? = null)

/** The reasons a student may give, in the order the web shows them. */
val messageReportReasons = listOf(
    "SCAM_OR_PAYMENT_REQUEST" to "Asked me for money or a fee",
    "OFF_PLATFORM_PRESSURE" to "Pushed me to talk outside ONE",
    "HARASSMENT" to "Harassment or threats",
    "INAPPROPRIATE_CONTENT" to "Inappropriate content",
    "DISCRIMINATION" to "Discrimination",
    "OTHER" to "Something else",
)

suspend fun Api.employerConversation(context: Context, employerId: String, applicationId: String): EmployerConversationDto =
    json.decodeFromString<EmployerConversationEnvelope>(request(context, "GET", "/api/v1/employers/$employerId/applications/$applicationId/messages")).conversation

suspend fun Api.sendEmployerMessage(context: Context, employerId: String, applicationId: String, body: String) {
    request(context, "POST", "/api/v1/employers/$employerId/applications/$applicationId/messages", json.encodeToString(MessageBody(body)))
}

suspend fun Api.studentConversation(context: Context, applicationId: String): StudentConversationDto =
    json.decodeFromString<StudentConversationEnvelope>(request(context, "GET", "/api/v1/students/me/applications/$applicationId/messages")).conversation

suspend fun Api.sendStudentMessage(context: Context, applicationId: String, body: String) {
    request(context, "POST", "/api/v1/students/me/applications/$applicationId/messages", json.encodeToString(MessageBody(body)))
}

suspend fun Api.muteConversation(context: Context, applicationId: String, muted: Boolean) {
    request(context, "POST", "/api/v1/students/me/applications/$applicationId/messages/mute", json.encodeToString(MuteBody(muted)))
}

suspend fun Api.reportMessage(context: Context, applicationId: String, messageId: String, reasonCode: String, statement: String?) {
    request(context, "POST", "/api/v1/students/me/applications/$applicationId/messages/$messageId/report",
        json.encodeToString(ReportBody(reasonCode, statement?.trim()?.ifBlank { null })))
}

/** The same sentences the web uses for the refusals a person can act on. */
internal fun messageError(error: Throwable, fallback: String): String = when ((error as? Api.ApiException)?.code) {
    "MESSAGING_NOT_AVAILABLE" -> "This conversation is closed: the application has ended or its details are no longer shared."
    "MESSAGE_RATE_LIMITED" -> "Too many messages in a short time. Wait a while before sending more."
    "MESSAGE_AWAITING_REPLY" -> "You have sent three messages without a reply. Wait for the candidate to answer before sending more."
    "INVALID_BODY" -> "Write a message of up to 2,000 characters."
    "MESSAGE_ALREADY_REPORTED" -> "You have already reported this message."
    else -> if ((error as? Api.ApiException)?.status == 403) "This candidate no longer shares their details with you, so the conversation is closed." else fallback
}

@Composable
private fun MessageCards(messages: List<ConversationMessageDto>, perspective: String, counterpart: String, onReport: ((ConversationMessageDto) -> Unit)?) {
    if (messages.isEmpty()) { Text("No messages yet.", style = MaterialTheme.typography.bodySmall); return }
    messages.forEach { message ->
        val ours = message.from == perspective
        Spacer(Modifier.height(8.dp))
        PilotCard {
            Column(Modifier.padding(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "${if (ours) (if (perspective == "EMPLOYER" && !message.mine) "Your team" else "You") else counterpart}  ·  ${formatWhen(message.sentAt)}",
                        Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                    )
                    if (message.reportedAt != null) StatusChip("Reported", ChipKind.Waiting)
                }
                Spacer(Modifier.height(4.dp))
                // Plain Text: a URL in it is never made tappable.
                Text(if (message.erased) "This message was erased." else message.body ?: "", style = MaterialTheme.typography.bodyMedium)
                if (message.containsLink && !message.erased) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        if (perspective == "STUDENT") "Contains a link. ONE does not check links — never pay a fee or share a password."
                        else "Contains a link, shown to the candidate with a warning.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error,
                    )
                }
                if (ours && message.readAt != null) Text("Read ${formatWhen(message.readAt)}", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (onReport != null && !ours && !message.erased && message.reportedAt == null) {
                    TextButton(onClick = { onReport(message) }) { Text("Report") }
                }
            }
        }
    }
}

@Composable
private fun Composer(label: String, onSend: suspend (String) -> Boolean) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    Spacer(Modifier.height(10.dp))
    OutlinedTextField(text, { text = it.take(MESSAGE_MAX_LENGTH) }, Modifier.fillMaxWidth(), enabled = !busy, minLines = 2,
        label = { Text(label) }, supportingText = { Text("${text.length} / $MESSAGE_MAX_LENGTH · Text only. No attachments.") })
    TextButton(onClick = {
        val body = text.trim()
        if (body.isEmpty()) return@TextButton
        busy = true
        scope.launch { if (onSend(body)) text = ""; busy = false }
    }, enabled = !busy && text.isNotBlank()) { Text("Send") }
}

/**
 * EMP-10 for the recruiter, on the applicant's page: the conversation while the candidate shares
 * their details, and the composer once they are shortlisted.
 */
@Composable
internal fun EmployerConversationSection(employerId: String, applicationId: String, candidateName: String, reload: Int) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var conversation by remember { mutableStateOf<EmployerConversationDto?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    LaunchedEffect(employerId, applicationId, reload, refresh) {
        runCatching { Api.employerConversation(context, employerId, applicationId) }
            .onSuccess { conversation = it }
            .onFailure { conversation = null; status = messageError(it, "The conversation could not be loaded.") }
    }
    Spacer(Modifier.height(12.dp))
    Text("Messages", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
    Text("One conversation per application, visible to your team while the candidate shares their details. Every message is recorded.",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    status?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    val shown = conversation
    when {
        shown == null && status == null -> LoadingSpinner()
        shown != null -> {
            MessageCards(shown.messages, "EMPLOYER", candidateName, null)
            if (shown.canSend) {
                Composer(if (shown.started) "Reply" else "Start the conversation") { body ->
                    runCatching { Api.sendEmployerMessage(context, employerId, applicationId, body) }
                        .onSuccess { status = "Message sent."; refresh++ }
                        .onFailure { status = messageError(it, "The message could not be sent.") }
                        .isSuccess
                }
            } else Text(
                if (shown.sendBlockedReason == "NOT_SHORTLISTED") "You can message a candidate once you shortlist them."
                else "This application has ended, so the conversation is closed.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

/** EMP-10 for the student: one application's conversation, opened from My applications. */
@Composable
internal fun StudentConversationPage(applicationId: String, title: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var conversation by remember { mutableStateOf<StudentConversationDto?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    var reporting by remember { mutableStateOf<ConversationMessageDto?>(null) }
    LaunchedEffect(applicationId, refresh) {
        runCatching { Api.studentConversation(context, applicationId) }
            .onSuccess { conversation = it }
            .onFailure { status = messageError(it, "The conversation could not be loaded.") }
    }
    OverlayScaffold("Messages", onClose) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(12.dp))
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            val shown = conversation
            val employer = shown?.employerName?.ifBlank { null } ?: "The employer"
            Text("Only you and $employer's hiring team can read this, and they can only while you share your application. Never pay a fee to an employer.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            status?.let { Spacer(Modifier.height(6.dp)); Text(it, style = MaterialTheme.typography.bodySmall) }
            when {
                shown == null && status == null -> LoadingSpinner()
                shown != null && !shown.started -> {
                    Spacer(Modifier.height(10.dp))
                    Text("$employer has not started a conversation. Employers can write once they shortlist you, and you can reply here.",
                        style = MaterialTheme.typography.bodyMedium)
                }
                shown != null -> {
                    MessageCards(shown.messages, "STUDENT", employer) { reporting = it }
                    if (shown.canReply) {
                        Composer("Reply") { body ->
                            runCatching { Api.sendStudentMessage(context, applicationId, body) }
                                .onSuccess { status = "Reply sent."; refresh++ }
                                .onFailure { status = messageError(it, "Your reply could not be sent.") }
                                .isSuccess
                        }
                    } else Text("This application has ended or is no longer shared, so you can read this conversation but not reply.",
                        style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = {
                        scope.launch {
                            val target = !shown.muted
                            runCatching { Api.muteConversation(context, applicationId, target) }
                                .onSuccess {
                                    conversation = shown.copy(muted = target)
                                    status = if (target) "Muted. Messages still arrive here, but you will not be notified." else "Notifications are back on for this conversation."
                                }
                                .onFailure { status = messageError(it, "That change could not be saved.") }
                        }
                    }) { Text(if (shown.muted) "Unmute notifications" else "Mute notifications") }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    reporting?.let { message ->
        var reason by remember(message.id) { mutableStateOf<String?>(null) }
        var statement by remember(message.id) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { reporting = null },
            title = { Text("Report this message") },
            text = {
                Column {
                    messageReportReasons.forEach { (code, label) ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = reason == code, onClick = { reason = code })
                            Text(label, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    OutlinedTextField(statement, { statement = it.take(1000) }, Modifier.fillMaxWidth(), minLines = 2,
                        label = { Text("Anything else we should know (optional)") })
                }
            },
            confirmButton = {
                TextButton(enabled = reason != null, onClick = {
                    val code = reason ?: return@TextButton
                    reporting = null
                    scope.launch {
                        runCatching { Api.reportMessage(context, applicationId, message.id, code, statement) }
                            .onSuccess { status = "Reported. The ONE trust and safety team will review it; the employer is not told."; refresh++ }
                            .onFailure { status = messageError(it, "The report could not be sent.") }
                    }
                }) { Text("Send report") }
            },
            dismissButton = { TextButton(onClick = { reporting = null }) { Text("Cancel") } },
        )
    }
}
