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

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }

    fun theme(context: Context): String = prefs(context).getString("theme", "nexus") ?: "nexus"

    fun setTheme(context: Context, id: String) {
        prefs(context).edit().putString("theme", id).apply()
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
