$ErrorActionPreference='Stop'
$ts=Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if(!(Test-Path $ts)){throw 'Tailscale executable missing'}
& $ts serve --https=443 off
if($LASTEXITCODE -ne 0){Write-Warning 'Studio route may already be disabled'}
& $ts serve --https=8443 off
if($LASTEXITCODE -ne 0){Write-Warning 'Optional API route may already be disabled'}
& $ts serve status
Write-Host 'Orbit remote routes disabled. Local Studio and API are unchanged.'
