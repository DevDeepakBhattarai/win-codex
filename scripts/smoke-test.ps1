$ErrorActionPreference = 'Stop'

$Base = $env:MCP_SMOKE_BASE_URL
if (-not $Base) {
  $Base = 'http://localhost:6000'
}

$McpRequestUrl = "$Base/mcp"
$ProtectedResource = Invoke-RestMethod -Uri "$Base/.well-known/oauth-protected-resource"
$McpResource = $ProtectedResource.resource
$Redirect = 'http://127.0.0.1/callback'

$ConsentPin = $env:MCP_SMOKE_CONSENT_PIN

function ConvertTo-Base64Url([byte[]] $Bytes) {
  [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertFrom-SseJson([string] $Content) {
  $Data = (($Content -split "`n") |
    Where-Object { $_ -like 'data: *' } |
    ForEach-Object { $_.Substring(6) }) -join "`n"

  $Data | ConvertFrom-Json
}

function ConvertFrom-JwtPayload([string] $Token) {
  $Payload = ($Token -split '\.')[1].Replace('-', '+').Replace('_', '/')
  while ($Payload.Length % 4 -ne 0) {
    $Payload += '='
  }

  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) |
    ConvertFrom-Json
}

function New-RandomBytes([int] $Length) {
  $Bytes = New-Object byte[] $Length
  $Rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $Rng.GetBytes($Bytes)
  } finally {
    $Rng.Dispose()
  }
  $Bytes
}

function Invoke-PostFormNoRedirect([string] $Uri, [hashtable] $Form) {
  $Body = (($Form.GetEnumerator() | ForEach-Object {
    "$([Uri]::EscapeDataString($_.Key))=$([Uri]::EscapeDataString([string] $_.Value))"
  }) -join '&')
  $BodyBytes = [Text.Encoding]::UTF8.GetBytes($Body)
  $Request = [Net.WebRequest]::Create($Uri)
  $Request.Method = 'POST'
  $Request.AllowAutoRedirect = $false
  $Request.ContentType = 'application/x-www-form-urlencoded'
  $Request.ContentLength = $BodyBytes.Length

  $RequestStream = $Request.GetRequestStream()
  try {
    $RequestStream.Write($BodyBytes, 0, $BodyBytes.Length)
  } finally {
    $RequestStream.Dispose()
  }

  try {
    $Request.GetResponse()
  } catch [Net.WebException] {
    if ($_.Exception.Response) {
      $_.Exception.Response
    } else {
      throw
    }
  }
}

$Verifier = ConvertTo-Base64Url (New-RandomBytes 48)
$Sha = [Security.Cryptography.SHA256]::Create()
$Challenge = ConvertTo-Base64Url ($Sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($Verifier)))

$Registration = Invoke-RestMethod `
  -Method Post `
  -Uri "$Base/oauth/register" `
  -ContentType 'application/json' `
  -Body (@{
    client_name = 'Terminal Smoke Test'
    redirect_uris = @($Redirect)
    scope = 'mcp:control'
    token_endpoint_auth_method = 'none'
  } | ConvertTo-Json)

$AuthorizeQuery = @{
  response_type = 'code'
  client_id = $Registration.client_id
  redirect_uri = $Redirect
  code_challenge = $Challenge
  code_challenge_method = 'S256'
  scope = 'mcp:control'
  resource = $McpResource
  state = 'smoke'
}
$AuthorizeQueryString = (($AuthorizeQuery.GetEnumerator() | ForEach-Object {
  "$([Uri]::EscapeDataString($_.Key))=$([Uri]::EscapeDataString([string] $_.Value))"
}) -join '&')
$AuthorizePage = Invoke-WebRequest -UseBasicParsing -Uri "$Base/oauth/authorize?$AuthorizeQueryString"

$AuthTxMatch = [regex]::Match(
  $AuthorizePage.Content,
  'name="auth_tx" value="([^"]+)"'
)
if (-not $AuthTxMatch.Success) {
  throw 'Authorization transaction was not rendered.'
}

if (-not $ConsentPin) {
  $ConsentPin = Read-Host 'Enter the 6-digit OAUTH CONSENT PIN shown in the server terminal'
}
if ($ConsentPin -notmatch '^\d{6}$') {
  throw 'MCP smoke consent PIN must contain exactly 6 digits.'
}

$AuthorizeForm = @{
  auth_tx = [Net.WebUtility]::HtmlDecode($AuthTxMatch.Groups[1].Value)
  action = 'authorize'
  consent_pin = $ConsentPin
}

$Authorize = Invoke-PostFormNoRedirect "$Base/oauth/authorize" $AuthorizeForm
$Code = [System.Web.HttpUtility]::ParseQueryString(([Uri] $Authorize.Headers['Location']).Query).Get('code')

$Token = Invoke-RestMethod `
  -Method Post `
  -Uri "$Base/oauth/token" `
  -Body @{
    grant_type = 'authorization_code'
    code = $Code
    redirect_uri = $Redirect
    client_id = $Registration.client_id
    code_verifier = $Verifier
    resource = $McpResource
  }

$AccessPayload = ConvertFrom-JwtPayload $Token.access_token
if (-not ($AccessPayload.PSObject.Properties.Name -contains 'exp')) {
  throw 'Access token is missing its exp claim.'
}

if (-not ($Token.PSObject.Properties.Name -contains 'expires_in')) {
  throw 'Token response is missing expires_in.'
}

$Refresh = Invoke-RestMethod `
  -Method Post `
  -Uri "$Base/oauth/token" `
  -Body @{
    grant_type = 'refresh_token'
    refresh_token = $Token.refresh_token
    client_id = $Registration.client_id
    resource = $McpResource
  }

if (-not ($Refresh.PSObject.Properties.Name -contains 'expires_in')) {
  throw 'Refresh token response is missing expires_in.'
}

if (-not $Refresh.refresh_token -or $Refresh.refresh_token -eq $Token.refresh_token) {
  throw 'Refresh token was not rotated.'
}

$Headers = @{
  Authorization = "Bearer $($Refresh.access_token)"
  Accept = 'application/json, text/event-stream'
}

$InitializeBody = @{
  jsonrpc = '2.0'
  id = 1
  method = 'initialize'
  params = @{
    protocolVersion = '2025-06-18'
    capabilities = @{}
    clientInfo = @{
      name = 'terminal-smoke-test'
      version = '0.1.0'
    }
  }
} | ConvertTo-Json -Depth 10

$InitializeResponse = Invoke-WebRequest `
  -UseBasicParsing `
  -Method Post `
  -Uri $McpRequestUrl `
  -Headers $Headers `
  -ContentType 'application/json' `
  -Body $InitializeBody

$RawSessionId = $InitializeResponse.Headers['mcp-session-id']
if ($RawSessionId) {
  throw 'Stateless MCP unexpectedly returned an Mcp-Session-Id header.'
}
$Headers['Mcp-Protocol-Version'] = '2025-06-18'

$InitializedBody = @{
  jsonrpc = '2.0'
  method = 'notifications/initialized'
} | ConvertTo-Json -Depth 10

Invoke-WebRequest `
  -UseBasicParsing `
  -Method Post `
  -Uri $McpRequestUrl `
  -Headers $Headers `
  -ContentType 'application/json' `
  -Body $InitializedBody | Out-Null

$ToolsBody = @{
  jsonrpc = '2.0'
  id = 2
  method = 'tools/list'
  params = @{}
} | ConvertTo-Json -Depth 10

$ToolsResponse = Invoke-WebRequest `
  -UseBasicParsing `
  -Method Post `
  -Uri $McpRequestUrl `
  -Headers $Headers `
  -ContentType 'application/json' `
  -Body $ToolsBody
$Tools = ConvertFrom-SseJson $ToolsResponse.Content

if (-not ($Tools.result.tools.name -contains 'analyze_image')) {
  throw 'analyze_image tool was not advertised by tools/list.'
}

$CallBody = @{
  jsonrpc = '2.0'
  id = 3
  method = 'tools/call'
  params = @{
    name = 'terminal'
    arguments = @{
      command = 'node -e "console.log(''mcp-terminal-ok'')"'
      timeoutMs = 10000
    }
  }
} | ConvertTo-Json -Depth 10

$CallResponse = Invoke-WebRequest `
  -UseBasicParsing `
  -Method Post `
  -Uri $McpRequestUrl `
  -Headers $Headers `
  -ContentType 'application/json' `
  -Body $CallBody
$Call = ConvertFrom-SseJson $CallResponse.Content
$TerminalResult = $Call.result.content[0].text | ConvertFrom-Json
if ($TerminalResult.stdout -notmatch 'mcp-terminal-ok') {
  throw 'Terminal tool did not return the expected smoke-test output.'
}

$BadProcessBody = @{
  jsonrpc = '2.0'
  id = 4
  method = 'tools/call'
  params = @{
    name = 'start_process'
    arguments = @{
      command = 'definitely-not-a-real-executable-mcp-test'
      args = @()
      wait = $false
      timeoutMs = 5000
    }
  }
} | ConvertTo-Json -Depth 10
$BadProcessResponse = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $McpRequestUrl -Headers $Headers -ContentType 'application/json' -Body $BadProcessBody
$BadProcess = ConvertFrom-SseJson $BadProcessResponse.Content
$BadProcessResult = $BadProcess.result.content[0].text | ConvertFrom-Json
if ($BadProcessResult.started) {
  throw 'A nonexistent process was reported as started.'
}

$ImageFile = Join-Path ([IO.Path]::GetTempPath()) "mcp-image-$([Guid]::NewGuid().ToString('N')).png"
$TinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl02QAAAABJRU5ErkJggg=='
try {
  [IO.File]::WriteAllBytes($ImageFile, [Convert]::FromBase64String($TinyPngBase64))
  $ImageBody = @{
    jsonrpc = '2.0'
    id = 6
    method = 'tools/call'
    params = @{
      name = 'analyze_image'
      arguments = @{
        path = $ImageFile
      }
    }
  } | ConvertTo-Json -Depth 10
  $ImageResponse = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $McpRequestUrl -Headers $Headers -ContentType 'application/json' -Body $ImageBody
  $ImageCall = ConvertFrom-SseJson $ImageResponse.Content
  $ImageContent = $ImageCall.result.content | Where-Object { $_.type -eq 'image' } | Select-Object -First 1
  if (-not $ImageContent -or $ImageContent.mimeType -ne 'image/png') {
    throw 'analyze_image did not return PNG MCP image content.'
  }
  if ($ImageContent.data -ne $TinyPngBase64) {
    throw 'analyze_image changed the image bytes.'
  }
} finally {
  Remove-Item -LiteralPath $ImageFile -Force -ErrorAction SilentlyContinue
}
$HealthAfterRuntimeErrors = Invoke-RestMethod -Uri "$Base/health"
if (-not $HealthAfterRuntimeErrors.ok) {
  throw 'Server was unhealthy after runtime error tests.'
}

Invoke-RestMethod `
  -Method Post `
  -Uri "$Base/oauth/revoke" `
  -Body @{
    token = $Refresh.refresh_token
    client_id = $Registration.client_id
  } | Out-Null

$RefreshRevoked = $false
try {
  Invoke-RestMethod `
    -Method Post `
    -Uri "$Base/oauth/token" `
    -Body @{
      grant_type = 'refresh_token'
      refresh_token = $Token.refresh_token
      client_id = $Registration.client_id
      resource = $McpResource
    } | Out-Null
} catch {
  $RefreshRevoked = $true
}

if (-not $RefreshRevoked) {
  throw 'Refresh token was still accepted after revocation.'
}

$AccessRevoked = $false
try {
  Invoke-WebRequest `
    -UseBasicParsing `
    -Method Post `
    -Uri $McpRequestUrl `
    -Headers $Headers `
    -ContentType 'application/json' `
    -Body $InitializeBody | Out-Null
} catch {
  if ($_.Exception.Response -and [int] $_.Exception.Response.StatusCode -eq 401) {
    $AccessRevoked = $true
  } else {
    throw
  }
}

if (-not $AccessRevoked) {
  throw 'Access token was still accepted after revocation.'
}

[pscustomobject] @{
  clientId = $Registration.client_id
  tokenType = $Token.token_type
  refreshTokenIssued = [bool] $Token.refresh_token
  refreshTokenRotated = $Refresh.refresh_token -ne $Token.refresh_token
  accessTokenExpiresIn = $Token.expires_in
  refreshRevoked = $RefreshRevoked
  accessRevoked = $AccessRevoked
  scope = $Token.scope
  mcpResource = $McpResource
  transportMode = 'stateless'
  sessionIdIssued = [bool] $RawSessionId
  tools = $Tools.result.tools.name
  terminalResult = $TerminalResult
  nonexistentProcessHandled = -not $BadProcessResult.started
  boundedReadBytes = $ReadResult.bytesRead
  imageToolMimeType = $ImageContent.mimeType
  healthyAfterRuntimeErrors = $HealthAfterRuntimeErrors.ok
} | ConvertTo-Json -Depth 10
