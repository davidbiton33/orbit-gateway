# Creates a brand-new self-contained copy, new Compose project, empty volumes, and independent ports.
# NEVER deletes/changes the existing installation or Docker volumes.
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$parent=Split-Path -Parent $root
$id=[guid]::NewGuid().ToString('N').Substring(0,8)
$destination=Join-Path $parent "Orbit-Clean-Test-$id"
New-Item -ItemType Directory -Path $destination -ErrorAction Stop | Out-Null
foreach ($file in @('.dockerignore','.env.example','.gitignore','docker-compose.yml','docker.ps1','tailscale-api.ps1','setup-docker.ps1','switch-gpt.ps1','start-clean-test.ps1','verify-clean.ps1','smoke-docker.ps1','package.json','INSTALL_HE.md','README.md','README_HE.md','SECURITY.md','PUBLISHING_HE.md','QA_RELEASE_HE.md','SHA256SUMS.txt')) {
  $src=Join-Path $root $file
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $destination $file) -Force }
}
foreach ($folder in @('bin','config','docker','docs','examples','legacy-gpt','public','scripts','skill','src','tests')) {
  Copy-Item -LiteralPath (Join-Path $root $folder) -Destination $destination -Recurse -Force
}
if (Test-Path (Join-Path $destination '.env.docker')) { throw 'Safety check failed: clean folder has a prior configuration.' }
Write-Host "Created independent copy: $destination" -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $destination 'setup-docker.ps1') -CleanTest
if ($LASTEXITCODE -ne 0) { throw "Clean install failed. Files kept at: $destination" }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $destination 'verify-clean.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Clean installation isolation verification failed.' }
Write-Host "Clean test directory: $destination" -ForegroundColor Green
Write-Host 'IMPORTANT: Open a NEW PowerShell inside the printed Clean test directory for ALL commands (docker.ps1, login, Tailscale). Do not run them from the release source folder.' -ForegroundColor Yellow
Write-Host ('Example: Set-Location -LiteralPath "' + $destination + '"')
Write-Host 'Keep this directory to manage or stop THIS clean instance.'
