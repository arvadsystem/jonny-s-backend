$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Ejecute PowerShell como administrador.' }
$agentRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20 o superior no esta instalado.' }
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw 'Se requiere Node.js 20 o superior.' }
if (-not (Test-Path (Join-Path $agentRoot '.env'))) { throw 'Falta print-agent\.env. Copie .env.example y configure valores reales fuera de Git.' }
$qzProcess = Get-Process -Name qz-tray -ErrorAction SilentlyContinue
if (-not $qzProcess) { Write-Warning 'QZ Tray no esta ejecutandose. El servicio se instalara, pero no imprimira hasta que QZ Tray este activo.' }
Push-Location $agentRoot
try { npm.cmd install --omit=dev; npm.cmd run service:install } finally { Pop-Location }
