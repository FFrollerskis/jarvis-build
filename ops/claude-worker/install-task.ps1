<#
  .SYNOPSIS
    Registers (or re-registers) the Windows Task Scheduler job for the Jarvis
    Architect <-> Claude worker. Idempotent.

  .DESCRIPTION
    Replaces the existing task definition rather than duplicating it. This is
    the SAME single worker schedule that has always existed - the supervisor
    added by this change is a separate recovery task, never a second worker.

  .PARAMETER IntervalMinutes
    Repetition interval. Default 5, matching the current worker cadence.

  .NOTES
    Uses -LogonType S4U so the task can run without an interactive logon and
    WITHOUT storing a Windows password. If S4U registration is denied in your
    environment, re-run with -Interactive. This script never changes account
    rights or permissions: if registration is denied, it reports the precise
    missing host action instead.
#>

param(
    [string]$TaskName = "JarvisClaudeWorker",
    [int]$IntervalMinutes = 5,
    [switch]$Interactive
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
if ($existing) {
    Write-Host "Existing task '$TaskName' found - unregistering before re-registering (idempotent update)."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
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

if ($Interactive) {
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Write-Host "Registering with LogonType=Interactive - the task only runs while $env:USERNAME is logged on."
} else {
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
    Write-Host "Registering with LogonType=S4U - runs without an interactive logon, no stored password."
}

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
} catch {
    Write-Error @"
Registration of '$TaskName' was DENIED: $($_.Exception.Message)

This script does not change permissions to work around a denial. Required host action:
  - run this script from an elevated PowerShell, or
  - grant the account '$env:USERNAME' the 'Log on as a batch job' right, or
  - re-run with -Interactive to register a logon-only task.
"@
    exit 1
}

Write-Host "Registered scheduled task '$TaskName' - fires every $IntervalMinutes minute(s), indefinitely."
Write-Host "Verify with:  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "NOTE: a Ready state and LastTaskResult=0 mean the SCHEDULER ran - not that the queue is healthy."
Write-Host "For real queue health:  node worker.mjs health"
