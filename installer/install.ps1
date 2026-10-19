[CmdletBinding()]
param(
  [switch]$AllUsers,
  [switch]$NoAutostart,
  [switch]$NoExtension,
  [switch]$InstallNode,
  [switch]$Force,
  [switch]$ForceExtensionPolicy,
  [switch]$NoShortcuts,
  [switch]$NoLaunch,
  [switch]$DryRun,
  [string]$InstallDir = '',
  [string]$DataDir = '',
  [string]$RegistryBase = '',
  [ValidateSet('auto', 'store', 'selfhosted', 'manual')]
  [string]$ExtensionMode = 'auto',
  [string]$ChromeStoreId = '',
  [string]$EdgeStoreId = '',
  [string]$FirefoxId = 'downloadx@local',
  [string]$FirefoxInstallUrl = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Version = '1.2.0'
try {
  $pkg = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
  if ($pkg.version) { $Version = [string]$pkg.version }
} catch { }

$Config = $null
try {
  $Config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
} catch { }

if ($Config) {
  if (-not $PSBoundParameters.ContainsKey('AllUsers') -and $Config.install -and $Config.install.allUsers) { $AllUsers = [bool]$Config.install.allUsers }
  if (-not $PSBoundParameters.ContainsKey('NoAutostart') -and $Config.install -and $Config.install.autostart -eq $false) { $NoAutostart = $true }
  if (-not $PSBoundParameters.ContainsKey('InstallNode') -and $Config.install -and $Config.install.installNode) { $InstallNode = $true }
  if ($Config.extension) {
    if (-not $PSBoundParameters.ContainsKey('ExtensionMode') -and $Config.extension.mode) { $ExtensionMode = [string]$Config.extension.mode }
    if (-not $PSBoundParameters.ContainsKey('ChromeStoreId') -and $Config.extension.chromeStoreId) { $ChromeStoreId = [string]$Config.extension.chromeStoreId }
    if (-not $PSBoundParameters.ContainsKey('EdgeStoreId') -and $Config.extension.edgeStoreId) { $EdgeStoreId = [string]$Config.extension.edgeStoreId }
    if (-not $PSBoundParameters.ContainsKey('FirefoxId') -and $Config.extension.firefoxAddonId) { $FirefoxId = [string]$Config.extension.firefoxAddonId }
    if (-not $PSBoundParameters.ContainsKey('FirefoxInstallUrl') -and $Config.extension.firefoxInstallUrl) { $FirefoxInstallUrl = [string]$Config.extension.firefoxInstallUrl }
  }
}

if ($ChromeStoreId) {
  $ChromeStoreId = $ChromeStoreId.Trim().ToLowerInvariant()
  if ($ChromeStoreId -notmatch '^[a-p]{32}$') { throw 'ChromeStoreId must be a 32-character Chrome Web Store extension ID (a-p).' }
}
if ($EdgeStoreId) {
  $EdgeStoreId = $EdgeStoreId.Trim().ToLowerInvariant()
  if ($EdgeStoreId -notmatch '^[a-p]{32}$') { throw 'EdgeStoreId must be a 32-character Edge Add-ons extension ID (a-p).' }
}
if ($FirefoxId -and $FirefoxId -match '[\s;]') { throw 'FirefoxId must not contain whitespace or semicolons.' }
if ($FirefoxInstallUrl -and $FirefoxInstallUrl -notmatch '^https://') { throw 'FirefoxInstallUrl must be an https:// URL.' }

function Write-Plan([string]$Text) { Write-Host "  [dry-run] $Text" }
function Write-Step([string]$Text) { Write-Host "  $Text" }

function Test-Admin {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

function Test-TcpPortFree([int]$Port) {
  $listener = $null
  try {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) { try { $listener.Stop() } catch { } }
  }
}

function Get-NodeMajor([string]$Path) {
  if (-not $Path) { return 0 }
  try {
    $text = (& $Path --version 2>$null | Out-String).Trim()
    if ($text -match '^v?(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return 0
}

function Find-Node {
  $candidates = New-Object System.Collections.ArrayList
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { [void]$candidates.Add($cmd.Source) }
  foreach ($candidate in @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { [void]$candidates.Add($candidate) }
  }
  $seen = @{}
  $oldest = $null
  foreach ($candidate in $candidates) {
    $key = ([IO.Path]::GetFullPath($candidate)).ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    if (-not $oldest) { $oldest = $candidate }
    if ((Get-NodeMajor $candidate) -ge 18) { return $candidate }
  }
  return $oldest
}

if (-not $InstallDir) {
  $baseDir = if ($AllUsers) { $env:ProgramFiles } else { Join-Path $env:LOCALAPPDATA 'Programs' }
  $InstallDir = Join-Path $baseDir 'downloadX'
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if ($InstallDir -match '^[A-Za-z]:$') { throw 'Refusing to install into a drive root. Choose a folder such as C:\Program Files\downloadX.' }

if (-not $DryRun -and (Test-Path -LiteralPath $InstallDir) -and -not (Test-Path -LiteralPath (Join-Path $InstallDir 'install.json')) -and -not $Force) {
  $existing = @(Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue)
  if ($existing.Count) {
    throw "$InstallDir already exists and is not a downloadX install. Use -Force to overwrite it or choose another -InstallDir."
  }
}

$ExplicitDataDir = $PSBoundParameters.ContainsKey('DataDir') -and -not [string]::IsNullOrWhiteSpace($DataDir)
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'downloadX\data' }
$DataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
if ($DataDir -match '^[A-Za-z]:$') { throw 'Refusing to use a drive root as the data directory.' }
$PerUserData = [bool]($AllUsers -and -not $ExplicitDataDir)
$ServerPort = 9765

$KeyDir = if ($AllUsers) { Join-Path $env:ProgramData 'downloadX' } else { Join-Path $env:LOCALAPPDATA 'downloadX' }
$KeyFile = Join-Path $KeyDir 'extension-key.pem'
$Backend = if ($RegistryBase) { $RegistryBase.TrimEnd('\') } else { if ($AllUsers) { 'HKLM:' } else { 'HKCU:' } }
$IsAdmin = Test-Admin
$DomainJoined = $false
try { $DomainJoined = [bool](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).PartOfDomain } catch { }

if ($AllUsers -and -not $IsAdmin) {
  if ($DryRun) {
    Write-Warning 'A per-machine install needs an elevated PowerShell window; this dry run is illustrative only.'
  } else {
    throw 'A per-machine install (AllUsers) needs an elevated PowerShell window. Run install.bat as administrator or use the default per-user install.'
  }
}

Write-Host ''
Write-Host "  downloadX $Version installer"
Write-Host "  ----------------------------------------"
Write-Host "  Install dir : $InstallDir"
Write-Host "  Data dir    : $DataDir"
Write-Host "  Scope       : $(if ($AllUsers) { 'all users' } else { 'current user' })"
Write-Host "  Extension   : $ExtensionMode$(if ($NoExtension) { ' (disabled)' } else { '' })"
Write-Host ''

$Node = Find-Node
$NodeMajor = if ($Node) { Get-NodeMajor $Node } else { 0 }
if (-not $Node -or $NodeMajor -lt 18) {
  if ($DryRun) {
    if ($Node) { Write-Plan "Node.js $NodeMajor is too old - would install OpenJS.NodeJS.LTS with winget" }
    else { Write-Plan 'Node.js not found - would install OpenJS.NodeJS.LTS with winget' }
  } elseif ($InstallNode) {
    if ($Node) { Write-Step "Node.js $NodeMajor is too old - installing LTS with winget..." }
    else { Write-Step 'Node.js not found - installing LTS with winget...' }
    $wingetArgs = @('install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements')
    if ($Node) { $wingetArgs += '--force' }
    try { & winget @wingetArgs } catch { throw 'winget could not install Node.js. Install Node.js 18+ from https://nodejs.org and run install.bat again.' }
    if ($LASTEXITCODE -ne 0) { throw 'winget could not install Node.js. Install Node.js 18+ from https://nodejs.org and run install.bat again.' }
    $Node = Find-Node
    $NodeMajor = if ($Node) { Get-NodeMajor $Node } else { 0 }
  }
  if (-not $DryRun -and (-not $Node -or $NodeMajor -lt 18)) {
    throw 'Node.js 18+ was not found. Install it from https://nodejs.org or run: install.bat -InstallNode'
  }
}

function Stop-RunningServer {
  $ports = @()
  $portFile = Join-Path $DataDir 'port'
  if (Test-Path -LiteralPath $portFile) {
    $saved = 0
    if ([int]::TryParse((Get-Content -LiteralPath $portFile -Raw).Trim(), [ref]$saved) -and $saved -gt 0) { $ports += $saved }
  }
  foreach ($p in 9765..9775) { if ($ports -notcontains $p) { $ports += $p } }
  foreach ($p in $ports) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$p/api/health" -TimeoutSec 1
      if ($health -and $health.ok) {
        if ($DryRun) { Write-Plan "would stop running instance on port $p"; return }
        Write-Step "Stopping running downloadX on port $p..."
        try { Invoke-RestMethod -Uri "http://127.0.0.1:$p/api/quit" -Method Post -TimeoutSec 3 | Out-Null } catch { }
        Start-Sleep -Milliseconds 600
        return
      }
    } catch { }
  }
}

Stop-RunningServer

if (-not $DryRun) {
  $freePort = 0
  for ($p = 9765; $p -le 9775; $p++) {
    if (Test-TcpPortFree $p) { $freePort = $p; break }
  }
  if (-not $freePort) { throw 'No free local port in the range 9765-9775. Close the application using one of those ports and try again.' }
  $ServerPort = $freePort
  if ($ServerPort -ne 9765) { Write-Step "Port 9765 is busy - downloadX will use $ServerPort." }
}

$sameDir = $InstallDir.TrimEnd('\') -ieq $ProjectRoot.TrimEnd('\')
if ($sameDir) {
  Write-Step 'Source and install directory are the same - skipping file copy.'
} else {
  if ($DryRun) {
    Write-Plan "would copy application files to $InstallDir"
  } else {
    Write-Step 'Copying application files...'
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    foreach ($item in @('server.js', 'package.json', 'README.md', 'lib', 'public', 'native', 'extension')) {
      $source = Join-Path $ProjectRoot $item
      if (-not (Test-Path -LiteralPath $source)) { throw "Missing application file: $source" }
      $dest = Join-Path $InstallDir $item
      if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).PSIsContainer) {
        Remove-Item -LiteralPath $dest -Recurse -Force
      }
      Copy-Item -LiteralPath $source -Destination $dest -Recurse -Force
    }
    foreach ($item in @('install.bat', 'uninstall.bat')) {
      $source = Join-Path $ProjectRoot $item
      if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $InstallDir $item) -Force }
    }
    $toolDir = Join-Path $InstallDir 'installer'
    New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
    foreach ($item in @('config.json', 'crx.js', 'extension-tools.js', 'prepare-extension.mjs', 'install.ps1', 'uninstall.ps1')) {
      $source = Join-Path $PSScriptRoot $item
      if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $toolDir $item) -Force }
    }
  }
}

$installJson = [ordered]@{
  version   = $Version
  installDir = $InstallDir
  dataDir   = $DataDir
  perUserData = $PerUserData
  host      = '127.0.0.1'
  port      = $ServerPort
  node      = $Node
  extension = [ordered]@{
    mode = $ExtensionMode
    id = ''
    firefoxId = $FirefoxId
    chromeStoreId = $ChromeStoreId
    edgeStoreId = $EdgeStoreId
    firefoxInstallUrl = $FirefoxInstallUrl
  }
}

if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  New-Item -ItemType Directory -Force -Path $KeyDir | Out-Null
  Write-Step 'Writing launchers...'
  $dataForBat = if ($PerUserData) { '%LOCALAPPDATA%\downloadX\data' } else { $DataDir.Replace('%', '%%') }
  $cmd = @(
    '@echo off',
    'setlocal',
    ('set "DLX_DATA_DIR=' + $dataForBat + '"'),
    'set "DLX_HOST=127.0.0.1"',
    ('set "DLX_PORT=' + $ServerPort + '"'),
    'set "DLX_OPEN=1"',
    ('"' + $Node + '" "%~dp0server.js" %*'),
    ''
  ) -join "`r`n"
  [IO.File]::WriteAllText((Join-Path $InstallDir 'downloadX.cmd'), $cmd, [Text.Encoding]::Default)

  $vbsData = $DataDir.Replace('"', '""')
  $vbsNode = $Node.Replace('"', '""')
  $vbsServer = (Join-Path $InstallDir 'server.js').Replace('"', '""')
  $vbsDataLine = if ($PerUserData) {
    'sh.Environment("PROCESS")("DLX_DATA_DIR") = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\downloadX\data")'
  } else {
    'sh.Environment("PROCESS")("DLX_DATA_DIR") = "' + $vbsData + '"'
  }
  $vbsLaunch = @(
    'Option Explicit',
    'Dim sh, cmd',
    'Set sh = CreateObject("WScript.Shell")',
    $vbsDataLine,
    'sh.Environment("PROCESS")("DLX_HOST") = "127.0.0.1"',
    ('sh.Environment("PROCESS")("DLX_PORT") = "' + $ServerPort + '"')
  )
  $vbsRun = @(
    ('cmd = """' + $vbsNode + '"" ""' + $vbsServer + '"""'),
    'sh.Run cmd, 0, False',
    ''
  )
  $vbsEncoding = New-Object -TypeName System.Text.UnicodeEncoding -ArgumentList $false, $true
  $silent = (($vbsLaunch + $vbsRun) -join "`r`n")
  [IO.File]::WriteAllText((Join-Path $InstallDir 'downloadX-silent.vbs'), $silent, $vbsEncoding)

  $opened = ((@($vbsLaunch + @('sh.Environment("PROCESS")("DLX_OPEN") = "1"') + $vbsRun)) -join "`r`n")
  [IO.File]::WriteAllText((Join-Path $InstallDir 'downloadX-start.vbs'), $opened, $vbsEncoding)

  $protoNode = $Node.Replace('"', '""')
  $protoScript = (Join-Path $InstallDir 'lib\protocol.js').Replace('"', '""')
  $proto = @(
    'Option Explicit',
    'Dim sh, cmd, arg',
    'If WScript.Arguments.Count = 0 Then WScript.Quit 1',
    'arg = WScript.Arguments(0)',
    'If Len(arg) > 4096 Then WScript.Quit 1',
    'If InStr(arg, Chr(34)) > 0 Or InStr(arg, vbCr) > 0 Or InStr(arg, vbLf) > 0 Or InStr(arg, Chr(0)) > 0 Then WScript.Quit 1',
    'Set sh = CreateObject("WScript.Shell")',
    ('cmd = """' + $protoNode + '"" ""' + $protoScript + '"" """ & arg & """"'),
    'sh.Run cmd, 0, False',
    ''
  ) -join "`r`n"
  [IO.File]::WriteAllText((Join-Path $InstallDir 'downloadx-protocol.vbs'), $proto, $vbsEncoding)

  [IO.File]::WriteAllText((Join-Path $InstallDir 'install.json'), ($installJson | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
} else {
  Write-Plan "would write downloadX.cmd, downloadX-silent.vbs, downloadX-start.vbs, downloadx-protocol.vbs and install.json"
}

$ExtInfo = $null
if (-not $NoExtension) {
  $prepare = Join-Path $InstallDir 'installer\prepare-extension.mjs'
  if ($DryRun) {
    Write-Plan "would build the extension in $InstallDir\extension (key: $KeyFile)"
  } else {
    Write-Step 'Building Chrome and Firefox extension packages...'
    $out = & $Node $prepare --root $InstallDir --out (Join-Path $InstallDir 'extension') --key $KeyFile --version $Version --firefox-id $FirefoxId --codebase ('http://127.0.0.1:' + $ServerPort + '/ext/downloadx.crx') 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('Extension build failed: ' + ($out | Out-String)) }
    $ExtInfo = (($out | Out-String).Trim() | ConvertFrom-Json)
    $installJson.extension.id = [string]$ExtInfo.id
    $installJson.extension.mode = [string]$ExtensionMode
    [IO.File]::WriteAllText((Join-Path $InstallDir 'install.json'), ($installJson | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
  }
}

$ExtId = if ($ExtInfo) { [string]$ExtInfo.id } else { '' }

if (-not $NoExtension -and -not $DryRun) {
  $origins = New-Object System.Collections.ArrayList
  if ($ExtId) { [void]$origins.Add("chrome-extension://$ExtId/") }
  if ($ChromeStoreId) { [void]$origins.Add("chrome-extension://$ChromeStoreId/") }
  if ($EdgeStoreId -and $EdgeStoreId -ne $ChromeStoreId) { [void]$origins.Add("chrome-extension://$EdgeStoreId/") }

  $shim = Join-Path $InstallDir 'downloadX-native-host.exe'
  $NativeReady = $false
  if ($origins.Count -gt 0 -or $FirefoxId) {
    try {
      if (Test-Path -LiteralPath $shim) { Remove-Item -LiteralPath $shim -Force -ErrorAction SilentlyContinue }
      Add-Type -Path (Join-Path $InstallDir 'native\host.cs') -OutputAssembly $shim -OutputType ConsoleApplication
      if (-not (Test-Path -LiteralPath $shim)) { throw 'compiler produced no executable' }
      $NativeReady = $true
    } catch {
      Write-Warning ('Could not compile the native messaging host: ' + $_.Exception.Message)
    }
  }

  if ($NativeReady) {
    Write-Step 'Registering native messaging host...'
    $nativeDir = Join-Path $InstallDir 'native'
    New-Item -ItemType Directory -Force -Path $nativeDir | Out-Null
    $chromeHostFile = Join-Path $nativeDir 'com.downloadx.host.json'
    $firefoxHostFile = Join-Path $nativeDir 'com.downloadx.host.firefox.json'
    if ($origins.Count -gt 0) {
      $chromeHost = [ordered]@{
        name = 'com.downloadx.host'
        description = 'downloadX native messaging host'
        path = $shim
        type = 'stdio'
        allowed_origins = @($origins)
      }
      [IO.File]::WriteAllText($chromeHostFile, ($chromeHost | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
      foreach ($vendor in @('Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser', 'Chromium')) {
        $key = "$Backend\Software\$vendor\NativeMessagingHosts\com.downloadx.host"
        New-Item -Path $key -Force | Out-Null
        Set-ItemProperty -Path $key -Name '(default)' -Value $chromeHostFile
      }
    }
    if ($FirefoxId) {
      $firefoxHost = [ordered]@{
        name = 'com.downloadx.host'
        description = 'downloadX native messaging host'
        path = $shim
        type = 'stdio'
        allowed_extensions = @($FirefoxId)
      }
      [IO.File]::WriteAllText($firefoxHostFile, ($firefoxHost | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
      $firefoxKey = "$Backend\Software\Mozilla\NativeMessagingHosts\com.downloadx.host"
      New-Item -Path $firefoxKey -Force | Out-Null
      Set-ItemProperty -Path $firefoxKey -Name '(default)' -Value $firefoxHostFile
    }
  } else {
    Write-Warning 'Native messaging is unavailable; the extension will still work while downloadX is running.'
    foreach ($vendor in @('Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser', 'Chromium', 'Mozilla')) {
      $key = "$Backend\Software\$vendor\NativeMessagingHosts\com.downloadx.host"
      Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
} elseif ($DryRun -and -not $NoExtension) {
  Write-Plan 'would compile the native messaging host and register it for Chrome, Edge, Brave, Chromium and Firefox'
}

if (-not $NoShortcuts -and -not $DryRun) {
  Write-Step 'Creating shortcuts...'
  $ws = New-Object -ComObject WScript.Shell
  $startMenu = if ($AllUsers) { Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs' } else { Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
  New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
  $launcher = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $lnk = $ws.CreateShortcut((Join-Path $startMenu 'downloadX.lnk'))
  $lnk.TargetPath = $launcher
  $lnk.Arguments = '"' + (Join-Path $InstallDir 'downloadX-start.vbs') + '"'
  $lnk.WorkingDirectory = $InstallDir
  $lnk.Description = 'downloadX download manager'
  $lnk.Save()

  $desktop = if ($AllUsers) { Join-Path $env:PUBLIC 'Desktop' } else { [Environment]::GetFolderPath('Desktop') }
  if (Test-Path -LiteralPath $desktop) {
    $lnk2 = $ws.CreateShortcut((Join-Path $desktop 'downloadX.lnk'))
    $lnk2.TargetPath = $launcher
    $lnk2.Arguments = '"' + (Join-Path $InstallDir 'downloadX-start.vbs') + '"'
    $lnk2.WorkingDirectory = $InstallDir
    $lnk2.Description = 'downloadX download manager'
    $lnk2.Save()
  }
} elseif (-not $NoShortcuts) {
  Write-Plan 'would create Start Menu and Desktop shortcuts'
}

if (-not $DryRun) {
  $runKey = "$Backend\Software\Microsoft\Windows\CurrentVersion\Run"
  if ($NoAutostart) {
    Remove-ItemProperty -Path $runKey -Name 'downloadX' -ErrorAction SilentlyContinue
    Write-Step 'Autostart disabled.'
  } else {
    New-Item -Path $runKey -Force | Out-Null
    $runValue = '"' + (Join-Path $env:SystemRoot 'System32\wscript.exe') + '" "' + (Join-Path $InstallDir 'downloadX-silent.vbs') + '"'
    Set-ItemProperty -Path $runKey -Name 'downloadX' -Value $runValue
    Write-Step 'Autostart enabled.'
  }

  Write-Step 'Registering downloadx:// protocol...'
  $protoKey = "$Backend\Software\Classes\downloadx"
  New-Item -Path $protoKey -Force | Out-Null
  Set-ItemProperty -Path $protoKey -Name '(default)' -Value 'URL:downloadX Protocol'
  Set-ItemProperty -Path $protoKey -Name 'URL Protocol' -Value ''
  $protoCmd = "$Backend\Software\Classes\downloadx\shell\open\command"
  New-Item -Path $protoCmd -Force | Out-Null
  $protoValue = '"' + (Join-Path $env:SystemRoot 'System32\wscript.exe') + '" "' + (Join-Path $InstallDir 'downloadx-protocol.vbs') + '" "%1"'
  Set-ItemProperty -Path $protoCmd -Name '(default)' -Value $protoValue

  Write-Step 'Writing uninstall information...'
  $uninstallKey = "$Backend\Software\Microsoft\Windows\CurrentVersion\Uninstall\downloadX"
  New-Item -Path $uninstallKey -Force | Out-Null
  $uninstallArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDir 'installer\uninstall.ps1') + '" -InstallDir "' + $InstallDir + '" -DataDir "' + $DataDir + '"'
  if ($AllUsers) { $uninstallArgs += ' -AllUsers' }
  $size = 0
  try { $size = [int](((Get-ChildItem -LiteralPath $InstallDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum) / 1KB) } catch { }
  Set-ItemProperty -Path $uninstallKey -Name 'DisplayName' -Value 'downloadX'
  Set-ItemProperty -Path $uninstallKey -Name 'DisplayVersion' -Value $Version
  Set-ItemProperty -Path $uninstallKey -Name 'Publisher' -Value 'downloadX'
  Set-ItemProperty -Path $uninstallKey -Name 'InstallLocation' -Value $InstallDir
  $iconPath = Join-Path $InstallDir 'downloadX-native-host.exe'
  if (Test-Path -LiteralPath $iconPath) { Set-ItemProperty -Path $uninstallKey -Name 'DisplayIcon' -Value $iconPath }
  Set-ItemProperty -Path $uninstallKey -Name 'UninstallString' -Value ('powershell.exe ' + $uninstallArgs)
  Set-ItemProperty -Path $uninstallKey -Name 'QuietUninstallString' -Value ('powershell.exe ' + $uninstallArgs + ' -Quiet')
  New-ItemProperty -Path $uninstallKey -Name 'NoModify' -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name 'NoRepair' -Value 1 -PropertyType DWord -Force | Out-Null
  if ($size -gt 0) { New-ItemProperty -Path $uninstallKey -Name 'EstimatedSize' -Value $size -PropertyType DWord -Force | Out-Null }
}

function Set-ForcelistEntry([string]$Vendor, [string]$Id, [string]$UpdateUrl) {
  if (-not $Id) { return }
  $key = "$Backend\SOFTWARE\Policies\$Vendor\ExtensionInstallForcelist"
  New-Item -Path $key -Force | Out-Null
  $value = if ($UpdateUrl) { "$Id;$UpdateUrl" } else { $Id }
  $slot = $null
  $next = 1
  $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  if ($props) {
    $names = @($props.PSObject.Properties | Where-Object { $_.Name -match '^\d+$' } | Sort-Object { [int]$_.Name })
    foreach ($name in $names) {
      $existing = [string]$name.Value
      if ($existing -eq $Id -or $existing -like "$Id;*" -or $existing -like "*;$Id") { $slot = $name.Name; break }
    }
    foreach ($name in $names) { if ([int]$name.Name -ge $next) { $next = [int]$name.Name + 1 } }
  }
  if ($slot) { Set-ItemProperty -Path $key -Name $slot -Value $value }
  else { New-ItemProperty -Path $key -Name ([string]$next) -Value $value -PropertyType String -Force | Out-Null }
}

function Set-FirefoxForceInstall([string]$InstallUrl) {
  if (-not $InstallUrl) { return }
  $key = "$Backend\SOFTWARE\Policies\Mozilla\Firefox"
  New-Item -Path $key -Force | Out-Null
  $settings = [ordered]@{}
  $raw = $null
  try { $raw = (Get-ItemProperty -Path $key -Name 'ExtensionSettings' -ErrorAction Stop).ExtensionSettings } catch { }
  if ($raw) {
    try {
      $existing = $raw | ConvertFrom-Json
      foreach ($p in $existing.PSObject.Properties) { $settings[$p.Name] = $p.Value }
    } catch {
      Write-Warning 'Existing Firefox ExtensionSettings policy is not valid JSON - leaving it untouched.'
      return
    }
  }
  $settings[$FirefoxId] = [ordered]@{ installation_mode = 'force_installed'; install_url = $InstallUrl }
  New-ItemProperty -Path $key -Name 'ExtensionSettings' -Value ($settings | ConvertTo-Json -Depth 6 -Compress) -PropertyType String -Force | Out-Null
}

$ResolvedMode = $ExtensionMode
if ($ResolvedMode -eq 'auto') {
  if ($ChromeStoreId -or $EdgeStoreId -or $FirefoxInstallUrl) { $ResolvedMode = 'store' }
  elseif ($DomainJoined) { $ResolvedMode = 'selfhosted' }
  else { $ResolvedMode = 'manual' }
}
if ($ResolvedMode -eq 'store' -and -not ($ChromeStoreId -or $EdgeStoreId -or $FirefoxInstallUrl)) {
  Write-Warning 'Store mode needs a Chrome/Edge store ID or a Firefox install URL. Falling back to manual extension setup.'
  $ResolvedMode = 'manual'
}
if ($ResolvedMode -eq 'selfhosted' -and -not $DomainJoined -and -not $ForceExtensionPolicy) {
  Write-Warning 'Self-hosted policy installs are only honoured by Chrome/Edge on domain-joined machines. Falling back to manual extension setup.'
  $ResolvedMode = 'manual'
}

if (-not $NoExtension -and -not $DryRun) {
  if ($ResolvedMode -eq 'store') {
    Write-Step 'Configuring browser policies (store)...'
    if ($ChromeStoreId) {
      Set-ForcelistEntry 'Google\Chrome' $ChromeStoreId ''
      Set-ForcelistEntry 'BraveSoftware\Brave' $ChromeStoreId ''
      Set-ForcelistEntry 'Chromium' $ChromeStoreId ''
    }
    if ($EdgeStoreId) {
      Set-ForcelistEntry 'Microsoft\Edge' $EdgeStoreId 'https://edge.microsoft.com/extensionwebstorebase/v1/crx'
    } elseif ($ChromeStoreId) {
      Set-ForcelistEntry 'Microsoft\Edge' $ChromeStoreId 'https://clients2.google.com/service/update2/crx'
    }
    Set-FirefoxForceInstall $FirefoxInstallUrl
  } elseif ($ResolvedMode -eq 'selfhosted') {
    Write-Step 'Configuring browser policies (self-hosted CRX)...'
    $updateUrl = 'http://127.0.0.1:' + $ServerPort + '/ext/updates.xml'
    if ($ExtId) {
      Set-ForcelistEntry 'Google\Chrome' $ExtId $updateUrl
      Set-ForcelistEntry 'Microsoft\Edge' $ExtId $updateUrl
      Set-ForcelistEntry 'BraveSoftware\Brave' $ExtId $updateUrl
      Set-ForcelistEntry 'Chromium' $ExtId $updateUrl
    }
    Set-FirefoxForceInstall $FirefoxInstallUrl
  } else {
    Write-Step 'Extension prepared for manual install (open Settings > Install browser extension in the app).'
  }
  $installJson.extension.mode = $ResolvedMode
  [IO.File]::WriteAllText((Join-Path $InstallDir 'install.json'), ($installJson | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
} elseif ($DryRun) {
  Write-Plan "extension mode resolves to '$ResolvedMode'"
}

if (-not $DryRun) {
  $extConfig = [ordered]@{
    extension = [ordered]@{
      mode = $ResolvedMode
      chromeStoreId = $ChromeStoreId
      edgeStoreId = $EdgeStoreId
      firefoxAddonId = $FirefoxId
      firefoxInstallUrl = $FirefoxInstallUrl
    }
  }
  [IO.File]::WriteAllText((Join-Path $InstallDir 'extension-config.json'), ($extConfig | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
}

if (-not $NoLaunch -and -not $DryRun) {
  Write-Step 'Starting downloadX...'
  try {
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $InstallDir 'downloadX-silent.vbs') + '"') -WorkingDirectory $InstallDir -WindowStyle Hidden
  } catch {
    Write-Warning 'Could not start downloadX automatically. Use the Start Menu shortcut.'
  }
}

Write-Host ''
Write-Host '  Installed.'
Write-Host "  App       : $InstallDir"
Write-Host "  Data      : $DataDir"
if ($ExtId) { Write-Host "  Extension : $ExtId ($ResolvedMode)" } elseif ($DryRun) { Write-Host "  Extension : $ResolvedMode (dry run)" } else { Write-Host '  Extension : disabled' }
if ($ResolvedMode -eq 'manual' -and -not $NoExtension) {
  Write-Host '  Browser   : extension must be loaded once manually (developer mode / temporary add-on).'
  Write-Host '              Chrome/Edge/Firefox auto-install needs store listings - see README.'
}
Write-Host ''
if (-not $NoLaunch -and -not $DryRun) {
  $ready = $false
  for ($attempt = 0; $attempt -lt 20 -and -not $ready; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$ServerPort/api/health" -TimeoutSec 1
      if ($health -and $health.ok) { $ready = $true }
    } catch { }
    if (-not $ready) { Start-Sleep -Milliseconds 300 }
  }
  if ($ready) {
    Write-Host '  Opening downloadX...'
    try { Start-Process ("http://127.0.0.1:$ServerPort/") } catch { }
  }
}
