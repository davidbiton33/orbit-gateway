# Send first and continued message to selected Docker providers. No automatic retry.
param([ValidateSet('all','gpt','gemini','claude')][string]$Provider='all')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath=Join-Path $root '.env.docker'
if (-not (Test-Path $envPath)) { throw 'Run setup-docker.ps1 first.' }
$match=Select-String -Path $envPath -Pattern '^GATEWAY_TOKEN=(.+)$' | Select-Object -First 1
if (-not $match) { throw 'GATEWAY_TOKEN missing in .env.docker' }
$token=$match.Matches[0].Groups[1].Value.Trim()
$headers=@{ Authorization="Bearer $token"; 'Content-Type'='application/json' }
$api=Select-String -Path $envPath -Pattern '^ORBIT_API_PORT=(\d+)$' | Select-Object -First 1
if (-not $api) { throw 'ORBIT_API_PORT missing in .env.docker' }
$base='http://127.0.0.1:'+$api.Matches[0].Groups[1].Value+'/v1/chat/completions'
function Get-OrbitErrorDetail($record) {
  if ($record.ErrorDetails -and $record.ErrorDetails.Message) { return $record.ErrorDetails.Message }
  try {
    $response = $record.Exception.Response
    if ($null -ne $response) {
      $stream = $response.GetResponseStream()
      if ($null -ne $stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        $body = $reader.ReadToEnd()
        if ($body) { return $body }
      }
    }
  } catch {}
  return $record.Exception.Message
}
$failures=0
$providers=if ($Provider -eq 'all') {@('gpt','gemini','claude')} else {@($Provider)}
foreach ($p in $providers) {
  Write-Host "Checking ${p}: first message + continuation" -ForegroundColor Cyan
  $conversationId=$null
  foreach ($iteration in @(1,2)) {
    $body=@{ model=$p; messages=@(@{role='user';content="Orbit Docker check ${iteration}: reply with just the word OK."});stream=$false }
    if ($conversationId) { $body['conversation_id']=$conversationId }
    try {
      $result=Invoke-RestMethod -Uri $base -Method Post -Headers $headers -Body ($body | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec 150
      $answer=[string]$result.choices[0].message.content
      if ([string]::IsNullOrWhiteSpace($answer)) { throw 'Empty response' }
      if (-not $result.conversation_id) { throw 'No conversation_id from provider' }
      if ($iteration -eq 2 -and $result.conversation_id -ne $conversationId) { throw 'conversation_id changed during continuation' }
      $conversationId=[string]$result.conversation_id
      Write-Host "  Message $iteration OK; response length=$($answer.Length) chars" -ForegroundColor Green
    } catch {
      $failures++
      $detail=Get-OrbitErrorDetail $_
      Write-Warning "${p} iteration $iteration failed: $detail"
      Write-Host 'The prompt might already have been submitted. No automatic retry.' -ForegroundColor Yellow
      break
    }
  }
}
if ($failures) { Write-Host "$failures failed check(s); see: docker compose logs --tail=100 gpt" -ForegroundColor Yellow; exit 1 }
Write-Host 'Selected Docker workers passed first-message and continuation checks.' -ForegroundColor Green
