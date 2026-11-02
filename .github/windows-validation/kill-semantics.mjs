// What a Bun parent sees when it kills a Bun child that ignores stdin EOF: the case the dashboard's 5 s Stop fallback
// (child.kill()) and its `code === null` mapping handle. Prints one JSON line.
import { spawn } from 'node:child_process';

const probe = (how) => new Promise(resolve => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.on("data",()=>{}); process.stdin.on("end",()=>{}); setInterval(()=>{}, 1e6)'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const started = performance.now();
  child.once('close', (code, signal) => resolve({ how, code, signal, exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed, ms: Math.round(performance.now() - started) }));
  setTimeout(() => { child.stdin.end(); setTimeout(() => (how === 'kill()' ? child.kill() : child.kill(how)), 300); }, 500);
});
const results = [];
for (const how of ['kill()', 'SIGTERM', 'SIGINT', 'SIGKILL']) results.push(await probe(how));
// The dashboard's mapping for a direct Pi child: code null -> 130 for SIGINT, else 1.
console.log(JSON.stringify({ platform: process.platform, bun: process.versions.bun, results: results.map(r => ({ ...r, dashboardReports: r.code === null ? (r.signal === 'SIGINT' ? 130 : 1) : r.code })) }));
