// Test of the packaged macOS app (run in CI on Apple Silicon).
// Starts the real UniDesk.app (built with only this Mac's native files) and checks it comes up and works.
// Usage: node scripts/mac-e2e.mjs path/to/UniDesk.app/Contents/MacOS/UniDesk
import { spawn } from 'child_process';
import path from 'path';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const app = path.resolve(process.argv[2]);
const results = []; let failed = false;
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); if (!ok) failed = true; console.log(results.at(-1)); };

async function page(port, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const p = list.find(x => x.type === 'page' && x.url.includes('index.html'));
      if (p) {
        const ws = new WebSocket(p.webSocketDebuggerUrl); let id = 0; const pend = new Map();
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
        return async (e) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true } })); const m = await new Promise(r => pend.set(n, r)); const r = m.result?.result; return r && 'value' in r ? r.value : m.result?.exceptionDetails?.exception?.description; };
      }
    } catch {}
    await sleep(500);
  }
  return null;
}
let log = '';
const proc = spawn(app, ['--remote-debugging-port=9311'], { env: { ...process.env, UNIDESK_PROFILE: 'ciMac' }, stdio: ['ignore', 'pipe', 'pipe'] });
proc.stdout.on('data', d => { log += d; }); proc.stderr.on('data', d => { log += d; });

const A = await page(9311, 60000);
check('app starts', !!A, A ? '' : log.split('\n').filter(Boolean).slice(-6).join(' | '));
if (!A) { proc.kill('SIGKILL'); process.exit(1); }
await sleep(3000);
check('shows an address', /^\d{9}$/.test(String(await A(`myId`))));
check('registers with the signaling server', !!(await (async () => { for (let i = 0; i < 40; i++) { if (await A(`!!(peer && peer.open)`)) return true; await sleep(500); } return false; })()));
check('reads this Mac\'s info', /mac|darwin/i.test(String(await A(`window.dw.sysinfo().then(i => i.os)`))), String(await A(`window.dw.sysinfo().then(i => i.os)`)));
check('wallpaper hiding is skipped on macOS', (await A(`window.dw.wallpaperHide().then(String)`)) === 'false');
check('no remote terminal, privacy screen or input blocking', (await A(`['termBtn', 'privBtn', 'blockBtn'].every(id => !document.getElementById(id)) && !window.dw.termInput && !window.dw.privacy && !window.dw.blockInput`)) === true);
proc.kill('SIGKILL');
console.log('\n' + results.join('\n'));
process.exit(failed ? 1 : 0);
