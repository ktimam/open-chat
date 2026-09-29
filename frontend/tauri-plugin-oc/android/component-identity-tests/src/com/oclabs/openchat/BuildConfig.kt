package com.oclabs.openchat

// Models the generated build-variant field, not a production configuration API.
// Mutable only in this host fixture so both compiled application branches are
// exercised by the matrix without changing production sources or using Gradle.
object BuildConfig {
    @JvmField
    var UNOFFICIAL_LOCAL_TEST = false
}
