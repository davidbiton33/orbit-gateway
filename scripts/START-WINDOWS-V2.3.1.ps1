$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile=Join-Path $root '.env'
if(!(Test-Path $envFile)){
  $bytes=New-Object byte[] 24
  $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $token=($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
  @(
    "GATEWAY_TOKEN=$token",
    'GATEWAY_API_HOST=127.0.0.1',
    'GATEWAY_UI_HOST=127.0.0.1',
    'API_PORT=5284',
    'STUDIO_PORT=5283',
    'GPT_MODE=browser',
    'GEMINI_MODE=browser',
    'CLAUDE_MODE=browser',
    'AIMODE_MODE=browser',
    'GATEWAY_BROWSER_CHANNEL=auto',
    "GATEWAY_DATA_DIR=$root\data",
    'REQUEST_TIMEOUT_MS=240000'
  ) | Set-Content -LiteralPath $envFile -Encoding Ascii
}
if(!(Get-Command node -ErrorAction SilentlyContinue)){
  Write-Host 'Node.js 22+ is required: https://nodejs.org/en/download' -ForegroundColor Yellow
  throw 'Node.js not installed'
}
if(!(Get-Command npm -ErrorAction SilentlyContinue)){throw 'npm is unavailable; install Node.js 22+'}
 $env:ORBIT_WARM_TABS='1'
Set-Location $root
if(!(Test-Path (Join-Path $root 'node_modules\playwright'))){
 npm install --no-audit --no-fund
 if($LASTEXITCODE -ne 0){throw 'npm install failed'}
}
$installedMarker=Join-Path $root 'data\playwright-browser-ready.txt'
if(!(Test-Path $installedMarker)){
 Write-Host 'Installing Chromium for first launch (this may download browser components)...'
 npx playwright install chromium
 if($LASTEXITCODE -ne 0){throw 'Chromium browser installation failed'}
 New-Item -ItemType Directory -Force -Path (Join-Path $root 'data') | Out-Null
 Set-Content -LiteralPath $installedMarker -Value 'Installed via npx playwright install chromium' -Encoding ASCII
}Write-Host 'Orbit Windows v2.3.1 Preview - Studio http://127.0.0.1:5283'
node src/server.mjs