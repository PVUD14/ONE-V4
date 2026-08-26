plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "pro.ai8ht.one"
    compileSdk = 35

    defaultConfig {
        applicationId = "pro.ai8ht.one"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        // The production API origin. Debug builds may override via the in-app
        // developer settings; the /api/v1 contract is additive-only once this
        // app ships (see docs/architecture/MOBILE_FOUNDATION.md).
        buildConfigField("String", "API_BASE_URL", "\"https://one.ai8ht.pro\"")
        // Cognito mobile app client — empty until the operator registers it
        // (AWS console, pool ap-south-1_nPl3qFkvB). The sign-in screen explains
        // itself while this is blank and offers the UAT token path instead.
        buildConfigField("String", "COGNITO_HOSTED_DOMAIN", "\"\"")
        // The public SPA client (same one the web app ships to every browser).
        // Password sign-in works once ALLOW_USER_PASSWORD_AUTH is enabled on it.
        buildConfigField("String", "COGNITO_SPA_CLIENT_ID", "\"1i2kqvh3hknfq6ntf1eph6nt5t\"")
        buildConfigField("String", "COGNITO_REGION", "\"ap-south-1\"")
        buildConfigField("String", "COGNITO_CLIENT_ID", "\"\"")
        buildConfigField("String", "OAUTH_REDIRECT_URI", "\"one.ai8ht.pro://signin\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.01.00")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.browser:browser:1.8.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // SRP sign-in against the existing Cognito client - same flow the web uses,
    // so no server or console change is needed.
    implementation("com.amazonaws:aws-android-sdk-cognitoidentityprovider:2.77.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.compose.ui:ui-tooling-preview")
}
