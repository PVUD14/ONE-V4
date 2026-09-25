package pro.ai8ht.one

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import java.security.MessageDigest
import java.security.SecureRandom
import android.util.Base64

/**
 * Cognito Hosted UI sign-in with PKCE.
 *
 * Password sign-in cannot complete an MFA challenge — the SDK hands back a
 * `getMFACode` callback and the app has nowhere to put it. ADR-025 puts staff in a
 * separate pool with MFA **required**, so the day that pool exists, password sign-in
 * stops working for every staff member. This is the flow that does not have that
 * problem: the challenge happens in the browser, where Cognito already knows how to
 * render it, and the app only ever sees the code that comes back.
 *
 * PKCE rather than a client secret, because a secret shipped inside an APK is not a
 * secret. The verifier is generated per attempt, never leaves the device, and the
 * authorization code is worthless without it.
 *
 * Dormant until `COGNITO_HOSTED_DOMAIN` is configured — the mobile app client has to
 * exist in the pool first, with this redirect URI registered against it.
 */
object OAuth {
    private val http = OkHttpClient()
    private val random = SecureRandom()

    /** True once an operator has registered the mobile app client. */
    fun isConfigured(): Boolean =
        BuildConfig.COGNITO_HOSTED_DOMAIN.isNotBlank() && BuildConfig.COGNITO_CLIENT_ID.isNotBlank()

    class OAuthException(message: String) : Exception(message)

    @Serializable
    private data class TokenResponse(
        val access_token: String? = null,
        val refresh_token: String? = null,
        val id_token: String? = null,
        val error: String? = null,
    )

    private fun base64Url(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    /**
     * Start sign-in.
     *
     * The verifier is stored before the browser opens because the app may be killed
     * while the user is in it — a slow MFA step on a low-memory phone is exactly when
     * that happens — and without the stored verifier the returning code cannot be
     * redeemed.
     */
    fun begin(context: Context) {
        if (!isConfigured()) throw OAuthException("Hosted sign-in is not configured for this build.")

        val verifierBytes = ByteArray(64).also(random::nextBytes)
        val verifier = base64Url(verifierBytes)
        val challenge = base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        val state = base64Url(ByteArray(16).also(random::nextBytes))

        Session.setOauthVerifier(context, verifier)
        Session.setOauthState(context, state)

        val authorize = Uri.parse("https://${BuildConfig.COGNITO_HOSTED_DOMAIN}/oauth2/authorize")
            .buildUpon()
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("client_id", BuildConfig.COGNITO_CLIENT_ID)
            .appendQueryParameter("redirect_uri", BuildConfig.OAUTH_REDIRECT_URI)
            .appendQueryParameter("scope", "openid email profile")
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("state", state)
            .build()

        // A Custom Tab, not a WebView. A WebView would let the app read what the user
        // types into the identity provider, which is precisely what it must not be able
        // to do, and Cognito's own guidance refuses it for that reason.
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, authorize)
    }

    /**
     * Finish sign-in from the redirect.
     *
     * @return true when tokens were stored. A mismatched `state` is treated as an
     *   attack rather than a glitch and the attempt is abandoned.
     */
    suspend fun complete(context: Context, redirect: Uri): Boolean = withContext(Dispatchers.IO) {
        val error = redirect.getQueryParameter("error")
        if (error != null) throw OAuthException(friendly(error))

        val code = redirect.getQueryParameter("code")
            ?: throw OAuthException("Sign-in did not complete. Try again.")
        val returnedState = redirect.getQueryParameter("state")
        val expectedState = Session.oauthState(context)
        if (expectedState.isNullOrBlank() || returnedState != expectedState) {
            Session.clearOauthTransient(context)
            throw OAuthException("Sign-in could not be verified. Start again.")
        }
        val verifier = Session.oauthVerifier(context)
            ?: throw OAuthException("Sign-in could not be completed on this device. Start again.")

        val form = FormBody.Builder()
            .add("grant_type", "authorization_code")
            .add("client_id", BuildConfig.COGNITO_CLIENT_ID)
            .add("code", code)
            .add("redirect_uri", BuildConfig.OAUTH_REDIRECT_URI)
            .add("code_verifier", verifier)
            .build()

        val request = Request.Builder()
            .url("https://${BuildConfig.COGNITO_HOSTED_DOMAIN}/oauth2/token")
            .post(form)
            .build()

        val body = http.newCall(request).execute().use { response -> response.body?.string() ?: "" }
        val parsed = runCatching { Api.json.decodeFromString<TokenResponse>(body) }.getOrNull()
        // The verifier is single-use whatever happens next; leaving it behind would let
        // a replayed redirect reuse it.
        Session.clearOauthTransient(context)

        val access = parsed?.access_token
        if (access.isNullOrBlank()) throw OAuthException(friendly(parsed?.error))
        Session.setTokens(context, access, parsed.refresh_token ?: "")
        true
    }

    private fun friendly(code: String?): String = when (code) {
        "access_denied" -> "Sign-in was cancelled."
        "invalid_grant" -> "That sign-in link has expired. Try again."
        null -> "Sign-in failed. Check your connection and try again."
        else -> "Sign-in failed. Try again, or sign in on the web."
    }
}
