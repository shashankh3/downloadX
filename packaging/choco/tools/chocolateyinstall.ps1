$ErrorActionPreference = 'Stop'

$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$url      = 'https://github.com/shashankh3/downloadX/releases/download/v1.4.0/downloadX.exe'
$checksum = 'EBE011C900E97EF0387344C854FBA31549E284B10789CD63C40050FB280DAA77'

Get-ChocolateyWebFile -PackageName 'downloadx' -FileFullPath "$toolsDir\downloadX.exe" `
  -Url $url -Checksum $checksum -ChecksumType 'sha256'

Install-BinFile -Name 'downloadx' -Path "$toolsDir\downloadX.exe"
