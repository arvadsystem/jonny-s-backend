$agentRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$daemonLogs = Join-Path $agentRoot 'daemon'
if (-not (Test-Path $daemonLogs)) { Write-Output 'Aun no hay logs del servicio.'; exit 0 }
Get-ChildItem -LiteralPath $daemonLogs -File | Sort-Object LastWriteTime -Descending | Select-Object -First 5 FullName,LastWriteTime,Length
