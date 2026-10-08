package pro.ai8ht.one

/*
 * ONE · Forgot password, and the password field shared with the sign-in card.
 *
 * The sign-in card had no way back for someone who forgot their password. This is the
 * app's half of the web reset page (apps/web/src/forgotPasswordPage.tsx): the same two
 * steps, the same words, and the same refusal to say whether an address has an account.
 */

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextFieldColors
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import pro.ai8ht.one.ui.LocalOnePalette

internal const val PASSWORD_RULE = "At least 8 characters, with upper and lower case letters, a number and a symbol."

private val emailShape = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")

/** Field colours for the sign-in and reset cards, taken from the active pilot palette. */
@Composable
internal fun signInFieldColors(): TextFieldColors {
    val palette = LocalOnePalette.current
    return OutlinedTextFieldDefaults.colors(
        focusedBorderColor = palette.accent,
        unfocusedBorderColor = palette.outline,
        focusedLabelColor = palette.accent,
        unfocusedLabelColor = palette.muted,
        cursorColor = palette.accent,
        focusedTextColor = palette.ink,
        unfocusedTextColor = palette.ink,
        focusedTrailingIconColor = palette.accent,
        unfocusedTrailingIconColor = palette.muted,
        focusedSupportingTextColor = palette.muted,
        unfocusedSupportingTextColor = palette.muted,
    )
}

/** A password field with a show/hide control, as on the web sign-in card. */
@Composable
internal fun PasswordField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    error: String? = null,
    hint: String? = null,
) {
    var visible by remember { mutableStateOf(false) }
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        modifier = modifier.fillMaxWidth(),
        singleLine = true,
        isError = error != null,
        supportingText = (error ?: hint)?.let { text -> { Text(text) } },
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
        trailingIcon = {
            IconButton(onClick = { visible = !visible }) {
                Icon(
                    if (visible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                    contentDescription = if (visible) "Hide password" else "Show password",
                )
            }
        },
        shape = RoundedCornerShape(10.dp),
        colors = signInFieldColors(),
    )
}

private fun messageFor(result: Api.PasswordReset): String = when (result) {
    Api.PasswordReset.CodeInvalid -> "That code is not right. Check the latest email from ONE and try again."
    Api.PasswordReset.CodeExpired -> "That code has expired. Ask for a new one below."
    Api.PasswordReset.PasswordRejected -> "Choose a stronger password: at least 8 characters, with upper and lower case letters, a number and a symbol."
    Api.PasswordReset.RateLimited -> "Too many attempts. Wait a few minutes and try again."
    else -> "Something went wrong. Try again in a moment."
}

private enum class ResetStep { Request, Confirm, Done }

/**
 * The reset card, shown in place of the sign-in card. [onBack] returns to sign-in, carrying
 * the email so the person does not type it twice.
 */
@Composable
internal fun PasswordResetCard(initialEmail: String, onBack: (email: String) -> Unit) {
    val context = LocalContext.current
    val palette = LocalOnePalette.current
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf(ResetStep.Request) }
    var email by remember { mutableStateOf(initialEmail.trim()) }
    // The code and new password are held only here, never saved or logged.
    var code by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var emailError by remember { mutableStateOf<String?>(null) }
    var codeError by remember { mutableStateOf<String?>(null) }
    var passwordError by remember { mutableStateOf<String?>(null) }
    val fieldColors = signInFieldColors()
    val primaryButton = ButtonDefaults.buttonColors(containerColor = palette.accent, contentColor = palette.onAccent)

    fun sendCode() {
        val value = email.trim()
        emailError = when {
            value.isEmpty() -> "Enter the email you sign in with."
            !emailShape.matches(value) -> "Enter a valid email address."
            else -> null
        }
        if (emailError != null) return
        error = null; busy = true
        scope.launch {
            val result = Api.requestPasswordReset(context, value)
            busy = false
            if (result == Api.PasswordReset.CodeSent) {
                email = value; code = ""; newPassword = ""; step = ResetStep.Confirm
            } else error = messageFor(result)
        }
    }

    fun confirm() {
        codeError = if (code.isBlank()) "Enter the code from the email." else null
        passwordError = if (newPassword.isEmpty()) "Choose a new password." else null
        if (codeError != null || passwordError != null) return
        error = null; busy = true
        scope.launch {
            val result = Api.confirmPasswordReset(context, email, code, newPassword)
            busy = false
            if (result == Api.PasswordReset.Reset) {
                code = ""; newPassword = ""; step = ResetStep.Done
            } else error = messageFor(result)
        }
    }

    PilotCard {
        Column(Modifier.padding(20.dp)) {
            Text(
                if (step == ResetStep.Done) "Password changed" else "Reset your password",
                style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = palette.ink,
            )
            Spacer(Modifier.height(6.dp))
            when (step) {
                ResetStep.Request -> {
                    Text("Enter the email you sign in with. If it has a ONE account, we will email you a code to set a new password.",
                        style = MaterialTheme.typography.bodySmall, color = palette.muted)
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(value = email, onValueChange = { email = it; emailError = null }, label = { Text("Email") },
                        modifier = Modifier.fillMaxWidth(), singleLine = true, isError = emailError != null,
                        supportingText = emailError?.let { text -> { Text(text) } },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false),
                        shape = RoundedCornerShape(10.dp), colors = fieldColors)
                    Spacer(Modifier.height(14.dp))
                    Button(onClick = ::sendCode, enabled = !busy, modifier = Modifier.fillMaxWidth().height(46.dp),
                        shape = RoundedCornerShape(10.dp), colors = primaryButton) {
                        Text(if (busy) "Sending…" else "Email me a code", fontWeight = FontWeight.SemiBold)
                    }
                }
                ResetStep.Confirm -> {
                    Text("If $email has a ONE account, a code is on its way. It can take a minute to arrive.",
                        style = MaterialTheme.typography.bodySmall, color = palette.muted)
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(value = code, onValueChange = { code = it; codeError = null }, label = { Text("Code from the email") },
                        modifier = Modifier.fillMaxWidth(), singleLine = true, isError = codeError != null,
                        supportingText = codeError?.let { text -> { Text(text) } },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, autoCorrectEnabled = false),
                        shape = RoundedCornerShape(10.dp), colors = fieldColors)
                    Spacer(Modifier.height(6.dp))
                    PasswordField(value = newPassword, onValueChange = { newPassword = it; passwordError = null },
                        label = "New password", error = passwordError, hint = PASSWORD_RULE)
                    Spacer(Modifier.height(14.dp))
                    Button(onClick = ::confirm, enabled = !busy, modifier = Modifier.fillMaxWidth().height(46.dp),
                        shape = RoundedCornerShape(10.dp), colors = primaryButton) {
                        Text(if (busy) "Saving…" else "Set new password", fontWeight = FontWeight.SemiBold)
                    }
                    TextButton(onClick = {
                        step = ResetStep.Request; error = null; codeError = null; passwordError = null; code = ""; newPassword = ""
                    }, enabled = !busy) { Text("Send a new code", color = palette.accent) }
                }
                ResetStep.Done -> {
                    Text("Your password has been changed. Sign in with your new password.",
                        style = MaterialTheme.typography.bodySmall, color = palette.muted)
                    Spacer(Modifier.height(14.dp))
                    Button(onClick = { onBack(email) }, modifier = Modifier.fillMaxWidth().height(46.dp),
                        shape = RoundedCornerShape(10.dp), colors = primaryButton) {
                        Text("Go to sign in", fontWeight = FontWeight.SemiBold)
                    }
                }
            }
            error?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            if (step != ResetStep.Done) {
                TextButton(onClick = { onBack(email) }, enabled = !busy) { Text("Back to sign in", color = palette.accent) }
            }
        }
    }
}
