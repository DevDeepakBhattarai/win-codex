$ErrorActionPreference = 'Stop'
$health = Invoke-RestMethod 'http://localhost:6000/health' -TimeoutSec 5
if (-not $health.ok -or $health.name -ne 'local-codex') { throw 'Local Computer Control MCP is not healthy on port 6000.' }
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 6000,6001,6002 -ErrorAction Stop)
$owners = @($listeners.OwningProcess | Sort-Object -Unique)
if ($owners.Count -ne 1 -or @($listeners.LocalPort | Sort-Object -Unique).Count -ne 3) {
	throw 'The MCP, browser bridge, and support bridge do not belong to one running connector.'
}
$publicHealth = Invoke-RestMethod ([uri]::new([uri]$health.mcp, '/health')) -TimeoutSec 10
if (-not $publicHealth.ok -or $publicHealth.name -ne 'local-codex') { throw 'The public MCP tunnel did not reach the local connector.' }
$startupPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Local Computer Control MCP.lnk'
if (-not (Test-Path -LiteralPath $startupPath)) { throw 'The MCP startup shortcut is missing.' }
[pscustomobject]@{
	Status = 'ready'
	ProcessId = $owners[0]
	LocalPorts = '6000, 6001, 6002'
	PublicMcp = $health.mcp
	StartupShortcut = $startupPath
} | Format-List
