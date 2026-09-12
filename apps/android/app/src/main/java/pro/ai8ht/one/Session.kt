package pro.ai8ht.one

import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.browser.customtabs.CustomTabsIntent
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Token/session handling.
 *
 * Production path: Cognito OAuth 2.0 authorization-code + PKCE via a custom
 * tab, activating once the operator registers the mobile app client
 * (COGNITO_HOSTED_DOMAIN + COGNITO_CLIENT_ID build fields). Until then, the
 * sign-in screen offers the UAT token path used by testers.
 */
object Session {
    private const val PREFS = "one-session"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun token(context: Context): String? = prefs(context).getString("access_token", null)?.ifBlank { null }

    fun setToken(context: Context, token: String) {
        prefs(context).edit().putString("access_token", token.trim()).apply()
    }

    fun refreshToken(context: Context): String? = prefs(context).getString("refresh_token", null)?.ifBlank { null }

    fun setTokens(context: Context, accessToken: String, refreshToken: String?) {
        prefs(context).edit()
            .putString("access_token", accessToken.trim())
            .putString("refresh_token", refreshToken?.trim() ?: prefs(context).getString("refresh_token", null))
            .apply()
    }

    /**
     * Sign out: drop everything that belongs to the session, keep what belongs to the device.
     *
     * This used to call `clear()`, which also threw away the chosen theme and the API
     * override. Neither is a credential. A user who picks a look and signs out gets it
     * silently reset, and a tester pointed at a non-default host is silently returned to
     * the default one, which is the kind of surprise that wastes an afternoon.
     *
     * Named keys rather than an exclusion list, so a new session key has to be added here
     * deliberately — forgetting to remove a token is a worse failure than forgetting to
     * preserve a preference.
     */
    fun clear(context: Context) {
        prefs(context).edit()
            .remove("access_token")
            .remove("refresh_token")
            .remove("email")
            .remove("workspace")
            .remove("pkce_verifier")
            .remove("oauth_verifier")
            .remove("oauth_state")
            .apply()
    }

    fun theme(context: Context): String = prefs(context).getString("theme", "nexus") ?: "nexus"

    fun setTheme(context: Context, id: String) {
        prefs(context).edit().putString("theme", id).apply()
    }

    fun email(context: Context): String? = prefs(context).getString("email", null)?.ifBlank { null }

    fun setEmail(context: Context, value: String) {
        prefs(context).edit().putString("email", value.trim()).apply()
    }

    fun workspace(context: Context): String? = prefs(context).getString("workspace", null)

    fun setWorkspace(context: Context, value: String?) {
        prefs(context).edit().putString("workspace", value).apply()
    }

    fun apiOverride(context: Context): String = prefs(context).getString("api_override", "") ?: ""

    fun setApiOverride(context: Context, value: String) {
        prefs(context).edit().putString("api_override", value.trim().trimEnd('/')).apply()
    }

    val hostedUiConfigured: Boolean
        get() = BuildConfig.COGNITO_HOSTED_DOMAIN.isNotBlank() && BuildConfig.COGNITO_CLIENT_ID.isNotBlank()

    /** Launches the Cognito Hosted UI with a fresh PKCE challenge. */
    fun launchHostedSignIn(context: Context) {
        val verifier = randomUrlSafe(64)
        prefs(context).edit().putString("pkce_verifier", verifier).apply()
        val challenge = Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )
        val url = Uri.parse("https://${BuildConfig.COGNITO_HOSTED_DOMAIN}/oauth2/authorize").buildUpon()
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("client_id", BuildConfig.COGNITO_CLIENT_ID)
            .appendQueryParameter("redirect_uri", BuildConfig.OAUTH_REDIRECT_URI)
            .appendQueryParameter("scope", "openid email")
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("code_challenge", challenge)
            .build()
        CustomTabsIntent.Builder().build().launchUrl(context, url)
    }

    fun pkceVerifier(context: Context): String? = prefs(context).getString("pkce_verifier", null)

    private fun randomUrlSafe(bytes: Int): String {
        val buffer = ByteArray(bytes)
        SecureRandom().nextBytes(buffer)
        return Base64.encodeToString(buffer, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }
}

/**
 * Transient PKCE state.
 *
 * Stored rather than held in memory because the app can be killed while the user is in
 * the browser — a slow MFA step on a low-memory phone is exactly when that happens —
 * and the returning authorization code is useless without the verifier that started it.
 * Both are cleared the moment the exchange is attempted, successfully or not.
 */
internal fun Session.setOauthVerifier(context: Context, verifier: String) {
    context.getSharedPreferences("one-session", Context.MODE_PRIVATE)
        .edit().putString("oauth_verifier", verifier).apply()
}

internal fun Session.oauthVerifier(context: Context): String? =
    context.getSharedPreferences("one-session", Context.MODE_PRIVATE)
        .getString("oauth_verifier", null)?.ifBlank { null }

internal fun Session.setOauthState(context: Context, state: String) {
    context.getSharedPreferences("one-session", Context.MODE_PRIVATE)
        .edit().putString("oauth_state", state).apply()
}

internal fun Session.oauthState(context: Context): String? =
    context.getSharedPreferences("one-session", Context.MODE_PRIVATE)
        .getString("oauth_state", null)?.ifBlank { null }

internal fun Session.clearOauthTransient(context: Context) {
    context.getSharedPreferences("one-session", Context.MODE_PRIVATE)
        .edit().remove("oauth_verifier").remove("oauth_state").apply()
}
