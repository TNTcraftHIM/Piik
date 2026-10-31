param(
    [Parameter(Mandatory = $true)] [ValidateSet('Start', 'Stop')] [string] $Action,
    [Parameter(Mandatory = $true)] [string] $Payload
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json

if ($Action -eq 'Start') {
    $stdout = Join-Path $spec.directory 'stdout.log'
    $stderr = Join-Path $spec.directory 'stderr.log'
    $start = @{
        FilePath = $spec.command
        WorkingDirectory = (Get-Location).Path
        WindowStyle = 'Hidden'
        PassThru = $true
        RedirectStandardOutput = $stdout
        RedirectStandardError = $stderr
    }
    if ($spec.arguments.Count -gt 0) {
        # Start-Process joins ArgumentList; preserve Windows argv quoting here.
        $start.ArgumentList = ($spec.arguments | ForEach-Object {
            '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
        }) -join ' '
    }
    $target = $null
    try {
        # Redirection selects CreateProcess; Hidden keeps its new console invisible.
        $target = Start-Process @start
        $null = $target.Handle
        [Console]::Out.WriteLine($target.Id)
        $target.WaitForExit()
        $exitCode = $target.ExitCode
        [Console]::Out.Write([IO.File]::ReadAllText($stdout))
        [Console]::Error.Write([IO.File]::ReadAllText($stderr))
        exit $exitCode
    }
    finally {
        if ($null -ne $target) {
            if (-not $target.HasExited) {
                $target.Kill()
                $null = $target.WaitForExit(5000)
            }
            $target.Dispose()
        }
    }
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class PiikConsoleSignal {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);

    public static void Stop(int processId) {
        using (Process target = Process.GetProcessById(processId)) {
            if (target.HasExited) return;
            FreeConsole();
            if (!AttachConsole((uint)processId)) throw new Win32Exception();
            try {
                if (!SetConsoleCtrlHandler(IntPtr.Zero, true)) throw new Win32Exception();
                if (!GenerateConsoleCtrlEvent(0, 0)) throw new Win32Exception();
                // Keep the sender attached until the target has handled Ctrl+C.
                if (!target.WaitForExit(10000)) throw new TimeoutException("Process did not exit after Ctrl+C");
            }
            finally { FreeConsole(); }
        }
    }
}
'@
[PiikConsoleSignal]::Stop([int]$spec.pid)
