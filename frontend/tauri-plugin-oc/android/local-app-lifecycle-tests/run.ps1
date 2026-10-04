[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$JavaHome,
    [Parameter(Mandatory = $true)][string]$KotlinCompilerClasspath,
    [Parameter(Mandatory = $true)][string]$KotlinRuntimeClasspath,
    [Parameter(Mandatory = $true)][string]$JUnitClasspath,
    [Parameter(Mandatory = $true)][string]$AndroidJar,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$AndroidXCoreAar,
    [switch]$DownloadAndroidXCore
)

$ErrorActionPreference = 'Stop'
$java = Join-Path $JavaHome 'bin/java.exe'
if (-not (Test-Path -LiteralPath $java -PathType Leaf)) {
    $java = Join-Path $JavaHome 'bin/java'
}
$separator = [IO.Path]::PathSeparator
foreach ($file in @($java, $AndroidJar) + (($KotlinCompilerClasspath, $KotlinRuntimeClasspath, $JUnitClasspath) -join $separator -split [regex]::Escape($separator))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required cached tool/dependency is missing: $file" }
}
if ([bool]$AndroidXCoreAar -eq [bool]$DownloadAndroidXCore) {
    throw 'Select exactly one existing AndroidXCoreAar or explicit DownloadAndroidXCore.'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw "Use a new output directory so old classes cannot pass this test: $output" }
New-Item -ItemType Directory -Path $output | Out-Null

# Existing application dependency, not a new app package. The cached AAR SHA-256
# independently matched this exact official Google Maven .aar.sha256 on 2026-10-04.
$coreBytes = 1364590
$coreSha256 = '311d83ac67d394076ec21d12ed2d10a44b59cb2929b7dce00e5a90a93842e37d'
$coreUrl = 'https://dl.google.com/dl/android/maven2/androidx/core/core/1.18.0/core-1.18.0.aar'
if ($DownloadAndroidXCore) {
    $AndroidXCoreAar = Join-Path $output 'core-1.18.0.aar'
    Invoke-WebRequest -Uri $coreUrl -OutFile $AndroidXCoreAar -TimeoutSec 30 -MaximumRedirection 0
}
if (-not (Test-Path -LiteralPath $AndroidXCoreAar -PathType Leaf)) { throw 'Pinned AndroidX core AAR is missing.' }
if ((Get-Item -LiteralPath $AndroidXCoreAar).Length -ne $coreBytes -or
    (Get-FileHash -LiteralPath $AndroidXCoreAar -Algorithm SHA256).Hash.ToLowerInvariant() -ne $coreSha256) {
    throw 'AndroidX core AAR size or SHA-256 mismatch.'
}

# Extract one fixed entry only: no archive-provided paths reach the filesystem.
$coreClasses = Join-Path $output 'core-1.18.0-classes.jar'
$archive = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($AndroidXCoreAar))
try {
    $entries = @($archive.Entries | Where-Object FullName -EQ 'classes.jar')
    if ($entries.Count -ne 1 -or $entries[0].Length -ne 1383395) { throw 'Unexpected AndroidX classes entry.' }
    $source = $entries[0].Open()
    try {
        $destination = [IO.File]::Open($coreClasses, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
        try { $source.CopyTo($destination) } finally { $destination.Dispose() }
    } finally { $source.Dispose() }
} finally { $archive.Dispose() }
if ((Get-FileHash -LiteralPath $coreClasses -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'd1f5a319a77555df7e23858ffb5ed45a95ebb4263fa1ab7a993510ceb53555a0') {
    throw 'AndroidX classes SHA-256 mismatch.'
}

$policy = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src/main/java/privateapps/LocalAppLeasePolicy.kt'))
$service = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src/main/java/privateapps/LocalAppTransferService.kt'))
$localTestPolicy = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src/main/java/LocalTestPolicy.kt'))
$policyTest = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../src/test/java/privateapps/LocalAppLeasePolicyTest.kt'))
$generatedResource = Join-Path $PSScriptRoot 'src/com/ocplugin/app/R.kt'
$hostOutput = Join-Path $output 'host-classes'
$sdkOutput = Join-Path $output 'sdk-classes'

Write-Output 'Compiling actual lease policy/test, then actual service with SDK 36 and pinned real AndroidX core.'
Get-FileHash -Algorithm SHA256 -LiteralPath $policy, $service, $localTestPolicy, $policyTest | Format-List Path, Hash
& $java -Xmx512m -cp $KotlinCompilerClasspath org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -jvm-target 17 -classpath "$KotlinRuntimeClasspath$separator$JUnitClasspath" -d $hostOutput $policy $policyTest
if ($LASTEXITCODE -ne 0) { throw 'Private-app lease policy test compilation failed.' }
& $java -Xmx256m -cp "$hostOutput$separator$KotlinRuntimeClasspath$separator$JUnitClasspath" org.junit.runner.JUnitCore com.ocplugin.app.privateapps.LocalAppLeasePolicyTest
if ($LASTEXITCODE -ne 0) { throw 'Private-app lease policy tests failed.' }

# No Android/AndroidX or local-test policy doubles. Only generated R is supplied.
& $java -Xmx512m -cp $KotlinCompilerClasspath org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -jvm-target 17 -classpath "$KotlinRuntimeClasspath$separator$AndroidJar$separator$coreClasses" -d $sdkOutput $policy $service $localTestPolicy $generatedResource
if ($LASTEXITCODE -ne 0) { throw 'Actual private-app service SDK/AndroidX compilation failed.' }
Write-Output 'PASS: lease policy tests and real SDK/AndroidX service compilation. Not device lifecycle or APK evidence.'
