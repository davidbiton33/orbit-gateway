param([Parameter(Mandatory=$true)][string]$ProfileDir)
# Never hide all Chrome windows: only the root browser process whose command line
# contains the exact dedicated user-data-dir path. No remote debugging is enabled.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrbitWindow {
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr param);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
 public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);
 public static void Hide(uint wanted) {
  EnumWindows(delegate(IntPtr hwnd, IntPtr _) {
   uint pid; GetWindowThreadProcessId(hwnd,out pid);
   if(pid==wanted && IsWindowVisible(hwnd))ShowWindow(hwnd,0);
   return true;
  },IntPtr.Zero);
 }
}
'@
$needle = [IO.Path]::GetFullPath($ProfileDir).TrimEnd('\')
$end = (Get-Date).AddSeconds(15)
while((Get-Date) -lt $end) {
 try {
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe' OR Name = 'chromium.exe'" -ErrorAction Stop
  foreach($p in $procs) {
   $cmd = [string]$p.CommandLine
   if($cmd -and $cmd.IndexOf('--user-data-dir', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $cmd.IndexOf($needle,[StringComparison]::OrdinalIgnoreCase) -ge 0) {
    # Avoid matching neighboring profiles with a coincidental path prefix.
    $tail = $cmd.Substring($cmd.IndexOf($needle,[StringComparison]::OrdinalIgnoreCase)+$needle.Length)
    if($tail.Length -eq 0 -or $tail[0] -eq '"' -or [char]::IsWhiteSpace($tail[0])) {
     [OrbitWindow]::Hide([uint32]$p.ProcessId)
    }
   }
  }
 } catch { }
 Start-Sleep -Milliseconds 250
}
