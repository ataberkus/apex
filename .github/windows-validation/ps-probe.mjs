// Times the preflight's Windows PowerShell probe (5 s budget) with the preflight's own environment and with the full
// environment: bun ps-probe.mjs <checkout>. Prints one JSON line.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = path.resolve(process.argv[2] ?? '.');
const { windowsProbeEnvironment } = await import(pathToFileURL(path.join(checkout, 'scripts', 'preflight-windows.mjs')).href);
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const NET_PROBE = String.raw`$ErrorActionPreference='Stop'; if($PSVersionTable.PSVersion.Major -lt 5 -or $ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 2 }; if((Get-ExecutionPolicy) -in @('Restricted','AllSigned')) { exit 2 }; [void][System.Security.AccessControl.DirectorySecurity]; [void][System.Security.Principal.WindowsIdentity]; Write-Output 'apex-windows-net-ready'`;
const time = (name, env) => { const started = performance.now(); const r = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', NET_PROBE], { cwd: checkout, env, encoding: 'utf8', windowsHide: true, timeout: 60000 }); return { name, ms: Math.round(performance.now() - started), status: r.status, ok: String(r.stdout).trim() === 'apex-windows-net-ready' }; };
const probeEnv = windowsProbeEnvironment(checkout);
const results = [];
for (let i = 0; i < 3; i++) results.push(time('preflight-env', probeEnv), time('full-env', process.env), time('preflight-env+LOCALAPPDATA+USERPROFILE', { ...probeEnv, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA }));
console.log(JSON.stringify({ probeEnvKeys: Object.keys(probeEnv), results }));
