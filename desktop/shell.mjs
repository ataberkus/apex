// Electron-free helpers for the desktop shell, so node:test can cover them.

// The dashboard prints {"apexDashboard": url} once listening; trust only a tokenised loopback URL.
export function parseReady(line) {
  let url;
  try { url = new URL(JSON.parse(line)?.apexDashboard); } catch { return null; }
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.searchParams.has('t') ? url.href : null;
}

// What the window does with a navigation: stay, restart the server, hand it to the browser, or ignore it.
export function linkAction(url, origin, startupPage) {
  let parsed;
  try { parsed = new URL(url); } catch { return 'drop'; }
  if (origin && parsed.origin === origin) return 'allow';
  if (url.split(/[?#]/)[0] === startupPage) return parsed.searchParams.get('state') === 'retry' ? 'retry' : 'allow';
  if (parsed.username || parsed.password) return 'drop';
  return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? 'external' : 'drop';
}

export function startupUrl(startupPage, state, detail) {
  return `${startupPage}?${new URLSearchParams(detail ? {state, detail} : {state})}`;
}

// Saved bounds are reused only when large enough and at least 100 px of them is on some screen.
export function restoreBounds(saved, workAreas) {
  const valid = saved && typeof saved === 'object' && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]))
    && saved.width >= 900 && saved.height >= 600
    && workAreas.some(area => Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x) >= 100
      && Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y) >= 100);
  return valid ? {x: saved.x, y: saved.y, width: saved.width, height: saved.height, maximized: saved.maximized === true} : {width: 1400, height: 900, maximized: false};
}

export const tail = (previous, chunk, limit = 8192) => (previous + chunk).slice(-limit);

// package.json says 0.0.0 in Git; the setup program stamps the release version into its copy.
export const versionLabel = version => version === '0.0.0' ? '(development checkout)' : version;
