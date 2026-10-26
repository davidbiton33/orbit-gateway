# Orbit 2.1.1 fresh Windows installer. Reuses an instance ONLY when .env.docker already exists.
# -CleanTest is accepted only in a directory that has never been initialized.
param([switch]$CleanTest)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
Write-Host 'ORBIT Gateway 2.1.4 - isolated Docker installation' -ForegroundColor Cyan
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI not installed. Install/start Docker Desktop first.' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is not running (Linux containers required).' }
$envFile = Join-Path $root '.env.docker'
if ($CleanTest -and (Test-Path -LiteralPath $envFile)) {
  throw 'CleanTest requires a fresh folder without .env.docker. Use start-clean-test.ps1 to make a separate fresh instance safely.'
}
function Is-PortBusy([int]$port) {
  $tcp = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $tcp.BeginConnect('127.0.0.1', $port, $null, $null)
    $finished = $async.AsyncWaitHandle.WaitOne(300)
    if (-not $finished) { return $false }
    try { $tcp.EndConnect($async); return $true }
    catch [System.Net.Sockets.SocketException] { return $false }
  } finally { $tcp.Dispose() }
}
function New-Token([int]$bytesCount) {
  $bytes = New-Object byte[] $bytesCount
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}
if (-not (Test-Path -LiteralPath $envFile)) {
  $ports = if ($CleanTest) {
    # Assign an independent set of loopback ports; allow several parallel clean installations.
    $chosen = $null
    for ($offset = 0; $offset -le 30; $offset++) {
      $base = 100 * $offset
      $candidate = @((5183+$base), (5184+$base), (6180+$base), (6181+$base), (6182+$base), (6183+$base))
      if (@($candidate | Where-Object { Is-PortBusy $_ }).Count -eq 0) { $chosen = $candidate; break }
    }
    if ($null -eq $chosen) { throw 'Could not find six free ports for a clean test.' }
    $chosen
  } else {
    @(4983, 4984, 6080, 6081, 6082, 6083)
  }
  foreach ($port in $ports) {
    if (Is-PortBusy $port) { throw "Port $port is already occupied. For a parallel isolated test, run start-clean-test.ps1 instead." }
  }
  $id = [guid]::NewGuid().ToString('N').Substring(0,10)
  $project = if ($CleanTest) { "orbit-clean-$id" } else { "orbit-gateway-$id" }
  $settings = @(
    "COMPOSE_PROJECT_NAME=$project"
    "GATEWAY_TOKEN=$(New-Token 48)"
    'GPT_BACKEND=legacy'
    "ORBIT_UI_PORT=$($ports[0])"
    "ORBIT_API_PORT=$($ports[1])"
    "ORBIT_GPT_LEGACY_VNC_PORT=$($ports[2])"
    "ORBIT_GPT_VNC_PORT=$($ports[3])"
    "ORBIT_GEMINI_VNC_PORT=$($ports[4])"
    "ORBIT_CLAUDE_VNC_PORT=$($ports[5])"
  )
  $out = ($settings -join "`n") + "`n"
  [System.IO.File]::WriteAllText($envFile, $out, (New-Object System.Text.UTF8Encoding($false)))
  if ($CleanTest) {
    [System.IO.File]::WriteAllText((Join-Path $root '.orbit-clean-install'), $project + "`n")
  }
  Write-Host "Created NEW isolated Docker project: $project" -ForegroundColor Green
} else {
  Write-Host 'Existing .env.docker retained: reusing this instance, NOT a fresh test.' -ForegroundColor Yellow
}
# Import only public port/project settings; the secret remains in .env.docker.
$props = @{}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.*)$') { $props[$Matches[1]] = $Matches[2] }
}
foreach ($required in @('COMPOSE_PROJECT_NAME','GATEWAY_TOKEN','ORBIT_UI_PORT','ORBIT_API_PORT','ORBIT_GPT_VNC_PORT','ORBIT_GEMINI_VNC_PORT','ORBIT_CLAUDE_VNC_PORT','ORBIT_GPT_LEGACY_VNC_PORT')) {
  if (-not $props.ContainsKey($required) -or [string]::IsNullOrWhiteSpace($props[$required])) {
    throw "Missing $required in .env.docker. This package requires a new isolated installation; do not mix it with the old release folder."
  }
}
if ($props['COMPOSE_PROJECT_NAME'] -notmatch '^orbit-(?:gateway|clean)-[a-f0-9]{10}$') { throw 'Invalid or reused project name. Do not attach this installer to an existing Docker project.' }
foreach ($setting in @('ORBIT_UI_PORT','ORBIT_API_PORT','ORBIT_GPT_VNC_PORT','ORBIT_GEMINI_VNC_PORT','ORBIT_CLAUDE_VNC_PORT','ORBIT_GPT_LEGACY_VNC_PORT')) {
  $p=[int]$props[$setting]
  if (Is-PortBusy $p) {
    $existing = @(docker compose --env-file .env.docker -f docker-compose.yml ps -q 2>$null)
    if (-not $existing.Count) { throw "Host port $p is occupied by another application. Nothing stopped or deleted." }
  }
}
Write-Host 'Validating isolated Compose project...'
& docker compose --env-file .env.docker -f docker-compose.yml config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Invalid Compose config.' }
Write-Host 'Building and starting Gateway, Gemini and Claude...' -ForegroundColor Yellow
& docker compose --env-file .env.docker -f docker-compose.yml up -d --build gateway gemini claude
if ($LASTEXITCODE -ne 0) { throw 'Docker build/start failed; inspect the logs.' }
Write-Host 'Starting selected ChatGPT backend...'
& (Join-Path $root 'switch-gpt.ps1')
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'GPT setup failed.' }
& docker compose --env-file .env.docker -f docker-compose.yml ps
Write-Host ('STUDIO: http://127.0.0.1:' + $props['ORBIT_UI_PORT']) -ForegroundColor Green
$currentBackend = ((Get-Content -LiteralPath $envFile | Select-String '^GPT_BACKEND=(.+)$' | Select-Object -First 1).Matches[0].Groups[1].Value)
$gptViewerPort = if ($currentBackend -eq 'legacy') { $props['ORBIT_GPT_LEGACY_VNC_PORT'] } else { $props['ORBIT_GPT_VNC_PORT'] }
Write-Host ('GPT (' + $currentBackend + '): http://127.0.0.1:' + $gptViewerPort + '/vnc.html')
Write-Host ('Gemini: http://127.0.0.1:' + $props['ORBIT_GEMINI_VNC_PORT'] + '/vnc.html')
Write-Host ('Claude: http://127.0.0.1:' + $props['ORBIT_CLAUDE_VNC_PORT'] + '/vnc.html')
Write-Host ('API:    http://127.0.0.1:' + $props['ORBIT_API_PORT'] + '/v1 (Bearer token required)') -ForegroundColor Green
Write-Host ('INSTANCE FOLDER: ' + $root) -ForegroundColor Yellow
Write-Host 'Run docker.ps1, login scripts and tailscale-api.ps1 ONLY from this installed instance folder.' -ForegroundColor Yellow
Write-Host 'See INSTALL_HE.md for fresh sign-in. No previously existing Docker volumes were mounted.'
