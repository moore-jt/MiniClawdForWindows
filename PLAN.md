# Plan: Clawd on the Taskbar

**Repository:** https://github.com/moore-jt/MiniClawdForWindows (public, open source)

Completed work (milestones 1-5c, Tier 1) was cleared on 2026-11-16 after re-verification; see git history and README.md for what exists. In short: an Electron overlay strip above the taskbar, a localhost event bus (`127.0.0.1:47821`), Claude Code hooks plus installer, per-session animated clawds, hover tooltip, click-to-focus terminal, tray (Clear done / Launch at login / Quit), stale-session GC, and Notification filtering.

## Open Work

### Needs your on-screen check
- Hover tooltip look, and clicks passing through the strip to apps underneath.
- Click-to-focus speedup (persistent PowerShell) feels fast.
- Esc-interrupt: does a clawd stay on `working`? If `Stop` fires, the 15-min working timeout in `src/gc.ts` is unnecessary; if not, shorten it or add `PreToolUse`/`PostToolUse` hooks.
- Known gap: after approving a permission prompt, the clawd stays needs-you until `Stop` (nothing fires in between).

### Milestone 6: Native extras
- Taskbar flash and overlay badge (`ITaskbarList3`) on done.
- Tray Mute.
- Hide the strip or fall back to the badge under fullscreen apps.

### Milestone 7: Robustness
- Multi-monitor, mixed-DPI and auto-hide taskbar handling (needs real hardware).

### Milestone 8: Stretch
- Sounds (mutable) and subagent mini-clawds via `SubagentStop`.

### Distribution and polish
- Packaging: `electron-builder` installer or portable `.exe` that registers the hooks itself; publish as a GitHub release.
- Resilient hook install: copy `clawd-hook.js` to a stable location (e.g. `%APPDATA%`) so moving the repo doesn't break `settings.json`.
- Port conflicts: port 47821 is fixed; make it configurable (and written into the hook) or add a fallback.
- Guard against format drift in `~/.claude/sessions/<pid>.json` (undocumented; warns once today, add graceful fallback).
- Windows Terminal tab picking (UI Automation or title match); today only the window is raised.

### Engineering hygiene
- Unit tests for `SessionStore` transitions and the installer's merge/uninstall logic (only `test:bus` exists).
- GitHub Actions running `typecheck`, build and tests.

## Risks
- **Taskbar position:** Win11 officially supports only the bottom; auto-hide changes where the strip should sit.
- **Hook latency:** the hook must return immediately (measured ~110-180ms, mostly Node startup).
- **Elevated terminals** can't be focused by a non-elevated app.

## Gotchas
- If Electron "failed to install correctly", run `node node_modules/electron/install.js` (takes minutes).
- The CSP in `index.html` is `default-src 'self'`: no inline scripts.
- The Clawd folder is its own git repo; never run git from the parent home-directory repo.
- `.claude/` and `New Text Document.txt` are git-ignored on purpose.
- Single-instance lock: if `npm start` says "already running", run `taskkill //F //IM electron.exe` (Git Bash) and retry.
- The strip is empty until an event arrives; use `npm run test:bus` to see it.
- `npm run snapshot <dir>` renders the renderer headlessly to PNGs.
