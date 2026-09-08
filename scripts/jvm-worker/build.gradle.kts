plugins {
    kotlin("jvm")
    application
}

dependencies {
    implementation(project(":shared"))
    implementation(libs.kotlinx.coroutines.core)
}

kotlin {
    jvmToolchain(19)
}

application {
    mainClass.set("com.murph.jvmworker.MainKt")
}