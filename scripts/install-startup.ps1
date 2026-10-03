param([string]$TunnelName = 'local')

$ErrorActionPreference = 'Stop'
$connectorRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$cloudflaredExecutable = (Get-Command cloudflared.exe -ErrorAction Stop).Source
$watchdogPath = Join-Path $connectorRoot 'scripts/connector-watchdog.ps1'
foreach ($requiredPath in @($watchdogPath, (Join-Path $connectorRoot 'dist/server.js'), (Join-Path $connectorRoot '.env'))) {
    if (!(Test-Path -LiteralPath $requiredPath)) { throw "Required file missing: $requiredPath" }
}
if ($TunnelName -notmatch '^[a-zA-Z0-9_-]+$') { throw 'TunnelName must be a tunnel name or UUID.' }
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startupDirectory 'Local Computer Control MCP.lnk'))
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$shortcut.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`" -ConnectorDirectory `"$connectorRoot`" -NodeExecutable `"$nodeExecutable`" -CloudflaredExecutable `"$cloudflaredExecutable`" -TunnelName $TunnelName"
$shortcut.WorkingDirectory = $connectorRoot
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Output "Installed Windows sign-in startup: $(Join-Path $startupDirectory 'Local Computer Control MCP.lnk')"
