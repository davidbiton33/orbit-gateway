# Non-destructive: verifies that active services and volumes belong to this new project.
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$file=Join-Path $root '.env.docker'
if (-not (Test-Path $file)) { throw 'No .env.docker: setup was not run.' }
$props=@{}
Get-Content $file | ForEach-Object { if ($_ -match '^([A-Z_]+)=(.*)$') { $props[$Matches[1]]=$Matches[2] } }
$project=$props['COMPOSE_PROJECT_NAME']
if ($project -notmatch '^orbit-(?:gateway|clean)-[a-f0-9]{10}$') { throw 'Project identity missing/invalid.' }
if ($project -match '^orbit-clean-') {
  $marker=Join-Path $root '.orbit-clean-install'
  if (-not (Test-Path -LiteralPath $marker)) { throw 'Missing clean-install marker.' }
  if ((Get-Content $marker -Raw).Trim() -ne $project) { throw 'Clean-install marker does not match project.' }
}
$backend=$props['GPT_BACKEND']
$required=@('gateway','gemini', $(if ($backend -eq 'legacy') { 'gpt-legacy' } else { 'gpt' }))
foreach ($service in $required) {
  $id=& docker compose --env-file .env.docker -f docker-compose.yml --profile gpt-docker --profile gpt-legacy ps -q $service
  if ($LASTEXITCODE -ne 0 -or -not "$id".Trim()) { throw "Missing running service: $service" }
  $id="$id".Trim()
  $info = @(& docker inspect $id | ConvertFrom-Json)[0]
  if ($LASTEXITCODE -ne 0) { throw "Failed inspecting $service" }
  $owner = $info.Config.Labels.'com.docker.compose.project'
  if ($owner -ne $project) { throw "$service unexpectedly belongs to $owner (expected $project)" }
  foreach ($mount in @($info.Mounts)) {
    if ($mount.Type -ne 'volume') { throw "$service mounts an unexpected bind filesystem path. NOT ISOLATED." }
    if (-not $mount.Name.StartsWith("${project}_")) { throw "$service mounts foreign volume $($mount.Name). NOT ISOLATED." }
  }
  Write-Host "PASS $service : own container + dedicated profile volume(s)" -ForegroundColor Green
}
Write-Host "PASS isolated Docker project: $project" -ForegroundColor Green
Write-Host 'Important: isolated credentials are confirmed by using a new profile volume, NOT by automatically proving remote sign-in state.'
