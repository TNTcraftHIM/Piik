[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$OutputDirectory,
    [Parameter(Mandatory = $true)] [string]$VisualStudioDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$pinPath = Join-Path $PSScriptRoot 'libvpx-dependencies.json'
$pins = Get-Content -Raw $pinPath | ConvertFrom-Json
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
$sourcePath = Join-Path $outputPath ('libvpx-' + $pins.libvpx.commit)
$buildPath = Join-Path $outputPath 'build'
$libraryPath = Join-Path $buildPath 'x64\Release\vpxmt.lib'
$stampPath = Join-Path $buildPath 'build-stamp.txt'
$toolset = Get-ChildItem (Join-Path $VisualStudioDirectory 'VC\Tools\MSVC') -Directory |
    Sort-Object Name -Descending | Select-Object -First 1
$stamp = (Get-FileHash $pinPath).Hash + (Get-FileHash $PSCommandPath).Hash + $toolset.Name
if ((Test-Path $libraryPath) -and (Test-Path $stampPath) -and
    (Get-Content -Raw $stampPath).Trim() -eq $stamp) {
    return @{ Include = $sourcePath; Library = $libraryPath }
}

New-Item -ItemType Directory -Path $outputPath,$buildPath -Force | Out-Null
function Get-PinnedArchive($pin, [string]$name) {
    $archive = Join-Path $outputPath $name
    if (!(Test-Path $archive) -or
        (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) {
        Invoke-WebRequest -UseBasicParsing -Uri $pin.url -OutFile $archive -TimeoutSec 120
    }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) {
        throw "Native codec dependency digest mismatch: $name"
    }
    return $archive
}

$sourceArchive = Get-PinnedArchive $pins.libvpx 'libvpx.tar.gz'
& tar -xf $sourceArchive -C $outputPath
if ($LASTEXITCODE -ne 0) { throw 'Could not unpack libvpx source.' }
$nasmArchive = Get-PinnedArchive $pins.nasm 'nasm.zip'
$nasmPath = Join-Path $outputPath ('nasm\nasm-' + $pins.nasm.version)
Expand-Archive -LiteralPath $nasmArchive -DestinationPath (Join-Path $outputPath 'nasm') -Force
$makeArchive = Get-PinnedArchive $pins.make 'make.pkg.tar.zst'
$makeRoot = Join-Path $outputPath 'make'
$makePath = Join-Path $makeRoot 'usr\bin'
New-Item -ItemType Directory -Path $makeRoot -Force | Out-Null
& tar -xf $makeArchive -C $makeRoot usr/bin/make.exe
if ($LASTEXITCODE -ne 0) { throw 'Could not unpack the libvpx build tool.' }

$gitRoot = Split-Path -Parent (Split-Path -Parent (Get-Command git.exe).Source)
$bashPath = Join-Path $gitRoot 'bin\bash.exe'
if (!(Test-Path $bashPath)) { throw 'Git for Windows Bash is required to build libvpx.' }
$developerCommand = Join-Path $VisualStudioDirectory 'Common7\Tools\VsDevCmd.bat'
$compile = @(
    'set "PATH={0};{1};{2};%PATH%"' -f $nasmPath,$makePath,(Join-Path $gitRoot 'usr\bin')
    'call "{0}" -arch=x64 -host_arch=x64 >nul' -f $developerCommand
    'cd /d "{0}"' -f $buildPath
    '"{0}" "{1}" --target=x86_64-win64-vs17 --as=nasm --disable-vp9 --disable-vp8-decoder --disable-examples --disable-unit-tests --disable-tools --disable-docs --disable-webm-io --disable-libyuv --disable-postproc --enable-realtime-only --enable-static-msvcrt' -f $bashPath,((Join-Path $sourcePath 'configure').Replace('\','/'))
    'make.exe -B vpx.vcxproj'
    'msbuild vpx.vcxproj /nologo /t:Rebuild /p:Configuration=Release /p:Platform=x64 /m:4 /v:minimal'
) -join ' && '
& cmd.exe /d /s /c $compile | Out-Host
if ($LASTEXITCODE -ne 0 -or !(Test-Path $libraryPath)) {
    throw 'Native VP8 library compilation failed.'
}
[IO.File]::WriteAllText($stampPath, $stamp + "`n")
return @{ Include = $sourcePath; Library = $libraryPath }
