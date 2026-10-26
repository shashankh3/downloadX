using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace DownloadX
{
    internal sealed class BrowserInfo
    {
        internal string Key;
        internal string Name;
        internal string ExePath;
        internal string ExtensionsUrl;
        internal bool IsFirefox;
    }

    /// <summary>
    /// Prepares the Chrome/Edge/Firefox extension and the native messaging host
    /// that lets the extension start downloadX when it is not running.
    /// </summary>
    internal sealed class BrowserIntegration
    {
        internal const string NativeHostName = "com.downloadx.desktop.host";
        internal const string FirefoxExtensionId = "downloadx-desktop@local";
        private const int DefaultDesktopPort = 9785;
        private const int DesktopPortTries = 10;

        private readonly string _dataDir;
        private readonly string _hostExe;
        private readonly string _browserDir;
        private readonly string _extensionDir;
        private readonly string _chromeExtensionDir;
        private readonly string _firefoxExtensionDir;
        private readonly string _nativeDir;
        private readonly string _nativeHostPath;
        private readonly string _chromeManifestPath;
        private readonly string _firefoxManifestPath;
        private string _lastError = string.Empty;

        internal BrowserIntegration(string dataDir, string hostExe)
        {
            _dataDir = dataDir;
            _hostExe = hostExe;
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            _browserDir = Path.Combine(local, "downloadX", "browser");
            _extensionDir = Path.Combine(_browserDir, "extension");
            _chromeExtensionDir = Path.Combine(_extensionDir, "chrome");
            _firefoxExtensionDir = Path.Combine(_extensionDir, "firefox");
            _nativeDir = Path.Combine(_browserDir, "native");
            _nativeHostPath = Path.Combine(_nativeDir, "downloadX-native-host.exe");
            _chromeManifestPath = Path.Combine(_nativeDir, "com.downloadx.desktop.host.json");
            _firefoxManifestPath = Path.Combine(_nativeDir, "com.downloadx.desktop.host.firefox.json");
        }

        internal string ExtensionRoot { get { return _extensionDir; } }
        internal string ChromeExtensionFolder { get { return _chromeExtensionDir; } }
        internal string FirefoxExtensionFolder { get { return _firefoxExtensionDir; } }
        internal string NativeHostFolder { get { return _nativeDir; } }
        internal string LastError { get { return _lastError; } }
        internal static int PreferredPort { get { return DefaultDesktopPort; } }
        internal static int PortTries { get { return DesktopPortTries; } }

        /// <summary>
        /// Extract the bundled extension and native host, then refresh the
        /// registry entries. Every failure is reported through LastError so a
        /// browser problem can never stop the download manager from starting.
        /// </summary>
        internal void Prepare()
        {
            try
            {
                Directory.CreateDirectory(_browserDir);
                Directory.CreateDirectory(_nativeDir);
                ExtractExtension();
                ExtractNativeHost();
                WriteLauncher();
                WriteInstallJson();
                WriteNativeManifests();
                RegisterNativeHost();
                _lastError = string.Empty;
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
            }
        }

        private void ExtractExtension()
        {
            string stampFile = Path.Combine(_extensionDir, ".stamp");
            string stamp = DesktopInfo.Version + "|" + DesktopInfo.BuildId + "|" + DesktopInfo.ExtensionId;
            if (File.Exists(stampFile) && File.ReadAllText(stampFile).Trim() == stamp &&
                File.Exists(Path.Combine(_chromeExtensionDir, "manifest.json")))
            {
                return;
            }

            string zip = Path.Combine(Path.GetTempPath(), "downloadX-extension-" + Guid.NewGuid().ToString("N") + ".zip");
            string fresh = _extensionDir + ".new";
            try
            {
                ResourceExtractor.Extract("desktop-extension.zip", zip);
                if (Directory.Exists(fresh)) Directory.Delete(fresh, true);
                ZipFile.ExtractToDirectory(zip, fresh);
                try
                {
                    if (Directory.Exists(_extensionDir)) Directory.Delete(_extensionDir, true);
                    Directory.Move(fresh, _extensionDir);
                }
                catch
                {
                    // Chrome may keep an old file open. Copy over it instead.
                    CopyDirectory(fresh, _extensionDir);
                }
                File.WriteAllText(stampFile, stamp);
            }
            finally
            {
                try { if (File.Exists(zip)) File.Delete(zip); } catch { }
                try { if (Directory.Exists(fresh)) Directory.Delete(fresh, true); } catch { }
            }
        }

        private void ExtractNativeHost()
        {
            string stampFile = _nativeHostPath + ".stamp";
            string stamp = DesktopInfo.Version + "|" + DesktopInfo.NativeHostBuild;
            if (File.Exists(_nativeHostPath) && File.Exists(stampFile) &&
                File.ReadAllText(stampFile).Trim() == stamp)
            {
                return;
            }
            ResourceExtractor.Extract("downloadX-native-host.exe", _nativeHostPath);
            File.WriteAllText(stampFile, stamp);
        }

        private void WriteLauncher()
        {
            string vbs = string.Join("\r\n", new[]
            {
                "Option Explicit",
                "Dim sh",
                "Set sh = CreateObject(\"WScript.Shell\")",
                "sh.Run Chr(34) & \"" + EscapeVbs(_hostExe) + "\" & Chr(34), 0, False",
                "",
            });
            File.WriteAllText(Path.Combine(_nativeDir, "downloadX-silent.vbs"), vbs, Encoding.Unicode);
        }

        private void WriteInstallJson()
        {
            var data = new Dictionary<string, object>();
            data["dataDir"] = _dataDir;
            data["port"] = DefaultDesktopPort;
            data["perUserData"] = false;
            data["desktop"] = _hostExe;
            File.WriteAllText(
                Path.Combine(_nativeDir, "install.json"),
                new JavaScriptSerializer().Serialize(data),
                new UTF8Encoding(false));
        }

        private void WriteNativeManifests()
        {
            var origins = new List<string>();
            if (!string.IsNullOrEmpty(DesktopInfo.ExtensionId))
            {
                origins.Add("chrome-extension://" + DesktopInfo.ExtensionId + "/");
            }
            var chrome = new Dictionary<string, object>();
            chrome["name"] = NativeHostName;
            chrome["description"] = "downloadX desktop native messaging host";
            chrome["path"] = _nativeHostPath;
            chrome["type"] = "stdio";
            chrome["allowed_origins"] = origins;
            var serializer = new JavaScriptSerializer();
            File.WriteAllText(_chromeManifestPath, serializer.Serialize(chrome), new UTF8Encoding(false));

            var firefox = new Dictionary<string, object>();
            firefox["name"] = NativeHostName;
            firefox["description"] = "downloadX desktop native messaging host";
            firefox["path"] = _nativeHostPath;
            firefox["type"] = "stdio";
            firefox["allowed_extensions"] = new[] { FirefoxExtensionId };
            File.WriteAllText(_firefoxManifestPath, serializer.Serialize(firefox), new UTF8Encoding(false));
        }

        private void RegisterNativeHost()
        {
            string[] chromium = new[]
            {
                @"Software\Google\Chrome\NativeMessagingHosts\" + NativeHostName,
                @"Software\Microsoft\Edge\NativeMessagingHosts\" + NativeHostName,
                @"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\" + NativeHostName,
                @"Software\Chromium\NativeMessagingHosts\" + NativeHostName,
            };
            foreach (string path in chromium)
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(path))
                {
                    if (key != null) key.SetValue(string.Empty, _chromeManifestPath);
                }
            }
            using (RegistryKey firefox = Registry.CurrentUser.CreateSubKey(
                @"Software\Mozilla\NativeMessagingHosts\" + NativeHostName))
            {
                if (firefox != null) firefox.SetValue(string.Empty, _firefoxManifestPath);
            }
        }

        internal bool IsNativeHostRegistered()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(
                    @"Software\Google\Chrome\NativeMessagingHosts\" + NativeHostName))
                {
                    return key != null &&
                        string.Equals(Convert.ToString(key.GetValue(string.Empty)), _chromeManifestPath,
                            StringComparison.OrdinalIgnoreCase);
                }
            }
            catch
            {
                return false;
            }
        }

        internal List<BrowserInfo> DetectBrowsers()
        {
            var list = new List<BrowserInfo>();
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            Add(list, "chrome", "Google Chrome", "chrome://extensions/", false,
                Path.Combine(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(local, "Google", "Chrome", "Application", "chrome.exe"));
            Add(list, "edge", "Microsoft Edge", "edge://extensions/", false,
                Path.Combine(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(local, "Microsoft", "Edge", "Application", "msedge.exe"));
            Add(list, "brave", "Brave", "brave://extensions/", false,
                Path.Combine(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
                Path.Combine(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"));
            Add(list, "chromium", "Chromium", "chrome://extensions/", false,
                Path.Combine(programFiles, "Chromium", "Application", "chrome.exe"),
                Path.Combine(local, "Chromium", "Application", "chrome.exe"));
            Add(list, "firefox", "Mozilla Firefox", "about:debugging#/runtime/this-firefox", true,
                Path.Combine(programFiles, "Mozilla Firefox", "firefox.exe"),
                Path.Combine(programFilesX86, "Mozilla Firefox", "firefox.exe"));
            return list;
        }

        private static void Add(List<BrowserInfo> list, string key, string name, string url, bool firefox,
            params string[] candidates)
        {
            foreach (string candidate in candidates)
            {
                if (string.IsNullOrEmpty(candidate) || !File.Exists(candidate)) continue;
                list.Add(new BrowserInfo
                {
                    Key = key,
                    Name = name,
                    ExePath = candidate,
                    ExtensionsUrl = url,
                    IsFirefox = firefox,
                });
                return;
            }
        }

        /// <summary>Open the browser's extension page and copy the right folder.</summary>
        internal bool OpenExtensionsPage(BrowserInfo browser)
        {
            try
            {
                if (browser.IsFirefox) CopyFolder(_firefoxExtensionDir);
                else CopyFolder(_chromeExtensionDir);
                var info = new ProcessStartInfo(browser.ExePath, browser.ExtensionsUrl);
                info.UseShellExecute = false;
                Process.Start(info);
                return true;
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                return false;
            }
        }

        /// <summary>
        /// Open a separate browser profile with the extension preloaded. This is
        /// the zero-setup way to grab downloads immediately.
        /// </summary>
        internal bool OpenWithExtension(BrowserInfo browser, out string error)
        {
            error = string.Empty;
            if (browser.IsFirefox)
            {
                error = "The quick-start window is only available for Chrome, Edge, Brave and Chromium. " +
                    "Use the Firefox setup button instead.";
                return false;
            }
            try
            {
                string profile = Path.Combine(_dataDir, "browser-profile", browser.Key);
                Directory.CreateDirectory(profile);
                string args = "--user-data-dir=\"" + profile + "\" " +
                    "--load-extension=\"" + _chromeExtensionDir + "\" " +
                    "--no-first-run --no-default-browser-check --new-window";
                var info = new ProcessStartInfo(browser.ExePath, args);
                info.UseShellExecute = false;
                Process.Start(info);
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        internal void OpenExtensionFolder()
        {
            OpenFolder(_chromeExtensionDir);
        }

        internal bool CopyChromeFolder()
        {
            return CopyFolder(_chromeExtensionDir);
        }

        internal bool CopyFirefoxFolder()
        {
            return CopyFolder(_firefoxExtensionDir);
        }

        private static bool CopyFolder(string folder)
        {
            try
            {
                Clipboard.SetText(folder);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void OpenFolder(string folder)
        {
            try
            {
                if (Directory.Exists(folder))
                {
                    Process.Start(new ProcessStartInfo("explorer.exe", "\"" + folder + "\"")
                    {
                        UseShellExecute = true,
                    });
                }
            }
            catch
            {
                // Explorer is unavailable.
            }
        }

        private static string EscapeVbs(string value)
        {
            return (value ?? string.Empty).Replace("\"", "\"\"");
        }

        private static void CopyDirectory(string source, string target)
        {
            Directory.CreateDirectory(target);
            foreach (string file in Directory.GetFiles(source))
            {
                string destination = Path.Combine(target, Path.GetFileName(file));
                try { File.Copy(file, destination, true); }
                catch { }
            }
            foreach (string dir in Directory.GetDirectories(source))
            {
                CopyDirectory(dir, Path.Combine(target, Path.GetFileName(dir)));
            }
        }
    }
}
