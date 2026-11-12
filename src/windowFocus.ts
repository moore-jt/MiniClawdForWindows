import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Claude Code keeps ~/.claude/sessions/<pid>.json for each live session ({pid, sessionId, ...}).
 * That gives us the long-lived claude process for a session with zero cost to Claude itself.
 * Internal, undocumented format: returns null if anything is off, and callers fall back.
 */
function claudePidFor(sessionId: string): number | null {
  try {
    const dir = path.join(os.homedir(), '.claude', 'sessions');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j.sessionId === sessionId && Number.isInteger(j.pid)) return j.pid;
      } catch { /* unreadable or half-written file: skip */ }
    }
  } catch { /* no sessions dir */ }
  return null;
}

// Cache of session id -> terminal window handle, so repeat clicks skip the process-tree walk.
const hwndCache = new Map<string, number>();

// One long-lived hidden PowerShell. The P/Invoke code is compiled once at startup, so a click
// only has to send it one line ("<cachedHwnd> <pid>") and read one line back.
const PS_SERVER = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace W -Name N -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p);
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
'@
# The window of the console a process is attached to. Works for Windows Terminal (ConPTY) and
# classic conhost windows, including shells launched from Explorer whose ancestors own no window.
function ConsoleHwnd($p) {
  if (-not $p) { return [IntPtr]::Zero }
  [W.N]::FreeConsole() | Out-Null
  $c = [IntPtr]::Zero
  if ([W.N]::AttachConsole([uint32]$p)) { $c = [W.N]::GetConsoleWindow(); [W.N]::FreeConsole() | Out-Null }
  if ($c -eq [IntPtr]::Zero) { return $c }
  $r = [W.N]::GetAncestor($c, 3)
  if ($r -ne [IntPtr]::Zero -and [W.N]::IsWindowVisible($r)) { return $r }
  return [IntPtr]::Zero
}
function Focus($cached, $p, $resolveOnly) {
  $h = [IntPtr]::Zero
  if ($cached -ne 0 -and [W.N]::IsWindow([IntPtr]$cached)) { $h = [IntPtr]$cached }
  else {
    $h = ConsoleHwnd $p
  }
  if ($h -eq [IntPtr]::Zero) {
    $seen = @{}
    while ($p -and -not $seen[$p]) {
      $seen[$p] = $true
      $g = Get-Process -Id $p
      # explorer owns the desktop/taskbar window; matching it would focus the wrong thing.
      if ($g -and $g.ProcessName -eq 'explorer') { break }
      if ($g -and $g.MainWindowHandle -ne 0) { $h = $g.MainWindowHandle; break }
      $c = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
      if (-not $c) { break }
      $p = $c.ParentProcessId
    }
  }
  if ($h -eq [IntPtr]::Zero) { return 'fail' }
  if ($resolveOnly) { return 'ok:' + $h.ToInt64() }
  if ([W.N]::IsIconic($h)) { [W.N]::ShowWindow($h, 9) | Out-Null }
  # Tapping Alt lets SetForegroundWindow succeed even when Windows would otherwise only flash the taskbar.
  [W.N]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [W.N]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [W.N]::SetForegroundWindow($h) | Out-Null
  return 'ok:' + $h.ToInt64()
}
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim().Split(' ')
  $r = 'fail'
  try { $r = Focus ([int64]$parts[0]) ([int]$parts[1]) ($parts[2] -eq 'r') } catch { }
  [Console]::Out.WriteLine($r); [Console]::Out.Flush()
}
`;

interface Pending { resolve: (line: string) => void; timer: NodeJS.Timeout }
let ps: ChildProcess | null = null;
let psReady: Promise<void> | null = null;
let buf = '';
const pending: Pending[] = [];

function failAll() {
  for (const p of pending.splice(0)) { clearTimeout(p.timer); p.resolve('fail'); }
}

function startHelper(): Promise<void> {
  if (psReady) return psReady;
  buf = '';
  const encoded = Buffer.from(PS_SERVER, 'utf16le').toString('base64');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
  );
  ps = child;
  psReady = new Promise<void>((resolveReady) => {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'ready') { resolveReady(); continue; }
        const p = pending.shift();
        if (p) { clearTimeout(p.timer); p.resolve(line); }
      }
    });
    const dead = () => {
      if (ps === child) { ps = null; psReady = null; }
      resolveReady();
      failAll();
    };
    child.on('exit', dead);
    child.on('error', dead);
    child.stdin!.on('error', () => {});
  });
  return psReady;
}

/** Start compiling the helper now so the first click is fast. Call once at app start. */
export function warmUpFocusHelper() {
  startHelper();
}

export function stopFocusHelper() {
  ps?.kill();
  ps = null;
  psReady = null;
}

async function ask(cached: number, pid: number, resolveOnly = false): Promise<string> {
  await startHelper();
  const child = ps;
  if (!child || !child.stdin?.writable) return 'fail';
  return new Promise<string>((resolve) => {
    const entry: Pending = {
      resolve,
      // A wedged helper is killed and restarted on the next click.
      timer: setTimeout(() => { child.kill(); }, 8000),
    };
    pending.push(entry);
    child.stdin!.write(`${cached} ${pid}\n`);
  });
}

/**
 * Brings the terminal window that hosts a Claude Code session to the front.
 * Walks up from the live claude process to the first ancestor that owns a visible window.
 * Resolves true on success, false if no window was found. Never rejects.
 */
export async function focusSessionWindow(sessionId: string, hookPid: number | null): Promise<boolean> {
  const cached = hwndCache.get(sessionId) ?? 0;
  // The hook's own parent shell is gone by click time, so prefer the live claude process.
  const pid = claudePidFor(sessionId) ?? hookPid;
  if (!Number.isInteger(pid) && !cached) return false;

  try {
    const out = await ask(cached, Number.isInteger(pid) ? (pid as number) : 0);
    const m = /^ok:(\d+)$/.exec(out);
    if (!m) {
      hwndCache.delete(sessionId);
      console.error('[clawd] focus failed for', sessionId, 'pid', pid, out);
      return false;
    }
    hwndCache.set(sessionId, Number(m[1]));
    return true;
  } catch (e) {
    console.error('[clawd] focus error', e);
    return false;
  }
}

/**
 * Finds a session's terminal window ahead of time (without raising it) so the first click is instant.
 * Best effort: silently does nothing if the session isn't known to Claude Code yet.
 */
export async function prefetchSessionWindow(sessionId: string, hookPid: number | null): Promise<void> {
  if (hwndCache.has(sessionId)) return;
  const pid = claudePidFor(sessionId) ?? hookPid;
  if (!Number.isInteger(pid)) return;
  const m = /^ok:(\d+)$/.exec(await ask(0, pid as number, true));
  if (m) hwndCache.set(sessionId, Number(m[1]));
}

export function forgetSessionWindow(sessionId: string) {
  hwndCache.delete(sessionId);
}
