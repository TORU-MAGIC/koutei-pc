param(
    [switch]$SelfTest,
    [int]$PollMilliseconds = 5,
    [int]$BridgePort = 8765
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MagicCueRemoteGuard
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const int VK_VOLUME_DOWN = 0xAE;
    private const int VK_VOLUME_UP = 0xAF;
    private const byte VK_F8 = 0x77;
    private const byte VK_F9 = 0x78;
    private const int CooldownMilliseconds = 650;
    private const int DEVICE_STATE_ACTIVE = 0x00000001;

    private static readonly Guid EmptyGuid = Guid.Empty;
    private static LowLevelKeyboardProc _proc = HookCallback;
    private static IntPtr _hookId = IntPtr.Zero;
    private static List<EndpointLock> _endpointLocks = new List<EndpointLock>();
    private static Thread _volumeThread;
    private static Thread _bridgeThread;
    private static volatile bool _running;
    private static long _lastActionTicks;
    private static readonly object Gate = new object();
    private static readonly List<CommandItem> Commands = new List<CommandItem>();
    private static long _nextCommandId;

    public static int VolumeDownCount { get; private set; }
    public static int VolumeUpCount { get; private set; }
    public static int LockedEndpointCount { get { lock (Gate) { return _endpointLocks.Count; } } }
    public static float LockedVolume
    {
        get
        {
            lock (Gate)
            {
                return _endpointLocks.Count > 0 ? _endpointLocks[0].LockedVolume : 0;
            }
        }
    }

    private sealed class EndpointLock
    {
        public string Id;
        public string Name;
        public IAudioEndpointVolume EndpointVolume;
        public float LockedVolume;
    }

    private sealed class CommandItem
    {
        public long Id;
        public string Action;
        public string Reason;
    }

    public static bool Start(int pollMilliseconds, int bridgePort)
    {
        if (_running)
        {
            return true;
        }

        _endpointLocks = GetDefaultEndpointLocks();
        if (_endpointLocks.Count == 0)
        {
            return false;
        }

        _running = true;

        _hookId = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, IntPtr.Zero, 0);
        if (_hookId == IntPtr.Zero)
        {
            _running = false;
            return false;
        }

        int interval = Math.Max(10, pollMilliseconds);
        _volumeThread = new Thread(() => WatchVolume(interval));
        _volumeThread.IsBackground = true;
        _volumeThread.Name = "MagicCueVolumeGuard";
        _volumeThread.Start();

        _bridgeThread = new Thread(() => RunBridge(bridgePort));
        _bridgeThread.IsBackground = true;
        _bridgeThread.Name = "MagicCueCommandBridge";
        _bridgeThread.Start();
        return true;
    }

    public static bool Stop()
    {
        _running = false;

        if (_volumeThread != null && _volumeThread.IsAlive)
        {
            _volumeThread.Join(250);
        }

        if (_bridgeThread != null && _bridgeThread.IsAlive)
        {
            _bridgeThread.Join(250);
        }

        if (_hookId == IntPtr.Zero)
        {
            return true;
        }

        bool result = UnhookWindowsHookEx(_hookId);
        _hookId = IntPtr.Zero;
        return result;
    }

    public static sbyte WaitForMessage()
    {
        MSG message;
        return GetMessage(out message, IntPtr.Zero, 0, 0);
    }

    private static void WatchVolume(int pollMilliseconds)
    {
        while (_running)
        {
            EndpointLock[] locks;
            lock (Gate)
            {
                locks = _endpointLocks.ToArray();
            }

            foreach (EndpointLock endpointLock in locks)
            {
                try
                {
                    float current = ReadVolume(endpointLock.EndpointVolume);
                    float difference = current - endpointLock.LockedVolume;
                    if (Math.Abs(difference) >= 0.0015f)
                    {
                        WriteVolume(endpointLock.EndpointVolume, endpointLock.LockedVolume);
                        if (difference < 0)
                        {
                            TriggerVolumeDown("volume restored");
                        }
                        else
                        {
                            TriggerVolumeUp("volume restored");
                        }
                    }
                }
                catch
                {
                    // Keep the show helper alive even if Windows audio temporarily rejects a read.
                }
            }

            Thread.Sleep(pollMilliseconds);
        }
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int message = wParam.ToInt32();
            KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            int vkCode = (int)data.vkCode;

            if (vkCode == VK_VOLUME_DOWN || vkCode == VK_VOLUME_UP)
            {
                if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN)
                {
                    if (vkCode == VK_VOLUME_DOWN)
                    {
                        TriggerVolumeDown("blocked");
                    }
                    else
                    {
                        TriggerVolumeUp("blocked");
                    }
                }

                if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN || message == WM_KEYUP || message == WM_SYSKEYUP)
                {
                    TryRestoreLockedVolume();
                    return (IntPtr)1;
                }
            }
        }

        return CallNextHookEx(_hookId, nCode, wParam, lParam);
    }

    private static void TriggerVolumeDown(string reason)
    {
        if (!TryBeginAction())
        {
            return;
        }

        VolumeDownCount++;
        EnqueueCommand("minus", reason);
        SendVirtualKey(VK_F8);
        TryRestoreLockedVolume();
        Console.WriteLine(DateTime.Now.ToString("HH:mm:ss") + "  - button -> F8 fade out (" + reason + ")");
    }

    private static void TriggerVolumeUp(string reason)
    {
        if (!TryBeginAction())
        {
            return;
        }

        VolumeUpCount++;
        EnqueueCommand("plus", reason);
        SendVirtualKey(VK_F9);
        TryRestoreLockedVolume();
        Console.WriteLine(DateTime.Now.ToString("HH:mm:ss") + "  + button -> F9 start (" + reason + ")");
    }

    private static void EnqueueCommand(string action, string reason)
    {
        lock (Gate)
        {
            Commands.Add(new CommandItem
            {
                Id = ++_nextCommandId,
                Action = action,
                Reason = reason
            });

            if (Commands.Count > 80)
            {
                Commands.RemoveRange(0, Commands.Count - 80);
            }
        }
    }

    private static bool TryBeginAction()
    {
        lock (Gate)
        {
            long now = DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
            if (now - _lastActionTicks < CooldownMilliseconds)
            {
                return false;
            }

            _lastActionTicks = now;
            return true;
        }
    }

    private static void SendVirtualKey(byte virtualKey)
    {
        keybd_event(virtualKey, 0, 0, UIntPtr.Zero);
        keybd_event(virtualKey, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    private static void TryRestoreLockedVolume()
    {
        EndpointLock[] locks;
        lock (Gate)
        {
            locks = _endpointLocks.ToArray();
        }

        foreach (EndpointLock endpointLock in locks)
        {
            try
            {
                WriteVolume(endpointLock.EndpointVolume, endpointLock.LockedVolume);
            }
            catch
            {
            }
        }
    }

    private static float ReadVolume(IAudioEndpointVolume endpointVolume)
    {
        float level;
        Marshal.ThrowExceptionForHR(endpointVolume.GetMasterVolumeLevelScalar(out level));
        return level;
    }

    private static void WriteVolume(IAudioEndpointVolume endpointVolume, float level)
    {
        Guid context = EmptyGuid;
        Marshal.ThrowExceptionForHR(endpointVolume.SetMasterVolumeLevelScalar(level, ref context));
    }

    private static List<EndpointLock> GetDefaultEndpointLocks()
    {
        List<EndpointLock> locks = new List<EndpointLock>();
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        AddActiveEndpointLocks(enumerator, locks);
        AddDefaultEndpointLock(enumerator, ERole.eConsole, "console", locks);
        AddDefaultEndpointLock(enumerator, ERole.eMultimedia, "multimedia", locks);
        AddDefaultEndpointLock(enumerator, ERole.eCommunications, "communications", locks);
        return locks;
    }

    private static void AddActiveEndpointLocks(IMMDeviceEnumerator enumerator, List<EndpointLock> locks)
    {
        try
        {
            IMMDeviceCollection devices;
            Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(EDataFlow.eRender, DEVICE_STATE_ACTIVE, out devices));
            uint count;
            Marshal.ThrowExceptionForHR(devices.GetCount(out count));

            for (uint index = 0; index < count; index++)
            {
                IMMDevice device;
                Marshal.ThrowExceptionForHR(devices.Item(index, out device));
                AddEndpointLockFromDevice(device, "active-" + index, locks);
            }
        }
        catch
        {
        }
    }

    private static void AddDefaultEndpointLock(IMMDeviceEnumerator enumerator, ERole role, string name, List<EndpointLock> locks)
    {
        try
        {
            IMMDevice device;
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, role, out device));
            AddEndpointLockFromDevice(device, name, locks);
        }
        catch
        {
        }
    }

    private static void AddEndpointLockFromDevice(IMMDevice device, string name, List<EndpointLock> locks)
    {
        string id = "";
        try
        {
            device.GetId(out id);
        }
        catch
        {
            id = name;
        }

        foreach (EndpointLock existing in locks)
        {
            if (String.Equals(existing.Id, id, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
        }

        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object endpoint;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out endpoint));
        IAudioEndpointVolume endpointVolume = (IAudioEndpointVolume)endpoint;
        float locked = ReadVolume(endpointVolume);

        locks.Add(new EndpointLock
        {
            Id = id,
            Name = name,
            EndpointVolume = endpointVolume,
            LockedVolume = locked
        });
    }

    private static void RunBridge(int bridgePort)
    {
        TcpListener listener = null;
        try
        {
            listener = new TcpListener(IPAddress.Loopback, bridgePort);
            listener.Start();
            Console.WriteLine("Command bridge is listening on http://127.0.0.1:" + bridgePort + "/commands");

            while (_running)
            {
                if (!listener.Pending())
                {
                    Thread.Sleep(25);
                    continue;
                }

                using (TcpClient client = listener.AcceptTcpClient())
                {
                    HandleBridgeClient(client);
                }
            }
        }
        catch (Exception error)
        {
            Console.WriteLine("Command bridge stopped: " + error.Message);
        }
        finally
        {
            if (listener != null)
            {
                listener.Stop();
            }
        }
    }

    private static void HandleBridgeClient(TcpClient client)
    {
        NetworkStream stream = client.GetStream();
        byte[] buffer = new byte[2048];
        int bytesRead = stream.Read(buffer, 0, buffer.Length);
        string request = bytesRead > 0 ? Encoding.ASCII.GetString(buffer, 0, bytesRead) : "";
        long since = ParseSince(request);
        string body = BuildCommandsJson(since);
        byte[] bodyBytes = Encoding.UTF8.GetBytes(body);
        string header =
            "HTTP/1.1 200 OK\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: Content-Type\r\n" +
            "Cache-Control: no-store\r\n" +
            "Content-Length: " + bodyBytes.Length + "\r\n" +
            "\r\n";

        byte[] headerBytes = Encoding.ASCII.GetBytes(header);
        stream.Write(headerBytes, 0, headerBytes.Length);
        stream.Write(bodyBytes, 0, bodyBytes.Length);
    }

    private static long ParseSince(string request)
    {
        int start = request.IndexOf("since=", StringComparison.OrdinalIgnoreCase);
        if (start < 0)
        {
            return 0;
        }

        start += 6;
        int end = start;
        while (end < request.Length && request[end] >= '0' && request[end] <= '9')
        {
            end++;
        }

        long value;
        return long.TryParse(request.Substring(start, end - start), out value) ? value : 0;
    }

    private static string BuildCommandsJson(long since)
    {
        List<CommandItem> pending = new List<CommandItem>();
        long latestId = 0;

        lock (Gate)
        {
            latestId = _nextCommandId;
            foreach (CommandItem command in Commands)
            {
                if (command.Id > since)
                {
                    pending.Add(command);
                }
            }
        }

        StringBuilder json = new StringBuilder();
        json.Append("{\"latestId\":");
        json.Append(latestId);
        json.Append(",\"commands\":[");
        for (int i = 0; i < pending.Count; i++)
        {
            if (i > 0)
            {
                json.Append(",");
            }

            json.Append("{\"id\":");
            json.Append(pending[i].Id);
            json.Append(",\"action\":\"");
            json.Append(EscapeJson(pending[i].Action));
            json.Append("\",\"reason\":\"");
            json.Append(EscapeJson(pending[i].Reason));
            json.Append("\"}");
        }

        json.Append("]}");
        return json.ToString();
    }

    private static string EscapeJson(string value)
    {
        return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    private enum EDataFlow
    {
        eRender = 0,
        eCapture = 1,
        eAll = 2
    }

    private enum ERole
    {
        eConsole = 0,
        eMultimedia = 1,
        eCommunications = 2
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator
    {
    }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(EDataFlow dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
        int RegisterEndpointNotificationCallback(IntPtr pClient);
        int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [ComImport]
    [Guid("0BD7A1BE-7A1A-44DB-8397-C0D44F3F2F4C")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        int GetCount(out uint pcDevices);
        int Item(uint nDevice, out IMMDevice ppDevice);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        int GetState(out int pdwState);
    }

    [ComImport]
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr pNotify);
        int UnregisterControlChangeNotify(IntPtr pNotify);
        int GetChannelCount(out uint channelCount);
        int SetMasterVolumeLevel(float levelDB, ref Guid eventContext);
        int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        int GetMasterVolumeLevel(out float levelDB);
        int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint channelNumber, float levelDB, ref Guid eventContext);
        int SetChannelVolumeLevelScalar(uint channelNumber, float level, ref Guid eventContext);
        int GetChannelVolumeLevel(uint channelNumber, out float levelDB);
        int GetChannelVolumeLevelScalar(uint channelNumber, out float level);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool isMuted, ref Guid eventContext);
        int GetMute(out bool isMuted);
        int GetVolumeStepInfo(out uint step, out uint stepCount);
        int VolumeStepUp(ref Guid eventContext);
        int VolumeStepDown(ref Guid eventContext);
        int QueryHardwareSupport(out uint hardwareSupportMask);
        int GetVolumeRange(out float volumeMinDB, out float volumeMaxDB, out float volumeIncrementDB);
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern sbyte GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

$started = [MagicCueRemoteGuard]::Start($PollMilliseconds, $BridgePort)
if (-not $started) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Could not start the volume-key guard. Win32 error: $errorCode"
}

try {
    $lockedPercent = [Math]::Round([MagicCueRemoteGuard]::LockedVolume * 100)
    Write-Host "Magic Show Cue remote helper is running."
    Write-Host "Current Windows volume is locked at $lockedPercent% across $([MagicCueRemoteGuard]::LockedEndpointCount) output endpoint(s)."
    Write-Host "Volume Down is blocked/restored and sent to the app as F8."
    Write-Host "Volume Up   is blocked/restored and sent to the app as F9."
    Write-Host "The app also receives commands directly through http://127.0.0.1:$BridgePort/commands."
    Write-Host "Keep this window open during the show. Press Ctrl+C to stop."

    if ($SelfTest) {
        Write-Host "Self-test OK: keyboard hook and volume guard started."
        return
    }

    while ([MagicCueRemoteGuard]::WaitForMessage() -ne 0) {
        # The hook callback and volume watcher do the actual conversion.
    }
} finally {
    [void][MagicCueRemoteGuard]::Stop()
}
