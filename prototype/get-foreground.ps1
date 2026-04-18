Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
}
"@
$hwnd = [FgWin]::GetForegroundWindow()
$pid  = 0
[FgWin]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
$p = Get-Process -Id $pid -ErrorAction SilentlyContinue
if ($p) { $p.MainModule.ModuleName.ToLower() } else { "unknown" }
