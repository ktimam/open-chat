param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$TargetDirectory
)
$ErrorActionPreference = 'Stop'
# This helper builds only; it never calls dfx, deploys, changes identities, or fetches dependencies.
# rust-toolchain.toml at the repository root selects Rust 1.95.0 and wasm32-unknown-unknown.
$registrySource = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $registrySource '../..'))
foreach ($candidate in @($OutputDirectory, $TargetDirectory)) {
    if (-not [System.IO.Path]::IsPathRooted($candidate)) { throw 'Build paths must be explicit absolute paths outside the repository.' }
    $resolved = [System.IO.Path]::GetFullPath($candidate).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    if ($resolved -eq $repositoryRoot -or $resolved.StartsWith($repositoryRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Use project-specific temporary storage outside the repository.'
    }
}
$registryOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$registryTarget = [System.IO.Path]::GetFullPath($TargetDirectory)
if (Test-Path -LiteralPath $registryOutput) { throw 'OutputDirectory must be new; existing artifacts are never overwritten.' }
$previousTarget = $env:CARGO_TARGET_DIR
try {
    $env:CARGO_TARGET_DIR = $registryTarget
    $manifest = Join-Path $registrySource 'Cargo.toml'
    & cargo test --manifest-path $manifest --locked --offline
    if ($LASTEXITCODE -ne 0) { throw 'Isolated registry tests failed.' }
    & cargo build --manifest-path $manifest --target wasm32-unknown-unknown --release --locked --offline
    if ($LASTEXITCODE -ne 0) { throw 'Isolated registry Wasm build failed.' }
    $generated = @(& cargo run --manifest-path $manifest --example export_candid --locked --offline --quiet)
    if ($LASTEXITCODE -ne 0) { throw 'Candid export failed.' }
    $generatedCandid = (($generated | Where-Object { -not $_.TrimStart().StartsWith('//') -and $_.Trim() }) -join "`n").Trim()
    $committedCandid = ((Get-Content -LiteralPath (Join-Path $registrySource 'app_registry.did') | Where-Object { $_.Trim() }) -join "`n").Trim()
    if ($generatedCandid -cne $committedCandid) { throw 'Generated Candid differs from the reviewed interface.' }
    New-Item -ItemType Directory -Path $registryOutput | Out-Null
    $wasm = Join-Path $registryTarget 'wasm32-unknown-unknown/release/openchat_fork_app_registry.wasm'
    Copy-Item -LiteralPath $wasm -Destination (Join-Path $registryOutput 'app_registry.wasm')
    Copy-Item -LiteralPath (Join-Path $registrySource 'app_registry.did') -Destination (Join-Path $registryOutput 'app_registry.did')
    Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $registryOutput 'app_registry.wasm'), (Join-Path $registryOutput 'app_registry.did')
} finally {
    $env:CARGO_TARGET_DIR = $previousTarget
}
