$ErrorActionPreference = 'Stop'

$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$url      = 'https://github.com/shashankh3/downloadX/releases/download/v1.3.0/downloadX.exe'
$checksum = 'DAD08ACC2AF269BE9941DBADDD0509DBF2C3B888C29FF89730EE424EDDF487E5'

Get-ChocolateyWebFile -PackageName 'downloadx' -FileFullPath "$toolsDir\downloadX.exe" `
  -Url $url -Checksum $checksum -ChecksumType 'sha256'

Install-BinFile -Name 'downloadx' -Path "$toolsDir\downloadX.exe"
