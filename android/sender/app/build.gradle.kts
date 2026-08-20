plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "icu.bonfire.screener.sender"
    compileSdk = 35

    defaultConfig {
        applicationId = "icu.bonfire.screener.sender"
        minSdk = 34
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
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
    implementation(project(":protocol"))
    implementation("com.squareup.okhttp3:okhttp:5.3.0")
    implementation("io.github.webrtc-sdk:android:144.7559.12")
}
