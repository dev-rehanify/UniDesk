// Test of the packaged macOS app (run in CI on Apple Silicon).
// Starts the real UniDesk.app and checks it runs, and that the privacy screen is left out of screen capture:
// the app grabs a frame of the screen itself and refuses to turn the privacy screen on if the cover shows up in it.
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
function launch(port, env = {}) {
  log = '';
  const c = spawn(app, [`--remote-debugging-port=${port}`], { env: { ...process.env, UNIDESK_PROFILE: 'ciMac', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', d => { log += d; }); c.stderr.on('data', d => { log += d; });
  return c;
}

// 1. The app starts (native modules for this Mac only, koffi removed)
let proc = launch(9311);
let A = await page(9311, 60000);
check('app starts', !!A, A ? '' : log.split('\n').filter(Boolean).slice(-6).join(' | '));
if (!A) { proc.kill('SIGKILL'); process.exit(1); }
await sleep(3000);
check('shows an address', /^\d{9}$/.test(String(await A(`myId`))));

// 2. Privacy screen: on, self-checked against a real screen grab, then off
const on = await A(`window.dw.privacy(true, 'CI').then(JSON.stringify)`);
check('privacy screen turns on and is left out of the screen capture', /"ok":true/.test(on), on);
await sleep(1500);
const off = await A(`window.dw.privacy(false).then(JSON.stringify)`);
check('privacy screen turns off', /"ok":true/.test(off) && /"on":false/.test(off), off);

// 3. Other host features answer clearly instead of failing silently
const blk = await A(`window.dw.blockInput(true).then(JSON.stringify)`);
check('block input says it is Windows only', /only available on Windows/.test(blk), blk);
check('wallpaper hiding is skipped on macOS', (await A(`window.dw.wallpaperHide().then(String)`)) === 'false');
proc.kill('SIGKILL'); await sleep(2000);

// 4. If a macOS version still captured the cover, UniDesk must turn it off and say so
proc = launch(9312, { UNIDESK_TEST_COVER_LEAKS: '1' });
A = await page(9312, 60000);
check('app starts again', !!A);
if (A) {
  await sleep(3000);
  const leak = await A(`window.dw.privacy(true, 'CI').then(JSON.stringify)`);
  check('privacy screen refuses when the cover would be visible to the visitor', /"ok":false/.test(leak) && /turned it off/.test(leak), leak);
  const again = await A(`window.dw.privacy(false).then(JSON.stringify)`);
  check('turning it off afterwards still answers normally', /"ok":true/.test(again) && /"on":false/.test(again), again);
}
proc.kill('SIGKILL');
console.log('\n' + results.join('\n'));
process.exit(failed ? 1 : 0);
