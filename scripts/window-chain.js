// Spike for milestone 5c: print the parent-process chain from a pid, with each
// process's main window title/handle, so we can see which ancestor is the terminal.
// Usage: node scripts/window-chain.js [pid]   (default: this script's parent)
const { execFileSync } = require('child_process');

const start = Number(process.argv[2]) || process.ppid;
const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$p = ${start}
$seen = @{}
while ($p -and -not $seen[$p]) {
  $seen[$p] = $true
  $c = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
  if (-not $c) { break }
  $g = Get-Process -Id $p
  "{0}|{1}|{2}|{3}" -f $p, $c.Name, $g.MainWindowHandle, $g.MainWindowTitle
  $p = $c.ParentProcessId
}`;
const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
console.log('pid\tname\thwnd\ttitle');
for (const line of out.split(/\r?\n/).filter(Boolean)) console.log(line.split('|').join('\t'));
