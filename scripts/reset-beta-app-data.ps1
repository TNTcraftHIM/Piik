param(
  [string]$DataDirectory = $env:PIIK_CHANNEL_APP_DATA_DIR,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
  $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
  if ([string]::IsNullOrWhiteSpace($localAppData)) { throw "Local application data directory is unavailable." }
  $DataDirectory = Join-Path $localAppData "Piik\channel-app"
}

$appProcesses = @(Get-Process -Name "piik-app", "piik-channel-app" -ErrorAction SilentlyContinue)
if ($appProcesses.Count -gt 0) {
  throw "Piik App is still running. Close it normally, then run this script again."
}

if (-not (Test-Path -LiteralPath $DataDirectory -PathType Container)) {
  Write-Host "No App data directory found: $DataDirectory"
  exit 0
}

$resolvedDataDirectory = (Resolve-Path -LiteralPath $DataDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $resolvedDataDirectory "app.sqlite") -PathType Leaf)) {
  throw "This is not a Piik App data directory: $resolvedDataDirectory"
}
if ((Get-Item -LiteralPath $resolvedDataDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw "Choose the actual App data directory, not a directory link."
}
$parentDirectory = Split-Path -Parent $resolvedDataDirectory
$leaf = Split-Path -Leaf $resolvedDataDirectory
$stamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss-fffZ")
$backupDirectory = Join-Path $parentDirectory "$leaf.beta-backup.$stamp"
if (Test-Path -LiteralPath $backupDirectory) { throw "Backup already exists: $backupDirectory" }

if (-not $Yes) {
  Write-Host "This beta-only action will rename the old data directory and keep it as a backup:"
  Write-Host "  $resolvedDataDirectory"
  Write-Host "-> $backupDirectory"
  Write-Host "It does not migrate or delete the old database."
  $answer = Read-Host "Type RESET to continue"
  if ($answer -cne "RESET") { Write-Host "Cancelled."; exit 1 }
}

Move-Item -LiteralPath $resolvedDataDirectory -Destination $backupDirectory
Write-Host "The next App start will create a fresh beta data directory."
Write-Host "Old data kept at: $backupDirectory"
