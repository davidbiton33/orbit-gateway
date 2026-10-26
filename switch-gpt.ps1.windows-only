param([ValidateSet('docker','legacy')][string]$Backend)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$envPath = Join-Path $root '.env.docker'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Missing .env.docker. Run setup-docker.ps1 first.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI unavailable.' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is not running.' }
function Save-Env([string]$raw) {
  [System.IO.File]::WriteAllText($envPath, $raw, (New-Object System.Text.UTF8Encoding($false)))
}
function Set-EnvVariable([string]$raw,[string]$key,[string]$value) {
  $pattern = '(?m)^' + [regex]::Escape($key) + '=.*$'
  if ([regex]::IsMatch($raw,$pattern)) { return [regex]::Replace($raw,$pattern,($key + '=' + $value)) }
  return $raw.TrimEnd() + "`n" + $key + '=' + $value + "`n"
}
$raw = Get-Content -LiteralPath $envPath -Raw
if ($PSBoundParameters.ContainsKey('Backend')) {
  $raw = Set-EnvVariable $raw 'GPT_BACKEND' $Backend
} elseif ($raw -match '(?m)^GPT_BACKEND=(.+)$') {
  $Backend=$Matches[1].Trim()
} else {
  $Backend='docker'
  $raw = Set-EnvVariable $raw 'GPT_BACKEND' $Backend
}
if ($Backend -notin @('docker','legacy')) { throw 'GPT_BACKEND must be docker or legacy.' }
if ($Backend -eq 'legacy') {
  if (-not (Test-Path (Join-Path $root 'legacy-gpt/docker/Dockerfile.gpt'))) { throw 'Legacy GPT engine missing.' }
  if ($raw -notmatch '(?m)^GPT_VNC_PASSWORD=.{12,}$') {
    $secret = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($secret) } finally { $rng.Dispose() }
    $password = [Convert]::ToBase64String($secret).TrimEnd('=').Replace('+','-').Replace('/','_')
    $raw = Set-EnvVariable $raw 'GPT_VNC_PASSWORD' $password
  }
}
Save-Env $raw
function Compose([string[]]$Arguments) {
  & docker compose --env-file .env.docker -f docker-compose.yml @Arguments
  if ($LASTEXITCODE -ne 0) { throw ('docker compose failed: ' + ($Arguments -join ' ')) }
}
function Get-ContainerId([string]$service) {
  $id = & docker compose --env-file .env.docker -f docker-compose.yml --profile gpt-docker --profile gpt-legacy ps -q $service
  if ($LASTEXITCODE -ne 0 -or -not "$id".Trim()) { throw "No container for service $service" }
  return "$id".Trim()
}
function Wait-Healthy([string]$service,[int]$attempts) {
  $container=Get-ContainerId $service
  for ($i=0; $i -lt $attempts; $i++) {
    $state = & docker inspect --format '{{.State.Health.Status}}' $container
    if ($LASTEXITCODE -eq 0 -and "$state".Trim() -eq 'healthy') { return $true }
    if ("$state".Trim() -eq 'unhealthy') { break }
    Start-Sleep -Seconds 2
  }
  & docker logs --tail 35 $container
  return $false
}
Write-Host ('Orbit GPT backend -> ' + $Backend) -ForegroundColor Cyan
Compose @('config','--quiet')
if ($Backend -eq 'legacy') {
  Compose @('--profile','gpt-legacy','up','-d','--build','--no-deps','gpt-legacy')
  $selected = 'gpt-legacy'; $unused = 'gpt'
} else {
  Compose @('--profile','gpt-docker','up','-d','--build','--no-deps','gpt')
  $selected = 'gpt'; $unused = 'gpt-legacy'
}
if (-not (Wait-Healthy $selected 45)) { throw "Selected GPT backend ($Backend) is not healthy. The previous backend has NOT been stopped." }
Compose @('up','-d','--no-build','--no-deps','--force-recreate','gateway')
if (-not (Wait-Healthy 'gateway' 25)) { throw 'Front gateway not healthy. Previous backend NOT stopped.' }
# Do not run two Chrome workers against the same provider; this touches only this project's container.
Compose @('--profile','gpt-docker','--profile','gpt-legacy','stop',$unused)
$ui = ((Get-Content -LiteralPath $envPath | Select-String '^ORBIT_UI_PORT=(\d+)' | Select-Object -First 1).Matches[0].Groups[1].Value)
$viewerKey=if($Backend -eq 'legacy') {'ORBIT_GPT_LEGACY_VNC_PORT'} else {'ORBIT_GPT_VNC_PORT'}
$viewer = ((Get-Content -LiteralPath $envPath | Select-String ('^'+$viewerKey+'=(\d+)') | Select-Object -First 1).Matches[0].Groups[1].Value)
Write-Host "GPT backend active: $Backend" -ForegroundColor Green
Write-Host "Studio: http://127.0.0.1:$ui"
Write-Host "GPT browser: http://127.0.0.1:$viewer/vnc.html"
if ($Backend -eq 'legacy') { Write-Host 'Legacy Chrome is already open in noVNC; sign in there directly. Use first eight characters of GPT_VNC_PASSWORD from .env.docker for noVNC.' }
