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
2. **Event bus:** a localhost HTTP listener, and a curl test that adds and removes clawds.
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

**Milestone 1: code complete, position not yet visually verified.** Last session ended with the app launching cleanly (no errors for 8s), but nobody has confirmed on screen that the strip lines up with the taskbar or that clicks pass through it.

What exists:
- `src/main.ts`: transparent, frameless, always-on-top, click-through, non-focusable window. 48px tall, full width of the primary display's `workArea`, bottom-aligned (just above the taskbar). Re-pins on `display-metrics-changed`, `display-added`, `display-removed`.
- `src/renderer/`: `index.html`, `style.css`, one static original 10x5 pixel-art clawd as inline SVG (40x20px, bottom-left of the strip).
- `scripts/copy-static.js`: copies non-TS renderer files into `dist/` after `tsc`.

How to run: `npm install`, then `npm start` (builds, then launches Electron). Quit with Ctrl+C in the terminal (no tray or quit option until milestone 6).

Gotchas:
- Electron's postinstall binary download can fail or stall on this machine. If `npx electron .` says "Electron failed to install correctly", run `node node_modules/electron/install.js` (takes several minutes).
- The Content-Security-Policy in `index.html` is `default-src 'self'`; inline scripts will be blocked, so put renderer JS in its own file.
- The Clawd folder is its own git repo (`origin` = this project's GitHub). The parent home-directory repo has a different remote; never run git from outside this folder.
- `.claude/` and `New Text Document.txt` are git-ignored on purpose.

**Next up:** confirm the milestone 1 position, then milestone 2 (localhost HTTP event bus with a curl test that adds and removes clawds).

## Decision

Start with the Electron overlay (milestones 1–4), or the native taskbar button route first? The native route is less charming, since it's one icon per window rather than a strip of clawds. **Recommendation: the overlay.**
