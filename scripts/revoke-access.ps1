param(
  [string] $StorePath = (Join-Path (Get-Location) '.data/oauth-store.json'),
  [string] $ClientId,
  [switch] $All,
  [switch] $RemoveClients
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $StorePath)) {
  Write-Output "No OAuth store found: $StorePath"
  exit 0
}

$LockPath = "$StorePath.lock"
$LockStream = $null

for ($Attempt = 0; $Attempt -lt 100; $Attempt++) {
  try {
    $LockStream = [IO.File]::Open(
      $LockPath,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
    break
  } catch [IO.IOException] {
    if (Test-Path -LiteralPath $LockPath) {
      $Age = [DateTime]::UtcNow - (Get-Item -LiteralPath $LockPath).LastWriteTimeUtc
      if ($Age.TotalSeconds -gt 30) {
        Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
        continue
      }
    }
    Start-Sleep -Milliseconds 50
  }
}

if (-not $LockStream) {
  throw 'Timed out waiting for the OAuth store lock.'
}

try {
  $Store = Get-Content -LiteralPath $StorePath -Raw | ConvertFrom-Json
  $Clients = @($Store.clients)
  $Grants = @($Store.grants)

  if (-not $All -and -not $ClientId) {
    if ($Clients.Count -eq 0) {
      Write-Output 'No registered OAuth clients found.'
      exit 0
    }

    $Clients | ForEach-Object {
      $Client = $_
      $ClientGrants = @($Grants | Where-Object { $_.clientId -eq $Client.clientId })
      [pscustomobject] @{
        clientId = $Client.clientId
        clientName = $Client.clientName
        activeGrants = @($ClientGrants | Where-Object { -not $_.revokedAt }).Count
        revokedGrants = @($ClientGrants | Where-Object { $_.revokedAt }).Count
        issuedAt = $Client.issuedAt
      }
    } | Format-Table -AutoSize

    Write-Output ''
    Write-Output 'Revoke one client: npm run revoke -- -ClientId <client_id>'
    Write-Output 'Revoke everything: npm run revoke -- -All'
    exit 0
  }

  $Now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $RevokedCount = 0

  foreach ($Grant in $Grants) {
    $MatchesTarget = $All -or $Grant.clientId -eq $ClientId
    if ($MatchesTarget -and -not $Grant.revokedAt) {
      $Grant | Add-Member -NotePropertyName revokedAt -NotePropertyValue $Now -Force
      $RevokedCount++
    }
  }

  if ($RemoveClients) {
    $Store.clients = @($Clients | Where-Object {
      -not ($All -or $_.clientId -eq $ClientId)
    })
  }

  $Store | Add-Member -NotePropertyName updatedAt -NotePropertyValue $Now -Force
  $Json = ($Store | ConvertTo-Json -Depth 20) + [Environment]::NewLine
  $TempPath = "$StorePath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  [IO.File]::WriteAllText($TempPath, $Json, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $TempPath -Destination $StorePath -Force

  [pscustomobject] @{
    storePath = (Resolve-Path -LiteralPath $StorePath).Path
    revokedGrants = $RevokedCount
    removedClients = [bool] $RemoveClients
  } | ConvertTo-Json
} finally {
  $LockStream.Dispose()
  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}
