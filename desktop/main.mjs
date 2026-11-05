// Apex desktop shell: one native window over the local dashboard, whose server it starts and stops itself. Closing the
// window hides it to the notification area; Quit in the tray menu stops the server. On start it offers a newer release.
import {app, BrowserWindow, dialog, Menu, screen, shell, Tray} from 'electron';
import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {linkAction, parseReady, restoreBounds, startupUrl, tail, versionLabel} from './shell.mjs';

const APP_ID = 'Apex.Desktop';
const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const serverPath = join(root, 'dashboard', 'server.mjs');
const iconPath = join(here, 'icon.ico');
const startupPage = pathToFileURL(join(here, 'startup.html')).href;
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; // stamped by the setup program; 0.0.0 in Git
const title = `Apex ${versionLabel(version)}`;
const smoke = process.argv.includes('--smoke');
const opened = []; // smoke mode records external links instead of opening a browser
const openExternal = url => { if (smoke) opened.push(url); else void shell.openExternal(url); };

app.setName('Apex');
app.setAppUserModelId(APP_ID);
app.setPath('userData', smoke ? join(app.getPath('temp'), `apex-desktop-smoke-${process.pid}`) : join(app.getPath('appData'), 'Apex Desktop'));

let win = null, child = null, origin = null, stderr = '', quitting = false, smoked = false;
let tray = null, exiting = false, trayHinted = false, updating = false, pendingInstaller = null;

const boundsFile = () => join(app.getPath('userData'), 'window.json');
function loadBounds() {
  let saved = null;
  try { saved = JSON.parse(readFileSync(boundsFile(), 'utf8')); } catch { /* first launch or unreadable: default size */ }
  return restoreBounds(saved, screen.getAllDisplays().map(display => display.workArea));
}
function saveBounds() {
  if (smoke) return;
  try {
    mkdirSync(app.getPath('userData'), {recursive: true});
    writeFileSync(boundsFile(), JSON.stringify({...win.getNormalBounds(), maximized: win.isMaximized()}));
  } catch { /* losing the window position is harmless */ }
}

function startServer() {
  if (child) return;
  origin = null; stderr = '';
  void win.loadURL(startupUrl(startupPage, 'starting'));
  // System Bun, not Electron's runtime: the server and its Pi children need the user's Bun >=1.4.3 as process.execPath.
  const proc = child = spawn(process.env.APEX_BUN || 'bun', [serverPath, '--port', '0', '--desktop'], {cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  const timer = setTimeout(() => fail(proc, 'Apex did not start within 30 seconds.'), 30_000);
  proc.on('error', error => fail(proc, error.code === 'ENOENT' ? 'Bun was not found on PATH. Install Bun 1.4.3 or newer, or set APEX_BUN to bun.exe.' : error.message));
  proc.stdin.on('error', () => {}); // the pipe closes if the server already exited
  proc.stderr.setEncoding('utf8').on('data', chunk => { stderr = tail(stderr, chunk); });
  createInterface({input: proc.stdout}).on('line', line => {
    const url = parseReady(line);
    if (!url || origin || proc !== child) return;
    clearTimeout(timer);
    origin = new URL(url).origin;
    void win.loadURL(url);
  });
  proc.on('exit', code => { clearTimeout(timer); if (!quitting) fail(proc, `Apex stopped (exit code ${code ?? 'unknown'}).`); });
}

function fail(proc, message) {
  if (proc !== child) return;
  child = null; origin = null;
  if (proc.exitCode === null && proc.signalCode === null) proc.kill();
  const detail = [message, stderr.trim()].filter(Boolean).join('\n\n');
  void win.loadURL(startupUrl(startupPage, 'failed', detail));
}

// The dashboard pre-opens a blank popup for sign-in, then points it at the provider; that page belongs in the real browser.
function handOffPopup(popup) {
  let handed = false;
  const handOff = url => {
    if (!/^https?:/i.test(url)) return false;
    if (handed) return true;
    handed = true;
    openExternal(url);
    // Stopping or destroying the popup inside its own navigation event crashes Electron; close it on a later tick.
    setTimeout(() => { if (!popup.isDestroyed()) popup.close(); }, 100);
    return true;
  };
  popup.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  popup.webContents.on('will-navigate', (event, url) => { if (handOff(url)) event.preventDefault(); });
  popup.webContents.on('will-redirect', (event, url) => { if (handOff(url)) event.preventDefault(); });
  popup.webContents.on('did-start-navigation', details => { handOff(details.url); }); // fires first; will-navigate then cancels
}

async function runSmoke() {
  const contents = win.webContents;
  const page = await contents.executeJavaScript(`fetch('/api/state').then(response => ({title: document.title, state: response.status}))`);
  await contents.executeJavaScript(`(() => {
    const popup = window.open('about:blank', '_blank');
    popup.location.replace('https://example.com/apex-smoke/sign-in');
    const follow = (href, target) => { const a = document.createElement('a'); a.href = href; if (target) a.target = target; document.body.append(a); a.click(); a.remove(); };
    follow('https://example.com/apex-smoke/new-window', '_blank');
    follow('https://example.com/apex-smoke/same-window');
  })()`, true);
  await new Promise(done => setTimeout(done, 1500));
  // Close like a user would, while a sign-in popup that never navigated is still hidden: the app must still quit.
  await contents.executeJavaScript(`void window.open('about:blank', '_blank')`, true);
  await new Promise(done => setTimeout(done, 300));
  win.close(); // hides to the tray and keeps the server
  await new Promise(done => setTimeout(done, 300));
  console.log(JSON.stringify({smoke: {...page, opened: [...opened].sort(), stayed: contents.getURL().startsWith(origin), serverPid: child?.pid,
    title: win.getTitle(), hiddenOnClose: !win.isDestroyed() && !win.isVisible() && Boolean(child), tray: Boolean(tray)}}));
  app.quit(); // the tray menu's Quit
}

// Smoke with a broken server: read the failure page, press Retry once, and report after the second failure.
let failures = 0;
async function smokeFailurePage() {
  failures += 1;
  const contents = win.webContents;
  const failurePage = await contents.executeJavaScript(`({status: document.getElementById('status').textContent, detail: document.getElementById('detail').textContent,
    retryVisible: !document.getElementById('retry').hidden})`);
  if (failures === 1) return void contents.executeJavaScript(`document.getElementById('retry').click()`, true);
  console.log(JSON.stringify({smoke: {failurePage, attempts: failures}}));
  app.quit();
}

function createWindow() {
  const {maximized, ...bounds} = loadBounds();
  win = new BrowserWindow({...bounds, minWidth: 900, minHeight: 600, title, icon: iconPath, autoHideMenuBar: true, backgroundColor: '#0F111C', show: false,
    webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true}});
  if (maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('page-title-updated', event => event.preventDefault()); // keep the version in the title bar
  win.on('session-end', () => { exiting = true; }); // Windows is signing out: really close
  win.on('close', event => {
    saveBounds();
    if (exiting) return;
    event.preventDefault();
    win.hide();
    if (trayHinted || smoke) return;
    trayHinted = true;
    tray.displayBalloon({iconType: 'info', title: 'Apex is still running',
      content: 'Apex keeps running in the notification area. Right-click its icon and choose Quit Apex to close it.'});
  });
  const contents = win.webContents;
  contents.on('will-navigate', (event, url) => {
    const action = linkAction(url, origin, startupPage);
    if (action === 'allow') return;
    event.preventDefault();
    if (action === 'retry') startServer();
    if (action === 'external') openExternal(url);
  });
  contents.setWindowOpenHandler(({url}) => {
    if (url === 'about:blank') return {action: 'allow', overrideBrowserWindowOptions: {show: false}};
    if (linkAction(url, origin, startupPage) === 'external') openExternal(url);
    return {action: 'deny'};
  });
  contents.on('did-create-window', handOffPopup);
  contents.on('did-finish-load', () => {
    if (smoke && !smoked && origin && contents.getURL().startsWith(origin)) { smoked = true; void runSmoke(); }
    if (smoke && contents.getURL().startsWith(`${startupPage}?state=failed`)) void smokeFailurePage();
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  tray = new Tray(iconPath);
  tray.on('click', showWindow);
  refreshTray();
}
function refreshTray(status) {
  tray.setToolTip(status ?? title);
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: title, enabled: false},
    {type: 'separator'},
    {label: 'Open Apex', click: showWindow},
    {label: updating ? 'Updating…' : 'Check for updates', enabled: !updating, click: () => void checkForUpdates(true)},
    {type: 'separator'},
    {label: 'Quit Apex', click: () => app.quit()},
  ]));
}

// Dialogs sit on the window when it is showing, otherwise they stand alone (the window may be in the tray).
const ask = options => dialog.showMessageBox(win?.isVisible() ? win : undefined, {title: 'Apex', noLink: true, ...options});

/**
 * On start (manual: false) only a newer, not skipped release of the setup program's own install is offered and every
 * failure stays silent; from the tray menu (manual: true) each outcome is reported. Installing downloads and verifies the
 * release's setup program, quits Apex and starts it silently with /RELAUNCH=1, which opens Apex again when it is done.
 */
async function checkForUpdates(manual) {
  if (updating) return;
  const update = await import('../lib/update.mjs');
  if (!manual && update.optedOut(process.env)) return;
  let token, release;
  try {
    update.assertUpdatable({root});
    token = await update.githubToken();
    release = await update.fetchLatestRelease({token});
    try { update.writeState(process.env, {lastCheck: Date.now(), ...(release ? {latestVersion: release.version} : {})}); } catch { /* only the CLI notice reads it */ }
  } catch (error) {
    if (manual) await ask({type: 'info', message: 'Apex cannot check for updates here.', detail: error.message});
    return;
  }
  if (!release || update.compareVersions(release.version, version) <= 0) {
    if (manual) await ask({type: 'info', message: `Apex ${version} is up to date.`, detail: release ? `The latest release is ${release.version}.` : `No release is published at ${update.RELEASES_URL}.`});
    return;
  }
  if (!manual && release.version === update.readState().skippedVersion) return;
  const {response} = await ask({type: 'question', message: `Apex ${release.version} is available.`, buttons: ['Update now', 'Later', 'Skip this version'], defaultId: 0, cancelId: 1,
    detail: `You have Apex ${version}. Updating closes Apex, installs ${release.version} and opens it again. Running agents stop; ` +
      'your sessions, settings and sign-ins are kept and sessions can be resumed from the sidebar.'});
  if (response === 2) { try { update.writeState(process.env, {skippedVersion: release.version}); } catch { /* asked again next start */ } }
  if (response !== 0) return;
  updating = true;
  refreshTray(`Downloading Apex ${release.version}…`);
  win?.setProgressBar(2); // indeterminate on the taskbar button
  try {
    pendingInstaller = await update.downloadInstaller(release, {token});
    app.quit(); // will-quit starts the setup program once the server has stopped
  } catch (error) {
    updating = false;
    refreshTray();
    win?.setProgressBar(-1);
    await ask({type: 'error', message: `Apex ${release.version} could not be downloaded.`, detail: `${error.message}\n\nYou can download it from ${update.RELEASES_URL}.`});
  }
}

if (process.argv.includes('--install-shortcuts')) {
  app.whenReady().then(() => {
    const links = [join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Apex.lnk'), join(app.getPath('desktop'), 'Apex.lnk')];
    const options = {target: process.execPath, args: `"${fileURLToPath(import.meta.url)}"`, cwd: root, icon: iconPath, iconIndex: 0, appUserModelId: APP_ID, description: 'Apex coding agent'};
    for (const link of links) if (!shell.writeShortcutLink(link, 'create', options)) { console.error(`Could not write ${link}`); app.exit(1); return; }
    console.log(`Created:\n${links.join('\n')}`);
    app.exit(0);
  });
} else if (!smoke && !app.requestSingleInstanceLock()) {
  app.quit(); // the running window is focused by its second-instance handler
} else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => app.quit());
  // Closing stdin runs the server's own shutdown (cancel logins, end each agent's stdin); kill only if it hangs.
  app.on('before-quit', event => {
    exiting = true; // from here closing the window closes it
    const proc = child;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    const force = setTimeout(() => proc.kill(), 5000);
    proc.once('exit', () => { clearTimeout(force); child = null; app.quit(); });
    proc.stdin.end();
  });
  // The setup program replaces this folder, so it starts only after the window and the server are gone.
  app.on('will-quit', event => {
    if (!pendingInstaller) return;
    event.preventDefault();
    const file = pendingInstaller;
    pendingInstaller = null;
    void import('../lib/update.mjs').then(update => update.runInstaller(file, {args: ['/RELAUNCH=1']}))
      .catch(error => dialog.showErrorBox('Apex update', `${error.message}\n\nRun ${file} yourself to install the update.`))
      .finally(() => app.exit(0));
  });
  app.whenReady().then(() => {
    createTray();
    createWindow();
    startServer();
    if (!smoke) setTimeout(() => void checkForUpdates(false), 3000);
  });
}
