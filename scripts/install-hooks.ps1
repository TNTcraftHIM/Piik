$ErrorActionPreference = "Stop"

$repoRoot = git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) {
    throw "This command must run inside the Piik Git repository."
}

git -C $repoRoot config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) {
    throw "Failed to configure core.hooksPath."
}

& "$repoRoot/scripts/check-project-state.ps1"

Write-Host "Git hooks installed from .githooks."
