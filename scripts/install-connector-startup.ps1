param([string]$NodeExecutable = 'node')
$ErrorActionPreference = 'Stop'
$connectorDirectory = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command $NodeExecutable -ErrorAction Stop).Source
$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$watchdogPath = Join-Path $PSScriptRoot 'connector-watchdog.ps1'
$startupDirectory = [Environment]::GetFolderPath('Startup')
$startupPath = Join-Path $startupDirectory 'Local Computer Control MCP.lnk'
$legacyPath = Join-Path $startupDirectory 'Local Windows Control Nightly PRs.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($startupPath)
$shortcut.TargetPath = $powershellPath
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`" -ConnectorDirectory `"$connectorDirectory`" -NodeExecutable `"$nodePath`""
$shortcut.WorkingDirectory = $connectorDirectory
$shortcut.WindowStyle = 7
$shortcut.Save()
if (Test-Path -LiteralPath $legacyPath) { Remove-Item -LiteralPath $legacyPath }
$existingWatchdog = Get-CimInstance Win32_Process | Where-Object {
	$_.Name -eq 'powershell.exe' -and
	$_.CommandLine -match '(connector|nightly-pr)-watchdog\.ps1' -and
	$_.CommandLine -like "*$connectorDirectory*"
}
if (-not $existingWatchdog) {
	Start-Process -FilePath $powershellPath -ArgumentList $shortcut.Arguments -WindowStyle Hidden
}
Write-Output "Installed connector startup shortcut: $startupPath"
