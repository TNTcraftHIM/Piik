[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
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
$executablePath = Join-Path $outputPath 'screener-window-capture.exe'
$mainObjectPath = Join-Path $outputPath 'window-capture.obj'
$audioObjectPath = Join-Path $outputPath 'process-audio.obj'
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

$compile = @(
    'call "{0}" -arch=x64 -host_arch=x64 >nul' -f $developerCommand
    'cl.exe /nologo /c /std:c++20 /EHsc /W4 /WX /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0A00 /DNTDDI_VERSION=0x0A00000A "{0}" /Fo:"{1}"' -f $mainSourcePath, $mainObjectPath
    'cl.exe /nologo /c /std:c++20 /EHsc /W4 /WX /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0A00 /DNTDDI_VERSION=0x0A00000A "{0}" /Fo:"{1}"' -f $audioSourcePath, $audioObjectPath
    'link.exe /nologo /out:"{0}" "{1}" "{2}" ole32.lib mmdevapi.lib runtimeobject.lib user32.lib mfplat.lib mf.lib mfuuid.lib d3d11.lib dxgi.lib dxguid.lib evr.lib oleaut32.lib windowsapp.lib' -f $executablePath, $mainObjectPath, $audioObjectPath
) -join ' && '

& cmd.exe /d /s /c $compile
if ($LASTEXITCODE -ne 0) {
    throw "Window-capture helper compilation failed with exit code $LASTEXITCODE."
}
Write-Output $executablePath
