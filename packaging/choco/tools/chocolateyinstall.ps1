$ErrorActionPreference = 'Stop'

$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$url      = 'https://github.com/shashankh3/downloadX/releases/download/v1.5.0/downloadX.exe'
$checksum = 'A488B2611127D598C524E012E680F08A2D45E1E77D31E0B1BBFDA201866BC838'

Get-ChocolateyWebFile -PackageName 'downloadx' -FileFullPath "$toolsDir\downloadX.exe" `
  -Url $url -Checksum $checksum -ChecksumType 'sha256'

Install-BinFile -Name 'downloadx' -Path "$toolsDir\downloadX.exe"
