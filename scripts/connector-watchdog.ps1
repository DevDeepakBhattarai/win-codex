param(
    [string]$ConnectorDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$NodeExecutable = '',
    [ValidateSet('cloudflare', 'tailscale', 'none')]
    [string]$TunnelProvider = 'cloudflare',
    [string]$CloudflaredExecutable = '',
    [string]$TailscaleExecutable = '',
    [string]$TunnelName = 'local',
    [ValidateRange(1, 3600)]
    [int]$RetrySeconds = 15
)

$ErrorActionPreference = 'Stop'
$connectorRoot = (Resolve-Path -LiteralPath $ConnectorDirectory).Path
$runtimeDirectory = Join-Path $connectorRoot '.data/runtime'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$watchdogLog = Join-Path $runtimeDirectory 'watchdog.log'

function Write-RuntimeLog([string]$Message) {
    Add-Content -LiteralPath $watchdogLog -Value "$(Get-Date -Format o) $Message"
}

function Get-TailscaleStatus {
    $raw = & $TailscaleExecutable status --json 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "tailscale status failed: $($raw -join [Environment]::NewLine)"
    }
    $json = $raw -join "`n"
    try { return ($json | ConvertFrom-Json) }
    catch { throw 'tailscale status returned invalid JSON.' }
}

function Get-TailscalePublicInfo {
    $status = Get-TailscaleStatus
    if ($status.BackendState -ne 'Running') {
        throw 'Tailscale is not connected. Start Tailscale and sign in first.'
    }
    $dnsName = [string]$status.Self.DNSName
    if (!$dnsName) { throw 'Tailscale did not report a MagicDNS name for this device.' }
    $dnsName = $dnsName.TrimEnd('.')
    $capabilities = @($status.Self.Capabilities)
    if ($status.Self.CapMap) { $capabilities += @($status.Self.CapMap.PSObject.Properties.Name) }
    $funnelEnabled = @($capabilities | Where-Object { ([string]$_).ToLowerInvariant() -in @('funnel', 'https://tailscale.com/cap/funnel') }).Count -gt 0
    $nodeId = [string]$status.Self.ID
    [pscustomobject]@{
        PublicBaseUrl = "https://$dnsName"
        FunnelEnabled = $funnelEnabled
        EnableUrl = if ($nodeId) { "https://login.tailscale.com/f/funnel?node=$([uri]::EscapeDataString($nodeId))" } else { '' }
    }
}

function Ensure-TailscaleFunnel([int]$Port) {
    $info = Get-TailscalePublicInfo
    if (!$info.FunnelEnabled) {
        if ($info.EnableUrl) { throw "Tailscale Funnel is not enabled. Enable it once at $($info.EnableUrl)" }
        throw 'Tailscale Funnel is not enabled for this device.'
    }
    $output = & $TailscaleExecutable funnel --bg --yes $Port 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "tailscale funnel failed: $($output -join [Environment]::NewLine)"
    }
    return $info
}

if (!$NodeExecutable) { $NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source }
if ($TunnelProvider -eq 'cloudflare' -and !$CloudflaredExecutable) { $CloudflaredExecutable = (Get-Command cloudflared.exe -ErrorAction Stop).Source }
if ($TunnelProvider -eq 'tailscale' -and !$TailscaleExecutable) { $TailscaleExecutable = (Get-Command tailscale.exe -ErrorAction Stop).Source }

$requiredPaths = @($NodeExecutable, (Join-Path $connectorRoot 'dist/server.js'), (Join-Path $connectorRoot '.env'))
if ($TunnelProvider -eq 'cloudflare') { $requiredPaths += $CloudflaredExecutable }
if ($TunnelProvider -eq 'tailscale') { $requiredPaths += $TailscaleExecutable }
foreach ($requiredPath in $requiredPaths) {
    if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        Write-RuntimeLog "Required file missing: $requiredPath"
        throw "Required file missing: $requiredPath"
    }
}
if ($TunnelProvider -eq 'cloudflare' -and $TunnelName -notmatch '^[a-zA-Z0-9_-]+$') {
    throw 'TunnelName must be a tunnel name or UUID.'
}

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
$browserStarted = $false
$tailscaleConfigured = $TunnelProvider -ne 'tailscale'
Write-RuntimeLog "Supervisor started with tunnel provider '$TunnelProvider'."
try {
    while ($true) {
        try {
            if (!$tailscaleConfigured) {
                $tailscaleInfo = Ensure-TailscaleFunnel -Port $connectorPort
                $env:PUBLIC_BASE_URL = $tailscaleInfo.PublicBaseUrl
                $env:MCP_PUBLIC_URL = "$($tailscaleInfo.PublicBaseUrl)/mcp"
                $env:AUTH_ISSUER = $tailscaleInfo.PublicBaseUrl
                $tailscaleConfigured = $true
                Write-RuntimeLog "Configured Tailscale Funnel: $($tailscaleInfo.PublicBaseUrl) -> localhost:$connectorPort"
            }

            if (!$browserStarted) {
                Start-Process -FilePath $NodeExecutable -ArgumentList 'scripts/start-browser.mjs' -WorkingDirectory $connectorRoot -WindowStyle Hidden `
                    -RedirectStandardOutput (Join-Path $runtimeDirectory 'browser.stdout.log') -RedirectStandardError (Join-Path $runtimeDirectory 'browser.stderr.log') | Out-Null
                $browserStarted = $true
                Write-RuntimeLog 'Started browser bootstrap.'
            }

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

            if ($TunnelProvider -eq 'cloudflare') {
                $tunnelPattern = '\btunnel\s+run\s+' + [regex]::Escape($TunnelName) + '(?:\s|$)'
                $existingTunnel = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" | Where-Object { $_.CommandLine -match $tunnelPattern }
                if (!$existingTunnel -and (!$tunnelProcess -or $tunnelProcess.HasExited)) {
                    $tunnelProcess = Start-Process -FilePath $CloudflaredExecutable -ArgumentList @('tunnel', 'run', $TunnelName) -WorkingDirectory $connectorRoot -WindowStyle Hidden -PassThru `
                        -RedirectStandardOutput (Join-Path $runtimeDirectory 'tunnel.stdout.log') -RedirectStandardError (Join-Path $runtimeDirectory 'tunnel.stderr.log')
                    Write-RuntimeLog "Started Cloudflare tunnel PID $($tunnelProcess.Id)."
                }
            }
        } catch {
            Write-RuntimeLog "Startup or recovery failed: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds $RetrySeconds
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
