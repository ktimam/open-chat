# Component identity contract tests

These offline tests compile the current production `IntentsManager.kt` and app
`MyApplication.kt`; they do not reproduce their implementation in test code.
They are deliberately outside Gradle's source sets and add no production or test
dependency to the application.

The JUnit matrix covers matching and mismatched installed package/class namespace,
both sides of the existing API 23 PendingIntent flag branch, and official versus
unofficial-local-test generated build flags: eight parameter combinations. All four
intent paths, clear errors before registration, cold Application startup before
Firebase/database callbacks and background-thread use without creating an Activity
remain covered. Official builds initialize Firebase (including its unavailable
result); local-test builds do not attempt it. Database initialization and component
registration remain required for both. Actual Application activity callbacks must
mark only MainActivity start/stop as foreground changes: an unrelated activity,
such as the native incoming-call screen, must not enable foreground push routing
or hide an already started MainActivity. Other callbacks, a background read and the
actual production foreground field's volatile modifier are checked as well. The
five tests execute across all eight combinations (40 JUnit cases).

Android factories and ActivityLifecycleCallbacks registration are explicit
recording doubles. Firebase, generated BuildConfig, database, app component classes
and notification serialization are explicit fixtures; the opaque notification
payload must pass through unchanged. The fixture BuildConfig flag is mutable only
to exercise both production branches in this host suite; it is not a new runtime
configuration or production test API. The obsolete ProcessLifecycleOwner fixture
is removed, so reintroducing that dependency cannot silently compile against it.

A second compilation omits every `android.*` double and uses the supplied real
Android SDK `android.jar`. It checks the production source's Android API/types and
seven SDK constants used by the recording doubles. Bundle and the complete
Application.ActivityLifecycleCallbacks API must compile against SDK 36 itself.
The non-Android collaborators remain fixtures, so this is not a complete app
compilation.

Run `run.ps1` with existing local tools only:

```powershell
./run.ps1 -JavaHome $jdkPath `
    -KotlinCompilerClasspath $compilerJars `
    -KotlinRuntimeClasspath $runtimeJars `
    -JUnitClasspath $junitAndHamcrestJars `
    -AndroidJar $sdkAndroidJar `
    -OutputDirectory $freshTestOutput
```

Classpaths use the platform path separator. Supply the complete cached Kotlin
compiler dependency classpath, Kotlin runtime, and JUnit 4.13.2/Hamcrest. The runner
does not fetch dependencies, modify defaults, or reuse an existing output directory.
It prints the hashes of the actual production sources it compiles.

The current independent `android-component-contracts` job in
`.github/workflows/unofficial_client_security.yaml` runs this same runner using
Java 21 and SDK 36. The original
`.github/workflows/on_device_model_security.yaml` remains a historical workflow,
not the current main route. Both use the same runner and pinned test-tool manifest;
this fixture update changes neither workflow. The job provisions only the nine
test-tool JARs in
`scripts/android_component_identity_tools.json`, with exact byte/SHA-256 checks
before producing classpaths. The manifest records the distinction between locally
computed SHA-256 pins and corroborating official Maven Central `.sha1` metadata:
https://central.sonatype.org/publish/requirements/#provide-file-checksums.
There are no mutable dependency versions, cache scans, redirects, retries,
credentials, Tauri initialization, native signing, or application dependencies in
this resolver. Each artifact has a 60-second deadline and bounded size. Fresh
download and compilation directories are mandatory; failed partial downloads are
left as `.part` diagnostics and are never accepted as JARs. Offline fixture tests
exercise these failure boundaries separately from the actual Kotlin/SDK job.

This is host contract and SDK compilation evidence, **not Robolectric or Android
runtime proof**. Before a phone handoff, separately validate a real merged manifest
and same-certificate in-place APK update, then exercise cold/background notification
tap, summary/individual dismissal and shortcut launch with installed application ID
different from class namespace. Do not uninstall or clear account data to perform
that validation.
