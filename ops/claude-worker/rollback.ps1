<#
  .SYNOPSIS
    Restore a previous worker/supervisor deployment from a backup directory
    created by install.ps1 / deploy.mjs.

  .DESCRIPTION
    Thin wrapper around `node deploy.mjs rollback`, which:
      - ENFORCES the manifest's recorded old SHA256 for every restored file
        (the previous rollback.ps1 restored bytes without checking them);
      - REMOVES files the install INTRODUCED, so a failed upgrade cannot leave
        new modules behind for old code to import (the previous version restored
        only files that had existed before, and left the new supervisor modules
        and task active);
      - restores files the install removed as superseded;
      - refuses to write over a RUNNING worker or supervisor and never terminates
        a process;
      - never touches operational data (config.json, state.json, logs, tmp).

    Scheduled tasks the install INTRODUCED are reported by deploy.mjs and are
    unregistered here, explicitly, and backed-up task definitions can be
    re-imported with -RestoreTasks.

  .PARAMETER BackupDir
    A directory under <Destination>\backups\<version>. Defaults to the most
    recent backup that contains an install-manifest.json.

  .PARAMETER RestoreTasks
    Also re-import the backed-up scheduled task definitions.

  .EXAMPLE
    .\rollback.ps1 -WhatIf
    .\rollback.ps1 -Destination "$env:USERPROFILE\.jarvis-claude-worker"
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$BackupDir,
    [string]$Destination = (Join-Path $env:USERPROFILE ".jarvis-claude-worker"),
    [switch]$RestoreTasks
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$deploy = Join-Path $here "deploy.mjs"

if (-not (Test-Path -LiteralPath $deploy)) {
    throw "deploy.mjs not found next to rollback.ps1 ($here)."
}

# Quiescence: never roll back under a running worker or supervisor.
foreach ($lockName in @(".worker.lock", ".supervisor.lock")) {
    $lockPath = Join-Path $Destination $lockName
    if (-not (Test-Path -LiteralPath $lockPath)) { continue }
    $lock = $null
    try { $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json } catch { $lock = $null }
    if ($null -eq $lock) {
        throw "$lockName is unreadable. Refusing to roll back while a lock cannot be interpreted. This script never terminates a process."
    }
    if ($null -ne $lock.pid) {
        $proc = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
        if ($null -ne $proc) {
            throw "$lockName is held by a LIVE process (pid=$($lock.pid), phase=$($lock.phase)). Refusing to roll back under a running process. This script never terminates a process."
        }
    }
}

if (-not $PSCmdlet.ShouldProcess($Destination, "Roll back the worker deployment")) {
    Write-Host "-WhatIf: nothing was restored."
    exit 0
}

$rollbackArgs = @("rollback", "--destination", $Destination)
if ($BackupDir) { $rollbackArgs += @("--backup-dir", $BackupDir) }

$json = & node $deploy @rollbackArgs
$rollbackExit = $LASTEXITCODE
Write-Host $json

if ($rollbackExit -ne 0) {
    throw "Rollback reported failures (exit $rollbackExit). Read the JSON above; nothing was force-restored past a hash mismatch."
}

$result = $json | ConvertFrom-Json

foreach ($taskName in @($result.tasks_to_unregister)) {
    if (-not $taskName) { continue }
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -eq $existing) { continue }
    if ($PSCmdlet.ShouldProcess($taskName, "Unregister scheduled task introduced by the rolled-back install")) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "unregistered introduced task: $taskName"
    }
}

if ($RestoreTasks) {
    foreach ($t in @($result.tasks_to_reimport)) {
        if (-not $t -or -not (Test-Path -LiteralPath $t.xml_path)) { continue }
        if (-not $PSCmdlet.ShouldProcess($t.name, "Re-register scheduled task from backup")) { continue }
        $definition = Get-Content -LiteralPath $t.xml_path -Raw
        # Register with -Force: the existing registration is REPLACED, never
        # unregistered first, so a failure cannot leave the host with no task.
        Register-ScheduledTask -TaskName $t.name -Xml $definition -User $env:USERNAME -Force | Out-Null
        Write-Host "restored scheduled task: $($t.name)"
    }
}

Write-Host ""
Write-Host "Rollback complete. Verify with:"
Write-Host "  .\verify-scripts.ps1"
Write-Host "  node worker.mjs status"
