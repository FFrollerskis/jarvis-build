<#
  .SYNOPSIS
    Registers the Jarvis worker recovery supervisor as a separate scheduled task.

  .DESCRIPTION
    Two triggers: at startup (so a reboot restores the recovery path even if the
    worker itself is wedged) and on a repeating interval. The supervisor is
    deliberately a DIFFERENT task from JarvisClaudeWorker so that a broken
    worker cannot disable its own recovery.

    Authorised by the scope update on WORKER-SELF-RECOVERY-20260907: this is ONE
    recovery supervisor, never a second implementation worker.

    D126 review blocker 4, same fixes as install-task.ps1:
      - the existing task's principal and executable are REUSED by default, so
        the host's actual logon/auth context is never silently replaced;
      - the existing definition is exported to a backup first;
      - registration is PROBED under a temporary name, so a denial leaves any
        working task completely untouched;
      - the real task is replaced with Register-ScheduledTask -Force, never
        unregister-then-register, so there is no window with no task;
      - the result is verified, and the backup is restored if it is wrong.

    Because this task is INTRODUCED by the D-126 change, a rollback removes it
    again: deploy.mjs records introduced tasks in the install manifest and
    rollback.ps1 unregisters them.

  .PARAMETER IntervalMinutes
    How often the supervisor checks the worker. Default 15 - deliberately much
    less frequent than the worker's own 5-minute cadence, because the supervisor
    only needs to notice a DEAD worker, not to race it.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = "JarvisWorkerSupervisor",
    [string]$WorkerTaskName = "JarvisClaudeWorker",
    [int]$IntervalMinutes = 15,
    [ValidateSet("S4U", "Interactive", "Password", "ServiceAccount", "InteractiveOrPassword")]
    [string]$LogonType,
    [switch]$Interactive,
    [string]$Shell
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$runScript = Join-Path $here "run-supervisor.ps1"

if (-not (Test-Path -LiteralPath $runScript)) {
    throw "run-supervisor.ps1 not found next to install-supervisor.ps1 ($here)."
}
if (-not (Test-Path -LiteralPath (Join-Path $here "supervisor.config.json"))) {
    Write-Warning "supervisor.config.json not found - copy supervisor.config.example.json and set 'host' and 'workerTaskName' BEFORE registering, or every run fails fast."
}

$worker = Get-ScheduledTask -TaskName $WorkerTaskName -ErrorAction SilentlyContinue
if ($null -eq $worker) {
    Write-Warning "The worker task '$WorkerTaskName' is not registered. The supervisor can observe and report, but it cannot start a task that does not exist. Register the worker first with install-task.ps1."
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
    Write-Host "Existing task '$TaskName' found (execute=$existingExecute, logonType=$existingLogonType)."
}

if ($Shell) {
    $shellPath = $Shell
} elseif ($existingExecute) {
    $shellPath = $existingExecute
} elseif ($null -ne $worker -and $null -ne @($worker.Actions)[0]) {
    # Match whatever the worker task already uses, rather than assuming.
    $shellPath = [string](@($worker.Actions)[0].Execute)
    Write-Host "Reusing the shell the worker task already runs: $shellPath"
} else {
    $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($null -ne $pwsh) { $shellPath = $pwsh.Source } else { $shellPath = (Get-Command powershell.exe -ErrorAction Stop).Source }
}

if ($Interactive) { $LogonType = "Interactive" }
if (-not $LogonType) {
    if ($existingLogonType) {
        $LogonType = $existingLogonType
    } elseif ($null -ne $worker) {
        # Match the worker's context: a supervisor that cannot run in the same
        # circumstances as the worker is no recovery path at all.
        $LogonType = [string]$worker.Principal.LogonType
        Write-Host "Reusing the worker task's logon type: $LogonType"
    } else {
        $LogonType = "S4U"
    }
}
$userId = if ($existingUserId) { $existingUserId } elseif ($null -ne $worker) { [string]$worker.Principal.UserId } else { $env:USERNAME }
$runLevel = if ($existingRunLevel) { $existingRunLevel } else { "Limited" }

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

$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration ([TimeSpan]::MaxValue)
$atStartup = New-ScheduledTaskTrigger -AtStartup

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType $LogonType -RunLevel $runLevel

if (-not $PSCmdlet.ShouldProcess($TaskName, "Register the supervisor scheduled task")) {
    Write-Host "-WhatIf: would register '$TaskName' with execute=$shellPath user=$userId logonType=$LogonType. Nothing was changed."
    exit 0
}

$probeName = "$TaskName-probe"
try {
    Register-ScheduledTask -TaskName $probeName -Action $action -Trigger @($periodic, $atStartup) -Settings $settings -Principal $principal -Force | Out-Null
} catch {
    Write-Error @"
Registration of '$TaskName' was DENIED (verified with a temporary probe task, so any existing
task was NOT touched): $($_.Exception.Message)

This script does not change permissions to work around a denial. Required host action:
  - run this script from an elevated PowerShell, or
  - grant '$userId' the 'Log on as a batch job' right, or
  - re-run with -LogonType Interactive.
"@
    exit 1
}
try { Unregister-ScheduledTask -TaskName $probeName -Confirm:$false -ErrorAction SilentlyContinue } catch { }

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($periodic, $atStartup) -Settings $settings -Principal $principal -Force | Out-Null
} catch {
    Write-Error "Replacing '$TaskName' failed after the probe succeeded: $($_.Exception.Message)"
    if ($backupXml -and (Test-Path -LiteralPath $backupXml)) {
        Register-ScheduledTask -TaskName $TaskName -Xml (Get-Content -LiteralPath $backupXml -Raw) -User $userId -Force | Out-Null
        Write-Host "Previous definition restored."
    }
    exit 1
}

$verify = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $verify) {
    Write-Error "Verification failed: '$TaskName' is not registered after the replace."
    exit 1
}

# If this registration INTRODUCED the task, record it in the latest install
# manifest so rollback.ps1 unregisters it again. Without this, rolling the files
# back would leave a brand-new schedule running against restored older code.
if ($null -eq $existing) {
    $deploy = Join-Path $here "deploy.mjs"
    if (Test-Path -LiteralPath $deploy) {
        & node $deploy record-introduced-task --destination $here --task $TaskName | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not record '$TaskName' as an introduced task. A rollback will NOT unregister it automatically; do that by hand with uninstall-task.ps1 -IncludeSupervisor."
        }
    }
}

Write-Host "Registered '$TaskName' - at startup and every $IntervalMinutes minute(s)."
Write-Host "  execute:   $shellPath"
Write-Host "  principal: user=$userId logonType=$LogonType runLevel=$runLevel"
Write-Host "Read-only check:  node supervisor.mjs status"
Write-Host "Dry run:          node supervisor.mjs run --dry-run"
Write-Host ""
Write-Host "Reboot persistence is claimed by the AtStartup trigger but is only PROVEN by an actual"
Write-Host "reboot. Do not report REBOOT_PERSISTENCE=true until a real restart has been observed."
