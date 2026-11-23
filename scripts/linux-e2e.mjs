// End-to-end test of the Linux AppImage on a virtual X screen (run in CI).
// Two copies connect through the public signaling server; we check the session, the picture,
// mouse control, file transfer, the PC info panel and the wallpaper.
// Usage: node scripts/linux-e2e.mjs path/to/UniDesk.AppImage   (with DISPLAY set to a running Xvfb)
import { spawn, execFileSync } from 'child_process';
import fs from 'fs'; import path from 'path'; import os from 'os';

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
        return async (e) => { const n = ++id; ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true } })); const m = await new Promise(r => pend.set(n, r)); return m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description; };
      }
    } catch {}
    await sleep(500);
  }
  return null;
}
const logs = {};
function launch(prof, port, extraArgs = []) {
  logs[prof] = '';
  const c = spawn(app, [`--remote-debugging-port=${port}`, ...extraArgs], { env: { ...process.env, UNIDESK_PROFILE: prof, APPIMAGE_EXTRACT_AND_RUN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', d => { logs[prof] += d; }); c.stderr.on('data', d => { logs[prof] += d; });
  return c;
}
const mouseAt = () => { const o = execFileSync('xdotool', ['getmouselocation', '--shell']).toString(); return { x: +/X=(\d+)/.exec(o)[1], y: +/Y=(\d+)/.exec(o)[1] }; };
const until = async (fn, ms = 30000) => { const t = Date.now() + ms; while (Date.now() < t) { const v = await fn(); if (v) return v; await sleep(500); } return null; };

// 1. Start normally (no extra flags), exactly as a user would
let procs = [launch('ciA', 9301)];
let A = await page(9301, 45000);
check('app starts without extra flags', !!A, A ? '' : logs.ciA.split('\n').filter(Boolean).slice(-6).join(' | '));
if (!A) { procs.forEach(p => p.kill('SIGKILL')); console.log(results.join('\n')); process.exit(1); }
procs.push(launch('ciB', 9302));
const B = await page(9302, 45000);
check('second copy starts', !!B);
if (!B) { procs.forEach(p => p.kill('SIGKILL')); process.exit(1); }

const ready = async (P) => until(() => P(`typeof peer !== 'undefined' && peer && peer.open === true && !!myId`), 40000);
check('A registered with the signaling server', !!(await ready(A)));
check('B registered with the signaling server', !!(await ready(B)));
const idA = await A(`myId`);

// Wallpaper (GNOME settings, inside the test's D-Bus session): start from a picture wallpaper
const gs = (...a) => { try { return execFileSync('gsettings', a, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
const hasGs = gs('set', 'org.gnome.desktop.background', 'picture-options', 'zoom') !== null && gs('get', 'org.gnome.desktop.background', 'picture-options') === "'zoom'";
check('test desktop has GNOME wallpaper settings', hasGs);

// 2. Connect and accept with control and files
await B(`connect('${idA}'); true`);
check('host sees the request', !!(await until(() => A(`$('reqCard').classList.contains('show')`), 30000)));
await A(`$('reqControl').checked = true; $('reqFiles').checked = true; $('reqAccept').click(); true`);
check('session starts', !!(await until(() => B(`$('session').classList.contains('active') && $('video').videoWidth > 0`), 30000)));
const vw = await B(`$('video').videoWidth + 'x' + $('video').videoHeight`);
await sleep(2000);
const bright = await B(`(() => { const v = $('video'); const c = document.createElement('canvas'); c.width = 64; c.height = 40; const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 40); const d = g.getImageData(0, 0, 64, 40).data; let s = 0, n = 0; for (let i = 0; i < d.length; i += 4) { s += d[i] + d[i+1] + d[i+2]; n++; } return Math.round(s / n / 3); })()`);
check('picture arrives', /^\d+x\d+$/.test(vw) && vw !== '0x0', `${vw}, brightness ${bright}`);
if (hasGs) check('wallpaper is hidden during the session', gs('get', 'org.gnome.desktop.background', 'picture-options') === "'none'", gs('get', 'org.gnome.desktop.background', 'picture-options'));
check('host reports Linux', /linux/i.test(String(await until(() => B(`remoteInfo?.os || ''`), 15000))), String(await B(`remoteInfo?.os`)));

// 3. Mouse control
await B(`sendInput({ t: 'move', x: 0.25, y: 0.25 }); true`); await sleep(800); const m1 = mouseAt();
await B(`sendInput({ t: 'move', x: 0.75, y: 0.75 }); true`); await sleep(800); const m2 = mouseAt();
const [sw, sh] = vw.split('x').map(Number);
const near = (p, fx, fy) => Math.abs(p.x - sw * fx) < 12 && Math.abs(p.y - sh * fy) < 12;
check('visitor moves the mouse', near(m1, 0.25, 0.25) && near(m2, 0.75, 0.75), `${m1.x},${m1.y} -> ${m2.x},${m2.y} on ${vw}`);

// 4. The remote terminal, privacy screen and input blocking were removed on purpose: make sure they stay gone
check('no remote terminal, privacy screen or input blocking', (await B(`['termBtn', 'privBtn', 'blockBtn'].every(id => !document.getElementById(id)) && !window.dw.termInput && !window.dw.privacy && !window.dw.blockInput`)) === true);

// 5. File transfer into the host's Downloads/UniDesk
const recv = path.join(os.homedir(), 'Downloads', 'UniDesk', 'ci-linux.txt'); fs.rmSync(recv, { force: true });
await B(`sendFiles([new File(['hello from the visitor'], 'ci-linux.txt')]); true`);
const got = await until(() => fs.existsSync(recv) && fs.readFileSync(recv, 'utf8') === 'hello from the visitor', 15000);
let where = '';
try { where = execFileSync('find', [os.homedir(), '/tmp', '-name', 'ci-linux*.txt', '-newer', app], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { where = String(e.stdout || '').trim(); }
check('file transfer lands on the host', !!got, got ? recv : 'expected ' + recv + ' | found: ' + (where || 'nowhere') + ' | downloads dir: ' + (process.env.XDG_DOWNLOAD_DIR || 'unset'));

// 6. Remote PC info panel
const info = await B(`piAsk('info', {}).then(r => r.info ? r.info.os + ' | disks ' + r.info.disks.length + ' | cpu ' + r.info.cpuPct + '%' : r.error)`);
check('PC info panel works', /linux/i.test(String(info)) && /disks [1-9]/.test(String(info)), String(info));

// 7. End
await B(`$('endBtn').click(); true`);
check('session ends on both sides', !!(await until(async () => (await A(`role === null`)) === true && (await B(`role === null`)) === true, 15000)));
if (hasGs) check('wallpaper comes back after the session', !!(await until(() => gs('get', 'org.gnome.desktop.background', 'picture-options') === "'zoom'", 10000)), gs('get', 'org.gnome.desktop.background', 'picture-options'));

procs.forEach(p => { try { p.kill('SIGKILL'); } catch {} });
console.log('\n' + results.join('\n'));
process.exit(failed ? 1 : 0);
