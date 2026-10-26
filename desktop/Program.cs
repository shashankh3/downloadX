using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DownloadX
{
    internal static class Program
    {
        internal const string ShowEventName = @"Local\downloadX-desktop-show";
        internal const string ExitEventName = @"Local\downloadX-desktop-exit";
        private static EventWaitHandle _showEvent;
        private static EventWaitHandle _exitEvent;

        [STAThread]
        private static void Main()
        {
            bool createdShow;
            bool createdExit;
            _showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName, out createdShow);
            _exitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ExitEventName, out createdExit);
            bool quit = Environment.GetCommandLineArgs().Length > 1 &&
                string.Equals(Environment.GetCommandLineArgs()[1], "--quit", StringComparison.OrdinalIgnoreCase);
            if (!createdShow)
            {
                if (quit)
                {
                    if (!createdExit)
                    {
                        _exitEvent.Set();
                    }
                    else
                    {
                        // The first instance is between creating its two
                        // events; give it a moment to publish the exit event.
                        for (int i = 0; i < 20; i++)
                        {
                            Thread.Sleep(50);
                            EventWaitHandle exit;
                            try
                            {
                                if (EventWaitHandle.TryOpenExisting(ExitEventName, out exit))
                                {
                                    using (exit) exit.Set();
                                    break;
                                }
                            }
                            catch
                            {
                                break;
                            }
                        }
                    }
                }
                else
                {
                    _showEvent.Set();
                }
                return;
            }
            if (quit) return;

            AppDomain.CurrentDomain.AssemblyResolve += ResolveWebView2Assembly;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (sender, e) => ShowFatal(e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (sender, e) => ShowFatal(e.ExceptionObject as Exception);

            try
            {
                using (var app = new DesktopApp(_showEvent, _exitEvent))
                {
                    app.Run();
                }
            }
            catch (Exception ex)
            {
                ShowFatal(ex);
            }
        }

        private static Assembly ResolveWebView2Assembly(object sender, ResolveEventArgs args)
        {
            string name = new AssemblyName(args.Name).Name;
            if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name + ".dll"))
            {
                if (stream == null) return null;
                byte[] data = new byte[stream.Length];
                int read = 0;
                while (read < data.Length)
                {
                    int count = stream.Read(data, read, data.Length - read);
                    if (count <= 0) break;
                    read += count;
                }
                return Assembly.Load(data);
            }
        }

        internal static void ShowFatal(Exception ex)
        {
            try
            {
                string message = ex == null ? "Unknown error" : ex.Message;
                MessageBox.Show(message, "downloadX", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch
            {
                // Nothing else can be shown.
            }
        }
    }

    internal sealed class DesktopApp : IDisposable
    {
        private readonly EventWaitHandle _showEvent;
        private readonly EventWaitHandle _exitEvent;
        private readonly string _hostDir;
        private readonly string _dataDir;
        private readonly string _appDir;
        private readonly BrowserIntegration _browser;
        private readonly ServerManager _server;
        private MainForm _form;
        private Thread _showThread;
        private volatile bool _stopping;

        internal DesktopApp(EventWaitHandle showEvent, EventWaitHandle exitEvent)
        {
            _showEvent = showEvent;
            _exitEvent = exitEvent;
            _hostDir = Path.GetDirectoryName(Application.ExecutablePath);
            _dataDir = ResolveDataDir(_hostDir);
            Directory.CreateDirectory(_dataDir);

            string appRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "downloadX", "app");
            _appDir = Path.Combine(appRoot, DesktopInfo.Version + "-" + DesktopInfo.BuildId);
            Directory.CreateDirectory(_appDir);
            CleanupOldBuilds(appRoot, Path.GetFileName(_appDir));
            string loader = Path.Combine(_appDir, "WebView2Loader.dll");
            if (!File.Exists(loader)) ResourceExtractor.Extract("WebView2Loader.dll", loader);
            NativeMethods.SetDllDirectory(_appDir);

            _browser = new BrowserIntegration(_dataDir, Application.ExecutablePath);
            _browser.Prepare();
            _server = new ServerManager(_hostDir, _dataDir, _appDir, _browser.ExtensionRoot);
        }

        internal void Run()
        {
            _form = new MainForm(_server, _dataDir, _browser);
            _showThread = new Thread(ShowLoop);
            _showThread.IsBackground = true;
            _showThread.Name = "downloadX show listener";
            _showThread.Start();

            try
            {
                Application.Run(_form);
            }
            finally
            {
                _stopping = true;
                try { _showEvent.Set(); } catch { }
                _server.Dispose();
            }
        }

        private void ShowLoop()
        {
            var events = new WaitHandle[] { _showEvent, _exitEvent };
            while (!_stopping)
            {
                try
                {
                    int index = WaitHandle.WaitAny(events, 500);
                    if (index == WaitHandle.WaitTimeout) continue;
                    if (_stopping) return;
                    MainForm form = _form;
                    if (form == null || form.IsDisposed) return;
                    if (index == 1)
                    {
                        form.BeginInvoke(new Action(form.RequestExit));
                    }
                    else
                    {
                        form.BeginInvoke(new Action(form.ShowFromTray));
                    }
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
                catch
                {
                    // The window may be closing; the next wait will notice.
                }
            }
        }

        private static string ResolveDataDir(string hostDir)
        {
            string preferred = Path.Combine(hostDir, "data");
            if (CanWrite(preferred)) return preferred;
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "downloadX", "data");
        }

        private static bool CanWrite(string dir)
        {
            try
            {
                Directory.CreateDirectory(dir);
                string probe = Path.Combine(dir, ".write-" + Guid.NewGuid().ToString("N") + ".tmp");
                File.WriteAllText(probe, "x");
                File.Delete(probe);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void CleanupOldBuilds(string appRoot, string current)
        {
            try
            {
                foreach (string dir in Directory.GetDirectories(appRoot))
                {
                    if (string.Equals(Path.GetFileName(dir), current, StringComparison.OrdinalIgnoreCase)) continue;
                    try { Directory.Delete(dir, true); } catch { }
                }
            }
            catch
            {
                // Old build folders are only housekeeping.
            }
        }

        public void Dispose()
        {
            _stopping = true;
            try { _showEvent.Set(); } catch { }
            _server.Dispose();
        }
    }

    internal sealed class ServerManager : IDisposable
    {
        private static readonly HttpClient Http = CreateHttpClient();
        private readonly string _hostDir;
        private readonly string _dataDir;
        private readonly string _appDir;
        private readonly string _extensionDir;
        private readonly object _sync = new object();
        private readonly Queue<string> _recent = new Queue<string>();
        private Process _process;
        private StreamWriter _log;
        private int _port;
        private bool _disposed;

        internal int Port
        {
            get { return _port; }
        }

        internal ServerManager(string hostDir, string dataDir, string appDir, string extensionDir)
        {
            _hostDir = hostDir;
            _dataDir = dataDir;
            _appDir = appDir;
            _extensionDir = extensionDir;
        }

        private static HttpClient CreateHttpClient()
        {
            var handler = new HttpClientHandler();
            handler.UseProxy = false;
            var client = new HttpClient(handler);
            client.Timeout = TimeSpan.FromMilliseconds(1200);
            return client;
        }

        internal async Task<int> EnsureRunningAsync()
        {
            if (_disposed) throw new ObjectDisposedException("ServerManager");
            int existing = ReadPortFile();
            if (existing > 0 && await HealthAsync(existing).ConfigureAwait(false))
            {
                _port = existing;
                return existing;
            }

            if (_process != null)
            {
                try
                {
                    if (!_process.HasExited) _process.Kill();
                }
                catch
                {
                    // The old child is already gone.
                }
                try { _process.Dispose(); } catch { }
                _process = null;
            }

            string serverExe = ResolveServerExe();
            StartServer(serverExe);

            DateTime deadline = DateTime.UtcNow.AddSeconds(35);
            while (DateTime.UtcNow < deadline)
            {
                int port = ReadPortFile();
                if (port > 0 && await HealthAsync(port).ConfigureAwait(false))
                {
                    _port = port;
                    return port;
                }

                Process process = _process;
                if (process != null && process.HasExited)
                {
                    // The child can exit normally when another instance already
                    // owns the same data directory.
                    port = ReadPortFile();
                    if (port > 0 && await HealthAsync(port).ConfigureAwait(false))
                    {
                        _port = port;
                        return port;
                    }
                    throw new InvalidOperationException(
                        StartupDetails("downloadX could not start (exit code " + process.ExitCode + ")."));
                }

                await Task.Delay(200).ConfigureAwait(false);
            }

            throw new TimeoutException(StartupDetails("downloadX did not start in time."));
        }

        internal async Task<string> GetAsync(string path)
        {
            if (_port <= 0) return string.Empty;
            try
            {
                return await Http.GetStringAsync(BaseUrl + path).ConfigureAwait(false);
            }
            catch
            {
                return string.Empty;
            }
        }

        internal async Task PostAsync(string path)
        {
            if (_port <= 0) return;
            try
            {
                using (var body = new StringContent("{}", Encoding.UTF8, "application/json"))
                {
                    await Http.PostAsync(BaseUrl + path, body).ConfigureAwait(false);
                }
            }
            catch
            {
                // The action is best-effort; the UI still works.
            }
        }

        private string BaseUrl
        {
            get { return "http://127.0.0.1:" + _port; }
        }

        private static async Task<bool> HealthAsync(int port)
        {
            try
            {
                string body = await Http.GetStringAsync(
                    "http://127.0.0.1:" + port + "/api/health").ConfigureAwait(false);
                return body.IndexOf("\"ok\":true", StringComparison.Ordinal) >= 0;
            }
            catch
            {
                return false;
            }
        }

        private int ReadPortFile()
        {
            try
            {
                string file = Path.Combine(_dataDir, "port");
                if (!File.Exists(file)) return 0;
                int port;
                return int.TryParse(File.ReadAllText(file).Trim(), out port) && port > 0 && port <= 65535
                    ? port
                    : 0;
            }
            catch
            {
                return 0;
            }
        }

        private string ResolveServerExe()
        {
            string local = Path.Combine(_hostDir, "downloadX-server.exe");
            if (File.Exists(local)) return local;

            string extracted = Path.Combine(_appDir, "downloadX-server.exe");
            string stamp = extracted + ".stamp";
            bool current = File.Exists(extracted) && File.Exists(stamp) &&
                File.ReadAllText(stamp).Trim() == DesktopInfo.Version;
            if (!current)
            {
                ResourceExtractor.Extract("downloadX-server.exe", extracted);
                File.WriteAllText(stamp, DesktopInfo.Version);
            }
            return extracted;
        }

        private void StartServer(string serverExe)
        {
            var info = new ProcessStartInfo(serverExe);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WorkingDirectory = Path.GetDirectoryName(serverExe);
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            info.EnvironmentVariables["DLX_HOST"] = "127.0.0.1";
            info.EnvironmentVariables["DLX_PORT"] = BrowserIntegration.PreferredPort.ToString();
            info.EnvironmentVariables["DLX_PORT_TRIES"] = BrowserIntegration.PortTries.ToString();
            info.EnvironmentVariables["DLX_DATA_DIR"] = _dataDir;
            info.EnvironmentVariables["DLX_OPEN"] = "0";
            info.EnvironmentVariables["DLX_PARENT_WATCH"] = "1";
            if (!string.IsNullOrEmpty(DesktopInfo.ExtensionId))
                info.EnvironmentVariables["DLX_EXTENSION_IDS"] = DesktopInfo.ExtensionId;
            info.EnvironmentVariables["DLX_FIREFOX_ID"] = BrowserIntegration.FirefoxExtensionId;
            if (!string.IsNullOrEmpty(_extensionDir))
                info.EnvironmentVariables["DLX_EXT_DIR"] = _extensionDir;
            else
                info.EnvironmentVariables.Remove("DLX_EXT_DIR");
            info.EnvironmentVariables.Remove("DLX_NO_OPEN");

            _process = new Process();
            _process.StartInfo = info;
            _process.OutputDataReceived += (sender, e) => AppendLog(e.Data);
            _process.ErrorDataReceived += (sender, e) => AppendLog(e.Data);
            _process.Start();
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();
        }

        private void AppendLog(string line)
        {
            if (string.IsNullOrEmpty(line)) return;
            lock (_sync)
            {
                _recent.Enqueue(line);
                while (_recent.Count > 80) _recent.Dequeue();
                try
                {
                    if (_log == null)
                    {
                        _log = new StreamWriter(Path.Combine(_dataDir, "server.log"), true, Encoding.UTF8);
                        _log.AutoFlush = true;
                    }
                    _log.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line);
                }
                catch
                {
                    // A log file is useful, but never required.
                }
            }
        }

        private string StartupDetails(string reason)
        {
            return reason + Environment.NewLine +
                "Log: " + Path.Combine(_dataDir, "server.log") + Environment.NewLine +
                RecentLog();
        }

        private string RecentLog()
        {
            lock (_sync)
            {
                if (_recent.Count == 0) return "(the server produced no output)";
                string[] lines = _recent.ToArray();
                int first = Math.Max(0, lines.Length - 8);
                return string.Join(Environment.NewLine, lines, first, lines.Length - first);
            }
        }

        internal void Stop()
        {
            if (_disposed) return;
            _disposed = true;

            if (_port > 0)
            {
                try
                {
                    Task.Run(() => PostAsync("/api/quit")).Wait(3000);
                }
                catch
                {
                    // The server may already be gone.
                }
            }

            Process process = _process;
            _process = null;
            if (process != null)
            {
                try
                {
                    if (!process.HasExited && !process.WaitForExit(4000)) process.Kill();
                }
                catch
                {
                    // Already stopped.
                }
                try { process.Dispose(); } catch { }
            }

            lock (_sync)
            {
                if (_log != null)
                {
                    try { _log.Dispose(); } catch { }
                    _log = null;
                }
            }
        }

        public void Dispose()
        {
            Stop();
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly ServerManager _server;
        private readonly string _dataDir;
        private readonly BrowserIntegration _browser;
        private readonly WebView2 _webView;
        private readonly Panel _loading;
        private readonly Panel _loadingBox;
        private readonly Label _title;
        private readonly Label _status;
        private readonly Label _detail;
        private readonly ProgressBar _progress;
        private readonly Button _retry;
        private readonly Button _webviewHelp;
        private const int BrowserSetupPromptVersion = 2;
        private NotifyIcon _tray;
        private bool _exiting;
        private bool _trayTipShown;
        private bool _starting;
        private bool _webViewReady;

        internal MainForm(ServerManager server, string dataDir, BrowserIntegration browser)
        {
            _server = server;
            _dataDir = dataDir;
            _browser = browser;

            Text = "downloadX";
            Icon = LoadAppIcon();
            AutoScaleMode = AutoScaleMode.Dpi;
            MinimumSize = new Size(820, 560);
            BackColor = Color.FromArgb(246, 247, 251);
            DoubleBuffered = true;
            LoadBounds();

            _webView = new WebView2();
            _webView.Dock = DockStyle.Fill;
            _webView.Visible = false;
            _webView.DefaultBackgroundColor = Color.White;

            _loading = new Panel();
            _loading.Dock = DockStyle.Fill;
            _loading.BackColor = Color.FromArgb(246, 247, 251);
            _loading.Resize += (sender, e) => CenterLoadingBox();

            _loadingBox = new Panel();
            _loadingBox.Width = 560;
            _loadingBox.Height = 300;
            _loadingBox.BackColor = Color.Transparent;
            _loading.Controls.Add(_loadingBox);

            var logo = new PictureBox();
            logo.Width = 64;
            logo.Height = 64;
            logo.Left = (560 - 64) / 2;
            logo.Top = 8;
            logo.SizeMode = PictureBoxSizeMode.Zoom;
            try
            {
                using (var large = new Icon(Icon, 64, 64)) logo.Image = large.ToBitmap();
            }
            catch
            {
                logo.Image = SystemIcons.Application.ToBitmap();
            }
            _loadingBox.Controls.Add(logo);

            _title = new Label();
            _title.Text = "downloadX";
            _title.Font = new Font("Segoe UI", 24F, FontStyle.Bold);
            _title.ForeColor = Color.FromArgb(24, 32, 48);
            _title.TextAlign = ContentAlignment.MiddleCenter;
            _title.Left = 0;
            _title.Top = 78;
            _title.Width = 560;
            _title.Height = 42;
            _loadingBox.Controls.Add(_title);

            _status = new Label();
            _status.Text = "Starting downloadX\u2026";
            _status.Font = new Font("Segoe UI", 10.5F);
            _status.ForeColor = Color.FromArgb(80, 92, 110);
            _status.TextAlign = ContentAlignment.MiddleCenter;
            _status.Left = 20;
            _status.Top = 128;
            _status.Width = 520;
            _status.Height = 24;
            _loadingBox.Controls.Add(_status);

            _progress = new ProgressBar();
            _progress.Style = ProgressBarStyle.Marquee;
            _progress.MarqueeAnimationSpeed = 30;
            _progress.Left = 130;
            _progress.Top = 160;
            _progress.Width = 300;
            _progress.Height = 8;
            _loadingBox.Controls.Add(_progress);

            _detail = new Label();
            _detail.Text = string.Empty;
            _detail.Font = new Font("Segoe UI", 8.5F);
            _detail.ForeColor = Color.FromArgb(120, 130, 145);
            _detail.TextAlign = ContentAlignment.TopCenter;
            _detail.Left = 30;
            _detail.Top = 178;
            _detail.Width = 500;
            _detail.Height = 64;
            _detail.Visible = false;
            _loadingBox.Controls.Add(_detail);

            _retry = new Button();
            _retry.Text = "Retry";
            _retry.Left = 145;
            _retry.Top = 250;
            _retry.Width = 100;
            _retry.Height = 32;
            _retry.Visible = false;
            _retry.Click += async (sender, e) => await StartAsync();
            _loadingBox.Controls.Add(_retry);

            _webviewHelp = new Button();
            _webviewHelp.Text = "Get WebView2";
            _webviewHelp.Left = 255;
            _webviewHelp.Top = 250;
            _webviewHelp.Width = 160;
            _webviewHelp.Height = 32;
            _webviewHelp.Visible = false;
            _webviewHelp.Click += (sender, e) => OpenExternal("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            _loadingBox.Controls.Add(_webviewHelp);

            Controls.Add(_webView);
            Controls.Add(_loading);
            _loading.BringToFront();
            CenterLoadingBox();

            _tray = CreateTray();
            Shown += async (sender, e) => await StartAsync();
            FormClosing += OnFormClosing;
        }

        private async Task StartAsync()
        {
            if (_starting) return;
            _starting = true;
            _retry.Visible = false;
            _webviewHelp.Visible = false;
            _detail.Visible = false;
            _detail.Text = string.Empty;
            _status.Text = "Starting downloadX\u2026";
            _progress.Visible = true;

            try
            {
                int port = await _server.EnsureRunningAsync();
                _status.Text = "Loading the interface\u2026";
                await InitWebViewAsync(port);
                _webView.Visible = true;
                _webView.BringToFront();
                _loading.Visible = false;
                _webViewReady = true;
                PromptBrowserSetupOnce();
            }
            catch (WebView2RuntimeNotFoundException)
            {
                ShowError(
                    "Microsoft Edge WebView2 is required for the downloadX window.",
                    "Install the free WebView2 Runtime, then click Retry.",
                    true);
            }
            catch (Exception ex)
            {
                ShowError("downloadX could not start.", ex.Message, false);
            }
            finally
            {
                _starting = false;
                _progress.Visible = false;
            }
        }

        private async Task InitWebViewAsync(int port)
        {
            if (_webViewReady) return;
            string webviewData = Path.Combine(_dataDir, "webview2");
            Directory.CreateDirectory(webviewData);
            CoreWebView2Environment environment =
                await CoreWebView2Environment.CreateAsync(null, webviewData, null);
            await _webView.EnsureCoreWebView2Async(environment);

            CoreWebView2 core = _webView.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;
            core.Settings.IsZoomControlEnabled = true;
            core.NewWindowRequested += OnNewWindowRequested;
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            core.ProcessFailed += OnProcessFailed;
            core.WebMessageReceived += OnWebMessageReceived;
            core.Navigate("http://127.0.0.1:" + port + "/");
        }

        private void ShowError(string status, string detail, bool webViewMissing)
        {
            _status.Text = status;
            _detail.Text = detail;
            _detail.Visible = true;
            _retry.Visible = true;
            _webviewHelp.Visible = webViewMissing;
            _progress.Visible = false;
            _loading.Visible = true;
            _loading.BringToFront();
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        }

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            Uri uri;
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri)) return;
            if (uri.Scheme == "about") return;
            if (uri.IsLoopback && uri.Port == _server.Port) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        }

        private async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess) return;
            try
            {
                await _webView.CoreWebView2.ExecuteScriptAsync(
                    "if (document.activeElement && document.activeElement.classList && " +
                    "document.activeElement.classList.contains('skip-link')) document.activeElement.blur();");
            }
            catch
            {
                // The page may have navigated away already.
            }
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                var data = new JavaScriptSerializer()
                    .Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
                object type;
                if (data != null && data.TryGetValue("type", out type) &&
                    string.Equals(Convert.ToString(type), "browser-setup", StringComparison.Ordinal))
                {
                    ShowBrowserSetup();
                }
            }
            catch
            {
                // The page sent something that is not a host command.
            }
        }

        private void PromptBrowserSetupOnce()
        {
            if (_browser == null) return;
            string marker = Path.Combine(_dataDir, "browser-setup.json");
            if (BrowserSetupPrompted(marker)) return;
            if (_browser.DetectBrowsers().Count == 0) return;
            using (var form = new BrowserSetupForm(_browser, true)) form.ShowDialog(this);
            try
            {
                File.WriteAllText(marker,
                    "{\"prompted\":true,\"version\":" + BrowserSetupPromptVersion + "}");
            }
            catch
            {
                // A read-only data folder only means the prompt can appear again.
            }
        }

        private static bool BrowserSetupPrompted(string marker)
        {
            try
            {
                if (!File.Exists(marker)) return false;
                var data = new JavaScriptSerializer()
                    .Deserialize<Dictionary<string, object>>(File.ReadAllText(marker));
                object version;
                if (data != null && data.TryGetValue("version", out version))
                {
                    int value;
                    if (int.TryParse(Convert.ToString(version), out value) &&
                        value >= BrowserSetupPromptVersion) return true;
                }
            }
            catch
            {
                // An unreadable or old marker is treated as "not asked yet".
            }
            return false;
        }

        private void ShowBrowserSetup()
        {
            if (_browser == null || IsDisposed) return;
            using (var form = new BrowserSetupForm(_browser)) form.ShowDialog(this);
        }

        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            if (_exiting) return;
            try
            {
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                {
                    MessageBox.Show(
                        "The downloadX window stopped. downloadX will close now; " +
                        "start it again to continue.",
                        "downloadX", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    RequestExit();
                }
                else
                {
                    _webView.Reload();
                }
            }
            catch
            {
                // The control may already be gone.
            }
        }

        private static void OpenExternal(string target)
        {
            try
            {
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            }
            catch
            {
                // No default handler for this address.
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

        private NotifyIcon CreateTray()
        {
            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("Open downloadX");
            open.Font = new Font(open.Font, FontStyle.Bold);
            open.Click += (sender, e) => ShowFromTray();
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripSeparator());

            var pause = new ToolStripMenuItem("Pause all");
            pause.Click += async (sender, e) =>
            {
                await _server.PostAsync("/api/pause-all");
                ShowBalloon("downloadX", "All downloads paused.");
            };
            menu.Items.Add(pause);

            var resume = new ToolStripMenuItem("Resume all");
            resume.Click += async (sender, e) =>
            {
                await _server.PostAsync("/api/resume-all");
                ShowBalloon("downloadX", "All downloads resumed.");
            };
            menu.Items.Add(resume);

            menu.Items.Add(new ToolStripSeparator());
            var browser = new ToolStripMenuItem("Browser integration...");
            browser.Click += (sender, e) => ShowBrowserSetup();
            menu.Items.Add(browser);

            menu.Items.Add(new ToolStripSeparator());
            var downloads = new ToolStripMenuItem("Open downloads folder");
            downloads.Click += async (sender, e) => await OpenDownloadsFolderAsync();
            menu.Items.Add(downloads);

            var data = new ToolStripMenuItem("Open data folder");
            data.Click += (sender, e) => OpenFolder(_dataDir);
            menu.Items.Add(data);

            menu.Items.Add(new ToolStripSeparator());
            var exit = new ToolStripMenuItem("Exit downloadX");
            exit.Click += (sender, e) => RequestExit();
            menu.Items.Add(exit);

            var tray = new NotifyIcon();
            tray.Icon = Icon;
            tray.Text = "downloadX";
            tray.Visible = true;
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += (sender, e) => ShowFromTray();
            tray.BalloonTipClicked += (sender, e) => ShowFromTray();
            return tray;
        }

        private async Task OpenDownloadsFolderAsync()
        {
            string folder = string.Empty;
            string json = await _server.GetAsync("/api/settings");
            try
            {
                var settings = new JavaScriptSerializer()
                    .Deserialize<Dictionary<string, object>>(json);
                if (settings != null && settings.ContainsKey("rootDir"))
                {
                    folder = Convert.ToString(settings["rootDir"]);
                }
            }
            catch
            {
                // Fall back to the usual Downloads folder.
            }
            if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder))
            {
                folder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
            }
            OpenFolder(folder);
        }

        private void ShowBalloon(string title, string text)
        {
            if (_tray == null) return;
            _tray.BalloonTipTitle = title;
            _tray.BalloonTipText = text;
            _tray.BalloonTipIcon = ToolTipIcon.Info;
            _tray.ShowBalloonTip(4000);
        }

        internal void ShowFromTray()
        {
            if (IsDisposed) return;
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
            NativeMethods.SetForegroundWindow(Handle);
        }

        private void HideToTray()
        {
            Hide();
            if (!_trayTipShown)
            {
                _trayTipShown = true;
                ShowBalloon(
                    "downloadX is still running",
                    "Downloads continue in the background. Right-click the tray icon to exit.");
            }
        }

        internal void RequestExit()
        {
            if (_exiting) return;
            _exiting = true;
            Close();
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            SaveBounds();
            if (_exiting || e.CloseReason != CloseReason.UserClosing)
            {
                DisposeTray();
                return;
            }
            e.Cancel = true;
            HideToTray();
        }

        private void DisposeTray()
        {
            if (_tray == null) return;
            try
            {
                _tray.Visible = false;
                _tray.Dispose();
            }
            catch
            {
                // Already gone.
            }
            _tray = null;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) DisposeTray();
            base.Dispose(disposing);
        }

        private void CenterLoadingBox()
        {
            if (_loading == null || _loadingBox == null) return;
            _loadingBox.Left = Math.Max(0, (_loading.ClientSize.Width - _loadingBox.Width) / 2);
            _loadingBox.Top = Math.Max(0, (_loading.ClientSize.Height - _loadingBox.Height) / 2);
        }

        private void LoadBounds()
        {
            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            int width = Math.Min(1200, (int)(area.Width * 0.92));
            int height = Math.Min(800, (int)(area.Height * 0.92));
            Size = new Size(Math.Max(MinimumSize.Width, width), Math.Max(MinimumSize.Height, height));
            StartPosition = FormStartPosition.CenterScreen;

            try
            {
                string file = Path.Combine(_dataDir, "desktop.json");
                if (!File.Exists(file)) return;
                var data = new JavaScriptSerializer()
                    .Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
                if (data == null) return;

                int x = GetInt(data, "x");
                int y = GetInt(data, "y");
                int w = GetInt(data, "w");
                int h = GetInt(data, "h");
                if (w >= MinimumSize.Width && h >= MinimumSize.Height)
                {
                    var bounds = new Rectangle(x, y, w, h);
                    bool visible = false;
                    foreach (Screen screen in Screen.AllScreens)
                    {
                        if (screen.WorkingArea.IntersectsWith(bounds))
                        {
                            visible = true;
                            break;
                        }
                    }
                    if (visible)
                    {
                        StartPosition = FormStartPosition.Manual;
                        Bounds = bounds;
                    }
                }
                if (GetBool(data, "max")) WindowState = FormWindowState.Maximized;
            }
            catch
            {
                // A broken window state file only means a fresh start.
            }
        }

        private void SaveBounds()
        {
            try
            {
                Rectangle bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                if (bounds.Width < 200 || bounds.Height < 200) return;
                var data = new Dictionary<string, object>();
                data["x"] = bounds.X;
                data["y"] = bounds.Y;
                data["w"] = bounds.Width;
                data["h"] = bounds.Height;
                data["max"] = WindowState == FormWindowState.Maximized;

                string file = Path.Combine(_dataDir, "desktop.json");
                string temp = file + ".tmp";
                File.WriteAllText(temp, new JavaScriptSerializer().Serialize(data));
                if (File.Exists(file)) File.Delete(file);
                File.Move(temp, file);
            }
            catch
            {
                // Window placement is a convenience, not a requirement.
            }
        }

        private static int GetInt(Dictionary<string, object> data, string key)
        {
            object value;
            if (data.TryGetValue(key, out value) && value != null)
            {
                int number;
                if (int.TryParse(Convert.ToString(value), out number)) return number;
            }
            return 0;
        }

        private static bool GetBool(Dictionary<string, object> data, string key)
        {
            object value;
            if (data.TryGetValue(key, out value) && value != null)
            {
                bool flag;
                if (bool.TryParse(Convert.ToString(value), out flag)) return flag;
            }
            return false;
        }

        private static Icon LoadAppIcon()
        {
            try
            {
                Icon icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                return icon ?? SystemIcons.Application;
            }
            catch
            {
                return SystemIcons.Application;
            }
        }
    }

    internal static class ResourceExtractor
    {
        internal static void Extract(string name, string target)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            string temp = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
                {
                    if (input == null)
                    {
                        throw new InvalidOperationException("Missing embedded resource: " + name);
                    }
                    using (FileStream output = File.Create(temp))
                    {
                        input.CopyTo(output);
                    }
                }
                if (File.Exists(target)) File.Delete(target);
                File.Move(temp, target);
            }
            finally
            {
                try
                {
                    if (File.Exists(temp)) File.Delete(temp);
                }
                catch
                {
                    // The move already succeeded or the file is gone.
                }
            }
        }
    }

    internal static class NativeMethods
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool SetDllDirectory(string path);

        [DllImport("user32.dll")]
        internal static extern bool SetForegroundWindow(IntPtr window);
    }
}
