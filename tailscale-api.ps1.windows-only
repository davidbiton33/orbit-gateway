# Enable and manage private Tailscale Serve for Orbit API only (NEVER the Studio or noVNC).
param(
  [ValidateSet('On','Off','Status')][string]$Action='Status',
  [ValidateRange(1,65535)][int]$HttpsPort=8443
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile=Join-Path $root '.env.docker'
if (-not (Test-Path -LiteralPath $envFile)) { throw "This is not an installed Orbit instance. Run this script INSIDE the installed instance folder (Clean Test: Orbit-Clean-Test-xxxxxxxx), not in the release source folder." }
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { throw 'Tailscale CLI missing. Install Tailscale for Windows, sign in, and try again.' }
$props=@{}
Get-Content -LiteralPath $envFile | ForEach-Object { if ($_ -match '^([A-Z_][A-Z0-9_]*)=(.*)$') {$props[$Matches[1]]=$Matches[2]} }
if (-not $props.ContainsKey('ORBIT_API_PORT')) { throw 'Missing ORBIT_API_PORT in this installation.' }
$localPort=[int]$props['ORBIT_API_PORT']
if ($Action -eq 'Status') { & tailscale serve status; exit $LASTEXITCODE }
if ($Action -eq 'On') {
  try {
    $r=Invoke-WebRequest -Uri "http://127.0.0.1:$localPort/v1/models" -Method Get -TimeoutSec 6 -UseBasicParsing -ErrorAction Stop
    throw "Unexpected unauthenticated API response: HTTP $($r.StatusCode). Refusing to publish an unauthenticated gateway."
  } catch {
    $response=$_.Exception.Response
    if ($null -eq $response -or [int]$response.StatusCode -ne 401) { throw "Local API must respond with 401 without a token before enabling remote access. Detail: $($_.Exception.Message)" }
  }
  Write-Host "Exposing ONLY Orbit API localhost:$localPort inside your Tailscale network (HTTPS $HttpsPort)." -ForegroundColor Cyan
  & tailscale serve --bg "--https=$HttpsPort" "http://127.0.0.1:$localPort"
  if ($LASTEXITCODE -ne 0) { throw 'Tailscale Serve could not start. See output above and check your Tailnet configuration.' }
  & tailscale serve status
  Write-Host "API base URL: use the printed HTTPS address + /v1. Keep the Bearer token private. No Funnel or noVNC exposure." -ForegroundColor Green
} else {
  & tailscale serve "--https=$HttpsPort" off
  if ($LASTEXITCODE -ne 0) { throw 'Unable to disable this HTTPS Serve listener; inspect tailscale serve status.' }
  & tailscale serve status
}
