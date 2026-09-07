<#
  .SYNOPSIS
    Staged, versioned installation of the Jarvis worker + recovery supervisor
    from this repository into the host worker directory.

  .DESCRIPTION
    This is the ONLY supported way to change the deployed worker. Hand-editing
    files on the host is what produced the ParserError that stopped the loop.

    Safety properties:
      - refuses to overwrite a RUNNING worker (checks the live lock first);
      - backs up every existing deployed file, plus the exported scheduled-task
        definitions, into a timestamped backup directory BEFORE touching
        anything, and writes a manifest with SHA256 of old and new files;
      - never touches config.json, state.json, logs/ or tmp/ - operational data
        and secrets stay exactly where they are;
      - verifies each copied file's hash after the copy;
      - -WhatIf shows the full plan and changes nothing;
      - rollback.ps1 restores any backup directory.

    Installation does NOT register or start anything by itself. Registering the
    scheduled tasks is a separate, explicit step (install-task.ps1 /
    install-supervisor.ps1), so a review can happen between "files staged" and
    "new logic actually runs".

  .PARAMETER Destination
    Host worker directory. Default: $env:USERPROFILE\.jarvis-claude-worker

  .PARAMETER Force
    Install even if the worker lock looks active. Refused unless the lock owner
    process is genuinely gone - this switch never kills a process.

  .EXAMPLE
    .\install.ps1 -WhatIf
    .\install.ps1
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Destination = (Join-Path $env:USERPROFILE ".jarvis-claude-worker"),
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$source = Split-Path -Parent $MyInvocation.MyCommand.Path

# Files owned by this repository. Anything not listed here is never written.
$payload = @(
    "worker.mjs",
    "supervisor.mjs",
    "run-worker.ps1",
    "run-supervisor.ps1",
    "install-task.ps1",
    "install-supervisor.ps1",
    "uninstall-task.ps1",
    "rollback.ps1",
    "verify-scripts.ps1",
    "config.example.json",
    "supervisor.config.example.json",
    "README.md",
    "lib/health.mjs",
    "lib/state.mjs",
    "lib/lock.mjs",
    "lib/quarantine.mjs",
    "lib/trust.mjs",
    "lib/reconcile.mjs",
    "lib/config.mjs",
    "lib/github.mjs",
    "lib/dispatch.mjs",
    "lib/supervise.mjs",
    "lib/wintask.mjs"
)

# Superseded by worker.mjs quarantine logic; removed so two rival preflights
# cannot both claim to guard the worktree.
$obsolete = @("run-worker-safe.ps1")

function Get-Sha256([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
}

Write-Host "Source:      $source"
Write-Host "Destination: $Destination"

if (-not (Test-Path -LiteralPath $Destination)) {
    Write-Host "Destination does not exist - it will be created."
} else {
    # Never overwrite a running worker in place.
    $lockPath = Join-Path $Destination ".worker.lock"
    if (Test-Path -LiteralPath $lockPath) {
        $lock = $null
        try { $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json } catch { $lock = $null }
        if ($null -ne $lock -and $null -ne $lock.pid) {
            $proc = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
            if ($null -ne $proc) {
                if (-not $Force) {
                    throw "Worker lock is held by a LIVE process (pid=$($lock.pid), phase=$($lock.phase), task=$($lock.task_id)). Refusing to overwrite a running worker. Wait for it to finish, then re-run. This installer never terminates a process."
                }
                throw "-Force was supplied but the lock owner pid=$($lock.pid) is still ALIVE. Refusing anyway: installing over a running worker can corrupt an in-flight task. Stop that process deliberately first."
            }
            Write-Host "Found a stale lock (pid=$($lock.pid) is gone). Safe to proceed."
        }
    }
}

foreach ($rel in $payload) {
    $src = Join-Path $source $rel
    if (-not (Test-Path -LiteralPath $src)) {
        throw "Payload file missing from the repository: $rel. Refusing a partial install."
    }
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$backupDir = Join-Path $Destination "backups\$stamp"
$manifest = @()

if ($PSCmdlet.ShouldProcess($Destination, "Back up existing deployment to backups\$stamp")) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

    foreach ($rel in ($payload + $obsolete)) {
        $dst = Join-Path $Destination $rel
        if (Test-Path -LiteralPath $dst) {
            $backupPath = Join-Path $backupDir $rel
            New-Item -ItemType Directory -Path (Split-Path -Parent $backupPath) -Force | Out-Null
            Copy-Item -LiteralPath $dst -Destination $backupPath -Force
            $manifest += [pscustomobject]@{
                file = $rel
                old_sha256 = (Get-Sha256 $dst)
                backed_up_to = $backupPath
            }
        }
    }

    # Back up the scheduled task definitions too, so rollback can restore the
    # schedule and not only the files.
    foreach ($taskName in @("JarvisClaudeWorker", "JarvisWorkerSupervisor")) {
        $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($null -ne $t) {
            $xmlPath = Join-Path $backupDir "$taskName.task.xml"
            Export-ScheduledTask -TaskName $taskName | Out-File -FilePath $xmlPath -Encoding utf8
            Write-Host "Backed up scheduled task definition: $taskName"
        }
    }
    Write-Host "Backup written to: $backupDir"
}

foreach ($rel in $payload) {
    $src = Join-Path $source $rel
    $dst = Join-Path $Destination $rel
    $newHash = Get-Sha256 $src
    $oldHash = Get-Sha256 $dst

    if ($oldHash -eq $newHash) {
        Write-Host "unchanged  $rel"
        continue
    }

    if ($PSCmdlet.ShouldProcess($dst, "Install $rel")) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
        Copy-Item -LiteralPath $src -Destination $dst -Force
        $verify = Get-Sha256 $dst
        if ($verify -ne $newHash) {
            throw "Hash mismatch after copying $rel (expected $newHash, got $verify). Run rollback.ps1 -BackupDir '$backupDir'."
        }
        Write-Host "installed  $rel  sha256=$($verify.Substring(0,16))..."
    } else {
        Write-Host "would install  $rel"
    }
}

foreach ($rel in $obsolete) {
    $dst = Join-Path $Destination $rel
    if (Test-Path -LiteralPath $dst) {
        if ($PSCmdlet.ShouldProcess($dst, "Remove superseded $rel (already backed up)")) {
            Remove-Item -LiteralPath $dst -Force
            Write-Host "removed    $rel (superseded; a copy is in the backup)"
        }
    }
}

if ($PSCmdlet.ShouldProcess($backupDir, "Write install manifest")) {
    $manifestPath = Join-Path $backupDir "install-manifest.json"
    $record = [pscustomobject]@{
        installed_at_utc = (Get-Date).ToUniversalTime().ToString("o")
        source = $source
        destination = $Destination
        files = @(foreach ($rel in $payload) {
            [pscustomobject]@{ file = $rel; new_sha256 = (Get-Sha256 (Join-Path $source $rel)) }
        })
        previous = $manifest
    }
    ($record | ConvertTo-Json -Depth 6) | Out-File -FilePath $manifestPath -Encoding utf8
    Write-Host "Manifest: $manifestPath"
}

Write-Host ""
Write-Host "Files are staged. NOTHING has been registered or started."
Write-Host "Next steps, in order:"
Write-Host "  1. Copy config.example.json to config.json (if absent) and check it."
Write-Host "  2. Copy supervisor.config.example.json to supervisor.config.json and set host + workerTaskName."
Write-Host "  3. node worker.mjs status      # read-only sanity check"
Write-Host "  4. node worker.mjs run --dry-run"
Write-Host "  5. node supervisor.mjs status  # read-only sanity check"
Write-Host "  6. .\install-task.ps1          # (re)register the worker schedule"
Write-Host "  7. .\install-supervisor.ps1    # register the supervisor schedule"
Write-Host ""
Write-Host "Rollback:  .\rollback.ps1 -BackupDir '$backupDir'"
