# Terminal watchdog — keeps the autonomous loop alive for 8 hours.
#
#   .\watchdog.ps1            # 8 hours (default)
#   .\watchdog.ps1 -Hours 2   # shorter run
#
# The loop resumes from disk: AUTONOMOUS_BACKLOG.md holds the task state and
# AUTONOMOUS_LOG.md the history, so a restarted session continues where the
# previous one stopped.

param(
  [int]$Hours = 8,
  [int]$RestartDelaySeconds = 5
)

$ErrorActionPreference = 'Continue'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PromptFile = Join-Path $ProjectRoot 'overnight_prompt.md'
if (-not (Test-Path -LiteralPath $PromptFile)) {
  Write-Error "Missing $PromptFile"
  exit 1
}

$EndTime = (Get-Date).AddHours($Hours)
$Prompt = Get-Content -LiteralPath $PromptFile -Raw

Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] OpenCode autonomous loop started (ends $($EndTime.ToString('yyyy-MM-dd HH:mm:ss')))"

while ((Get-Date) -lt $EndTime) {
  Push-Location $ProjectRoot
  try {
    & opencode run $Prompt
  } catch {
    Write-Warning "opencode run failed: $($_.Exception.Message)"
  } finally {
    Pop-Location
  }
  if ((Get-Date) -ge $EndTime) { break }
  Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Session concluded. Restarting in ${RestartDelaySeconds}s..."
  Start-Sleep -Seconds $RestartDelaySeconds
}

Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Time is up. Review with:"
Write-Host "  git log --oneline -n 20"
Write-Host "  Get-Content .\AUTONOMOUS_LOG.md"
