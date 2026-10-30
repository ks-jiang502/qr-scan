// 扫码器 · 单文件 exe 启动器
// 把前端资源全部嵌进 exe，运行时用本地 TCP 服务提供给浏览器；
// 然后以 Edge 的 --app 模式打开，得到一个看起来像独立应用的窗口。
// 目标框架：.NET Framework 4.x（Win10/11 自带），编译：csc.exe，产物单个 exe、无外部依赖。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Program
{
    // 请求路径的扩展名 → MIME
    static readonly Dictionary<string, string> ContentTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { ".html", "text/html; charset=utf-8" },
        { ".css", "text/css; charset=utf-8" },
        { ".js", "application/javascript; charset=utf-8" },
        { ".png", "image/png" },
        { ".ico", "image/x-icon" },
        { ".json", "application/json; charset=utf-8" },
    };

    static int _lastActivity;
    static int _port;
    static string _logPath;

    static int Main(string[] args)
    {
        int startPort = 7457;
        int idleMinutes = 20;
        bool noOpen = false;

        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--no-open") noOpen = true;
            else if (a == "--port" && i + 1 < args.Length) int.TryParse(args[++i], out startPort);
            else if (a == "--idle" && i + 1 < args.Length) int.TryParse(args[++i], out idleMinutes);
            else if (a.StartsWith("--port=")) int.TryParse(a.Substring(7), out startPort);
            else if (a.StartsWith("--idle=")) int.TryParse(a.Substring(7), out idleMinutes);
        }
        if (startPort <= 0) startPort = 7457;
        if (idleMinutes <= 0) idleMinutes = 20;

        _logPath = ResolveLogPath();
        Log("启动，参数 -port " + startPort + " -idle " + idleMinutes + " -noOpen " + noOpen);

        // 已经有一个扫码器在跑：直接把窗口指过去，不再启第二个服务
        if (!noOpen && IsOurServer(startPort))
        {
            Log("端口 " + startPort + " 上已有扫码器实例，直接打开窗口");
            OpenAppWindow("http://127.0.0.1:" + startPort + "/");
            return 0;
        }

        TcpListener listener = ListenOnFreePort(startPort);
        if (listener == null)
        {
            Log("所有端口都被占用，放弃启动");
            return 2;
        }

        _port = ((IPEndPoint)listener.LocalEndpoint).Port;
        string url = "http://127.0.0.1:" + _port + "/";
        Log("服务就绪 " + url);

        _lastActivity = Environment.TickCount;
        Thread t = new Thread(delegate () { AcceptLoop(listener); });
        t.IsBackground = true;
        t.Start();

        if (!noOpen) OpenAppWindow(url);

        // 没有页面活动就一直等，超时后自己退出，避免进程残留在后台
        while (true)
        {
            Thread.Sleep(15000);
            int idleMs = unchecked(Environment.TickCount - _lastActivity);
            if (idleMs < 0) idleMs = 0;
            if (idleMs >= idleMinutes * 60000L)
            {
                Log("空闲 " + idleMinutes + " 分钟，退出");
                break;
            }
        }

        try { listener.Stop(); } catch { }
        return 0;
    }

    /// <summary>探测某个端口上跑的是不是我们自己的服务（返回的首页里有页面标题）</summary>
    static bool IsOurServer(int port)
    {
        try
        {
            using (TcpClient client = new TcpClient())
            {
                IAsyncResult ar = client.BeginConnect(IPAddress.Loopback, port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(400)) return false;
                client.EndConnect(ar);

                using (NetworkStream stream = client.GetStream())
                {
                    stream.ReadTimeout = 1500;
                    byte[] req = Encoding.ASCII.GetBytes("GET /index.html HTTP/1.0\r\nConnection: close\r\n\r\n");
                    stream.Write(req, 0, req.Length);

                    MemoryStream ms = new MemoryStream();
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = stream.Read(buf, 0, buf.Length)) > 0) ms.Write(buf, 0, n);

                    string text = Encoding.UTF8.GetString(ms.ToArray());
                    return text.IndexOf("扫码器", StringComparison.Ordinal) >= 0;
                }
            }
        }
        catch
        {
            return false;
        }
    }

    static TcpListener ListenOnFreePort(int startPort)
    {
        for (int i = 0; i < 20; i++)
        {
            int p = startPort + i;
            try
            {
                TcpListener l = new TcpListener(IPAddress.Loopback, p);
                l.Start();
                return l;
            }
            catch (SocketException)
            {
                // 端口被占，换下一个
            }
        }
        return null;
    }

    static void AcceptLoop(TcpListener listener)
    {
        while (true)
        {
            TcpClient client;
            try { client = listener.AcceptTcpClient(); }
            catch { return; }

            TcpClient c = client;
            ThreadPool.QueueUserWorkItem(delegate (object _) { Handle(c); });
        }
    }

    static void Handle(TcpClient client)
    {
        try
        {
            using (client)
            using (NetworkStream stream = client.GetStream())
            {
                stream.ReadTimeout = 8000;
                stream.WriteTimeout = 15000;

                string head = ReadHeaders(stream);
                if (head == null) return;

                string[] lines = head.Split('\n');
                if (lines.Length == 0) return;

                string[] parts = lines[0].Trim().Split(' ');
                if (parts.Length < 2) return;

                string method = parts[0].ToUpperInvariant();
                if (method != "GET" && method != "HEAD")
                {
                    WriteResponse(stream, 405, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Method Not Allowed"), false);
                    return;
                }

                string path = parts[1];
                int q = path.IndexOf('?');
                if (q >= 0) path = path.Substring(0, q);
                if (path.Length == 0 || path == "/") path = "/index.html";
                try { path = Uri.UnescapeDataString(path); } catch { }

                _lastActivity = Environment.TickCount;
                if (path.EndsWith(".html", StringComparison.OrdinalIgnoreCase) || path == "/")
                    Log("页面请求 " + path);

                byte[] body = LoadResource(path);
                if (body == null)
                {
                    Log("404 " + path);
                    WriteResponse(stream, 404, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("404 Not Found"), method == "HEAD");
                    return;
                }

                string type;
                if (!ContentTypes.TryGetValue(Path.GetExtension(path), out type)) type = "application/octet-stream";
                WriteResponse(stream, 200, type, body, method == "HEAD");
            }
        }
        catch (Exception ex)
        {
            Log("请求处理异常: " + ex.GetType().Name + " " + ex.Message);
        }
    }

    /// <summary>读到空行为止，只取请求头（页面极小，不需要读 body）</summary>
    static string ReadHeaders(NetworkStream stream)
    {
        byte[] buffer = new byte[4096];
        StringBuilder sb = new StringBuilder();
        while (sb.Length < 65536)
        {
            int n = stream.Read(buffer, 0, buffer.Length);
            if (n <= 0) break;
            sb.Append(Encoding.ASCII.GetString(buffer, 0, n));
            if (sb.ToString().IndexOf("\r\n\r\n", StringComparison.Ordinal) >= 0) break;
        }
        return sb.Length == 0 ? null : sb.ToString();
    }

    /// <summary>把 /app/decode.js 这样的路径映射到内嵌资源 www.app.decode.js</summary>
    static byte[] LoadResource(string path)
    {
        string clean = path.TrimStart('/').Replace('/', '.');
        if (clean.Length == 0) return null;
        string name = "www." + clean;

        Assembly asm = Assembly.GetExecutingAssembly();
        using (Stream st = asm.GetManifestResourceStream(name))
        {
            if (st == null) return null;
            using (MemoryStream ms = new MemoryStream())
            {
                st.CopyTo(ms);
                return ms.ToArray();
            }
        }
    }

    static void WriteResponse(NetworkStream stream, int status, string contentType, byte[] body, bool headOnly)
    {
        string reason = status == 200 ? "OK" : (status == 404 ? "Not Found" : "Method Not Allowed");
        StringBuilder sb = new StringBuilder();
        sb.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason).Append("\r\n");
        sb.Append("Content-Type: ").Append(contentType).Append("\r\n");
        sb.Append("Content-Length: ").Append(body.Length).Append("\r\n");
        sb.Append("Cache-Control: no-cache, no-store, must-revalidate\r\n");
        sb.Append("Pragma: no-cache\r\n");
        sb.Append("Connection: close\r\n");
        sb.Append("\r\n");

        byte[] head = Encoding.ASCII.GetBytes(sb.ToString());
        stream.Write(head, 0, head.Length);
        if (!headOnly) stream.Write(body, 0, body.Length);
        stream.Flush();
    }

    static void OpenAppWindow(string url)
    {
        string browser = FindBrowser();
        bool opened = false;
        try
        {
            if (browser != null)
            {
                string appArgs = "--app=\"" + url + "\" --window-size=1220,900";

                // 先用一套独立的浏览器配置：不碰用户正在用的那个 Edge。
                // 用户自己的配置被占用时，新起的浏览器进程会直接退出（code=21），一个窗口都不开。
                string profile = ProfileDir();
                if (profile != null)
                {
                    ClearProfileLocks(profile);
                    string isolArgs = "--user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check --disable-sync --disable-features=msEdgeOnboarding,msEdgeFirstRunExperience,msEdgeSyncPromo,msImplicitSignin --disable-component-update " + appArgs;
                    Log("用浏览器打开 " + browser + "（独立配置 " + profile + "）");
                    if (LaunchAndWait(browser, isolArgs, 20000)) opened = true;
                }

                // 兜底一：用用户自己的配置再试一次
                if (!opened)
                {
                    Log("独立配置没起来，改用当前配置再试");
                    if (LaunchAndWait(browser, appArgs, 10000)) opened = true;
                }

                if (!opened) Log("两种方式都没看到窗口，改用系统默认浏览器");
            }
            else
            {
                Log("没找到 Edge/Chrome，交给系统默认浏览器");
            }

            if (!opened)
            {
                try { Process.Start(url); opened = true; }
                catch (Exception ex2) { Log("默认浏览器也失败: " + ex2.Message); }
            }
        }
        catch (Exception ex)
        {
            Log("打开窗口失败: " + ex.Message);
        }

        if (!opened)
        {
            // 一个窗口都没出来时给个明确提示，别让用户以为双击没反应
            try
            {
                System.Windows.Forms.MessageBox.Show(
                    "程序已经在后台运行，但没能自动打开窗口。\r\n\r\n请手动在浏览器里打开：\r\n" + url,
                    "扫码器", System.Windows.Forms.MessageBoxButtons.OK,
                    System.Windows.Forms.MessageBoxIcon.Information);
            }
            catch { }
        }
    }


    /// <summary>启动浏览器并等一会儿，看看界面上是不是真的出现了这个应用的窗口</summary>
    static bool LaunchAndWait(string exe, string args, int waitMs)
    {
        Process p = null;
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(exe);
            psi.Arguments = args;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            p = Process.Start(psi);
        }
        catch (Exception ex)
        {
            Log("启动失败: " + ex.Message);
            return false;
        }

        // 全新配置目录首次启动要初始化，慢的时候七八秒才出窗口，所以耐心等
        int waited = 0;
        while (waited < waitMs)
        {
            Thread.Sleep(400);
            waited += 400;
            if (AppWindowExists())
            {
                Log("窗口已出现（" + waited + "ms）");
                return true;
            }
            if (p != null && p.HasExited && waited >= 1600)
            {
                int code = 0;
                try { code = p.ExitCode; } catch { }
                Log("浏览器进程提前退出 code=" + code);
                return AppWindowExists();
            }
        }
        Log("等待 " + waitMs + "ms 仍没看到窗口");
        return AppWindowExists();
    }

    /// <summary>界面上有没有本应用的窗口（标题里带页面标题）</summary>
    static bool AppWindowExists()
    {
        bool found = false;
        try
        {
            EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                StringBuilder sb = new StringBuilder(512);
                GetWindowText(hWnd, sb, sb.Capacity);
                string title = sb.ToString();
                // 认两种标题：页面加载完是"扫码器 · 截图识别二维码"，
                // 还在加载时浏览器会把地址显示成"127.0.0.1_/"这种东西。
                // 只要窗口出来了就算成功 —— 页面是本地服务，马上就渲染好。
                if (title.IndexOf("扫码器 ·", StringComparison.Ordinal) >= 0 ||
                    title.IndexOf("127.0.0.1_", StringComparison.Ordinal) >= 0)
                {
                    found = true;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
        }
        catch (Exception ex)
        {
            Log("检查窗口失败: " + ex.Message);
            return true; // 检查不了就当成功，避免把好端端的窗口流程搞错
        }
        return found;
    }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    /// <summary>删掉 Chromium 留在配置目录里的单例锁文件</summary>
    static void ClearProfileLocks(string profile)
    {
        if (string.IsNullOrEmpty(profile)) return;
        string[] names = new string[] { "SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile" };
        foreach (string name in names)
        {
            try
            {
                string path = Path.Combine(profile, name);
                if (File.Exists(path)) { File.Delete(path); Log("清掉 " + name); }
                else if (Directory.Exists(path)) { Directory.Delete(path, true); Log("清掉目录 " + name); }
            }
            catch (Exception ex)
            {
                Log("清理 " + name + " 失败: " + ex.Message);
            }
        }
    }

    /// <summary>给这个应用专用的浏览器配置目录；逐个尝试候选位置，失败时返回 null</summary>
    static string ProfileDir()
    {
        List<string> candidates = new List<string>();
        try
        {
            candidates.Add(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "qrscan", "profile"));
        }
        catch { }
        try { candidates.Add(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "profile")); } catch { }
        try { candidates.Add(Path.Combine(Path.GetTempPath(), "qrscan-profile")); } catch { }

        foreach (string dir in candidates)
        {
            try
            {
                string parent = Path.GetDirectoryName(dir);
                if (!Directory.Exists(parent)) Directory.CreateDirectory(parent);
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                Log("配置目录 " + dir);
                return dir;
            }
            catch (Exception ex)
            {
                Log("配置目录不可用 " + dir + " -> " + ex.GetType().Name + ": " + ex.Message);
            }
        }
        return null;
    }

    static string FindBrowser()
    {
        // 优先 Edge，其次 Chrome —— 两者都支持 --app 独立窗口
        string[] rels = new string[]
        {
            "Microsoft\\Edge\\Application\\msedge.exe",
            "Google\\Chrome\\Application\\chrome.exe",
        };
        string[] bases = new string[]
        {
            Environment.GetEnvironmentVariable("PROGRAMFILES(X86)"),
            Environment.GetEnvironmentVariable("PROGRAMFILES"),
            Environment.GetEnvironmentVariable("LOCALAPPDATA"),
        };
        foreach (string rel in rels)
        {
            foreach (string b in bases)
            {
                if (string.IsNullOrEmpty(b)) continue;
                string p = Path.Combine(b, rel);
                if (File.Exists(p)) return p;
            }
        }
        return null;
    }

    /// <summary>日志优先放 exe 旁边，写不了再退回临时目录</summary>
    static string ResolveLogPath()
    {
        try
        {
            string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (!string.IsNullOrEmpty(dir))
            {
                string p = Path.Combine(dir, "qrscan.log");
                using (FileStream probe = new FileStream(p, FileMode.Append, FileAccess.Write, FileShare.ReadWrite)) { }
                return p;
            }
        }
        catch { }
        return Path.Combine(Path.GetTempPath(), "qrscan.log");
    }

    static void Log(string message)
    {
        try
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + "\r\n";
            File.AppendAllText(_logPath, line, Encoding.UTF8);
        }
        catch { }
    }
}
