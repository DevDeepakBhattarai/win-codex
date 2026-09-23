param(
	[string]$ConnectorDirectory = (Split-Path -Parent $PSScriptRoot),
	[string]$NodeExecutable = 'node',
	[int]$Port = 6000
)
$ErrorActionPreference = 'Stop'
# Reuse the old mutex so the previous watchdog cannot start a second server.
$watchdogMutex = [System.Threading.Mutex]::new($false, 'Local\LocalWindowsControlNightlyWatchdog')
if (-not $watchdogMutex.WaitOne(0)) { exit 0 }
try {
	Set-Location -LiteralPath $ConnectorDirectory
	$logDirectory = Join-Path $ConnectorDirectory '.data\connector-startup'
	New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
	$nodePath = (Get-Command $NodeExecutable -ErrorAction Stop).Source
	while ($true) {
		try {
			$health = Invoke-RestMethod -Uri "http://localhost:$Port/health" -TimeoutSec 10
			if (-not $health.ok -or $health.name -ne 'local-codex') { throw 'Another service answered on the MCP port.' }
		} catch {
			# Wait if anything owns the port. Never compete with a manual server.
			$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
			if ($listeners.Count -eq 0) {
				$process = Start-Process -FilePath $nodePath -ArgumentList 'dist/server.js' -WorkingDirectory $ConnectorDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'connector.stdout.log') -RedirectStandardError (Join-Path $logDirectory 'connector.stderr.log')
				$process.WaitForExit()
			}
		}
		Start-Sleep -Seconds 30
	}
} finally {
	$watchdogMutex.ReleaseMutex()
	$watchdogMutex.Dispose()
}
