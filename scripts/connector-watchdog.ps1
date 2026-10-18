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

$requiredPaths = @($NodeExecutable, (Join-Path $connectorRoot 'dist/server.js'), (Join-Path $connectorRoot '.env'), (Join-Path $connectorRoot 'assets/local-codex.ico'))
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
$pausedPath = Join-Path $runtimeDirectory 'paused'
$tunnelDisabledPath = Join-Path $runtimeDirectory 'tunnel-disabled'
$paused = Test-Path -LiteralPath $pausedPath
$tunnelEnabled = !(Test-Path -LiteralPath $tunnelDisabledPath)
$tray = $null
$trayIcon = $null
$timer = $null
$lastServiceError = $null
$browserStarted = $false
$tailscaleConfigured = $TunnelProvider -ne 'tailscale'

function Stop-ManagedProcess([string]$Name) {
    $managed = Get-Variable -Name $Name -ValueOnly -Scope Script
    if ($managed -and !$managed.HasExited) {
        Stop-Process -Id $managed.Id -ErrorAction Stop
        if (!$managed.WaitForExit(5000)) { throw "Process $($managed.Id) did not stop." }
        Write-RuntimeLog "Stopped $Name PID $($managed.Id)."
    }
    Set-Variable -Name $Name -Value $null -Scope Script
}

function Update-Tray {
    $pauseItem.Enabled = !$script:paused
    $resumeItem.Enabled = $script:paused
    $tunnelItem.Enabled = !$script:paused -and $TunnelProvider -eq 'cloudflare'
    $tunnelItem.Text = if ($script:tunnelEnabled) { 'Stop Cloudflare tunnel' } else { 'Start Cloudflare tunnel' }
    $tray.Text = if ($script:paused) { 'Local Codex - paused' } elseif (!$script:tunnelEnabled) { 'Local Codex - tunnel stopped' } else { 'Local Codex - running' }
}

function Sync-Services {
    if ($script:paused) { return }
    try {
        if (!$script:tailscaleConfigured) {
            $tailscaleInfo = Ensure-TailscaleFunnel -Port $connectorPort
            $env:PUBLIC_BASE_URL = $tailscaleInfo.PublicBaseUrl
            $env:MCP_PUBLIC_URL = "$($tailscaleInfo.PublicBaseUrl)/mcp"
            $env:AUTH_ISSUER = $tailscaleInfo.PublicBaseUrl
            $script:tailscaleConfigured = $true
            Write-RuntimeLog "Configured Tailscale Funnel: $($tailscaleInfo.PublicBaseUrl) -> localhost:$connectorPort"
        }
        if (!$script:browserStarted) {
            Start-Process -FilePath $NodeExecutable -ArgumentList 'scripts/start-browser.mjs' -WorkingDirectory $connectorRoot -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $runtimeDirectory 'browser.stdout.log') -RedirectStandardError (Join-Path $runtimeDirectory 'browser.stderr.log') | Out-Null
            $script:browserStarted = $true
        }
        $healthy = $false
        try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2; $healthy = $health.ok -eq $true -and $health.name -eq 'local-codex' } catch { }
        if ($healthy -and (!$script:serverProcess -or $script:serverProcess.HasExited)) {
            $owners = @(Get-NetTCPConnection -State Listen -LocalPort $connectorPort -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
            if ($health.installationId -ne $mutexId -or !$health.pid -or $health.pid -notin $owners) {
                throw "Port $connectorPort belongs to another or older installation. Its server has been left running. See the runtime logs."
            }
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($health.pid)"
            if (!$owner -or $owner.ExecutablePath -ine $NodeExecutable) { throw "Cannot verify the server process on port $connectorPort." }
            $script:serverProcess = Get-Process -Id $owner.ProcessId -ErrorAction Stop
            Write-RuntimeLog "Adopted existing MCP server PID $($script:serverProcess.Id)."
        }
        if (!$healthy) {
            $listener = Get-NetTCPConnection -State Listen -LocalPort $connectorPort -ErrorAction SilentlyContinue
            if (!$listener -and (!$script:serverProcess -or $script:serverProcess.HasExited)) {
                $script:serverProcess = Start-Process -FilePath $NodeExecutable -ArgumentList 'dist/server.js' -WorkingDirectory $connectorRoot -WindowStyle Hidden -PassThru `
                    -RedirectStandardOutput (Join-Path $runtimeDirectory 'server.stdout.log') -RedirectStandardError (Join-Path $runtimeDirectory 'server.stderr.log')
                Write-RuntimeLog "Started MCP server PID $($script:serverProcess.Id)."
            } elseif ($listener) {
                Write-RuntimeLog "Port $connectorPort is occupied but health is unavailable. Preserving the existing process."
            }
        }
        if ($TunnelProvider -eq 'cloudflare' -and $script:tunnelEnabled) {
            $tunnelPattern = '\btunnel\s+run\s+' + [regex]::Escape($TunnelName) + '(?:\s|$)'
            $existingTunnel = @(Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" | Where-Object { $_.CommandLine -match $tunnelPattern })
            if ($existingTunnel.Count -gt 0 -and (!$script:tunnelProcess -or $script:tunnelProcess.HasExited)) {
                if ($existingTunnel.Count -ne 1 -or $existingTunnel[0].ExecutablePath -ine $CloudflaredExecutable) {
                    throw "Cannot verify the existing Cloudflare tunnel $TunnelName. It has been left running."
                }
                $script:tunnelProcess = Get-Process -Id $existingTunnel[0].ProcessId -ErrorAction Stop
                Write-RuntimeLog "Adopted existing Cloudflare tunnel PID $($script:tunnelProcess.Id)."
            }
            if (!$script:tunnelProcess -or $script:tunnelProcess.HasExited) {
                $script:tunnelProcess = Start-Process -FilePath $CloudflaredExecutable -ArgumentList @('tunnel', 'run', $TunnelName) -WorkingDirectory $connectorRoot -WindowStyle Hidden -PassThru `
                    -RedirectStandardOutput (Join-Path $runtimeDirectory 'tunnel.stdout.log') -RedirectStandardError (Join-Path $runtimeDirectory 'tunnel.stderr.log')
                Write-RuntimeLog "Started Cloudflare tunnel PID $($script:tunnelProcess.Id)."
            }
        }
        $script:lastServiceError = $null
        Update-Tray
    } catch {
        $tray.Text = 'Local Codex - service error'
        if ($script:lastServiceError -ne $_.Exception.Message) {
            $script:lastServiceError = $_.Exception.Message
            Write-RuntimeLog "Startup or recovery failed: $($_.Exception.Message)"
            $tray.ShowBalloonTip(5000, 'Local Codex', $_.Exception.Message, [System.Windows.Forms.ToolTipIcon]::Error)
        }
    }
}

function Pause-Services {
    # Persist before stopping children so neither recovery nor the next sign-in restarts them.
    New-Item -ItemType File -Path $pausedPath -Force | Out-Null
    $script:paused = $true
    $timer.Stop()
    try { Stop-ManagedProcess 'tunnelProcess' } finally { Stop-ManagedProcess 'serverProcess' }
    Update-Tray
    Write-RuntimeLog 'Paused. Server, tunnel, and recovery checks are stopped.'
}

function Invoke-TrayAction([scriptblock]$Action) {
    try { & $Action } catch {
        Write-RuntimeLog "Tray action failed: $($_.Exception.Message)"
        $tray.Text = 'Local Codex - action failed'
        $tray.ShowBalloonTip(5000, 'Local Codex', $_.Exception.Message, [System.Windows.Forms.ToolTipIcon]::Error)
    }
}

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $tray = New-Object System.Windows.Forms.NotifyIcon
    $trayIcon = New-Object System.Drawing.Icon -ArgumentList (Join-Path $connectorRoot 'assets/local-codex.ico')
    $tray.Icon = $trayIcon
    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $pauseItem = $menu.Items.Add('Pause everything')
    $resumeItem = $menu.Items.Add('Resume everything')
    $tunnelItem = $menu.Items.Add('Stop Cloudflare tunnel')
    [void]$menu.Items.Add('-')
    $logsItem = $menu.Items.Add('Open logs')
    $quitItem = $menu.Items.Add('Quit Local Codex and Cloudflare')
    $tray.ContextMenuStrip = $menu
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = $RetrySeconds * 1000
    $timer.Add_Tick({ Sync-Services })
    $pauseItem.Add_Click({ Invoke-TrayAction { Pause-Services } })
    $resumeItem.Add_Click({ Invoke-TrayAction {
        if (Test-Path -LiteralPath $pausedPath) { Remove-Item -LiteralPath $pausedPath -Force -ErrorAction Stop }
        $script:paused = $false
        Update-Tray
        Sync-Services
        $timer.Start()
        Write-RuntimeLog 'Resumed.'
    } })
    $tunnelItem.Add_Click({ Invoke-TrayAction {
        if ($script:tunnelEnabled) {
            New-Item -ItemType File -Path $tunnelDisabledPath -Force | Out-Null
            $script:tunnelEnabled = $false
            Stop-ManagedProcess 'tunnelProcess'
        } else {
            Remove-Item -LiteralPath $tunnelDisabledPath -Force -ErrorAction Stop
            $script:tunnelEnabled = $true
        }
        Update-Tray
        Sync-Services
    } })
    $logsItem.Add_Click({ Invoke-TrayAction { Start-Process explorer.exe -ArgumentList ('"' + $runtimeDirectory + '"') } })
    $quitItem.Add_Click({ Invoke-TrayAction {
        Pause-Services
        [System.Windows.Forms.Application]::ExitThread()
    } })
    Update-Tray
    $tray.Visible = $true
    Write-RuntimeLog 'Tray supervisor started. Right-click the tray icon to pause or quit.'
    if (!$paused) {
        Sync-Services
        $timer.Start()
    }
    [System.Windows.Forms.Application]::Run()
} finally {
    if ($timer) { $timer.Stop(); $timer.Dispose() }
    if ($tray) { $tray.Visible = $false; $tray.Dispose() }
    if ($trayIcon) { $trayIcon.Dispose() }
    if ($menu) { $menu.Dispose() }
    try {
        Stop-ManagedProcess 'tunnelProcess'
        Stop-ManagedProcess 'serverProcess'
    } finally {
        $mutex.ReleaseMutex()
        $mutex.Dispose()
    }
}
