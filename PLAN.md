# Plan: Clawd on the Taskbar

**Repository:** https://github.com/moore-jt/MiniClawdForWindows (public, open source)

## Feasibility

Windows 11 has no supported way to draw custom content inside the taskbar. Two workable approaches, combined:

1. **Overlay strip (main feature).** A transparent, frameless, always-on-top, click-through window sits along the top edge of the taskbar. Each agent gets a mini clawd standing on it, like a desktop pet.
2. **Native taskbar button (fallback).** The app uses `ITaskbarList3` to flash the button and show an overlay badge when an agent finishes. Useful when the strip is hidden behind a fullscreen app.

## How It Knows What the Agents Are Doing

Claude Code hooks fire at the right moments. Each hook receives JSON on stdin with `session_id`, `cwd` and `transcript_path`.

| Hook | Clawd state |
|------|-------------|
| `SessionStart` | Clawd appears and idles |
| `UserPromptSubmit` | Working: typing or digging animation |
| `Notification` | Needs you: waves, with a "!" bubble |
| `Stop` | Done: celebrates, shows a ✓, then rests and stays until you click it |
| `SessionEnd` | Clawd walks off and is removed |

A tiny hook script POSTs `{session_id, event, cwd, pid}` to `localhost:<port>`, in the background and with a short timeout. If the app isn't running, it fails silently, so Claude is never slowed down or blocked. Subagents (`SubagentStop`) can be shown as even smaller clawds later.

## Stack

- **Electron + TypeScript.** Transparent windows, `setIgnoreMouseEvents`, and sprite animation with CSS or canvas are all straightforward. C#/WPF would be lighter, but animating it takes more work. Tauri is a middle option.
- **Sprites:** a small original pixel-art sheet (idle, work, wave, celebrate, walk-off). Avoid copying Anthropic's official art.
- **Local state:** a `Map<session_id, {state, cwd, pid, lastSeen}>` in the main process.

## Milestones

1. **Skeleton (done, verified):** an overlay window pinned just above the taskbar using `screen.getPrimaryDisplay()` bounds minus `workArea`, with one static clawd.
2. **Event bus (done):** a localhost HTTP listener, and a curl test that adds and removes clawds.
3. **Hook script and installer (done, installed into `~/.claude/settings.json` and verified in a real session):** a command that merges the hooks into `~/.claude/settings.json`, with an uninstall option.
4. **State machine and animations (done, verified on screen):** idle, working, needs-you, done, each with a transition.
5. **Layout (built; hover untested by user):** clawds spaced along the strip, a hover tooltip with the project folder name (from `cwd`), and a tint or hat per project so agents are distinguishable.
5b. **Movable clawds (planned, depends on 5's hover hit-testing):** let the user reposition the clawd strip instead of it being locked above the taskbar.
   - **Click-through hit-testing (shared with the tooltip and click-to-dismiss):** the window stays click-through with `setIgnoreMouseEvents(true, {forward: true})`. The renderer gets forwarded `mousemove` events, and when the pointer is over a clawd it tells main (IPC) to switch to `setIgnoreMouseEvents(false)`, then back to click-through when it leaves. Everything outside the clawds keeps passing clicks to the apps underneath.
   - **Window shrinks to fit:** today the window spans the full work-area width, so moving it sideways is meaningless. Change it to hug the clawds (width = N clawds x slot + padding, resized with `setBounds` as sessions come and go), anchored at a saved left/bottom position.
   - **Edit mode, not always-draggable:** a tray item "Move clawds" (milestone 6) toggles edit mode. While on, the strip shows a dashed outline and can be dragged anywhere with pointer events (the renderer sends drag deltas, main calls `setBounds`, clamped to the display's `workArea`). Leaving edit mode locks it, so a normal click can't move it by accident. A "Reset position" tray item returns it to above-the-taskbar-left.
   - **Persistence:** `settings.json` in Electron's `userData`: `{displayId, offsetX, offsetBottom}`, stored relative to the display's `workArea`, so it survives resolution, DPI and taskbar changes. Optional snap to the taskbar edge and screen edges within ~12px.
   - **Robustness:** if the saved display is unplugged, fall back to the primary display's default spot. Re-clamp on `display-metrics-changed`. Mixed-DPI multi-monitor `setBounds` rounding needs testing.
   - **Later:** drag a single clawd out of the strip, or a vertical layout.
   - **Decided:** the whole strip moves together (not each clawd independently).
6. **Native extras:** taskbar flash and overlay badge on done, plus a tray icon with quit, mute and "clear done".
7. **Robustness:**
   - Sessions with a dead PID or no events for N minutes are garbage-collected.
   - Handle multi-monitor setups, an auto-hidden taskbar, DPI scaling, and fullscreen apps (hide the strip or fall back to the badge).
   - Launch at login.
8. **Stretch goals:** click a clawd to focus its terminal window (needs a window-handle lookup from the PID), sounds, and subagent mini-clawds.

## Risks

- **Taskbar position:** Win11 only officially supports the bottom, so start there. Auto-hide changes where the strip should sit.
- **Parallel sessions with identical `cwd`:** `session_id` is the key, so they stay separate. Tint by session, not by folder.
- **Hook latency:** the hook must return immediately. Test it with the app off.

## Status (for resuming work)

**Milestones 1-4: done and verified.** The user confirmed on screen that the clawd strip sits at the bottom left just above the taskbar, that the milestone 4 animations look right, and that a real new Claude Code session makes a clawd appear (so the hooks installed in `~/.claude/settings.json` work end to end on Windows). The event bus was also verified over HTTP (`/health` 200, valid events 204, bad events/bodies 400). Not explicitly confirmed: that clicks pass through the strip to apps underneath.

Current state: the app and hooks work end to end, but it is still a bare strip: no tooltip, tint per session, tray icon, quit option, movable position or launch-at-login. The next work is milestones 5, 5b and 6.

What exists:
- `src/main.ts`: transparent, frameless, always-on-top, click-through, non-focusable window. 48px tall, full width of the primary display's `workArea`, bottom-aligned (just above the taskbar). Re-pins on `display-metrics-changed`, `display-added`, `display-removed`. Wires the session store, event bus and IPC together.
- `src/eventBus.ts`: HTTP listener on `127.0.0.1:47821` (localhost only). `POST /event` with `{session_id, event, cwd?, pid?}` returns 204; `GET /health` returns 200; 400 for bad input or unknown events; 64KB body cap.
- `src/sessions.ts`: `SessionStore` (`Map<session_id, Session>`). Maps `SessionStart`->idle, `UserPromptSubmit`->working, `Notification`->needs-you, `Stop`->done, `SessionEnd`->remove. Emits upsert/remove changes.
- `src/preload.ts`: exposes `window.clawd` (`onSessions`, `onChange`, `ready`) via `contextBridge`.
- `src/renderer/`: `index.html` (clawd SVG in a `<template>`), `renderer.ts` (adds/updates/removes clawds, 56px spacing, tooltip text in `data-tip` = last folder of `cwd`), `style.css` (per-state animations, see below).
- `scripts/copy-static.js`: copies non-TS renderer files into `dist/` after `tsc`.
- `hooks/clawd-hook.js`: the Claude Code hook. Reads the hook JSON on stdin, POSTs `{session_id, event: hook_event_name, cwd, pid: process.ppid}` to the bus. Prints nothing, always exits 0, 400ms timeout plus a hard 600ms stop. Measured ~113ms total with the app off (mostly Node startup).
- `scripts/hooks-installer.js` (`npm run hooks:install` / `hooks:uninstall`, options `--settings <path>`, `--dry-run`): merges one hook entry per event (`SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, `SessionEnd`) into `~/.claude/settings.json`. Entries are identified by `clawd-hook.js` in the command; existing hooks are kept, install is idempotent, the file is backed up to `settings.json.clawd-backup-<timestamp>` before each write, invalid JSON aborts. Command uses forward slashes and quotes, e.g. `node "C:/.../hooks/clawd-hook.js"`. Tested against a scratch copy, then installed for real into the user's `~/.claude/settings.json` (backup: `settings.json.clawd-backup-2026-11-11T23-58-40-745Z` next to it); formatting is normalized to 2-space JSON. The hooks are live for every new Claude Code session on this machine; `npm run hooks:uninstall` removes only Clawd's entries. If the repo is moved, re-run `npm run hooks:install` because the hook command holds an absolute path.
- Milestone 4 animations live in `src/renderer/style.css` (stepped CSS keyframes on SVG parts defined in `index.html`'s `<template>`): idle = slow bob + blink; working = fast bounce, typing arms, shuffling feet; needs-you = hop, waving arm, flashing red "!"; done = 3 jumps with arms up, then sleepy eyes and a green check that stays; appear = 4-step pop-in; leaving (SessionEnd) = walks right 160px and fades, then the DOM node is removed (`renderer.ts`). The state machine itself is just last-event-wins in `sessions.ts`.
- `scripts/snapshot.js` (`npm run snapshot`, writes PNGs to a dir you pass as the first arg): renders the real renderer in a hidden window with fake sessions so animations can be checked without watching the screen.
- `scripts/test-bus.js` (`npm run test:bus`): sends a sequence of events; `node scripts/test-bus.js clear` removes the leftover test clawd.

How to run: `npm install`, then `npm start` (builds, then launches Electron). Then `npm run test:bus` in a second terminal. Quit with Ctrl+C in the terminal (no tray or quit option until milestone 6).

Gotchas:
- Electron's postinstall binary download can fail or stall on this machine. If `npx electron .` says "Electron failed to install correctly", run `node node_modules/electron/install.js` (takes several minutes).
- The Content-Security-Policy in `index.html` is `default-src 'self'`; inline scripts will be blocked, so put renderer JS in its own file.
- The Clawd folder is its own git repo (`origin` = this project's GitHub). The parent home-directory repo has a different remote; never run git from outside this folder.
- `.claude/` and `New Text Document.txt` are git-ignored on purpose.
- `main.ts` takes a single-instance lock. If `npm start` prints "already running; exiting this copy" (plus cache 'Access is denied' errors), stray Electron processes are alive: run `taskkill //F //IM electron.exe` (double slashes in Git Bash) and start again. Backgrounded `npm start` runs leave orphans when stopped.
- The strip is empty until an event arrives (no static clawd since milestone 2); use `npm run test:bus` to see it.

- The event bus port is fixed at 47821 (`CLAWD_PORT` env var is honored by the test script only). If the port is taken the bus logs an error and the app keeps running without it.

**Milestone 5 built, awaiting on-screen check:** click-through hit-testing (renderer reports pointer-over-clawd via IPC `strip:hover`, main toggles `setIgnoreMouseEvents`), hover tooltip (`folder · state`), and a per-session body color (palette in `renderer.ts`, lowest free slot per session, set via CSS var `--tint`). The strip window is now 72px tall to leave room for the tooltip. Verified by typecheck and snapshot only; hover and click-through still need a real check. Next: 5b (movable strip, whole strip moves together: decided), then 6 (tray with quit/mute/clear-done/"Move clawds", taskbar flash/badge).

Known design gaps to decide along the way:
- A `Notification` after `Stop` (Claude's idle prompt) flips a done clawd to needs-you.
- "Done stays until you click it" needs the same click handling as the tooltip, since the strip is fully click-through today. Until then, done stays until the next event.
- Stopping a backgrounded `npm start` can leave orphan Electron processes; a tray "Quit" (milestone 6) would fix the need for `taskkill`.

## Decision

**Decided:** the Electron overlay strip comes first (milestones 1-4 are built on it). The native taskbar button route is kept as a later fallback (milestone 6): it's less charming, since it's one icon per window rather than a strip of clawds.
