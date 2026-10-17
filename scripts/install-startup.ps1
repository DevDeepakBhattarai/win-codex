param(
    [ValidateSet('cloudflare', 'tailscale', 'none')]
    [string]$TunnelProvider = 'cloudflare',
    [string]$TunnelName = 'local',
    [string]$StartupDirectory = ''
)

$ErrorActionPreference = 'Stop'
$connectorRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$watchdogPath = Join-Path $connectorRoot 'scripts/connector-watchdog.ps1'
$cloudflaredExecutable = ''
$tailscaleExecutable = ''
if ($TunnelProvider -eq 'cloudflare') { $cloudflaredExecutable = (Get-Command cloudflared.exe -ErrorAction Stop).Source }
if ($TunnelProvider -eq 'tailscale') { $tailscaleExecutable = (Get-Command tailscale.exe -ErrorAction Stop).Source }
foreach ($requiredPath in @($watchdogPath, (Join-Path $connectorRoot 'dist/server.js'), (Join-Path $connectorRoot '.env'))) {
    if (!(Test-Path -LiteralPath $requiredPath)) { throw "Required file missing: $requiredPath" }
}
if ($TunnelProvider -eq 'cloudflare' -and $TunnelName -notmatch '^[a-zA-Z0-9_-]+$') {
    throw 'TunnelName must be a tunnel name or UUID.'
}

$arguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', "`"$watchdogPath`"",
    '-ConnectorDirectory', "`"$connectorRoot`"",
    '-NodeExecutable', "`"$nodeExecutable`"",
    '-TunnelProvider', $TunnelProvider
)
if ($TunnelProvider -eq 'cloudflare') {
    $arguments += @('-CloudflaredExecutable', "`"$cloudflaredExecutable`"", '-TunnelName', $TunnelName)
}
if ($TunnelProvider -eq 'tailscale') {
    $arguments += @('-TailscaleExecutable', "`"$tailscaleExecutable`"")
}

if (!$StartupDirectory) { $StartupDirectory = [Environment]::GetFolderPath('Startup') }
New-Item -ItemType Directory -Path $StartupDirectory -Force | Out-Null
$startupDirectory = (Resolve-Path -LiteralPath $StartupDirectory).Path
$shortcutPath = Join-Path $startupDirectory 'Local Computer Control MCP.lnk'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$shortcut.Arguments = ($arguments -join ' ')
$shortcut.WorkingDirectory = $connectorRoot
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Output "Installed Windows sign-in startup: $shortcutPath"
Write-Output "Tunnel provider: $TunnelProvider"

if ($TunnelProvider -eq 'tailscale') {
    $raw = & $tailscaleExecutable status --json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "tailscale status failed: $($raw -join [Environment]::NewLine)" }
    $json = $raw -join "`n"
    $status = $json | ConvertFrom-Json
    $dnsName = ([string]$status.Self.DNSName).TrimEnd('.')
    if ($dnsName) {
        Write-Output "Tailscale public URL: https://$dnsName"
        Write-Output "MCP URL: https://$dnsName/mcp"
    }
    $capabilities = @($status.Self.Capabilities)
    if ($status.Self.CapMap) { $capabilities += @($status.Self.CapMap.PSObject.Properties.Name) }
    if (@($capabilities | Where-Object { ([string]$_).ToLowerInvariant() -in @('funnel', 'https://tailscale.com/cap/funnel') }).Count -eq 0 -and $status.Self.ID) {
        Write-Warning "Tailscale Funnel must be enabled once before the startup shortcut can expose the MCP server: https://login.tailscale.com/f/funnel?node=$([uri]::EscapeDataString([string]$status.Self.ID))"
    }
}
