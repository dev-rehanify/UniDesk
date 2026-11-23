// UniDesk Secure Desktop helper (Windows).
//
//   UniDeskHelper.exe service            Windows service (LocalSystem). Localhost-only control port.
//                                        Commands: PING, SAS (Ctrl+Alt+Del), AGENT (start a capture agent).
//   UniDeskHelper.exe agent <port> <tok> Runs inside the user's session as SYSTEM. Captures whichever desktop
//                                        currently receives input (normal desktop, lock screen, UAC, Ctrl+Alt+Del
//                                        screen) and injects mouse/keyboard input into it.
//
// Security: both listeners bind to 127.0.0.1 only and require a random token. The service token is stored in
// %ProgramData%\UniDesk\service.token with an ACL that only SYSTEM and Administrators can read.
// Compile (C# 5 / .NET Framework 4, built into Windows):
//   csc /nologo /platform:x64 /target:exe /out:UniDeskHelper.exe /r:System.ServiceProcess.dll /r:System.Drawing.dll UniDeskHelper.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace UniDesk
{
    static class N
    {
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr desk);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr desk);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int len, out int needed);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("sas.dll")] public static extern void SendSAS(bool asUser);
        [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attrs, int impersonation, int type, out IntPtr newToken);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool SetTokenInformation(IntPtr token, int cls, ref uint info, int len);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr pa, IntPtr ta, bool inherit,
            uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

        public const uint DESKTOP_ALL = 0x01FF | 0x000F0000;
        public const int UOI_NAME = 2;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
        [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
        [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    }

    static class Util
    {
        public static string NewToken()
        {
            byte[] b = new byte[24];
            using (RandomNumberGenerator r = RandomNumberGenerator.Create()) r.GetBytes(b);
            return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
        }
        public static string ReadLine(Stream s)
        {
            List<byte> buf = new List<byte>();
            while (true)
            {
                int c = s.ReadByte();
                if (c < 0) return buf.Count > 0 ? Encoding.UTF8.GetString(buf.ToArray()) : null;
                if (c == '\n') return Encoding.UTF8.GetString(buf.ToArray()).TrimEnd('\r');
                buf.Add((byte)c);
                if (buf.Count > 8192) return null;
            }
        }
        public static void Write(Stream s, string line)
        {
            byte[] b = Encoding.UTF8.GetBytes(line + "\n");
            s.Write(b, 0, b.Length); s.Flush();
        }
        public static bool SafeEquals(string a, string b)
        {
            if (a == null || b == null || a.Length != b.Length) return false;
            int d = 0; for (int i = 0; i < a.Length; i++) d |= a[i] ^ b[i];
            return d == 0;
        }
    }

    // ===================================================================== SERVICE
    class Svc : ServiceBase
    {
        public const string NAME = "UniDeskService";
        public const int PORT = 47810;
        TcpListener listener; string token; Process agent; readonly object agentLock = new object();

        public Svc() { ServiceName = NAME; CanStop = true; }

        static string Dir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "UniDesk"); } }

        protected override void OnStart(string[] args)
        {
            token = Util.NewToken();
            WriteProtected(Path.Combine(Dir, "service.token"), token);
            listener = new TcpListener(IPAddress.Loopback, PORT);
            listener.Start();
            Thread t = new Thread(Accept); t.IsBackground = true; t.Start();
        }
        protected override void OnStop()
        {
            try { listener.Stop(); } catch { }
            KillAgent();
        }

        // token file readable only by SYSTEM + Administrators
        static void WriteProtected(string path, string content)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            DirectorySecurity ds = new DirectorySecurity();
            ds.SetAccessRuleProtection(true, false);
            ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(Path.GetDirectoryName(path), ds);
            File.WriteAllText(path, content);
        }

        void Accept()
        {
            while (true)
            {
                TcpClient c;
                try { c = listener.AcceptTcpClient(); } catch { return; }
                ThreadPool.QueueUserWorkItem(delegate { Handle(c); });
            }
        }

        void Handle(TcpClient c)
        {
            using (c)
            using (NetworkStream s = c.GetStream())
            {
                try
                {
                    c.ReceiveTimeout = 30000;
                    string first = Util.ReadLine(s);
                    if (first == null || !first.StartsWith("TOKEN ") || !Util.SafeEquals(first.Substring(6), token)) { Util.Write(s, "ERR auth"); return; }
                    string cmd;
                    while ((cmd = Util.ReadLine(s)) != null)
                    {
                        if (cmd == "PING") Util.Write(s, "OK");
                        else if (cmd == "SAS") { N.SendSAS(false); Util.Write(s, "OK"); }
                        else if (cmd == "AGENT") Util.Write(s, StartAgent());
                        else if (cmd == "STOPAGENT") { KillAgent(); Util.Write(s, "OK"); }
                        else Util.Write(s, "ERR unknown");
                    }
                }
                catch { }
            }
        }

        void KillAgent()
        {
            lock (agentLock)
            {
                try { if (agent != null && !agent.HasExited) agent.Kill(); } catch { }
                agent = null;
            }
        }

        // Launch "agent" as SYSTEM inside the active console session, so it can reach the lock screen / UAC desktop.
        string StartAgent()
        {
            lock (agentLock)
            {
                KillAgent();
                uint session = N.WTSGetActiveConsoleSessionId();
                if (session == 0xFFFFFFFF) return "ERR nosession";
                IntPtr tok, dup;
                if (!N.OpenProcessToken(N.GetCurrentProcess(), 0x000F01FF, out tok)) return "ERR token";
                try
                {
                    if (!N.DuplicateTokenEx(tok, 0x02000000, IntPtr.Zero, 2, 1, out dup)) return "ERR dup";
                    try
                    {
                        if (!N.SetTokenInformation(dup, 12, ref session, 4)) return "ERR session " + Marshal.GetLastWin32Error();
                        int port = 47811 + new Random().Next(0, 500);
                        string agentToken = Util.NewToken();
                        string exe = Process.GetCurrentProcess().MainModule.FileName;
                        N.STARTUPINFO si = new N.STARTUPINFO();
                        si.cb = Marshal.SizeOf(typeof(N.STARTUPINFO));
                        si.lpDesktop = "winsta0\\winlogon";
                        N.PROCESS_INFORMATION pi;
                        string cmdline = "\"" + exe + "\" agent " + port + " " + agentToken;
                        if (!N.CreateProcessAsUser(dup, null, cmdline, IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, Path.GetDirectoryName(exe), ref si, out pi))
                            return "ERR create " + Marshal.GetLastWin32Error();
                        N.CloseHandle(pi.hThread); N.CloseHandle(pi.hProcess);
                        try { agent = Process.GetProcessById(pi.dwProcessId); } catch { }
                        return "OK " + port + " " + agentToken;
                    }
                    finally { N.CloseHandle(dup); }
                }
                finally { N.CloseHandle(tok); }
            }
        }
    }

    // ===================================================================== AGENT
    static class Agent
    {
        static string token;
        static DateTime lastSeen = DateTime.UtcNow;

        public static void Run(int port, string tok)
        {
            token = tok;
            N.SetProcessDPIAware();
            TcpListener l = new TcpListener(IPAddress.Loopback, port);
            l.Start();
            // exit if nobody talks to us for 2 minutes (session ended, app closed)
            Thread watchdog = new Thread(delegate () { while (true) { Thread.Sleep(5000); if ((DateTime.UtcNow - lastSeen).TotalSeconds > 120) Environment.Exit(0); } });
            watchdog.IsBackground = true; watchdog.Start();
            while (true)
            {
                TcpClient c = l.AcceptTcpClient();
                Thread t = new Thread(delegate () { Serve(c); }); t.IsBackground = true; t.Start();
            }
        }

        static IntPtr curDesk = IntPtr.Zero;
        static string curName = "";

        // Attach this thread to whatever desktop is receiving input right now.
        static string SyncDesktop()
        {
            IntPtr d = N.OpenInputDesktop(0, false, N.DESKTOP_ALL);
            if (d == IntPtr.Zero) return curName == "" ? "Unknown" : curName;
            StringBuilder sb = new StringBuilder(256); int needed;
            N.GetUserObjectInformation(d, N.UOI_NAME, sb, sb.Capacity * 2, out needed);
            string name = sb.ToString();
            if (name != curName || curDesk == IntPtr.Zero)
            {
                if (N.SetThreadDesktop(d)) { if (curDesk != IntPtr.Zero) N.CloseDesktop(curDesk); curDesk = d; curName = name; }
                else N.CloseDesktop(d);
            }
            else N.CloseDesktop(d);
            return curName;
        }

        static void Serve(TcpClient c)
        {
            curDesk = IntPtr.Zero; curName = "";
            using (c)
            using (NetworkStream s = c.GetStream())
            {
                try
                {
                    string first = Util.ReadLine(s);
                    if (first == null || !first.StartsWith("TOKEN ") || !Util.SafeEquals(first.Substring(6), token)) { Util.Write(s, "ERR auth"); return; }
                    Util.Write(s, "OK");
                    string line;
                    while ((line = Util.ReadLine(s)) != null)
                    {
                        lastSeen = DateTime.UtcNow;
                        string[] p = line.Split(' ');
                        string desk = SyncDesktop();
                        switch (p[0])
                        {
                            case "DESK": Util.Write(s, "OK " + desk); break;
                            case "FRAME": SendFrame(s, desk, int.Parse(p[1]), int.Parse(p[2])); break;
                            case "MOVE": Mouse(0x8001, Parse(p[1]), Parse(p[2]), 0); Util.Write(s, "OK"); break;
                            case "DOWN": Mouse(Btn(p[1], true), -1, -1, 0); Util.Write(s, "OK"); break;
                            case "UP": Mouse(Btn(p[1], false), -1, -1, 0); Util.Write(s, "OK"); break;
                            case "WHEEL": Mouse(0x0800, -1, -1, int.Parse(p[1])); Util.Write(s, "OK"); break;
                            case "KEY": Key(ushort.Parse(p[1]), p[2] == "1"); Util.Write(s, "OK"); break;
                            case "QUIT": Util.Write(s, "OK"); Environment.Exit(0); break;
                            default: Util.Write(s, "ERR unknown"); break;
                        }
                    }
                }
                catch { }
            }
        }

        static double Parse(string v) { return double.Parse(v, System.Globalization.CultureInfo.InvariantCulture); }
        static uint Btn(string b, bool down)
        {
            if (b == "2") return down ? 0x0008u : 0x0010u;   // right
            if (b == "1") return down ? 0x0020u : 0x0040u;   // middle
            return down ? 0x0002u : 0x0004u;                 // left
        }

        static void Mouse(uint flags, double x, double y, int data)
        {
            N.INPUT[] i = new N.INPUT[1];
            i[0].type = 0;
            i[0].U.mi.dwFlags = flags;
            i[0].U.mi.mouseData = (uint)data;
            if (x >= 0) { i[0].U.mi.dx = (int)(Math.Max(0, Math.Min(1, x)) * 65535); i[0].U.mi.dy = (int)(Math.Max(0, Math.Min(1, y)) * 65535); }
            N.SendInput(1, i, Marshal.SizeOf(typeof(N.INPUT)));
        }

        static void Key(ushort vk, bool down)
        {
            N.INPUT[] i = new N.INPUT[1];
            i[0].type = 1;
            i[0].U.ki.wVk = vk;
            uint flags = down ? 0u : 0x0002u;
            // extended keys: arrows, Home/End/PgUp/PgDn, Insert/Delete, right Ctrl/Alt, Win
            if ((vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0xA3 || vk == 0xA5 || vk == 0x5B || vk == 0x5C) flags |= 0x0001;
            i[0].U.ki.dwFlags = flags;
            N.SendInput(1, i, Marshal.SizeOf(typeof(N.INPUT)));
        }

        static ImageCodecInfo jpeg;
        static void SendFrame(Stream s, string desk, int maxW, int quality)
        {
            int w = N.GetSystemMetrics(0), h = N.GetSystemMetrics(1); // primary monitor (where Windows shows the lock screen)
            byte[] bytes;
            using (Bitmap full = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(0, 0, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
                double sc = Math.Min(1.0, (double)maxW / w);
                int ow = Math.Max(1, (int)(w * sc)), oh = Math.Max(1, (int)(h * sc));
                using (Bitmap outBmp = new Bitmap(ow, oh, PixelFormat.Format24bppRgb))
                {
                    using (Graphics g = Graphics.FromImage(outBmp)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(full, 0, 0, ow, oh); }
                    if (jpeg == null) foreach (ImageCodecInfo ci in ImageCodecInfo.GetImageEncoders()) if (ci.MimeType == "image/jpeg") jpeg = ci;
                    EncoderParameters ep = new EncoderParameters(1);
                    ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(20, Math.Min(90, quality)));
                    using (MemoryStream ms = new MemoryStream()) { outBmp.Save(ms, jpeg, ep); bytes = ms.ToArray(); }
                }
            }
            Util.Write(s, "OK " + desk + " " + bytes.Length);
            s.Write(bytes, 0, bytes.Length); s.Flush();
        }
    }

    static class Program
    {
        static int Main(string[] args)
        {
            if (args.Length >= 1 && args[0] == "service") { ServiceBase.Run(new Svc()); return 0; }
            if (args.Length >= 3 && args[0] == "agent") { Agent.Run(int.Parse(args[1]), args[2]); return 0; }
            Console.WriteLine("UniDesk Secure Desktop helper. Usage: service | agent <port> <token>");
            return 1;
        }
    }
}
