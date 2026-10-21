$ErrorActionPreference = 'Stop'

$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$url      = 'https://github.com/shashankh3/downloadX/releases/download/v1.4.0/downloadX.exe'
$checksum = '4DBF48C26199DDF1B90F737760A2E29F1FE3F14E9AE53114B45EE4DECB1DA1D8'

Get-ChocolateyWebFile -PackageName 'downloadx' -FileFullPath "$toolsDir\downloadX.exe" `
  -Url $url -Checksum $checksum -ChecksumType 'sha256'

Install-BinFile -Name 'downloadx' -Path "$toolsDir\downloadX.exe"
