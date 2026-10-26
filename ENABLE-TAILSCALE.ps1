param([switch]$ExposeApi)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile=Join-Path $root '.env'
if(!(Test-Path $envFile)){throw 'First run START-WINDOWS-V2.3.1.ps1 to create .env, then restart Orbit.'}
$ts=Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if(!(Test-Path $ts)){throw 'Install Tailscale: winget install --id Tailscale.Tailscale --exact'}
$status=(& $ts status --json | ConvertFrom-Json)
if($LASTEXITCODE -ne 0 -or $status.BackendState -ne 'Running'){throw 'Tailscale is not connected. Open Tailscale and sign in.'}
$dns=([string]$status.Self.DNSName).TrimEnd('.').ToLowerInvariant()
if($dns -notmatch '^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$'){throw "Invalid Tailscale hostname: $dns"}
$current=[IO.File]::ReadAllText($envFile)
if($current -match '(?m)^ORBIT_REMOTE_STUDIO_HOST='){
 $current=[regex]::Replace($current,'(?m)^ORBIT_REMOTE_STUDIO_HOST=.*$',"ORBIT_REMOTE_STUDIO_HOST=$dns")
}else{
 $current=$current.TrimEnd([char]13,[char]10)+[Environment]::NewLine+"ORBIT_REMOTE_STUDIO_HOST=$dns"+[Environment]::NewLine
}
[IO.File]::WriteAllText($envFile,$current,[Text.UTF8Encoding]::new($false))
Write-Host "Configured private Studio host: $dns" -ForegroundColor Cyan
# Never use Tailscale Funnel; Serve is only for the private tailnet.
& $ts serve --bg --https=443 http://127.0.0.1:5283
if($LASTEXITCODE -ne 0){throw 'Studio Serve failed. Enable HTTPS certificates in Tailscale admin settings.'}
if($ExposeApi){
 & $ts serve --bg --https=8443 http://127.0.0.1:5284
 if($LASTEXITCODE -ne 0){throw 'Studio may work; API Serve on port 8443 failed.'}
}
& $ts serve status
Write-Host ('STUDIO: https://'+$dns+'/') -ForegroundColor Green
if($ExposeApi){Write-Host ('API: https://'+$dns+':8443/v1 (Bearer token REQUIRED)') -ForegroundColor Yellow}
Write-Host 'IMPORTANT: Restart the Orbit PowerShell process to load ORBIT_REMOTE_STUDIO_HOST.' -ForegroundColor Yellow
Write-Host 'Authorized devices in your tailnet can reach Studio. Restrict tailnet ACL/grants.'
