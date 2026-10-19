$ErrorActionPreference = 'Ignore'

Uninstall-BinFile -Name 'downloadx'
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Remove-Item "$toolsDir\downloadX.exe" -Force -ErrorAction SilentlyContinue
