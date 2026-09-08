<#
  .SYNOPSIS
    Removes the worker and/or supervisor scheduled task registrations.

  .DESCRIPTION
    Does NOT delete state, logs, config or the deployed files - only the
    schedule registration. Re-run install-task.ps1 / install-supervisor.ps1 to
    re-enable.
#>
param(
    [string]$TaskName = "JarvisClaudeWorker",
    [switch]$IncludeSupervisor,
    [string]$SupervisorTaskName = "JarvisWorkerSupervisor"
)
$ErrorActionPreference = "Stop"

function Remove-TaskIfPresent([string]$name) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "No scheduled task named '$name' found - nothing to do."
        return
    }
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "Unregistered scheduled task '$name'. State, logs and config left untouched."
}

Remove-TaskIfPresent $TaskName
if ($IncludeSupervisor) {
    Remove-TaskIfPresent $SupervisorTaskName
}
