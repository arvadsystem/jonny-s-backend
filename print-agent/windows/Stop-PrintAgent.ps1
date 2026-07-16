$ErrorActionPreference = 'Stop'
Stop-Service -Name 'Jonnys Branch Print Agent'
Get-Service -Name 'Jonnys Branch Print Agent'
