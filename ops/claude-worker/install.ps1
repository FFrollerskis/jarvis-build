<#
  .SYNOPSIS
    Staged, versioned, transactional installation of the Jarvis worker and
    recovery supervisor from this repository into the host worker directory.

  .DESCRIPTION
    This is the ONLY supported way to change the deployed worker. Hand-editing
    files on the host is what produced the ParserError that stopped the loop.

    This script is a THIN wrapper. The whole stage/verify/switch/rollback engine
    lives in lib/deploy.mjs and deploy.mjs, in Node, so every failure path can be
    exercised with real files and injected faults in CI on any OS. PowerShell
    keeps only what genuinely needs it: scheduled-task registration, which is a
    separate, explicit step.

    Safety properties (all enforced by deploy.mjs, all covered by fixture tests):
      - STAGE first: every payload byte is copied into
        <Destination>\staging\<version> and hash-verified BEFORE anything live is
        touched;
      - QUIESCENCE: a live worker or supervisor lock DEFERS activation and writes
        a pending-activation marker instead of overwriting a running process.
        An install launched by the running worker is therefore handed off and
        applied by the next scheduler tick, after its legitimate parent exits.
        Nothing is ever terminated;
      - NO TRANSIENT MISSING ENTRYPOINT: each file is written beside its target
        and renamed over it; a target is never deleted first;
      - a superseded file (run-worker-safe.ps1) is removed ONLY when no
        registered scheduled task still references it, and never at all when the
        scheduled tasks could not be queried;
      - every changed file, plus the exported scheduled-task definitions, is
        backed up into <Destination>\backups\<version> with SHA256 of old AND new
        bytes recorded in install-manifest.json;
      - ANY failure during the switch rolls back automatically to the recorded
        old hashes and removes files the install had introduced;
      - config.json, supervisor.config.json, state.json, logs\ and tmp\ are never
        in the payload and are never touched;
      - -WhatIf shows the plan and changes nothing.

    Registering the scheduled tasks stays a separate, explicit step
    (install-task.ps1 / install-supervisor.ps1), so a review can happen between
    "files staged" and "new logic actually runs".

  .PARAMETER Destination
    Host worker directory. Default: $env:USERPROFILE\.jarvis-claude-worker

  .PARAMETER StageOnly
    Stage the release and stop. Activation is then done later, explicitly, or by
    the next scheduler tick via -ApplyPending.

  .EXAMPLE
    .\install.ps1 -WhatIf
    .\install.ps1
    .\install.ps1 -StageOnly
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Destination = (Join-Path $env:USERPROFILE ".jarvis-claude-worker"),
    [switch]$StageOnly,
    [string]$Version
)

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$deploy = Join-Path $source "deploy.mjs"

if (-not (Test-Path -LiteralPath $deploy)) {
    throw "deploy.mjs not found next to install.ps1 ($source). Keep all worker files together."
}

Write-Host "Source:      $source"
Write-Host "Destination: $Destination"
Write-Host ""

Write-Host "--- plan (read-only) ---"
& node $deploy plan --source $source --destination $Destination
if ($LASTEXITCODE -ne 0) {
    throw "Deployment plan failed (exit $LASTEXITCODE). Nothing was changed."
}

if (-not $PSCmdlet.ShouldProcess($Destination, "Stage and activate the worker deployment")) {
    Write-Host ""
    Write-Host "-WhatIf: the plan above is everything that would change. Nothing was written."
    exit 0
}

if (-not $Version) {
    $Version = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
}

Write-Host ""
Write-Host "--- stage ---"
& node $deploy stage --source $source --destination $Destination --version $Version
if ($LASTEXITCODE -ne 0) {
    throw "Staging failed (exit $LASTEXITCODE). The live deployment was NOT touched."
}

if ($StageOnly) {
    Write-Host ""
    Write-Host "Staged version $Version. Nothing live was changed."
    Write-Host "Activate later with:  node deploy.mjs activate --destination '$Destination' --version '$Version'"
    exit 0
}

Write-Host ""
Write-Host "--- activate ---"
& node $deploy activate --destination $Destination --version $Version
$activateExit = $LASTEXITCODE

if ($activateExit -eq 5) {
    Write-Host ""
    Write-Host "ACTIVATION DEFERRED. A live worker or supervisor still owns its lock, so nothing was"
    Write-Host "overwritten and no process was terminated. A pending-activation marker was written."
    Write-Host ""

    # D126 FINAL review finding 3: do NOT rely on the next scheduler tick to
    # apply the marker. When this install was launched by the CURRENTLY DEPLOYED
    # worker, the next tick invokes the OLD registered entrypoint, which knows
    # nothing about pending-activation.json - the staged new run-worker.ps1 is
    # not live yet. Claiming otherwise is circular.
    #
    # Instead start the controlled bootstrap handoff NOW, from the SOURCE tree,
    # with the node binary already on this host. It is therefore runnable before
    # the payload is switched, and does not require the staged runner to be
    # active. It waits for the EXACT legitimate parent identity to exit,
    # re-checks worker + supervisor quiescence, and only then activates
    # transactionally. It terminates nothing and touches no scheduled task.
    $handoffLog = Join-Path $Destination "logs\bootstrap-handoff.log"
    $handoffLogDir = Split-Path -Parent $handoffLog
    if (-not (Test-Path -LiteralPath $handoffLogDir)) {
        New-Item -ItemType Directory -Path $handoffLogDir -Force | Out-Null
    }

    $handoffArgs = @(
        $deploy, "bootstrap-handoff",
        "--destination", $Destination,
        "--version", $Version,
        "--wait-seconds", "1800"
    )

    try {
        $handoff = Start-Process -FilePath "node" -ArgumentList $handoffArgs `
            -RedirectStandardOutput $handoffLog -RedirectStandardError "$handoffLog.err" `
            -WindowStyle Hidden -PassThru
        Write-Host "Controlled bootstrap handoff started (pid $($handoff.Id))."
        Write-Host "It waits for the exact process that currently owns the lock to exit, re-checks"
        Write-Host "quiescence, then activates version $Version transactionally. Nothing is terminated."
        Write-Host "Progress: $handoffLog"
    } catch {
        Write-Host "WARNING: the bootstrap handoff could not be started: $($_.Exception.Message)"
        Write-Host "The staged release and the pending-activation marker are intact; NOTHING was lost."
    }

    Write-Host ""
    Write-Host "You can also complete the handoff by hand once the worker is idle:"
    Write-Host "  node deploy.mjs bootstrap-handoff --destination '$Destination' --version '$Version'"
    Write-Host "  node deploy.mjs apply-pending --destination '$Destination'"
    exit 0
}
if ($activateExit -ne 0) {
    throw "Activation failed (exit $activateExit). deploy.mjs rolled the deployment back automatically; read the JSON above for the exact failure and the backup directory."
}

Write-Host ""
Write-Host "Files are installed. NOTHING has been registered or started."
Write-Host "Next steps, in order:"
Write-Host "  1. Copy config.example.json to config.json (if absent) and check it."
Write-Host "     claudeArgs is REQUIRED and explicit - there is no permissive default any more."
Write-Host "  2. Copy supervisor.config.example.json to supervisor.config.json and set host + workerTaskName."
Write-Host "  3. .\verify-scripts.ps1        # every .ps1 must parse and be ASCII"
Write-Host "  4. node worker.mjs status      # read-only sanity check"
Write-Host "  5. node worker.mjs run --dry-run   # read-only, takes no lock, writes nothing"
Write-Host "  6. node supervisor.mjs status  # read-only sanity check"
Write-Host "  7. .\install-task.ps1          # (re)register the worker schedule"
Write-Host "  8. .\install-supervisor.ps1    # register the supervisor schedule"
Write-Host ""
Write-Host "Rollback:  .\rollback.ps1 -Destination '$Destination'"
