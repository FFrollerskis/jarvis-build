<#
  .SYNOPSIS
    Task Scheduler entry point for the Jarvis worker recovery supervisor.

  .DESCRIPTION
    Runs supervisor.mjs, which observes the existing JarvisClaudeWorker task and
    the worker's health journal, polls the trusted control issue for the two
    allowlisted commands (STATUS, RESTART_WORKER), and starts the existing
    scheduled task when the worker is provably a dead queue consumer.

    The supervisor never terminates a process, never edits the repository and
    never runs implementation tasks. It is intentionally separate from
    run-worker.ps1 so that a broken worker cannot take its own recovery path
    down with it.

    ASCII-only on purpose - see the note in run-worker.ps1.

  .NOTES
    Exit codes: 0 healthy/busy, 3 blocked, 4 transient, 1 fatal.
#>

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$logDir = Join-Path $here "supervisor-logs"
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

# The supervisor gets its own scratch, separate from the worker's.
$scratchRoot = Join-Path $logDir "tmp"
if (-not (Test-Path -LiteralPath $scratchRoot)) {
    New-Item -ItemType Directory -Path $scratchRoot -Force | Out-Null
}
$env:TEMP = $scratchRoot
$env:TMP = $scratchRoot

$schedulerLog = Join-Path $logDir "supervisor-scheduler.log"

$stamp = (Get-Date).ToUniversalTime().ToString("o")
"[$stamp] run-supervisor.ps1 invoked" | Out-File -FilePath $schedulerLog -Append -Encoding utf8

$exitCode = 1
try {
    node "supervisor.mjs" run 2>&1 | Tee-Object -FilePath $schedulerLog -Append
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
} catch {
    $errStamp = (Get-Date).ToUniversalTime().ToString("o")
    "[$errStamp] run-supervisor.ps1 caught exception: $($_.Exception.Message)" |
        Out-File -FilePath $schedulerLog -Append -Encoding utf8
    $exitCode = 1
}

$stampEnd = (Get-Date).ToUniversalTime().ToString("o")
"[$stampEnd] run-supervisor.ps1 finished, exit=$exitCode" | Out-File -FilePath $schedulerLog -Append -Encoding utf8

exit $exitCode
