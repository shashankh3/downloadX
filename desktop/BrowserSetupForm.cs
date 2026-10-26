using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace DownloadX
{
    internal sealed class BrowserSetupForm : Form
    {
        private readonly BrowserIntegration _browser;
        private readonly Label _status;
        private readonly TextBox _folder;

        internal BrowserSetupForm(BrowserIntegration browser) : this(browser, false) { }

        internal BrowserSetupForm(BrowserIntegration browser, bool firstRun)
        {
            _browser = browser;
            Text = firstRun ? "Install browser extension" : "Browser integration";
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            ClientSize = new Size(680, 590);
            Font = new Font("Segoe UI", 9F);
            BackColor = Color.FromArgb(246, 247, 251);

            var title = new Label();
            title.Text = firstRun ? "Install the browser extension" : "Grab downloads from Chrome and Edge";
            title.Font = new Font("Segoe UI", 16F, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(24, 32, 48);
            title.Left = 24;
            title.Top = 18;
            title.Width = 632;
            title.Height = 32;
            Controls.Add(title);

            var intro = new Label();
            intro.Text = firstRun
                ? "To capture downloads from Chrome and Edge, install the downloadX extension. " +
                  "The extension and native helper are already prepared. This is a one-time setup: " +
                  "choose your browser below and click Set up. You can also do this later from the tray menu."
                : "downloadX uses a small browser extension to take over downloads. " +
                  "The extension and the native helper are already prepared. Chrome and Edge do not " +
                  "allow a local extension to install silently, so the last step is a one-time " +
                  "\"Load unpacked\" in each browser.";
            intro.Left = 24;
            intro.Top = 56;
            intro.Width = 632;
            intro.Height = 54;
            intro.ForeColor = Color.FromArgb(80, 92, 110);
            Controls.Add(intro);

            var list = new FlowLayoutPanel();
            list.Left = 24;
            list.Top = 116;
            list.Width = 632;
            list.Height = 236;
            list.FlowDirection = FlowDirection.TopDown;
            list.WrapContents = false;
            list.AutoScroll = true;
            list.BackColor = Color.White;
            list.BorderStyle = BorderStyle.FixedSingle;
            list.Padding = new Padding(8);
            Controls.Add(list);

            List<BrowserInfo> browsers = _browser.DetectBrowsers();
            if (browsers.Count == 0)
            {
                var none = new Label();
                none.Text = "Chrome, Edge, Brave, Chromium and Firefox were not found on this PC.";
                none.AutoSize = true;
                none.ForeColor = Color.FromArgb(120, 130, 145);
                none.Margin = new Padding(8);
                list.Controls.Add(none);
            }
            else
            {
                foreach (BrowserInfo info in browsers) list.Controls.Add(CreateBrowserRow(info));
            }

            var note = new Label();
            note.Text = "In a hurry? \"Open with downloadX\" starts a separate browser profile with the " +
                "extension already loaded. Your normal browser profile still needs the one-time setup.";
            note.Left = 24;
            note.Top = 364;
            note.Width = 632;
            note.Height = 36;
            note.ForeColor = Color.FromArgb(80, 92, 110);
            Controls.Add(note);

            var folderLabel = new Label();
            folderLabel.Text = "Chrome / Edge extension folder";
            folderLabel.Left = 24;
            folderLabel.Top = 410;
            folderLabel.Width = 300;
            folderLabel.Height = 20;
            folderLabel.ForeColor = Color.FromArgb(80, 92, 110);
            Controls.Add(folderLabel);

            _folder = new TextBox();
            _folder.ReadOnly = true;
            _folder.Text = _browser.ChromeExtensionFolder;
            _folder.Left = 24;
            _folder.Top = 432;
            _folder.Width = 500;
            _folder.Height = 25;
            Controls.Add(_folder);

            var copy = new Button();
            copy.Text = "Copy path";
            copy.Left = 532;
            copy.Top = 430;
            copy.Width = 124;
            copy.Height = 29;
            copy.Click += (sender, e) =>
            {
                if (_browser.CopyChromeFolder()) SetStatus("The extension folder is on your clipboard.");
                else SetStatus("Could not access the clipboard. Select the path above and copy it manually.");
            };
            Controls.Add(copy);

            var open = new Button();
            open.Text = "Open extension folder";
            open.Left = 24;
            open.Top = 476;
            open.Width = 160;
            open.Height = 32;
            open.Click += (sender, e) => _browser.OpenExtensionFolder();
            Controls.Add(open);

            var close = new Button();
            close.Text = firstRun ? "Not now" : "Close";
            close.Left = 506;
            close.Top = 476;
            close.Width = 150;
            close.Height = 32;
            close.DialogResult = DialogResult.OK;
            close.Click += (sender, e) => Close();
            Controls.Add(close);

            _status = new Label();
            _status.Left = 24;
            _status.Top = 520;
            _status.Width = 632;
            _status.Height = 48;
            _status.ForeColor = Color.FromArgb(80, 92, 110);
            Controls.Add(_status);
            RefreshStatus();
        }

        private Control CreateBrowserRow(BrowserInfo browser)
        {
            var row = new Panel();
            row.Width = 596;
            row.Height = 42;
            row.Margin = new Padding(0, 0, 0, 6);

            var name = new Label();
            name.Text = browser.Name;
            name.Left = 8;
            name.Top = 12;
            name.Width = 150;
            name.Height = 20;
            name.Font = new Font("Segoe UI", 9.5F, FontStyle.Bold);
            row.Controls.Add(name);

            var setup = new Button();
            setup.Text = "Set up";
            setup.Left = 166;
            setup.Top = 7;
            setup.Width = 82;
            setup.Height = 28;
            setup.Click += (sender, e) =>
            {
                if (_browser.OpenExtensionsPage(browser)) ShowInstructions(browser);
                else SetStatus("Could not open " + browser.Name + ": " + _browser.LastError);
            };
            row.Controls.Add(setup);

            if (!browser.IsFirefox)
            {
                var quick = new Button();
                quick.Text = "Open with downloadX";
                quick.Left = 256;
                quick.Top = 7;
                quick.Width = 160;
                quick.Height = 28;
                quick.Click += (sender, e) =>
                {
                    string error;
                    if (_browser.OpenWithExtension(browser, out error))
                    {
                        SetStatus(browser.Name + " opened with the downloadX extension in a separate profile.");
                    }
                    else
                    {
                        MessageBox.Show(this, error, "downloadX", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                };
                row.Controls.Add(quick);
            }
            else
            {
                var hint = new Label();
                hint.Text = "Temporary add-on";
                hint.Left = 256;
                hint.Top = 12;
                hint.Width = 160;
                hint.Height = 20;
                hint.ForeColor = Color.FromArgb(120, 130, 145);
                row.Controls.Add(hint);
            }
            return row;
        }

        private void ShowInstructions(BrowserInfo browser)
        {
            string text;
            if (browser.IsFirefox)
            {
                text = "The about:debugging page is open and the Firefox extension folder is on your clipboard.\r\n\r\n" +
                    "1. Click \"Load Temporary Add-on...\".\r\n" +
                    "2. Open the folder and select manifest.json.\r\n\r\n" +
                    "Firefox removes temporary add-ons when the browser closes.";
            }
            else
            {
                text = "The extensions page is open and the extension folder is on your clipboard.\r\n\r\n" +
                    "1. Turn on Developer mode (top right).\r\n" +
                    "2. Click \"Load unpacked\".\r\n" +
                    "3. Paste the folder path (Ctrl+V) and press Enter.\r\n\r\n" +
                    "Chrome and Edge require this one-time step for local extensions.";
            }
            MessageBox.Show(this, text, "Set up " + browser.Name,
                MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void RefreshStatus()
        {
            string helper = _browser.IsNativeHostRegistered()
                ? "Native helper: registered."
                : "Native helper: not registered (run downloadX again or check the data folder permissions).";
            string error = string.IsNullOrEmpty(_browser.LastError)
                ? string.Empty
                : "  Setup warning: " + _browser.LastError;
            SetStatus(helper + error);
        }

        private void SetStatus(string text)
        {
            if (_status == null) return;
            _status.Text = text;
        }
    }
}
