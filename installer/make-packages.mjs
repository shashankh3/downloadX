// Generates winget + Chocolatey manifests for the built EXE with its real SHA-256.
// Run after `npm run build:exe`: node installer/make-packages.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const EXE = path.join(ROOT, 'dist', 'downloadX.exe');
if (!fs.existsSync(EXE)) {
  console.error('dist/downloadX.exe not found — run npm run build:exe first');
  process.exit(1);
}
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex');
const size = fs.statSync(EXE).size;

const PUBLISHER = 'ShashankH3';
const PACKAGE_ID = 'DownloadX';
const WINGET_ID = `${PUBLISHER}.${PACKAGE_ID}`;
const GH = 'https://github.com/shashankh3/downloadX';
const DOWNLOAD_URL = `${GH}/releases/download/v${VERSION}/downloadX.exe`;

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.replace(/\r\n/g, '\n'));
}

/* ---------------- winget (manifests/<p>/<Publisher>/<Package>/<version>/) ---------------- */
const wingetDir = path.join(
  ROOT, 'packaging', 'winget', 'manifests',
  PUBLISHER[0].toLowerCase(), PUBLISHER, PACKAGE_ID, VERSION
);

write(path.join(wingetDir, `${WINGET_ID}.yaml`), [
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json`,
  `PackageIdentifier: ${WINGET_ID}`,
  `PackageVersion: ${VERSION}`,
  `DefaultLocale: en-US`,
  `ManifestType: version`,
  `ManifestVersion: 1.6.0`,
  '',
].join('\n'));

write(path.join(wingetDir, `${WINGET_ID}.installer.yaml`), [
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json`,
  `PackageIdentifier: ${WINGET_ID}`,
  `PackageVersion: ${VERSION}`,
  `InstallerType: portable`,
  `Commands:`,
  `  - downloadX`,
  `PortableCommandAlias: downloadx`,
  `Installers:`,
  `  - Architecture: x64`,
  `    InstallerUrl: ${DOWNLOAD_URL}`,
  `    InstallerSha256: ${sha256.toUpperCase()}`,
  `    InstallerLocale: en-US`,
  `ManifestType: installer`,
  `ManifestVersion: 1.6.0`,
  '',
].join('\n'));

write(path.join(wingetDir, `${WINGET_ID}.locale.en-US.yaml`), [
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json`,
  `PackageIdentifier: ${WINGET_ID}`,
  `PackageVersion: ${VERSION}`,
  `PackageLocale: en-US`,
  `Publisher: downloadX`,
  `PublisherUrl: ${GH}`,
  `PublisherSupportUrl: ${GH}/issues`,
  `PackageName: downloadX`,
  `PackageUrl: ${GH}`,
  `License: MIT`,
  `LicenseUrl: ${GH}/blob/main/LICENSE`,
  `ShortDescription: Segmented Windows download manager with FTP/FTPS, HLS/DASH capture and browser integration.`,
  `Description: downloadX is a zero-dependency download manager with a local web UI. It supports multi-connection HTTP(S) downloads, FTP/FTPS, mirrors, resume, checksums, speed limits, scheduling, HLS and DASH media capture, proxies, Basic/Digest auth and one-click browser handoff.`,
  `Moniker: downloadx`,
  `Tags:`,
  `  - download-manager`,
  `  - ftp`,
  `  - hls`,
  `  - dash`,
  `  - downloader`,
  `ManifestType: defaultLocale`,
  `ManifestVersion: 1.6.0`,
  '',
].join('\n'));

/* ---------------- chocolatey ---------------- */
const chocoDir = path.join(ROOT, 'packaging', 'choco');
write(path.join(chocoDir, 'downloadx.nuspec'), [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<package xmlns="http://schemas.microsoft.com/packaging/2015/06/nuspec.xsd">',
  '  <metadata>',
  '    <id>downloadx</id>',
  `    <version>${VERSION}</version>`,
  '    <title>downloadX</title>',
  '    <authors>shashankh3</authors>',
  '    <owners>shashankh3</owners>',
  `    <projectUrl>${GH}</projectUrl>`,
  `    <packageSourceUrl>${GH}</packageSourceUrl>`,
  '    <license type="expression">MIT</license>',
  '    <requireLicenseAcceptance>false</requireLicenseAcceptance>',
  '    <description>Segmented Windows download manager with FTP/FTPS, HLS/DASH capture, proxies and browser integration. Local web UI, zero runtime dependencies.</description>',
  '    <summary>Fast download manager with a local web UI.</summary>',
  '    <tags>download-manager ftp hls dash downloader</tags>',
  '  </metadata>',
  '  <files>',
  '    <file src="tools\\**" target="tools" />',
  '  </files>',
  '</package>',
  '',
].join('\n'));

write(path.join(chocoDir, 'tools', 'chocolateyinstall.ps1'), [
  '$ErrorActionPreference = \'Stop\'',
  '',
  '$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition',
  `$url      = '${DOWNLOAD_URL}'`,
  `$checksum = '${sha256.toUpperCase()}'`,
  '',
  'Get-ChocolateyWebFile -PackageName \'downloadx\' -FileFullPath "$toolsDir\\downloadX.exe" `',
  '  -Url $url -Checksum $checksum -ChecksumType \'sha256\'',
  '',
  'Install-BinFile -Name \'downloadx\' -Path "$toolsDir\\downloadX.exe"',
  '',
].join('\n'));

write(path.join(chocoDir, 'tools', 'chocolateyuninstall.ps1'), [
  '$ErrorActionPreference = \'Ignore\'',
  '',
  'Uninstall-BinFile -Name \'downloadx\'',
  '$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition',
  'Remove-Item "$toolsDir\\downloadX.exe" -Force -ErrorAction SilentlyContinue',
  '',
].join('\n'));

console.log(`winget manifests: ${path.relative(ROOT, wingetDir)}`);
console.log(`chocolatey package: ${path.relative(ROOT, chocoDir)}`);
console.log(`sha256 ${sha256} (${(size / 1024 / 1024).toFixed(1)} MB)`);
