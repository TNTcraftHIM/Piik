[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$helperDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $helperDirectory '..\..\..'))
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
$repositoryPrefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$buildPrefix = (Join-Path $repositoryRoot 'build') + [IO.Path]::DirectorySeparatorChar
if ($outputPath.Equals($repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
    ($outputPath.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase) -and
     !$outputPath.StartsWith($buildPrefix, [StringComparison]::OrdinalIgnoreCase))) {
    throw 'OutputDirectory must be below build/ or outside the repository.'
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ([string]::IsNullOrWhiteSpace($installationPath)) {
    throw 'Visual Studio C++ Build Tools were not found.'
}

$developerCommand = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
$executablePath = Join-Path $outputPath 'piik-capture.exe'
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$webrtc = & (Join-Path $helperDirectory 'get-webrtc.ps1')
$includeFlags = @('', 'third_party\abseil-cpp', 'third_party\boringssl\src\include',
    'third_party\libyuv\include', 'third_party\libvpx\source\libvpx') | ForEach-Object {
    '/external:I "{0}"' -f (Join-Path $webrtc.Include $_).TrimEnd('\')
}
$compileFlags = '/nologo /c /std:c++20 /EHsc /GR /O2 /W4 /WX /MT /D_ITERATOR_DEBUG_LEVEL=0 /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0A00 /DNTDDI_VERSION=0x0A00000A /external:W0 ' + ($includeFlags -join ' ')
$systemLibraries = 'ole32.lib mmdevapi.lib runtimeobject.lib user32.lib gdi32.lib dwmapi.lib shell32.lib mfplat.lib mf.lib mfuuid.lib d3d11.lib dxgi.lib dxguid.lib evr.lib oleaut32.lib windowsapp.lib winmm.lib ws2_32.lib strmiids.lib crypt32.lib dmoguids.lib iphlpapi.lib msdmo.lib secur32.lib wmcodecdspuuid.lib'
$linkCommand = '"{0}" /nologo /libpath:"{1}"' -f $webrtc.Linker,$webrtc.RuntimeLibraries

function Invoke-CaptureBuild([string]$command) {
    & cmd.exe /d /s /c ('call "{0}" -arch=x64 -host_arch=x64 >nul && {1}' -f $developerCommand,$command) | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Window-capture helper compilation failed with exit code $LASTEXITCODE."
    }
}

$objects = foreach ($name in @('main', 'process_audio', 'capture_target', 'h264_encoder', 'adaptive_encoder')) {
    $source = Join-Path $helperDirectory ($name + '.cpp')
    $object = Join-Path $outputPath ($name + '.obj')
    $definitions = if ($name -eq 'adaptive_encoder') { '/DWEBRTC_WIN /DRTC_ENABLE_H265 /DNOMINMAX' } else { '' }
    Invoke-CaptureBuild ('cl.exe {0} /DNDEBUG {1} "{2}" /Fo:"{3}"' -f $compileFlags,$definitions,$source,$object)
    '"{0}"' -f $object
}
Invoke-CaptureBuild ('{0} /out:"{1}" {2} "{3}" {4}' -f $linkCommand,$executablePath,($objects -join ' '),$webrtc.Library,$systemLibraries)

if ($Check) {
    $vp8Object = Join-Path $outputPath 'vp8_encoder.obj'
    Invoke-CaptureBuild ('cl.exe {0} /DNDEBUG "{1}" /Fo:"{2}"' -f $compileFlags,(Join-Path $helperDirectory 'vp8_encoder.cpp'),$vp8Object)
    foreach ($name in @('capture_geometry', 'capture_control', 'capture_target', 'output_worker')) {
        $source = Join-Path $helperDirectory ($name + '.test.cpp')
        $object = Join-Path $outputPath ($name + '.test.obj')
        $executable = Join-Path $outputPath ($name + '.test.exe')
        Invoke-CaptureBuild ('cl.exe {0} "{1}" /Fo:"{2}"' -f $compileFlags,$source,$object)
        $codecObjects = if ($name -eq 'capture_control') { '"{0}" "{1}"' -f $vp8Object,$webrtc.Library } else { '' }
        if ($name -eq 'capture_target') {
            $codecObjects = '"{0}"' -f (Join-Path $outputPath 'capture_target.obj')
        }
        if ($name -eq 'output_worker') {
            $codecObjects = (@('h264_encoder', 'process_audio', 'capture_target') | ForEach-Object {
                '"{0}"' -f (Join-Path $outputPath ($_ + '.obj'))
            }) -join ' '
            $codecObjects += ' "{0}"' -f $webrtc.Library
        }
        Invoke-CaptureBuild ('{0} /out:"{1}" "{2}" {3} {4}' -f $linkCommand,$executable,$object,$codecObjects,$systemLibraries)
        & $executable
        if ($LASTEXITCODE -ne 0) { throw "Capture check failed: $name" }
    }
}
Write-Output $executablePath
