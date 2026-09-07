<#
  .SYNOPSIS
    Restore a previous worker/supervisor deployment from a backup directory
    created by install.ps1.

  .DESCRIPTION
    Restores the exact bytes that were deployed before an install, verifying
    each file's SHA256 against the manifest. Optionally restores the exported
    scheduled task definitions.

    Like install.ps1 it refuses to write over a RUNNING worker and never
    terminates a process. Operational data (config.json, state.json, logs, tmp)
    is not touched.

  .PARAMETER BackupDir
    A directory under <worker>\backups\<timestamp> produced by install.ps1.

  .PARAMETER RestoreTasks
    Also re-import the backed-up scheduled task definitions.

  .EXAMPLE
    .\rollback.ps1 -BackupDir "$env:USERPROFILE\.jarvis-claude-worker\backups\20260907-011500" -WhatIf
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$BackupDir,
    [string]$Destination = (Join-Path $env:USERPROFILE ".jarvis-claude-worker"),
    [switch]$RestoreTasks
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $BackupDir)) {
    throw "Backup directory not found: $BackupDir"
}

$lockPath = Join-Path $Destination ".worker.lock"
if (Test-Path -LiteralPath $lockPath) {
    $lock = $null
    try { $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json } catch { $lock = $null }
    if ($null -ne $lock -and $null -ne $lock.pid) {
        $proc = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
        if ($null -ne $proc) {
            throw "Worker lock is held by a LIVE process (pid=$($lock.pid)). Refusing to roll back under a running worker. This script never terminates a process."
        }
    }
}

$manifestPath = Join-Path $BackupDir "install-manifest.json"
$manifest = $null
if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    Write-Host "Restoring the deployment that was replaced at $($manifest.installed_at_utc)"
}

# Restore every regular file in the backup except bookkeeping artefacts.
$files = Get-ChildItem -LiteralPath $BackupDir -Recurse -File |
    Where-Object { $_.Name -ne "install-manifest.json" -and $_.Extension -ne ".xml" }

if ($files.Count -eq 0) {
    Write-Host "Backup contains no payload files - the previous state was an empty destination."
}

foreach ($f in $files) {
    $rel = $f.FullName.Substring($BackupDir.Length).TrimStart('\', '/')
    $dst = Join-Path $Destination $rel
    if ($PSCmdlet.ShouldProcess($dst, "Restore $rel")) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
        Copy-Item -LiteralPath $f.FullName -Destination $dst -Force
        $restored = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
        $expected = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
        if ($restored -ne $expected) {
            throw "Hash mismatch after restoring $rel."
        }
        Write-Host "restored   $rel  sha256=$($restored.Substring(0,16))..."
    } else {
        Write-Host "would restore  $rel"
    }
}

if ($RestoreTasks) {
    foreach ($xml in (Get-ChildItem -LiteralPath $BackupDir -Filter "*.task.xml" -File -ErrorAction SilentlyContinue)) {
        $taskName = $xml.Name -replace '\.task\.xml$', ''
        if ($PSCmdlet.ShouldProcess($taskName, "Re-register scheduled task from backup")) {
            $definition = Get-Content -LiteralPath $xml.FullName -Raw
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
            Register-ScheduledTask -TaskName $taskName -Xml $definition -User $env:USERNAME | Out-Null
            Write-Host "restored scheduled task: $taskName"
        }
    }
}

Write-Host ""
Write-Host "Rollback complete. Verify with:  node worker.mjs status"
