using System;
using System.IO;
using System.Net;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;

class DownloadXNativeHost
{
    const string NativeHostName = "com.downloadx.host";
    static readonly string BaseDir = AppDomain.CurrentDomain.BaseDirectory;

    static int Main(string[] args)
    {
        try
        {
            ServicePointManager.Expect100Continue = false;
            Stream stdin = Console.OpenStandardInput();
            Stream stdout = Console.OpenStandardOutput();
            while (true)
            {
                byte[] lenBuf = ReadExact(stdin, 4);
                if (lenBuf == null) break;
                int len = BitConverter.ToInt32(lenBuf, 0);
                if (len < 0 || len > 1048576) break;
                byte[] msgBuf = ReadExact(stdin, len);
                if (msgBuf == null) break;
                string reply = Handle(Encoding.UTF8.GetString(msgBuf));
                byte[] outBuf = Encoding.UTF8.GetBytes(reply);
                byte[] outLen = BitConverter.GetBytes(outBuf.Length);
                stdout.Write(outLen, 0, 4);
                stdout.Write(outBuf, 0, outBuf.Length);
                stdout.Flush();
            }
            return 0;
        }
        catch (Exception e)
        {
            try
            {
                byte[] outBuf = Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"" + Escape(e.Message) + "\"}");
                Stream stdout = Console.OpenStandardOutput();
                stdout.Write(BitConverter.GetBytes(outBuf.Length), 0, 4);
                stdout.Write(outBuf, 0, outBuf.Length);
                stdout.Flush();
            }
            catch { }
            return 1;
        }
    }

    static byte[] ReadExact(Stream s, int n)
    {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n)
        {
            int r = s.Read(buf, off, n - off);
            if (r <= 0) return null;
            off += r;
        }
        return buf;
    }

    static string Handle(string json)
    {
        string cmd = GetString(json, "cmd");
        if (cmd == "ping")
        {
            int port;
            string version;
            bool up = FindServer(out port, out version);
            return "{\"ok\":true,\"server\":" + (up ? "true" : "false") +
                   ",\"port\":" + (up ? port : 0) +
                   ",\"version\":\"" + Escape(version == null ? "" : version) + "\"}";
        }
        if (cmd == "add" || cmd == "open")
        {
            string url = GetString(json, "url");
            if (cmd == "add" && (url == null || url.Length == 0))
                return "{\"ok\":false,\"error\":\"missing url\"}";
            int port;
            string version;
            string err = null;
            if (!FindServer(out port, out version))
            {
                err = StartServer();
                if (err != null) return "{\"ok\":false,\"error\":\"" + Escape(err) + "\"}";
                if (!WaitForServer(12000, out port, out version))
                    return "{\"ok\":false,\"error\":\"downloadX did not start\"}";
            }
            if (cmd == "open")
            {
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo("http://127.0.0.1:" + port + "/");
                    psi.UseShellExecute = true;
                    Process.Start(psi);
                }
                catch { }
                return "{\"ok\":true,\"port\":" + port + "}";
            }
            string filename = GetString(json, "filename");
            string referer = GetString(json, "referer");
            string cookies = GetString(json, "cookies");
            StringBuilder body = new StringBuilder();
            body.Append("{\"url\":\"").Append(Escape(url)).Append("\"");
            if (!string.IsNullOrEmpty(filename)) body.Append(",\"filename\":\"").Append(Escape(filename)).Append("\"");
            if (!string.IsNullOrEmpty(referer)) body.Append(",\"referer\":\"").Append(Escape(referer)).Append("\"");
            if (!string.IsNullOrEmpty(cookies)) body.Append(",\"cookies\":\"").Append(Escape(cookies)).Append("\"");
            body.Append("}");
            string response = HttpPost("http://127.0.0.1:" + port + "/api/downloads", body.ToString());
            if (response == null) return "{\"ok\":false,\"error\":\"server request failed\"}";
            return "{\"ok\":true,\"port\":" + port + ",\"result\":" + response + "}";
        }
        return "{\"ok\":false,\"error\":\"unknown command\"}";
    }

    static string DataDir()
    {
        string envDir = Environment.GetEnvironmentVariable("DLX_DATA_DIR");
        if (!string.IsNullOrEmpty(envDir)) return envDir;

        string localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        try
        {
            string installFile = Path.Combine(BaseDir, "install.json");
            if (File.Exists(installFile))
            {
                string json = File.ReadAllText(installFile);
                if (GetBool(json, "perUserData")) return Path.Combine(localData, "downloadX", "data");
                string dir = GetString(json, "dataDir");
                if (!string.IsNullOrEmpty(dir)) return dir;
            }
        }
        catch { }
        return Path.Combine(localData, "downloadX", "data");
    }

    static int DefaultPort()
    {
        try
        {
            string envPort = Environment.GetEnvironmentVariable("DLX_PORT");
            int p;
            if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out p) && p > 0 && p <= 65535) return p;
        }
        catch { }
        try
        {
            string installFile = Path.Combine(BaseDir, "install.json");
            if (File.Exists(installFile))
            {
                int p = GetInt(File.ReadAllText(installFile), "port");
                if (p > 0 && p <= 65535) return p;
            }
        }
        catch { }
        return 9765;
    }

    static bool FindServer(out int port, out string version)
    {
        port = 0;
        version = null;
        List<int> ports = new List<int>();
        int basePort = DefaultPort();
        try
        {
            string portFile = Path.Combine(DataDir(), "port");
            if (File.Exists(portFile))
            {
                int p;
                if (int.TryParse(File.ReadAllText(portFile).Trim(), out p) && p > 0) ports.Add(p);
            }
        }
        catch { }
        for (int p = basePort; p <= basePort + 10 && p <= 65535; p++) if (!ports.Contains(p)) ports.Add(p);
        foreach (int p in ports)
        {
            string body = HttpGet("http://127.0.0.1:" + p + "/api/health", 1200);
            if (body != null && body.IndexOf("\"ok\":true", StringComparison.Ordinal) >= 0)
            {
                port = p;
                version = GetString(body, "version");
                return true;
            }
        }
        return false;
    }

    static bool WaitForServer(int timeoutMs, out int port, out string version)
    {
        DateTime end = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < end)
        {
            if (FindServer(out port, out version)) return true;
            Thread.Sleep(300);
        }
        port = 0;
        version = null;
        return false;
    }

    static string StartServer()
    {
        try
        {
            string vbs = Path.Combine(BaseDir, "downloadX-silent.vbs");
            if (!File.Exists(vbs)) return "downloadX-silent.vbs not found";
            ProcessStartInfo psi = new ProcessStartInfo("wscript.exe", "\"" + vbs + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = BaseDir;
            Process.Start(psi);
            return null;
        }
        catch (Exception e)
        {
            return e.Message;
        }
    }

    static string HttpGet(string url, int timeoutMs)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Proxy = null;
            req.KeepAlive = false;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            using (StreamReader reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                return reader.ReadToEnd();
        }
        catch { return null; }
    }

    static string HttpPost(string url, string body)
    {
        try
        {
            byte[] data = Encoding.UTF8.GetBytes(body);
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.ContentType = "application/json";
            req.ContentLength = data.Length;
            req.Timeout = 15000;
            req.ReadWriteTimeout = 15000;
            req.Proxy = null;
            req.KeepAlive = false;
            using (Stream s = req.GetRequestStream()) s.Write(data, 0, data.Length);
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            using (StreamReader reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                return reader.ReadToEnd();
        }
        catch { return null; }
    }

    static bool GetBool(string json, string key)
    {
        if (json == null) return false;
        int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
        if (i < 0) return false;
        i = json.IndexOf(':', i + key.Length + 2);
        if (i < 0) return false;
        i++;
        while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
        return i < json.Length && json.Substring(i).StartsWith("true", StringComparison.Ordinal);
    }

    static int GetInt(string json, string key)
    {
        if (json == null) return 0;
        int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
        if (i < 0) return 0;
        i = json.IndexOf(':', i + key.Length + 2);
        if (i < 0) return 0;
        i++;
        while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
        int start = i;
        while (i < json.Length && (char.IsDigit(json[i]) || (i == start && json[i] == '-'))) i++;
        int value;
        return int.TryParse(json.Substring(start, i - start), out value) ? value : 0;
    }

    static string GetString(string json, string key)
    {
        if (json == null) return null;
        int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
        if (i < 0) return null;
        i = json.IndexOf(':', i + key.Length + 2);
        if (i < 0) return null;
        i++;
        while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
        if (i >= json.Length || json[i] != '"') return null;
        i++;
        StringBuilder sb = new StringBuilder();
        while (i < json.Length)
        {
            char c = json[i++];
            if (c == '"') break;
            if (c == '\\' && i < json.Length)
            {
                char e = json[i++];
                if (e == 'n') sb.Append('\n');
                else if (e == 'r') sb.Append('\r');
                else if (e == 't') sb.Append('\t');
                else if (e == 'b') sb.Append('\b');
                else if (e == 'f') sb.Append('\f');
                else if (e == 'u' && i + 3 < json.Length)
                {
                    int code;
                    if (int.TryParse(json.Substring(i, 4), System.Globalization.NumberStyles.HexNumber, null, out code))
                    {
                        sb.Append((char)code);
                        i += 4;
                    }
                }
                else sb.Append(e);
            }
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static string Escape(string s)
    {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') { sb.Append('\\'); sb.Append(c); }
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.ToString();
    }
}
