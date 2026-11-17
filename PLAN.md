# Plan: Clawd on the Taskbar

**Repository:** https://github.com/moore-jt/MiniClawdForWindows (public, open source)

Completed work (milestones 1-5c, Tier 1) was cleared on 2026-11-16 after re-verification; see git history and README.md for what exists. In short: an Electron overlay strip above the taskbar, a localhost event bus (`127.0.0.1:47821`), Claude Code hooks plus installer, an NSIS Windows installer (v0.1.0), per-session animated clawds, hover tooltip, click-to-focus terminal, tray (Clear done / Launch at login / Claude Code hooks / Quit), stale-session GC, and Notification filtering.

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

### Milestone 6b: Dashboard (right-click a clawd)
A normal, resizable BrowserWindow (not the click-through strip) opened by right-clicking a clawd. A second right-click focuses the existing window. Also reachable from the tray ("Dashboard...").

**Data sources** (all read-only, local, nothing sent anywhere):
- *Token usage and model:* every hook payload carries `transcript_path`. Store it on `Session` (new field, set from any event). The transcript is JSONL; each assistant line has `message.model` and `message.usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`). Sum per session, tail-read incrementally (remember the byte offset) so large files are cheap. Dedupe by `message.id` (streamed messages repeat). Context-window fill = latest turn's input + cache tokens vs. the model's window.
- *Rollups:* today / last 7 days / all time, by model and by project (`cwd`), scanned from `~/.claude/projects/**/*.jsonl` on a background timer, cached to userData so startup is instant. Estimated cost from a small editable price table (clearly labelled "estimate").
- *Skills, plugins, MCP, hooks:* `~/.claude/settings.json` (`enabledPlugins`, `hooks`, `permissions`, `model`, `env`), `~/.claude/plugins/installed_plugins.json`, `~/.claude/skills/*/SKILL.md` plus project `.claude/skills` and `.mcp.json` for the selected session's `cwd`. Show name, source (user / project / plugin) and enabled state.
- *Session stats:* state, cwd, git branch, uptime, turns, tool-call counts, time spent working vs. waiting on you (derived from our own state transitions, kept in `SessionStore`).
- *App settings:* hooks installed, launch at login, port, version, event bus health (last event time, events/min).

**Layout:** header with the selected clawd and its state; tabs: Overview (tokens, context fill, model, cost estimate, sparkline of tokens over time), Usage (rollups and per-model/project breakdown), Skills and plugins, Settings (read-only view of the relevant Claude Code settings plus our app toggles). A session picker at top, defaulting to the clawd that was clicked.

**Implementation steps:**
1. Extend hook payload handling and `Session` with `transcriptPath`; unit-test the transitions.
2. `src/usage.ts`: incremental transcript parser and rollup cache, with tests against fixture JSONL (including malformed and half-written lines).
3. `src/claudeConfig.ts`: tolerant readers for settings, plugins, skills and MCP (same graceful-fallback rule as `claudeSessions.ts`: warn once on format drift, never throw).
4. `src/dashboard/` window (own HTML/CSS/TS, same CSP: no inline scripts) plus IPC through `preload.ts` (`dashboard:get`, `dashboard:subscribe` for live updates while open).
5. Renderer: right-click handler on a clawd opens the dashboard for that session. Make sure the strip's click-through regions still treat right-click correctly.
6. Extend `npm run snapshot` to render the dashboard headlessly for review.

**Open questions:**
- Transcript format is internal and undocumented (like the sessions files), so everything degrades to "n/a" rather than failing.
- Cost needs a price table that will go stale; decide whether to show cost at all or tokens only.
- Large histories: confirm the first full scan stays fast and off the main thread (worker or chunked async).

### Milestone 7: Robustness
- Multi-monitor, mixed-DPI and auto-hide taskbar handling (needs real hardware).

### Milestone 8: Stretch
- Sounds (mutable) and subagent mini-clawds via `SubagentStop`.

### Distribution and polish
- Installer: `npm run dist` builds an unsigned NSIS installer (hooks self-install on first run, staged in userData, removed on uninstall). v0.1.0 is published on GitHub Releases (cut with `gh release create`, which needs `gh` installed and logged in). Still to do: code signing, auto-update, and a check that the Setup exe works end to end on a clean machine.
- Hooks need `node` on PATH; consider running the hook via the app's own exe so Node isn't required.
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
- The installed app and `npm start` both use port 47821 and show the same tray icon. Quit one (tray > Quit) before running the other.
- Releases: bump `version` in package.json, `npm run dist`, then `gh release create vX.Y.Z "release/Mini Clawd Setup X.Y.Z.exe"`. In Git Bash, `gh` is at `/c/Program Files/GitHub CLI` and may not be on PATH.
- The strip is empty until an event arrives; use `npm run test:bus` to see it.
- `npm run snapshot <dir>` renders the renderer headlessly to PNGs.
