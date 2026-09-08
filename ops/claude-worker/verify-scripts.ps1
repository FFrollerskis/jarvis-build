<#
  .SYNOPSIS
    Verifies that every delivered .ps1 actually PARSES with the real PowerShell
    AST parser and is pure ASCII, and that every delivered .mjs parses with node.

  .DESCRIPTION
    This is the check that would have caught the failure described in the
    WORKER-SELF-RECOVERY-20260907 task: a wrapper patch was retyped on a mobile
    keyboard, which introduced a stray character, produced a ParserError, and
    silently stopped the whole loop. Nothing reported that as broken.

    Run this BEFORE install.ps1 and again on the host AFTER installation. It
    mutates nothing.

  .EXAMPLE
    .\verify-scripts.ps1
    .\verify-scripts.ps1 -Path "$env:USERPROFILE\.jarvis-claude-worker"
#>

param(
    [string]$Path = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$ErrorActionPreference = "Stop"
$fail = 0

$scripts = Get-ChildItem -Path $Path -Filter *.ps1 -File
if ($scripts.Count -eq 0) {
    Write-Host "No .ps1 files found under $Path"
    exit 1
}

foreach ($s in $scripts) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($s.FullName, [ref]$tokens, [ref]$errors) | Out-Null

    $bytes = [System.IO.File]::ReadAllBytes($s.FullName)
    $nonAscii = @($bytes | Where-Object { $_ -gt 127 }).Count
    $sha = (Get-FileHash -LiteralPath $s.FullName -Algorithm SHA256).Hash

    if ($errors -and $errors.Count -gt 0) {
        Write-Host ("PARSE_FAIL  " + $s.Name)
        $errors | ForEach-Object { Write-Host ("    " + $_.Message) }
        $fail = 1
    }
    elseif ($nonAscii -gt 0) {
        # Non-ASCII is not wrong in principle, but in THIS delivery it means the
        # file was retyped or re-encoded outside the repository.
        Write-Host ("NON_ASCII   " + $s.Name + " (" + $nonAscii + " byte(s) > 127 - file was likely edited off-repo)")
        $fail = 1
    }
    else {
        Write-Host ("PARSE_OK    " + $s.Name + "  ascii  " + $bytes.Length + "b  sha256=" + $sha.Substring(0, 16) + "...")
    }
}

# The same class of failure can hit the JavaScript modules, so check them with
# the real node parser rather than assuming.
$modules = @(Get-ChildItem -Path $Path -Filter *.mjs -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\(staging|backups|tmp|logs|supervisor-logs)\\' })

foreach ($m in $modules) {
    $null = & node --check $m.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host ("NODE_PARSE_FAIL  " + $m.Name)
        $fail = 1
    } else {
        Write-Host ("NODE_PARSE_OK    " + $m.FullName.Substring($Path.Length).TrimStart('\', '/'))
    }
}

Write-Host ""
if ($fail -eq 0) {
    Write-Host "ALL_SCRIPTS_PARSE=true"
} else {
    Write-Host "ALL_SCRIPTS_PARSE=false  - do NOT install or activate until this is fixed in the repository."
}
exit $fail
