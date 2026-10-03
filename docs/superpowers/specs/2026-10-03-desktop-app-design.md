# Apex desktop app — design

Date: 2026-10-03 · Status: approved in chat, awaiting written-spec review

## Intent

**What the user said:** "create desktop app like claude code to use apex easily." The gap versus today's browser dashboard is *a real app, not a tab*: its own window and Start-menu/taskbar icon, launching its backend itself — no `npm run dashboard`, no token URL, no stray browser tab. It is for the user only, on this PC, running from this repository checkout.

**Assumptions (confirmed in chat):** the existing dashboard UI (`dashboard/`) is kept as the interface; no UI redesign, diff viewer, terminal, tray, background running or OS notifications in this scope. No installer, code signing or auto-update.

**Success criteria**

1. Clicking an "Apex" Start-menu or desktop shortcut opens one Apex window showing the dashboard, with the Apex icon in the taskbar grouped as its own app.
2. No console window, no browser tab and no manual URL at any point.
3. Launching a second time focuses the existing window.
4. Closing the window stops the dashboard server and every `apex --mode rpc` child it started; no Apex node processes remain.
5. Provider sign-in still completes; links in chat answers open in the default browser, never inside the Apex window.
6. `npm run dashboard` behaves exactly as before.

## Approach

An Electron shell around the existing dashboard server. Chosen over an Edge `--app` window (unreliable taskbar identity and window-close detection) and Tauri (Rust toolchain, no benefit for a single-PC checkout).

## Components

| Unit | Purpose | Depends on |
|---|---|---|
| `desktop/main.mjs` | Electron main process: single-instance lock, spawn/supervise the server, own the window, lock down navigation | `electron`, system `node` on PATH, `dashboard/server.mjs` |
| `desktop/startup.html` | "Starting Apex…" / failure page. Loaded as `startup.html?state=starting` or `?state=failed&detail=<text>`; a small inline script renders `detail` with `textContent`. Retry is a link to `apex:retry`, which main intercepts in `will-navigate` | — |
| `desktop/icon.ico` | App icon (generated monogram "A"; replaceable) | — |
| `desktop/install-shortcut.ps1` | Creates Start-menu and desktop shortcuts | Windows PowerShell |
| `dashboard/server.mjs` (changed) | Adds `--port` and `--desktop` flags | — |
| `package.json` (changed) | `electron` pinned devDependency (44.5.1, latest stable at writing); scripts `desktop`, `desktop:shortcut`, `smoke:desktop`; `desktop` added to `files` | — |

## Dashboard server changes (backward compatible)

- **`--port N`** — port precedence: `--port` > `APEX_DASH_PORT` > `4777`. `0` binds any free port. After `listen`, the bound port (`server.address().port`) is used everywhere the configured port is used today: the Host-header allowlist (`127.0.0.1:<port>`, `localhost:<port>`) and the printed URL. The Origin check already derives from the Host header and needs no change.
- **`--desktop`** —
  - after listening, prints exactly one line `{"apexDashboard":"http://127.0.0.1:<port>/?t=<token>"}` to stdout (in addition to the existing human line);
  - never opens a browser (ignores `--open`);
  - on `process.stdin` `end`, runs the same shutdown as the existing SIGINT/SIGTERM handler (cancel pending logins, end each live session child's stdin, exit 0). The handler body is extracted into one `shutdown()` function used by both paths.
- Without `--desktop`, stdin is not read and nothing else changes.

## Startup and lifecycle (`desktop/main.mjs`)

1. `app.setAppUserModelId('Apex.Desktop')`. `app.requestSingleInstanceLock()`; on failure `app.quit()`. On `second-instance`, restore and focus the existing window.
2. Create the window (see Window) showing `desktop/startup.html`.
3. Spawn `node <repo>/dashboard/server.mjs --port 0 --desktop` with `cwd` = repo root, `windowsHide: true`, `stdio: ['pipe','pipe','pipe']`, inheriting the environment. `node` is resolved from PATH (the server and its Pi children need the user's Node ≥22.19 as `process.execPath`; Electron's embedded Node is not used). If `APEX_NODE` is set, it is used instead.
4. Read stdout line by line until a line parses as JSON with an `apexDashboard` string starting with `http://127.0.0.1:`; load it in the window. Keep the last 8 KiB of stderr (the failure page's `detail`).
5. **Failure:** if the child exits before ready, or no ready line arrives within 30 s, kill the child and show `startup.html` in failure mode with the stderr tail and a Retry action that repeats steps 3–4. Missing `node` on PATH is reported as such.
6. **Server dies after ready:** show the failure page (stderr tail + Retry); do not auto-restart.
7. **Shutdown:** closing the window quits the app (`window-all-closed` → quit). On `before-quit`, if the child is alive: `preventDefault`, end its stdin, wait for exit up to 5 s, then `child.kill()`; then quit. Nothing keeps running after the window closes; sessions are already persisted by Pi and resumable from the sidebar.

## Window

- `BrowserWindow`: title "Apex", `icon` = `desktop/icon.ico`, default 1400×900, min 900×600; bounds (and maximized state) saved to `app.getPath('userData')/window.json` on close and restored on launch, ignored if off-screen. `autoHideMenuBar: true` with the default application menu retained so Ctrl+R, Ctrl+Shift+I, zoom, and clipboard shortcuts work.
- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no preload. The page has no Electron access.
- **Navigation lockdown** — allowed origin is the dashboard origin from the ready line (plus `file:` for `startup.html`):
  - `will-navigate` to any other URL: `preventDefault`; `apex:retry` restarts the server (startup steps 3–4); if `http:`, `https:` or `mailto:`, `shell.openExternal(url)`; anything else is dropped.
  - `setWindowOpenHandler`: `http(s)`/`mailto` → `openExternal`, `deny`. `about:blank` → `allow` with `show: false` (the dashboard's sign-in popup pre-open). For that child window, the first navigation to an `http(s)` URL (`will-navigate` / `will-redirect` / `did-start-navigation`) is cancelled, opened with `openExternal`, and the child is closed. Everything else → `deny`.
  - Fallback: if the hidden popup interception does not fire, the sign-in dialog's existing visible link (`#auth-open`) is an ordinary external link and goes through `setWindowOpenHandler`/`will-navigate` above.
- OAuth completes because Pi's provider login listens on its own localhost callback; the default browser reaches it directly.
- Folder picking keeps the server's existing PowerShell `FolderBrowserDialog`; no IPC.

## Shortcut

`npm run desktop:shortcut` runs `powershell -NoProfile -ExecutionPolicy Bypass -File desktop/install-shortcut.ps1`, which creates `Apex.lnk` in the user Start-menu Programs folder and on the desktop: target `<repo>\node_modules\electron\dist\electron.exe`, arguments `"<repo>\desktop\main.mjs"`, working folder `<repo>`, icon `<repo>\desktop\icon.ico`, and the shortcut's `System.AppUserModel.ID` set to `Apex.Desktop` so pinned/taskbar grouping matches the window. Re-running overwrites both shortcuts. Because the shortcut runs this checkout, `git pull` updates the app.

## Error handling summary

| Situation | Behaviour |
|---|---|
| `node` not on PATH | Failure page: "Node was not found on PATH" + Retry |
| Server crashes or never prints ready within 30 s | Failure page with stderr tail + Retry |
| Server dies after ready | Failure page with stderr tail + Retry; no auto-restart |
| Second launch | Focus existing window |
| Graceful shutdown hangs | Hard kill after 5 s |
| External link / navigation | Default browser; Apex window never leaves the dashboard origin |

## Testing

- **Unit (`tests/dashboard-desktop.test.mjs`, node:test, part of `npm test`):** spawns the real `dashboard/server.mjs` with a temporary `APEX_DASH_HOME` and `PI_CODING_AGENT_DIR`, no sessions started, no model calls:
  - `--port 0 --desktop` prints a parseable ready line with a non-4777 port;
  - a request with the bound port's Host and the token cookie gets 200 on `/api/state`; a different Host gets 403;
  - closing the child's stdin makes it exit with code 0 within 5 s;
  - without `--desktop`, no ready JSON line is printed and closing stdin does not stop it (then killed by the test).
- **Electron smoke (`npm run smoke:desktop`, `scripts/smoke-desktop.mjs`):** launches Electron with `desktop/main.mjs --smoke`; in smoke mode main waits for the dashboard to load, checks `document.title === 'Apex'` and that `/api/state` returns 200 from the page, prints a JSON result, and quits through the normal shutdown path. The script then verifies the server child PID no longer exists. Uses a temporary `APEX_DASH_HOME`. Not part of `npm test` (needs a display and Electron binary).
- **Manual acceptance:** launch via the shortcut, screenshot, add a workspace, close the window, confirm no leftover `node.exe` running `dashboard/server.mjs` or `bin/apex`.

## Out of scope

Installer/bundled Node, code signing, auto-update, tray/background mode, OS notifications, UI redesign, diff/terminal/file panes, non-Windows shortcuts (the Electron shell itself is not Windows-specific, but only Windows is tested).
