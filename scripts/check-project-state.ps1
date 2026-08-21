$ErrorActionPreference = "Stop"

$repoRoot = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "This command must run inside the Screener Git repository."
}
Set-Location $repoRoot

$requiredPaths = Get-Content -Encoding UTF8 scripts/required-project-paths.txt

foreach ($path in $requiredPaths) {
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    git ls-files --error-unmatch -- $path 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Required project artifact is not Git-tracked: $path"
    }
}

$agentLines = @(Get-Content -Encoding UTF8 AGENTS.md).Count
$memoryLines = @(Get-Content -Encoding UTF8 docs/project-memory.md).Count
$memoryBytes = (Get-Item docs/project-memory.md).Length
$statusLines = @(Get-Content -Encoding UTF8 docs/status.md).Count
$statusBytes = (Get-Item docs/status.md).Length

if ($agentLines -gt 200) {
    throw "AGENTS.md exceeds the 200-line context budget: $agentLines lines"
}
if ($memoryLines -gt 200 -or $memoryBytes -gt 16000) {
    throw "docs/project-memory.md exceeds its budget: $memoryLines lines, $memoryBytes bytes"
}
if ($statusLines -gt 120 -or $statusBytes -gt 12000) {
    throw "docs/status.md exceeds its 120-line/12000-byte current-index budget: $statusLines lines, $statusBytes bytes. Remove completed history or move retained detail to its owning document; do not micro-compress prose."
}

git diff --check
if ($LASTEXITCODE -ne 0) { throw "Working-tree whitespace check failed." }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw "Staged whitespace check failed." }

if ($env:SCREENER_BASE_SHA) {
    git diff --check "$env:SCREENER_BASE_SHA...HEAD"
    if ($LASTEXITCODE -ne 0) { throw "Commit-range whitespace check failed." }
}

Write-Host "Repository hygiene checks passed."
