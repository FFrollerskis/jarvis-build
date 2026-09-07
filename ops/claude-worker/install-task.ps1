<#
  .SYNOPSIS
    Registers (or re-registers) the Windows Task Scheduler job for the Jarvis
    Architect <-> Claude worker. Idempotent, and safe to run against a working
    installation.

  .DESCRIPTION
    D126 review blocker 4: the previous version UNREGISTERED the existing task
    before the new registration could fail. A denied registration therefore
    destroyed a working schedule and left the host with no worker at all. It
    also hard-coded powershell.exe and -LogonType S4U, silently replacing
    whatever logon/auth context the host was actually using.

    This version:
      1. reads the EXISTING task's principal (UserId / LogonType / RunLevel) and
         its executable, and reuses them by default. The host's own hardened
         setup is preserved; an override must be asked for explicitly;
      2. exports the existing definition to an XML backup first;
      3. PROBES the registration under a temporary task name, so a denial is
         discovered while the working task is still untouched;
      4. only then replaces the real task with Register-ScheduledTask -Force,
         which REPLACES rather than unregister-then-register - there is no window
         in which the task does not exist;
      5. verifies the result and restores the exported XML if verification fails.

    It never changes account rights or permissions. If registration is denied it
    reports the precise missing host action and leaves everything as it was.

  .PARAMETER IntervalMinutes
    Repetition interval. Default 5, matching the current worker cadence.

  .PARAMETER LogonType
    Override the logon type. Default: reuse the existing task's logon type, or
    S4U for a first-time registration.

  .PARAMETER Interactive
    Shorthand for -LogonType Interactive.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = "JarvisClaudeWorker",
    [int]$IntervalMinutes = 5,
    [ValidateSet("S4U", "Interactive", "Password", "ServiceAccount", "InteractiveOrPassword")]
    [string]$LogonType,
    [switch]$Interactive,
    [string]$Shell
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$runScript = Join-Path $here "run-worker.ps1"

if (-not (Test-Path -LiteralPath $runScript)) {
    throw "run-worker.ps1 not found next to install-task.ps1 ($here). Keep all worker files together."
}
if (-not (Test-Path -LiteralPath (Join-Path $here "config.json"))) {
    Write-Warning "config.json not found - copy config.example.json to config.json and edit it BEFORE the task first fires, or every run will fail fast with a clear config error (see logs\worker-*.log)."
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

# --- preserve the host's actual execution context -------------------------
$existingExecute = $null
$existingUserId = $null
$existingLogonType = $null
$existingRunLevel = $null
if ($null -ne $existing) {
    $existingUserId = [string]$existing.Principal.UserId
    $existingLogonType = [string]$existing.Principal.LogonType
    $existingRunLevel = [string]$existing.Principal.RunLevel
    $firstAction = @($existing.Actions)[0]
    if ($null -ne $firstAction) { $existingExecute = [string]$firstAction.Execute }
    Write-Host "Existing task '$TaskName' found."
    Write-Host "  execute:   $existingExecute"
    Write-Host "  principal: user=$existingUserId logonType=$existingLogonType runLevel=$existingRunLevel"
}

if ($Shell) {
    $shellPath = $Shell
    Write-Host "Using the explicitly supplied shell: $shellPath"
} elseif ($existingExecute) {
    $shellPath = $existingExecute
    Write-Host "Reusing the shell the existing task already runs: $shellPath"
} else {
    $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($null -ne $pwsh) {
        $shellPath = $pwsh.Source
    } else {
        $shellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
    }
    Write-Host "First-time registration; selected shell: $shellPath"
}

if ($Interactive) { $LogonType = "Interactive" }
if (-not $LogonType) {
    if ($existingLogonType) {
        $LogonType = $existingLogonType
        Write-Host "Reusing the existing logon type: $LogonType (not silently substituting S4U)."
    } else {
        $LogonType = "S4U"
        Write-Host "First-time registration; using LogonType=S4U - runs without an interactive logon, no stored password."
    }
}
$userId = if ($existingUserId) { $existingUserId } else { $env:USERNAME }
$runLevel = if ($existingRunLevel) { $existingRunLevel } else { "Limited" }

# --- back up the existing definition before anything changes ---------------
$backupXml = $null
if ($null -ne $existing) {
    $backupDir = Join-Path $here "backups\task-definitions"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    $backupXml = Join-Path $backupDir "$TaskName-$stamp.xml"
    Export-ScheduledTask -TaskName $TaskName | Out-File -FilePath $backupXml -Encoding utf8
    Write-Host "Backed up the existing definition to: $backupXml"
}

$action = New-ScheduledTaskAction -Execute $shellPath `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runScript`"" `
    -WorkingDirectory $here

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

# MultipleInstances IgnoreNew is a second line of defence behind the worker's
# own lock: Windows will not start a second run while one is still going.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType $LogonType -RunLevel $runLevel

if (-not $PSCmdlet.ShouldProcess($TaskName, "Register the worker scheduled task")) {
    Write-Host "-WhatIf: would register '$TaskName' with execute=$shellPath user=$userId logonType=$LogonType runLevel=$runLevel. Nothing was changed."
    exit 0
}

# --- 1. PROBE: prove the registration is permitted while the real task is
#        still completely untouched. ---------------------------------------
$probeName = "$TaskName-probe"
try {
    Register-ScheduledTask -TaskName $probeName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
} catch {
    Write-Error @"
Registration of '$TaskName' was DENIED (verified with a temporary probe task, so the EXISTING
task was NOT touched and is still registered and working): $($_.Exception.Message)

This script does not change permissions to work around a denial. Required host action:
  - run this script from an elevated PowerShell, or
  - grant the account '$userId' the 'Log on as a batch job' right, or
  - re-run with -LogonType Interactive to register a logon-only task.
"@
    exit 1
}
try { Unregister-ScheduledTask -TaskName $probeName -Confirm:$false -ErrorAction SilentlyContinue } catch { }

# --- 2. replace the real task. -Force REPLACES: the old task is never
#        unregistered first, so there is no window with no task. -----------
try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
} catch {
    Write-Error "Replacing '$TaskName' failed after the probe succeeded: $($_.Exception.Message)"
    if ($backupXml -and (Test-Path -LiteralPath $backupXml)) {
        Write-Host "Restoring the previous definition from $backupXml ..."
        Register-ScheduledTask -TaskName $TaskName -Xml (Get-Content -LiteralPath $backupXml -Raw) -User $userId -Force | Out-Null
        Write-Host "Previous definition restored."
    }
    exit 1
}

# --- 3. verify, and restore the backup if the result is not what we asked for.
$verify = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$verifyExecute = if ($null -ne $verify) { [string](@($verify.Actions)[0].Execute) } else { $null }
if ($null -eq $verify -or $verifyExecute -ne $shellPath) {
    Write-Error "Verification failed: '$TaskName' is not registered as expected (execute=$verifyExecute)."
    if ($backupXml -and (Test-Path -LiteralPath $backupXml)) {
        Register-ScheduledTask -TaskName $TaskName -Xml (Get-Content -LiteralPath $backupXml -Raw) -User $userId -Force | Out-Null
        Write-Host "Previous definition restored from $backupXml."
    }
    exit 1
}

# If this registration INTRODUCED the task, record it so a rollback can
# unregister it again rather than leaving a new schedule against restored code.
if ($null -eq $existing) {
    $deploy = Join-Path $here "deploy.mjs"
    if (Test-Path -LiteralPath $deploy) {
        & node $deploy record-introduced-task --destination $here --task $TaskName | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not record '$TaskName' as an introduced task. A rollback will NOT unregister it automatically; do that by hand with uninstall-task.ps1."
        }
    }
}

Write-Host "Registered scheduled task '$TaskName' - fires every $IntervalMinutes minute(s), indefinitely."
Write-Host "  execute:   $shellPath"
Write-Host "  principal: user=$userId logonType=$LogonType runLevel=$runLevel"
Write-Host "Verify with:  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "NOTE: a Ready state and LastTaskResult=0 mean the SCHEDULER ran - not that the queue is healthy."
Write-Host "For real queue health:  node worker.mjs health"
