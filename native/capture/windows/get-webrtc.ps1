[CmdletBinding()]
param([ValidateSet('x64', 'x86')][string]$Architecture = 'x64')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$pins = Get-Content -Raw (Join-Path $PSScriptRoot 'webrtc-dependencies.json') | ConvertFrom-Json
$cachePath = Join-Path $repositoryRoot 'build\encoder-pool'
$sdkPath = Join-Path $cachePath $(if ($Architecture -eq 'x86') { 'webrtc-x86' } else { 'webrtc' })
$toolchainPath = Join-Path $cachePath 'msvc-crt'
$clangPath = Join-Path $cachePath 'clang'
New-Item -ItemType Directory -Path $cachePath,$toolchainPath,$sdkPath -Force | Out-Null
$tar = Join-Path $env:SystemRoot 'System32/tar.exe'

function Expand-PinnedArchive($pin, [string]$name, [string]$destination, [string[]]$entries) {
    $archive = Join-Path $cachePath $name
    if (!(Test-Path $archive) -or
        (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) {
        $download = $archive + '.download'
        Invoke-WebRequest -UseBasicParsing -Uri $pin.url -OutFile $download -TimeoutSec 600
        if ((Get-FileHash $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) {
            throw "Native WebRTC dependency digest mismatch: $name"
        }
        Move-Item -LiteralPath $download -Destination $archive -Force
    }
    $stamp = $archive + '.extracted'
    $missing = @($entries | Where-Object { !(Test-Path (Join-Path $destination $_)) })
    if ($missing.Count -gt 0 -or !(Test-Path $stamp) -or
        (Get-Content -Raw $stamp).Trim() -ne $pin.sha256) {
        & $tar -xf $archive -C $destination @entries
        if ($LASTEXITCODE -ne 0) { throw "Could not unpack native WebRTC dependency: $name" }
        [IO.File]::WriteAllText($stamp, $pin.sha256 + "`n")
    }
}

if ($Architecture -eq 'x86') {
    $sdkPin = $pins.webrtcX86
    Expand-PinnedArchive $sdkPin 'libwebrtc-win-x86.7z' $sdkPath @('include', 'NOTICE', 'VERSION', 'release/webrtc.lib')
    Expand-PinnedArchive $pins.msvc.crtX86 'msvc-crt-x86.vsix' $toolchainPath ($pins.msvc.directory + '/lib/x86')
    New-Item -ItemType Directory -Path $clangPath -Force | Out-Null
    Expand-PinnedArchive $pins.clang 'clang.tar.xz' $clangPath @('lib', 'bin/clang-cl.exe')
    if ((Get-Content -Raw (Join-Path $sdkPath 'VERSION')).Trim() -ne $sdkPin.archiveVersion) {
        throw 'Cached x86 WebRTC SDK version differs from the dependency pin.'
    }
} else {
    $sdkPin = $pins.webrtc
    Expand-PinnedArchive $sdkPin 'webrtc.windows_x86_64.zip' $cachePath 'webrtc'
    Expand-PinnedArchive $pins.msvc.crt 'msvc-crt.vsix' $toolchainPath ($pins.msvc.directory + '/lib/x64')
    $versions = Get-Content -Raw (Join-Path $sdkPath 'VERSIONS') | ConvertFrom-StringData
    if ($versions.WEBRTC_COMMIT -ne $sdkPin.commit -or
        ('m' + $versions.WEBRTC_BUILD_VERSION) -ne $sdkPin.version) {
        throw 'Cached WebRTC SDK version differs from the dependency pin.'
    }
}
Expand-PinnedArchive $pins.msvc.tools 'msvc-tools.vsix' $toolchainPath ($pins.msvc.directory + '/bin/Hostx64/x64')
$notices = Get-Content -Raw (Join-Path $repositoryRoot 'licenses\upstream.json') | ConvertFrom-Json
$notice = $notices.('webrtc@' + $sdkPin.version)
$packagedNotice = Join-Path $repositoryRoot ('licenses\' + $notice.file)
# Tracked notices use LF without trailing whitespace; the Windows SDK uses CRLF.
$sdkNotice = [IO.File]::ReadAllText((Join-Path $sdkPath 'NOTICE')).Replace("`r`n", "`n").TrimEnd() + "`n"
$sdkNotice = [regex]::Replace($sdkNotice, '(?m)[ \t]+$', '')
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $sdkNoticeHash = [BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($sdkNotice))).Replace('-', '').ToLowerInvariant()
} finally { $sha256.Dispose() }
if ($sdkNoticeHash -ne $notice.sha256 -or
    (Get-FileHash $packagedNotice -Algorithm SHA256).Hash.ToLowerInvariant() -ne $notice.sha256) {
    throw 'WebRTC SDK and packaged notices must match the pinned upstream notice.'
}
$msvcPath = Join-Path $toolchainPath $pins.msvc.directory
return @{
    Include = Join-Path $sdkPath 'include'
    Library = Join-Path $sdkPath $(if ($Architecture -eq 'x86') { 'release/webrtc.lib' } else { 'lib/webrtc.lib' })
    RuntimeLibraries = Join-Path $msvcPath ('lib/' + $Architecture)
    Linker = Join-Path $msvcPath 'bin\Hostx64\x64\link.exe'
    AdapterCompiler = if ($Architecture -eq 'x86') { Join-Path $clangPath 'bin/clang-cl.exe' } else { 'cl.exe' }
}
