param(
  [string] $EnvPath = (Join-Path (Get-Location) '.env'),
  [string] $DataPath = (Join-Path (Get-Location) '.data')
)

$ErrorActionPreference = 'Stop'
$RunningOnWindows = $env:OS -eq 'Windows_NT'

if (-not $RunningOnWindows) {
  function Protect-PosixPath {
    param(
      [Parameter(Mandatory)] [string] $LiteralPath,
      [switch] $Recursive
    )

    if (-not (Test-Path -LiteralPath $LiteralPath)) {
      return
    }

    $Resolved = (Resolve-Path -LiteralPath $LiteralPath).Path
    $Arguments = if ($Recursive) {
      @('-R', 'go-rwx', $Resolved)
    } else {
      @('go-rwx', $Resolved)
    }

    & chmod @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "chmod failed with exit code ${LASTEXITCODE}: $($Arguments -join ' ')"
    }
  }

  Protect-PosixPath -LiteralPath $DataPath -Recursive
  Protect-PosixPath -LiteralPath $EnvPath

  [pscustomobject] @{
    envPath = if (Test-Path -LiteralPath $EnvPath) { (Resolve-Path -LiteralPath $EnvPath).Path } else { $null }
    dataPath = if (Test-Path -LiteralPath $DataPath) { (Resolve-Path -LiteralPath $DataPath).Path } else { $null }
    protectedFor = [Environment]::UserName
    platform = 'posix'
  } | ConvertTo-Json
  return
}

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$CurrentSid = $Identity.User.Value
$SystemSid = 'S-1-5-18'
$AdministratorsSid = 'S-1-5-32-544'
$AuthenticatedUsersSid = 'S-1-5-11'
$UsersSid = 'S-1-5-32-545'

function Invoke-Icacls {
  param([Parameter(Mandatory)] [string[]] $Arguments)

  & icacls.exe @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "icacls failed with exit code ${LASTEXITCODE}: $($Arguments -join ' ')"
  }
}

function Protect-File {
  param([Parameter(Mandatory)] [string] $LiteralPath)

  if (-not (Test-Path -LiteralPath $LiteralPath)) {
    return
  }

  $Resolved = (Resolve-Path -LiteralPath $LiteralPath).Path
  Invoke-Icacls @(
    $Resolved,
    '/inheritance:r',
    '/remove:g', "*$AuthenticatedUsersSid", "*$UsersSid",
    '/grant:r', "*$CurrentSid`:F", "*$SystemSid`:F", "*$AdministratorsSid`:F"
  )
}

function Protect-DirectoryTree {
  param([Parameter(Mandatory)] [string] $LiteralPath)

  if (-not (Test-Path -LiteralPath $LiteralPath)) {
    return
  }

  $Resolved = (Resolve-Path -LiteralPath $LiteralPath).Path
  Invoke-Icacls @(
    $Resolved,
    '/inheritance:r',
    '/remove:g', "*$AuthenticatedUsersSid", "*$UsersSid",
    '/grant:r',
    "*$CurrentSid`:(OI)(CI)F",
    "*$SystemSid`:(OI)(CI)F",
    "*$AdministratorsSid`:(OI)(CI)F"
  )

  $Children = @(Get-ChildItem -LiteralPath $Resolved -Force)
  if ($Children.Count -gt 0) {
    Invoke-Icacls @(
      (Join-Path $Resolved '*'),
      '/reset',
      '/T',
      '/C'
    )
  }
}

Protect-DirectoryTree -LiteralPath $DataPath
Protect-File -LiteralPath $EnvPath

[pscustomobject] @{
  envPath = if (Test-Path -LiteralPath $EnvPath) { (Resolve-Path -LiteralPath $EnvPath).Path } else { $null }
  dataPath = if (Test-Path -LiteralPath $DataPath) { (Resolve-Path -LiteralPath $DataPath).Path } else { $null }
  protectedFor = $Identity.Name
  platform = 'windows'
} | ConvertTo-Json
