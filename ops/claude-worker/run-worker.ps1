<#
  .SYNOPSIS
    Task Scheduler entry point for the Jarvis Architect <-> Claude worker.

  .DESCRIPTION
    Thin, deliberately boring wrapper. It does exactly three things:
      1. points TEMP/TMP at the worker's own scratch root, so nothing the child
         process creates can ever land inside the Jarvis repository;
      2. records a scheduler_invoked health event BEFORE node starts, so a
         crash-on-startup is still visible as "the scheduler fired but the queue
         was never polled";
      3. runs worker.mjs and propagates its exit code faithfully.

    All repository preflight, scratch quarantine and dirty-guard logic now lives
    in worker.mjs (it needs worker state to verify provenance, which PowerShell
    does not have). The old run-worker-safe.ps1 is superseded and is removed by
    install.ps1.

    IMPORTANT: this file is ASCII-only on purpose. A previous hand-edit of the
    wrapper introduced a stray character from a mobile keyboard and produced a
    ParserError, which silently stopped the whole loop. Edit it in the repo and
    deploy it with install.ps1 - never by retyping it on the host.

  .NOTES
    Exit codes come from worker.mjs and are NOT all-or-nothing:
      0 = healthy (idle, or a task completed with verified evidence)
      3 = blocked (needs a human or a fresh task; NOT silently healthy)
      4 = transient (auth/network/retryable failure; will retry with backoff)
      1 = fatal (config/parse error)
#>

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$logDir = Join-Path $here "logs"
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

# Scratch is outside the repository by construction.
$scratchRoot = Join-Path $here "tmp"
if (-not (Test-Path -LiteralPath $scratchRoot)) {
    New-Item -ItemType Directory -Path $scratchRoot -Force | Out-Null
}
$env:TEMP = $scratchRoot
$env:TMP = $scratchRoot
$env:JARVIS_WORKER_SCRATCH = $scratchRoot

$schedulerLog = Join-Path $logDir "scheduler.log"
$healthFile = Join-Path $logDir "health.jsonl"

$stamp = (Get-Date).ToUniversalTime().ToString("o")
"[$stamp] run-worker.ps1 invoked" | Out-File -FilePath $schedulerLog -Append -Encoding utf8

# Health event written from PowerShell, before node exists: this is the ONLY
# evidence that survives a node-level startup crash.
$invokeEvent = [pscustomobject]@{
    ts      = $stamp
    event   = "scheduler_invoked"
    script  = "run-worker.ps1"
    pid     = $PID
}
($invokeEvent | ConvertTo-Json -Compress) | Out-File -FilePath $healthFile -Append -Encoding utf8

$exitCode = 1
try {
    node "worker.mjs" run 2>&1 | Tee-Object -FilePath $schedulerLog -Append
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
} catch {
    $errStamp = (Get-Date).ToUniversalTime().ToString("o")
    "[$errStamp] run-worker.ps1 caught exception: $($_.Exception.Message)" |
        Out-File -FilePath $schedulerLog -Append -Encoding utf8
    $exitCode = 1
}

$stampEnd = (Get-Date).ToUniversalTime().ToString("o")
"[$stampEnd] run-worker.ps1 finished, exit=$exitCode" | Out-File -FilePath $schedulerLog -Append -Encoding utf8

exit $exitCode
