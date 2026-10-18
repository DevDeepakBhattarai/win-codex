$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $repo ('.data/runtime/tray-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $fixture 'dist'), (Join-Path $fixture 'scripts'), (Join-Path $fixture 'assets'), (Join-Path $fixture '.data/runtime') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'assets/local-codex.ico') -Destination (Join-Path $fixture 'assets/local-codex.ico')
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
Set-Content -LiteralPath (Join-Path $fixture '.env') -Value "HOST=127.0.0.1`nPORT=$port"
Set-Content -LiteralPath (Join-Path $fixture 'dist/server.js') -Value @"
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
const installationId = process.env.TRAY_TEST_FOREIGN === '1' ? 'another-installation' : createHash('sha256').update(path.resolve(import.meta.dirname, '..').toLowerCase()).digest('hex');
createServer((req,res) => {
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ok:true,name:'local-codex',pid:process.pid,installationId}));
}).listen($port,'127.0.0.1');
"@
Set-Content -LiteralPath (Join-Path $fixture 'scripts/start-browser.mjs') -Value ''
New-Item -ItemType File -Path (Join-Path $fixture '.data/runtime/paused') | Out-Null
Add-Type -TypeDefinition 'public class TrayFixture { public static void Main(string[] args) { System.Threading.Thread.Sleep(120000); } }' -OutputAssembly (Join-Path $fixture 'cloudflared.exe') -OutputType ConsoleApplication
$checks = @'
    $externalServer = $null
    $foreignServer = $null
    $externalTunnel = $null
    try {
        $externalServer = Start-Process -FilePath $NodeExecutable -ArgumentList 'dist/server.js' -WorkingDirectory $connectorRoot -WindowStyle Hidden -PassThru
        $externalTunnel = Start-Process -FilePath $CloudflaredExecutable -ArgumentList @('tunnel', 'run', $TunnelName) -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 1
        $resumeItem.PerformClick()
        if (!$serverProcess -or $serverProcess.Id -ne $externalServer.Id) { throw 'The tray rejected an existing server from the same installation.' }
        if (!$tunnelProcess -or $tunnelProcess.Id -ne $externalTunnel.Id) { throw 'The tray rejected the existing configured tunnel.' }
        $pauseItem.PerformClick()
        if (!$externalServer.WaitForExit(5000) -or !$externalTunnel.WaitForExit(5000)) { throw 'Pause did not stop the adopted server and tunnel.' }
        Sync-Services
        if ($serverProcess -or $tunnelProcess -or $timer.Enabled) { throw 'Paused services restarted.' }
        $resumeItem.PerformClick()
        Start-Sleep -Seconds 1
        if (!$serverProcess -or $serverProcess.HasExited -or !$tunnelProcess -or $tunnelProcess.HasExited) { throw 'Resume did not start services.' }
        $activeServer = $serverProcess
        $activeTunnel = $tunnelProcess
        $tunnelItem.PerformClick()
        Sync-Services
        if ($tunnelProcess -or !$activeTunnel.HasExited -or $activeServer.HasExited) { throw 'Independent tunnel stop failed.' }
        $tunnelItem.PerformClick()
        if (!$tunnelProcess -or $tunnelProcess.HasExited) { throw 'Independent tunnel start failed.' }
        Stop-Process -Id $activeServer.Id
        [void]$activeServer.WaitForExit(5000)
        Sync-Services
        Start-Sleep -Seconds 1
        if (!$serverProcess -or $serverProcess.HasExited -or $serverProcess.Id -eq $activeServer.Id) { throw 'Server crash recovery failed.' }
        $pauseItem.PerformClick()
        $env:TRAY_TEST_FOREIGN = '1'
        try { $foreignServer = Start-Process -FilePath $NodeExecutable -ArgumentList 'dist/server.js' -WorkingDirectory $connectorRoot -WindowStyle Hidden -PassThru }
        finally { Remove-Item Env:TRAY_TEST_FOREIGN }
        Start-Sleep -Seconds 1
        $resumeItem.PerformClick()
        Sync-Services
        if ($serverProcess -or $foreignServer.HasExited) { throw 'The tray adopted or stopped another installation.' }
        $errors = @(Get-Content -LiteralPath $watchdogLog | Where-Object { $_ -match 'Startup or recovery failed:' })
        if ($errors.Count -ne 1) { throw "An unchanged conflict was reported $($errors.Count) times instead of once." }
        $pauseItem.PerformClick()
        if ($foreignServer.HasExited) { throw 'Pause stopped another installation.' }
        Stop-Process -Id $foreignServer.Id
        [void]$foreignServer.WaitForExit(5000)
        $resumeItem.PerformClick()
        Start-Sleep -Seconds 1
        $lastServer = $serverProcess
        $lastTunnel = $tunnelProcess
        $quitItem.PerformClick()
        if (!$lastServer.HasExited -or !$lastTunnel.HasExited -or !(Test-Path -LiteralPath $pausedPath)) { throw 'Quit failed to stop services and preserve pause.' }
        Write-Output 'PASS: existing server and tunnel adoption, pause/resume, tunnel toggle, crash recovery, foreign installation preservation, repeated error suppression, quit.'
    } finally {
        foreach ($child in @($externalServer, $externalTunnel, $foreignServer)) {
            if ($child -and !$child.HasExited) { Stop-Process -Id $child.Id }
        }
    }
'@
$source = Get-Content -LiteralPath (Join-Path $repo 'scripts/connector-watchdog.ps1') -Raw
$source = $source.Replace('[System.Windows.Forms.Application]::Run()', $checks).Replace('$tray.Visible = $true', '$tray.Visible = $false')
$testPath = Join-Path $fixture 'verify-supervisor.ps1'
Set-Content -LiteralPath $testPath -Value $source
& $testPath -ConnectorDirectory $fixture -NodeExecutable (Get-Command node.exe).Source -CloudflaredExecutable (Join-Path $fixture 'cloudflared.exe') -TunnelName tray-test
