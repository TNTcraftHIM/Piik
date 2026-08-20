[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [string]$Revision
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $scriptDirectory '..'))
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$repositoryPrefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($outputRoot.Equals($repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $outputRoot.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDirectory must be outside the repository.'
}
if (Test-Path -LiteralPath $outputRoot) {
    throw 'OutputDirectory must not already exist.'
}

$headRevision = (& git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve the Git revision.' }
if ([string]::IsNullOrWhiteSpace($Revision)) { $Revision = $headRevision }
$Revision = $Revision.Trim().ToLowerInvariant()
if ($Revision -notmatch '^[0-9a-f]{40}$' -or $Revision -ne $headRevision) {
    throw 'Revision must be the full SHA-1 of the checked-out commit.'
}
$dirty = @(git -C $repositoryRoot status --porcelain)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw 'Native packages must be built from a clean Git checkout.'
}

$go = Get-Command go.exe -ErrorAction Stop
$senderDirectory = Join-Path $repositoryRoot 'native\sender'
$packageName = "screener-native-windows-x64-$($Revision.Substring(0, 12))"
$packageDirectory = Join-Path $outputRoot $packageName
$licenseDirectory = Join-Path $packageDirectory 'licenses'
$senderExecutable = Join-Path $packageDirectory 'screener-sender.exe'
$zipPath = Join-Path $outputRoot "$packageName.zip"
New-Item -ItemType Directory -Path $licenseDirectory -Force | Out-Null

$previousGoOS = $env:GOOS
$previousGoArch = $env:GOARCH
$previousCGO = $env:CGO_ENABLED
Push-Location $senderDirectory
try {
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    $linkerFlags = "-X main.buildRevision=$Revision"
    & $go.Source build -mod=readonly -trimpath -buildvcs=true -ldflags $linkerFlags -o $senderExecutable ./cmd/screener-sender
    if ($LASTEXITCODE -ne 0) { throw 'Native sender build failed.' }

    $moduleLines = @(& $go.Source list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}{{end}}' ./cmd/screener-sender |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    if ($LASTEXITCODE -ne 0 -or $moduleLines.Count -eq 0) {
        throw 'Unable to enumerate linked Go modules.'
    }
    $goVersion = (& $go.Source version).Trim()
    $goRoot = (& $go.Source env GOROOT).Trim()
} finally {
    Pop-Location
    $env:GOOS = $previousGoOS
    $env:GOARCH = $previousGoArch
    $env:CGO_ENABLED = $previousCGO
}

& (Join-Path $repositoryRoot 'native\window-capture-helper\build.ps1') -OutputDirectory $packageDirectory | Out-Null
@('window-capture.obj', 'process-audio.obj') | ForEach-Object {
    $helperObject = Join-Path $packageDirectory $_
    if (Test-Path -LiteralPath $helperObject) { Remove-Item -LiteralPath $helperObject -Force }
}

$moduleManifest = @()
foreach ($line in $moduleLines) {
    $modulePath, $moduleVersion, $moduleDirectory = $line -split '\|', 3
    if ([string]::IsNullOrWhiteSpace($moduleDirectory) -or -not (Test-Path -LiteralPath $moduleDirectory -PathType Container)) {
        throw "Linked module source is unavailable: $modulePath@$moduleVersion"
    }
    $licenseFiles = @(Get-ChildItem -LiteralPath $moduleDirectory -File | Where-Object {
        $_.Name -match '^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)'
    })
    if ($licenseFiles.Count -eq 0) { throw "Linked module has no recognized license file: $modulePath@$moduleVersion" }
    $moduleLicenseDirectory = Join-Path $licenseDirectory (($modulePath + '@' + $moduleVersion) -replace '[^A-Za-z0-9._@+-]', '_')
    New-Item -ItemType Directory -Path $moduleLicenseDirectory | Out-Null
    $licenseFiles | Copy-Item -Destination $moduleLicenseDirectory
    $moduleManifest += "$modulePath $moduleVersion"
}

$goLicense = Join-Path $goRoot 'LICENSE'
if (-not (Test-Path -LiteralPath $goLicense -PathType Leaf)) { throw 'Go toolchain license was not found.' }
$goLicenseDirectory = Join-Path $licenseDirectory 'go-toolchain'
New-Item -ItemType Directory -Path $goLicenseDirectory | Out-Null
Copy-Item -LiteralPath $goLicense -Destination (Join-Path $goLicenseDirectory 'LICENSE')
$moduleManifest | Set-Content -LiteralPath (Join-Path $licenseDirectory 'MODULES.txt') -Encoding ascii
Copy-Item -LiteralPath (Join-Path $senderDirectory 'README.md') -Destination (Join-Path $packageDirectory 'README.md')
@(
    "revision=$Revision"
    'platform=windows/amd64'
    "toolchain=$goVersion"
) | Set-Content -LiteralPath (Join-Path $packageDirectory 'REVISION.txt') -Encoding ascii

$versionOutput = (& $senderExecutable --version).Trim()
if ($LASTEXITCODE -ne 0 -or $versionOutput -ne "Screener sender $Revision") {
    throw 'Packaged sender revision smoke failed.'
}

$packagePrefix = $packageDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$checksums = Get-ChildItem -LiteralPath $packageDirectory -File -Recurse | Sort-Object FullName | ForEach-Object {
    $relativePath = $_.FullName.Substring($packagePrefix.Length).Replace('\', '/')
    "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $relativePath"
}
$checksums | Set-Content -LiteralPath (Join-Path $packageDirectory 'SHA256SUMS.txt') -Encoding ascii

Compress-Archive -LiteralPath $packageDirectory -DestinationPath $zipPath -CompressionLevel Optimal
$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
"$zipHash  $([IO.Path]::GetFileName($zipPath))" |
    Set-Content -LiteralPath "$zipPath.sha256" -Encoding ascii

Write-Output $zipPath
Write-Output "$zipPath.sha256"
