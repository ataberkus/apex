// Launches the desktop shell in smoke mode twice: once normally (dashboard loads, links leave the window, closing the
// window hides it to the tray with the server still up, and Quit with a stray hidden popup still quits and stops the
// server) and once with a missing Bun (failure page and Retry).
import electron from 'electron';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const main = fileURLToPath(new URL('../desktop/main.mjs', import.meta.url));

async function launch(extraEnv = {}) {
  const home = await mkdtemp(join(tmpdir(), 'apex-desktop-smoke-'));
  const env = {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), ...extraEnv};
  delete env.ELECTRON_RUN_AS_NODE; // set by some editors' terminals; it would make electron.exe act as plain Node
  const child = spawn(electron, [main, '--smoke'], {env, stdio: ['ignore', 'pipe', 'inherit']});
  let out = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
  const timer = setTimeout(() => child.kill(), 90_000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  await rm(home, {recursive: true, force: true});
  const line = out.split(/\r?\n/).find(text => text.startsWith('{"smoke"'));
  return {code, ...(line ? JSON.parse(line).smoke : {error: `no smoke result; output: ${out.trim() || '(none)'}`})};
}

const normal = await launch();
let serverGone = true;
if (normal.serverPid) try { process.kill(normal.serverPid, 0); serverGone = false; } catch { /* ESRCH: exited */ }
const expected = ['https://example.com/apex-smoke/new-window', 'https://example.com/apex-smoke/same-window', 'https://example.com/apex-smoke/sign-in'];
const normalOk = normal.code === 0 && normal.title === 'Apex (development checkout)' && normal.state === 200 && normal.stayed === true
  && JSON.stringify(normal.opened) === JSON.stringify(expected) && normal.hiddenOnClose === true && normal.tray === true && serverGone;

const missingBun = await launch({APEX_BUN: join(tmpdir(), 'apex-no-such-bun.exe')});
const page = missingBun.failurePage;
const failureOk = missingBun.code === 0 && page?.status === 'Apex could not start.' && page.retryVisible === true
  && /Bun was not found/.test(page.detail) && missingBun.attempts === 2;

console.log(JSON.stringify({ok: normalOk && failureOk, normal: {...normal, serverGone, ok: normalOk}, missingBun: {...missingBun, ok: failureOk}}, null, 1));
process.exit(normalOk && failureOk ? 0 : 1);
