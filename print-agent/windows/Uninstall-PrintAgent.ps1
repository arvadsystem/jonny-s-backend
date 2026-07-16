$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Ejecute PowerShell como administrador.' }
$agentRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $agentRoot
try { npm.cmd run service:uninstall } finally { Pop-Location }
