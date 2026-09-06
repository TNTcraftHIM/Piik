$ErrorActionPreference = "Stop"

$repoRoot = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "This command must run inside the Screener Git repository."
}
Set-Location $repoRoot

foreach ($path in Get-Content -Encoding UTF8 scripts/required-project-paths.txt) {
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    git ls-files --error-unmatch -- $path 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Required project artifact is not Git-tracked: $path"
    }
}

git diff --check
if ($LASTEXITCODE -ne 0) { throw "Working-tree whitespace check failed." }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw "Staged whitespace check failed." }

if ($env:SCREENER_BASE_SHA -and $env:SCREENER_BASE_SHA -notmatch '^0{40}$') {
    git diff --check "$env:SCREENER_BASE_SHA...HEAD"
    if ($LASTEXITCODE -ne 0) { throw "Commit-range whitespace check failed." }
}

node scripts/check-docs.mjs
if ($LASTEXITCODE -ne 0) { throw "Documentation check failed." }

Write-Host "Repository hygiene checks passed."
