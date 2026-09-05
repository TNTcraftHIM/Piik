[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$helperDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $helperDirectory '..\..'))
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
$repositoryPrefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($outputPath.Equals($repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $outputPath.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDirectory must be outside the repository.'
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ([string]::IsNullOrWhiteSpace($installationPath)) {
    throw 'Visual Studio C++ Build Tools were not found.'
}

$developerCommand = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
$mainSourcePath = Join-Path $helperDirectory 'main.cpp'
$audioSourcePath = Join-Path $helperDirectory 'process_audio.cpp'
$targetSourcePath = Join-Path $helperDirectory 'capture_target.cpp'
$vp8SourcePath = Join-Path $helperDirectory 'vp8_encoder.cpp'
$executablePath = Join-Path $outputPath 'screener-client-capture.exe'
$mainObjectPath = Join-Path $outputPath 'window-capture.obj'
$audioObjectPath = Join-Path $outputPath 'process-audio.obj'
$targetObjectPath = Join-Path $outputPath 'capture-target.obj'
$vp8ObjectPath = Join-Path $outputPath 'vp8-encoder.obj'
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$vpx = & (Join-Path $helperDirectory 'build-libvpx.ps1') -OutputDirectory (Join-Path $outputPath 'libvpx') -VisualStudioDirectory $installationPath

$compile = @(
    'call "{0}" -arch=x64 -host_arch=x64 >nul' -f $developerCommand
    'cl.exe /nologo /c /std:c++20 /EHsc /W4 /WX /external:I "{2}" /external:W0 /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0A00 /DNTDDI_VERSION=0x0A00000A "{0}" /Fo:"{1}"' -f $mainSourcePath, $mainObjectPath, $vpx.Include
    'cl.exe /nologo /c /std:c++20 /EHsc /W4 /WX /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0A00 /DNTDDI_VERSION=0x0A00000A "{0}" /Fo:"{1}"' -f $audioSourcePath, $audioObjectPath
    'cl.exe /nologo /c /std:c++20 /EHsc /W4 /WX /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0A00 /DNTDDI_VERSION=0x0A00000A "{0}" /Fo:"{1}"' -f $targetSourcePath, $targetObjectPath
    'cl.exe /nologo /c /std:c++20 /EHsc /O2 /W4 /WX /external:I "{2}" /external:W0 "{0}" /Fo:"{1}"' -f $vp8SourcePath, $vp8ObjectPath, $vpx.Include
    'link.exe /nologo /LTCG /out:"{0}" "{1}" "{2}" "{3}" "{4}" "{5}" ole32.lib mmdevapi.lib runtimeobject.lib user32.lib gdi32.lib dwmapi.lib shell32.lib mfplat.lib mf.lib mfuuid.lib d3d11.lib dxgi.lib dxguid.lib evr.lib oleaut32.lib windowsapp.lib' -f $executablePath, $mainObjectPath, $audioObjectPath, $targetObjectPath, $vp8ObjectPath, $vpx.Library
) -join ' && '

& cmd.exe /d /s /c $compile
if ($LASTEXITCODE -ne 0) {
    throw "Window-capture helper compilation failed with exit code $LASTEXITCODE."
}
if ($Check) {
    $geometrySource = Join-Path $helperDirectory 'capture_geometry.test.cpp'
    $geometryObject = Join-Path $outputPath 'capture-geometry.test.obj'
    $geometryCheck = Join-Path $outputPath 'capture-geometry.test.exe'
    $compileCheck = 'call "{0}" -arch=x64 -host_arch=x64 >nul && cl.exe /nologo /std:c++20 /EHsc /W4 /WX "{1}" /Fo:"{2}" /Fe:"{3}" /link user32.lib' -f $developerCommand, $geometrySource, $geometryObject, $geometryCheck
    & cmd.exe /d /s /c $compileCheck
    if ($LASTEXITCODE -ne 0) { throw 'Capture geometry check compilation failed.' }
    & $geometryCheck
    if ($LASTEXITCODE -ne 0) { throw 'Capture geometry check failed.' }
}
Write-Output $executablePath
