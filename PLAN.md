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

1. **Skeleton (done, pending visual check):** an overlay window pinned just above the taskbar using `screen.getPrimaryDisplay()` bounds minus `workArea`, with one static clawd.
2. **Event bus (done):** a localhost HTTP listener, and a curl test that adds and removes clawds.
3. **Hook script and installer:** a command that merges the hooks into `~/.claude/settings.json`, with an uninstall option.
4. **State machine and animations:** idle, working, needs-you, done, each with a transition.
5. **Layout:** clawds spaced along the strip, a hover tooltip with the project folder name (from `cwd`), and a tint or hat per project so agents are distinguishable.
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

**Milestones 1 and 2: code complete.** Milestone 2 (event bus) was verified over HTTP: `/health` returns 200, valid events return 204, bad events/bodies return 400, no app errors. The user confirmed on screen: a clawd appears at the bottom left just above the taskbar and turns green on `Stop`. Click-through and removal were not explicitly confirmed.

What exists:
- `src/main.ts`: transparent, frameless, always-on-top, click-through, non-focusable window. 48px tall, full width of the primary display's `workArea`, bottom-aligned (just above the taskbar). Re-pins on `display-metrics-changed`, `display-added`, `display-removed`. Wires the session store, event bus and IPC together.
- `src/eventBus.ts`: HTTP listener on `127.0.0.1:47821` (localhost only). `POST /event` with `{session_id, event, cwd?, pid?}` returns 204; `GET /health` returns 200; 400 for bad input or unknown events; 64KB body cap.
- `src/sessions.ts`: `SessionStore` (`Map<session_id, Session>`). Maps `SessionStart`->idle, `UserPromptSubmit`->working, `Notification`->needs-you, `Stop`->done, `SessionEnd`->remove. Emits upsert/remove changes.
- `src/preload.ts`: exposes `window.clawd` (`onSessions`, `onChange`, `ready`) via `contextBridge`.
- `src/renderer/`: `index.html` (clawd SVG in a `<template>`), `renderer.ts` (adds/updates/removes clawds, 56px spacing, tooltip text in `data-tip` = last folder of `cwd`), `style.css` (placeholder tints per `data-state`; real animations are milestone 4).
- `scripts/copy-static.js`: copies non-TS renderer files into `dist/` after `tsc`.
- `scripts/test-bus.js` (`npm run test:bus`): sends a sequence of events; `node scripts/test-bus.js clear` removes the leftover test clawd.

How to run: `npm install`, then `npm start` (builds, then launches Electron). Then `npm run test:bus` in a second terminal. Quit with Ctrl+C in the terminal (no tray or quit option until milestone 6).

Gotchas:
- Electron's postinstall binary download can fail or stall on this machine. If `npx electron .` says "Electron failed to install correctly", run `node node_modules/electron/install.js` (takes several minutes).
- The Content-Security-Policy in `index.html` is `default-src 'self'`; inline scripts will be blocked, so put renderer JS in its own file.
- The Clawd folder is its own git repo (`origin` = this project's GitHub). The parent home-directory repo has a different remote; never run git from outside this folder.
- `.claude/` and `New Text Document.txt` are git-ignored on purpose.
- `main.ts` takes a single-instance lock. If `npm start` prints "already running; exiting this copy" (plus cache 'Access is denied' errors), stray Electron processes are alive: run `taskkill //F //IM electron.exe` (double slashes in Git Bash) and start again. Backgrounded `npm start` runs leave orphans when stopped.
- The strip is empty until an event arrives (no static clawd since milestone 2); use `npm run test:bus` to see it.

- The `data-tip` tooltip attribute is set but nothing displays it yet (the window is click-through, so hover needs `setIgnoreMouseEvents(true, {forward: true})` mouse-move handling; planned for milestone 5).
- The event bus port is fixed at 47821 (`CLAWD_PORT` env var is honored by the test script only). If the port is taken the bus logs an error and the app keeps running without it.

**Next up:** milestone 3, the hook script and installer: a tiny script that POSTs to the bus in the background with a short timeout and fails silently when the app is off, plus an install/uninstall command that merges the hooks into `~/.claude/settings.json`. Keep the merge non-destructive (preserve existing hooks, back up the file first) and test with the app off to confirm Claude is never slowed.

## Decision

Start with the Electron overlay (milestones 1–4), or the native taskbar button route first? The native route is less charming, since it's one icon per window rather than a strip of clawds. **Recommendation: the overlay.**
