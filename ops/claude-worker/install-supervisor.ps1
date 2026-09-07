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

  .PARAMETER IntervalMinutes
    How often the supervisor checks the worker. Default 15 - deliberately much
    less frequent than the worker's own 5-minute cadence, because the supervisor
    only needs to notice a DEAD worker, not to race it.
#>

param(
    [string]$TaskName = "JarvisWorkerSupervisor",
    [string]$WorkerTaskName = "JarvisClaudeWorker",
    [int]$IntervalMinutes = 15,
    [switch]$Interactive
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
if ($existing) {
    Write-Host "Existing task '$TaskName' found - unregistering before re-registering (idempotent update)."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
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

if ($Interactive) {
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
} else {
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
}

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($periodic, $atStartup) -Settings $settings -Principal $principal | Out-Null
} catch {
    Write-Error @"
Registration of '$TaskName' was DENIED: $($_.Exception.Message)

This script does not change permissions to work around a denial. Required host action:
  - run this script from an elevated PowerShell, or
  - grant '$env:USERNAME' the 'Log on as a batch job' right, or
  - re-run with -Interactive.
"@
    exit 1
}

Write-Host "Registered '$TaskName' - at startup and every $IntervalMinutes minute(s)."
Write-Host "Read-only check:  node supervisor.mjs status"
Write-Host "Dry run:          node supervisor.mjs run --dry-run"
Write-Host ""
Write-Host "Reboot persistence is claimed by the AtStartup trigger but is only PROVEN by an actual"
Write-Host "reboot. Do not report REBOOT_PERSISTENCE=true until a real restart has been observed."
