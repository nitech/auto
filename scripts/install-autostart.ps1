# Install Auto supervisor as a Windows Scheduled Task at logon.
# Run once (as current user):
#   powershell -ExecutionPolicy Bypass -File D:\Sevenfold\auto\scripts\install-autostart.ps1
#
# Uninstall:
#   powershell -ExecutionPolicy Bypass -File D:\Sevenfold\auto\scripts\install-autostart.ps1 -Uninstall

param(
  [switch]$Uninstall,
  [string]$TaskName = "AutoSupervise"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Node = (Get-Command node -ErrorAction Stop).Source
$Supervise = Join-Path $Root "scripts\supervise.mjs"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName'"
  exit 0
}

if (-not (Test-Path $Supervise)) {
  throw "Missing $Supervise"
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$arg = "`"$Supervise`""
$action = New-ScheduledTaskAction -Execute $Node -Argument $arg -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Keep Auto (:4331) alive via scripts/supervise.mjs" `
  -User $env:USERNAME |
  Out-Null

Write-Host "Installed scheduled task '$TaskName' (AtLogOn)."
Write-Host "Start now with:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Or: npm run supervise"
