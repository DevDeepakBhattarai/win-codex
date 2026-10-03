param(
    [string]$ConnectorDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$NodeExecutable = '',
    [string]$CloudflaredExecutable = '',
    [string]$TunnelName = 'local'
)

$ErrorActionPreference = 'Stop'
$connectorRoot = (Resolve-Path -LiteralPath $ConnectorDirectory).Path
$runtimeDirectory = Join-Path $connectorRoot '.data/runtime'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$watchdogLog = Join-Path $runtimeDirectory 'watchdog.log'

function Write-RuntimeLog([string]$Message) {
    Add-Content -LiteralPath $watchdogLog -Value "$(Get-Date -Format o) $Message"
}

if (!$NodeExecutable) { $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
if (!$CloudflaredExecutable) { $CloudflaredExecutable = (Get-Command cloudflared.exe -ErrorAction Stop).Source }
foreach ($requiredPath in @($NodeExecutable, $CloudflaredExecutable, (Join-Path $connectorRoot 'dist/server.js'), (Join-Path $connectorRoot '.env'))) {
    if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        Write-RuntimeLog "Required file missing: $requiredPath"
        throw "Required file missing: $requiredPath"
    }
}
if ($TunnelName -notmatch '^[a-zA-Z0-9_-]+$') { throw 'TunnelName must be a tunnel name or UUID.' }

$connectorPort = 6000
$connectorHost = 'localhost'
foreach ($line in Get-Content -LiteralPath (Join-Path $connectorRoot '.env')) {
    if ($line -match '^\s*PORT\s*=\s*["'']?(\d+)') { $connectorPort = [int]$Matches[1] }
    if ($line -match '^\s*HOST\s*=\s*["'']?([^\s"''#]+)') { $connectorHost = $Matches[1] }
}
$healthUrl = "http://${connectorHost}:${connectorPort}/health"
$hash = [System.Security.Cryptography.SHA256]::Create()
try { $mutexId = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($connectorRoot.ToLowerInvariant()))).Replace('-', '') }
finally { $hash.Dispose() }
$mutex = New-Object System.Threading.Mutex($false, "Local\LocalCodex-$mutexId")
$ownsMutex = $false
try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
if (!$ownsMutex) { $mutex.Dispose(); exit 0 }

$serverProcess = $null
$tunnelProcess = $null
Write-RuntimeLog 'Supervisor started. Server and tunnel run without visible windows.'
try {
    Start-Process -FilePath $NodeExecutable -ArgumentList 'scripts/start-browser.mjs' -WorkingDirectory $connectorRoot -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDirectory 'browser.stdout.log') -RedirectStandardError (Join-Path $runtimeDirectory 'browser.stderr.log') | Out-Null
    while ($true) {
        try {
            $healthy = $false
            try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5; $healthy = $health.ok -eq $true -and $health.name -eq 'local-codex' } catch { }
            if (!$healthy) {
                $listener = Get-NetTCPConnection -State Listen -LocalPort $connectorPort -ErrorAction SilentlyContinue
                if (!$listener -and (!$serverProcess -or $serverProcess.HasExited)) {
                    $serverProcess = Start-Process -FilePath $NodeExecutable -ArgumentList 'dist/server.js' -WorkingDirectory $connectorRoot -WindowStyle Hidden -PassThru `
                        -RedirectStandardOutput (Join-Path $runtimeDirectory 'server.stdout.log') -RedirectStandardError (Join-Path $runtimeDirectory 'server.stderr.log')
                    Write-RuntimeLog "Started MCP server PID $($serverProcess.Id)."
                } elseif ($listener) {
                    Write-RuntimeLog "Port $connectorPort is occupied but health is unavailable. Preserving the existing process."
                }
            }
            $tunnelPattern = '\btunnel\s+run\s+' + [regex]::Escape($TunnelName) + '(?:\s|$)'
            $existingTunnel = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" | Where-Object { $_.CommandLine -match $tunnelPattern }
            if (!$existingTunnel -and (!$tunnelProcess -or $tunnelProcess.HasExited)) {
                $tunnelProcess = Start-Process -FilePath $CloudflaredExecutable -ArgumentList @('tunnel', 'run', $TunnelName) -WorkingDirectory $connectorRoot -WindowStyle Hidden -PassThru `
                    -RedirectStandardOutput (Join-Path $runtimeDirectory 'tunnel.stdout.log') -RedirectStandardError (Join-Path $runtimeDirectory 'tunnel.stderr.log')
                Write-RuntimeLog "Started Cloudflare tunnel PID $($tunnelProcess.Id)."
            }
        } catch {
            Write-RuntimeLog "Startup or recovery failed: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 15
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
