[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$pins = Get-Content -Raw (Join-Path $PSScriptRoot 'webrtc-dependencies.json') | ConvertFrom-Json
$cachePath = Join-Path $repositoryRoot 'build\encoder-pool'
$sdkPath = Join-Path $cachePath 'webrtc'
$toolchainPath = Join-Path $cachePath 'msvc-crt'
New-Item -ItemType Directory -Path $cachePath,$toolchainPath -Force | Out-Null

function Expand-PinnedArchive($pin, [string]$name, [string]$destination, [string]$entry) {
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
    if (!(Test-Path (Join-Path $destination $entry)) -or !(Test-Path $stamp) -or
        (Get-Content -Raw $stamp).Trim() -ne $pin.sha256) {
        & tar -xf $archive -C $destination $entry
        if ($LASTEXITCODE -ne 0) { throw "Could not unpack native WebRTC dependency: $name" }
        [IO.File]::WriteAllText($stamp, $pin.sha256 + "`n")
    }
}

Expand-PinnedArchive $pins.webrtc 'webrtc.windows_x86_64.zip' $cachePath 'webrtc'
Expand-PinnedArchive $pins.msvc.crt 'msvc-crt.vsix' $toolchainPath ($pins.msvc.directory + '/lib/x64')
Expand-PinnedArchive $pins.msvc.tools 'msvc-tools.vsix' $toolchainPath ($pins.msvc.directory + '/bin/Hostx64/x64')

$versions = Get-Content -Raw (Join-Path $sdkPath 'VERSIONS') | ConvertFrom-StringData
if ($versions.WEBRTC_COMMIT -ne $pins.webrtc.commit -or
    ('m' + $versions.WEBRTC_BUILD_VERSION) -ne $pins.webrtc.version) {
    throw 'Cached WebRTC SDK version differs from the dependency pin.'
}
$notices = Get-Content -Raw (Join-Path $repositoryRoot 'licenses\upstream.json') | ConvertFrom-Json
$notice = $notices.('webrtc@' + $pins.webrtc.version)
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
    Library = Join-Path $sdkPath 'lib\webrtc.lib'
    RuntimeLibraries = Join-Path $msvcPath 'lib\x64'
    Linker = Join-Path $msvcPath 'bin\Hostx64\x64\link.exe'
}
