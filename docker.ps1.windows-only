param([Parameter(ValueFromRemainingArguments=$true)][string[]]$DockerArgs)
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
if (-not (Test-Path '.env.docker')) { throw 'Run .\setup-docker.ps1 first.' }
& docker compose --env-file .env.docker -f docker-compose.yml @DockerArgs
exit $LASTEXITCODE
