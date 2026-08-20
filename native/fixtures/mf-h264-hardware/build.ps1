[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$fixtureDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $fixtureDirectory '..\..\..'))
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
$repositoryPrefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

if ($outputPath.Equals($repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $outputPath.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDirectory must be outside the repository.'
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw 'Visual Studio Installer vswhere.exe was not found.'
}

$installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ([string]::IsNullOrWhiteSpace($installationPath)) {
    throw 'Visual Studio C++ Build Tools were not found.'
}

$developerCommand = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
$sourcePath = Join-Path $fixtureDirectory '..\..\window-capture-helper\main.cpp'
$executablePath = Join-Path $outputPath 'screener-mf-h264-fixture.exe'
$objectPath = Join-Path $outputPath 'main.obj'

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

$compile = @(
    'call "{0}" -arch=x64 -host_arch=x64 >nul' -f $developerCommand
    'cl.exe /nologo /std:c++20 /EHsc /W4 /WX /DSCREENER_H264_FIXTURE /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0A00 "{0}" /Fo:"{1}" /Fe:"{2}" /link mfplat.lib mf.lib mfuuid.lib d3d11.lib dxgi.lib dxguid.lib evr.lib ole32.lib oleaut32.lib pdh.lib windowsapp.lib' -f $sourcePath, $objectPath, $executablePath
) -join ' && '

& cmd.exe /d /s /c $compile
if ($LASTEXITCODE -ne 0) {
    throw "Native fixture compilation failed with exit code $LASTEXITCODE."
}

Write-Output $executablePath
