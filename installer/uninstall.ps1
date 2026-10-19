[CmdletBinding()]
param(
  [switch]$AllUsers,
  [switch]$RemoveData,
  [switch]$Quiet,
  [switch]$DryRun,
  [string]$InstallDir = '',
  [string]$DataDir = '',
  [string]$RegistryBase = ''
)

$ErrorActionPreference = 'Stop'

function Write-Plan([string]$Text) { Write-Host "  [dry-run] $Text" }
function Write-Step([string]$Text) { Write-Host "  $Text" }

function Test-Admin {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

if (-not $InstallDir) {
  $baseDir = if ($AllUsers) { $env:ProgramFiles } else { Join-Path $env:LOCALAPPDATA 'Programs' }
  $InstallDir = Join-Path $baseDir 'downloadX'
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if ($InstallDir -match '^[A-Za-z]:$') { throw 'Refusing to uninstall from a drive root.' }

$installJsonPath = Join-Path $InstallDir 'install.json'
$Info = $null
if (Test-Path -LiteralPath $installJsonPath) {
  try { $Info = Get-Content -LiteralPath $installJsonPath -Raw | ConvertFrom-Json } catch { }
}
if ($Info -and $Info.installDir) {
  $recorded = [IO.Path]::GetFullPath([string]$Info.installDir).TrimEnd('\')
  if ($recorded -ine $InstallDir) {
    throw "install.json belongs to $recorded, not $InstallDir. Use -InstallDir with the recorded path."
  }
}
if (-not $DataDir) {
  if ($Info -and $Info.dataDir) { $DataDir = [string]$Info.dataDir }
  else { $DataDir = Join-Path $env:LOCALAPPDATA 'downloadX\data' }
}
$DataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
if ($DataDir -match '^[A-Za-z]:$') { throw 'Refusing to use a drive root as the data directory.' }
$KeyDir = if ($AllUsers) { Join-Path $env:ProgramData 'downloadX' } else { Join-Path $env:LOCALAPPDATA 'downloadX' }
$KeyFile = Join-Path $KeyDir 'extension-key.pem'
$Backend = if ($RegistryBase) { $RegistryBase.TrimEnd('\') } else { if ($AllUsers) { 'HKLM:' } else { 'HKCU:' } }

if ($AllUsers -and -not (Test-Admin)) {
  if ($DryRun) {
    Write-Warning 'A per-machine uninstall needs elevation; the dry run will only inspect HKCU.'
    $Backend = 'HKCU:'
  } else {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-AllUsers', '-InstallDir', ('"' + $InstallDir + '"'), '-DataDir', ('"' + $DataDir + '"'))
    if ($RemoveData) { $argList += '-RemoveData' }
    if ($Quiet) { $argList += '-Quiet' }
    Write-Host 'Requesting administrator rights...'
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList ($argList -join ' ')
    return
  }
}

if (-not $DryRun -and -not (Test-Path -LiteralPath (Join-Path $InstallDir 'server.js')) -and -not (Test-Path -LiteralPath $installJsonPath)) {
  throw "$InstallDir does not look like a downloadX installation."
}

Set-Location -LiteralPath $env:TEMP

$ExtId = ''
$FirefoxId = 'downloadx@local'
$ChromeStoreId = ''
$EdgeStoreId = ''
if ($Info -and $Info.extension) {
  if ($Info.extension.id) { $ExtId = [string]$Info.extension.id }
  if ($Info.extension.firefoxId) { $FirefoxId = [string]$Info.extension.firefoxId }
  if ($Info.extension.chromeStoreId) { $ChromeStoreId = [string]$Info.extension.chromeStoreId }
  if ($Info.extension.edgeStoreId) { $EdgeStoreId = [string]$Info.extension.edgeStoreId }
}
if (-not $ExtId) {
  $buildInfo = Join-Path $InstallDir 'extension\build-info.json'
  if (Test-Path -LiteralPath $buildInfo) {
    try {
      $bi = Get-Content -LiteralPath $buildInfo -Raw | ConvertFrom-Json
      if ($bi.id) { $ExtId = [string]$bi.id }
      if ($bi.firefoxId) { $FirefoxId = [string]$bi.firefoxId }
    } catch { }
  }
}
$Ids = @($ExtId, $ChromeStoreId, $EdgeStoreId) | Where-Object { $_ }

Write-Host ''
Write-Host '  downloadX uninstaller'
Write-Host '  ----------------------------------------'
Write-Host "  Install dir : $InstallDir"
Write-Host "  Data dir    : $DataDir"
if ($ExtId) { Write-Host "  Extension   : $ExtId" }
Write-Host ''

Write-Step 'Stopping downloadX...'
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
      if ($DryRun) { Write-Plan "would stop running instance on port $p" }
      else {
        try { Invoke-RestMethod -Uri "http://127.0.0.1:$p/api/quit" -Method Post -TimeoutSec 3 | Out-Null } catch { }
        Start-Sleep -Milliseconds 600
      }
      break
    }
  } catch { }
}

function Remove-ForcelistEntries([string]$Vendor) {
  $key = "$Backend\SOFTWARE\Policies\$Vendor\ExtensionInstallForcelist"
  if (-not (Test-Path -LiteralPath $key)) { return }
  $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  if ($props) {
    $names = @($props.PSObject.Properties | Where-Object { $_.Name -match '^\d+$' })
    foreach ($name in $names) {
      $value = [string]$name.Value
      $first = ($value -split ';')[0].Trim()
      if (($Ids -contains $first) -or $value -match ';http://127\.0\.0\.1:\d+/ext/updates\.xml$') {
        if ($DryRun) { Write-Plan "would remove forcelist entry $Vendor\$($name.Name)" }
        else { Remove-ItemProperty -Path $key -Name $name.Name -ErrorAction SilentlyContinue }
      }
    }
  }
  if (-not $DryRun) {
    $left = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    $remaining = @($left.PSObject.Properties | Where-Object { $_.Name -match '^\d+$' })
    if (-not $remaining.Count) { Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

Write-Step 'Removing browser policies...'
foreach ($vendor in @('Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave', 'Chromium')) {
  Remove-ForcelistEntries $vendor
}

$ffKey = "$Backend\SOFTWARE\Policies\Mozilla\Firefox"
if (Test-Path -LiteralPath $ffKey) {
  try {
    $raw = (Get-ItemProperty -Path $ffKey -Name 'ExtensionSettings' -ErrorAction Stop).ExtensionSettings
    if ($raw) {
      $settings = [ordered]@{}
      $existing = $raw | ConvertFrom-Json
      foreach ($p in $existing.PSObject.Properties) {
        if ($p.Name -ne $FirefoxId) { $settings[$p.Name] = $p.Value }
      }
      if ($DryRun) { Write-Plan "would remove Firefox extension policy for $FirefoxId" }
      elseif ($settings.Count -eq 0) { Remove-ItemProperty -Path $ffKey -Name 'ExtensionSettings' -ErrorAction SilentlyContinue }
      else { Set-ItemProperty -Path $ffKey -Name 'ExtensionSettings' -Value ($settings | ConvertTo-Json -Depth 6 -Compress) }
    }
  } catch {
    Write-Warning 'Could not update the Firefox ExtensionSettings policy.'
  }
}

Write-Step 'Removing native messaging host registrations...'
foreach ($vendor in @('Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser', 'Chromium', 'Mozilla')) {
  $key = "$Backend\Software\$vendor\NativeMessagingHosts\com.downloadx.host"
  if (Test-Path -LiteralPath $key) {
    if ($DryRun) { Write-Plan "would remove $vendor native host registration" }
    else { Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

Write-Step 'Removing shortcuts and autostart...'
$startMenus = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\downloadX.lnk'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\downloadX.lnk')
)
$desktops = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'downloadX.lnk'),
  (Join-Path $env:PUBLIC 'Desktop\downloadX.lnk')
)
foreach ($shortcut in ($startMenus + $desktops)) {
  if (Test-Path -LiteralPath $shortcut) {
    if ($DryRun) { Write-Plan "would remove $shortcut" }
    else { Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue }
  }
}
$runKey = "$Backend\Software\Microsoft\Windows\CurrentVersion\Run"
try {
  if (Get-ItemProperty -Path $runKey -Name 'downloadX' -ErrorAction SilentlyContinue) {
    if ($DryRun) { Write-Plan 'would remove autostart entry' }
    else { Remove-ItemProperty -Path $runKey -Name 'downloadX' -ErrorAction SilentlyContinue }
  }
} catch { }

Write-Step 'Removing protocol handler...'
$protoKey = "$Backend\Software\Classes\downloadx"
if (Test-Path -LiteralPath $protoKey) {
  if ($DryRun) { Write-Plan "would remove $protoKey" }
  else { Remove-Item -Path $protoKey -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Step 'Removing uninstall entry...'
$uninstallKey = "$Backend\Software\Microsoft\Windows\CurrentVersion\Uninstall\downloadX"
if (Test-Path -LiteralPath $uninstallKey) {
  if ($DryRun) { Write-Plan "would remove $uninstallKey" }
  else { Remove-Item -Path $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue }
}

if (-not $RemoveData -and -not $Quiet -and -not $DryRun) {
  Write-Host ''
  Write-Host "  Download history and settings are kept in $DataDir"
  $answer = Read-Host '  Also delete download history and settings? [y/N]'
  if ($answer -match '^(y|yes)$') { $RemoveData = $true }
}

if ($RemoveData) {
  Write-Step 'Removing download history and settings...'
  if ($DryRun) {
    Write-Plan "would remove $DataDir and $KeyFile"
  } else {
    if (Test-Path -LiteralPath $DataDir) { Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $KeyFile) { Remove-Item -LiteralPath $KeyFile -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $KeyDir) {
      $left = @(Get-ChildItem -LiteralPath $KeyDir -Force -ErrorAction SilentlyContinue)
      if (-not $left.Count) { Remove-Item -LiteralPath $KeyDir -Force -ErrorAction SilentlyContinue }
    }
  }
}

if ($DryRun) {
  Write-Plan "would remove $InstallDir"
  Write-Host ''
  Write-Host '  Dry run complete - nothing was changed.'
  return
}

Write-Step 'Removing application files...'
try {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
} catch {
  $cmdLine = 'ping 127.0.0.1 -n 3 >nul & rmdir /s /q "' + $InstallDir + '"'
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList ('/c ' + $cmdLine) -WindowStyle Hidden
}

Write-Host ''
Write-Host '  downloadX has been uninstalled.'
if (-not $RemoveData) { Write-Host "  Your download history remains in $DataDir" }
Write-Host ''
if (-not $Quiet) { Read-Host '  Press Enter to close' | Out-Null }
