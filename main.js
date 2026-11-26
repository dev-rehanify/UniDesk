const { app, BrowserWindow, WebContentsView, ipcMain, desktopCapturer, dialog, clipboard, screen: eScreen, shell, nativeTheme, Tray, Menu, safeStorage, nativeImage, systemPreferences, globalShortcut } = require('electron');
const IS_MAC = process.platform === 'darwin';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Optional separate profile (for testing two instances on one PC): UNIDESK_PROFILE=name
if (process.env.UNIDESK_PROFILE) app.setPath('userData', path.join(app.getPath('appData'), 'UniDesk-' + process.env.UNIDESK_PROFILE.replace(/[^\w-]/g, '')));

// Single instance: a second launch just focuses the running app
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', (_e, argv) => { showWin(); handleLink(argv.find(a => a.startsWith('unidesk://'))); });

// ---------- Invite links: unidesk://connect/123456789 ----------
// Registered only for the installed app, so running from source never touches the registry.
if (app.isPackaged) app.setAsDefaultProtocolClient('unidesk');
let pendingLink = process.argv.find(a => a.startsWith('unidesk://')) || null;
function parseLink(url) { const m = /^unidesk:\/\/(?:connect\/)?(\d{9})/i.exec(String(url || '').replace(/\s/g, '')); return m ? m[1] : null; }
function handleLink(url) {
  const id = parseLink(url); if (!id) return;
  if (win && !win.webContents.isLoading()) win.webContents.send('deep-link', id); else pendingLink = url;
}
app.on('open-url', (e, url) => { e.preventDefault(); showWin(); handleLink(url); }); // macOS
ipcMain.handle('take-pending-link', () => { const id = parseLink(pendingLink); pendingLink = null; return id; });
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.on('open-external', (_e, url) => { if (/^https:\/\/(github\.com|dev-rehanify\.github\.io)\//.test(url)) shell.openExternal(url); });

// ---------- Forced auto-update ----------
// Each CI build stamps build-info.json with an increasing build number. The release carries latest.json
// ({ build, files: { key: { name, sha256 } } }). If the release's build is newer, we download the right file,
// verify its SHA-256, install it and restart. Only for the installed app (never when running from source).
const https = require('https');
const os0 = require('os');
const { spawn } = require('child_process');
const RELEASE_BASE = 'https://github.com/dev-rehanify/UniDesk/releases/latest/download/';
function localBuild() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')); } catch { return { build: 0 }; } }
function get(url, onData, redirects = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!/(^|\.)github(usercontent)?\.com$/.test(u.hostname)) return reject(new Error('Blocked host ' + u.hostname));
    https.get(u, { headers: { 'User-Agent': 'UniDesk-Updater' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) { res.resume(); return resolve(get(new URL(res.headers.location, u).toString(), onData, redirects + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = +res.headers['content-length'] || 0; const chunks = []; let got = 0;
      res.on('data', (c) => { got += c.length; if (onData) onData(c, got, total); else chunks.push(c); });
      res.on('end', () => resolve(onData ? null : Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}
function updateKey() {
  if (process.platform === 'win32') return isPortable() ? 'win-zip' : 'win-installer';
  if (IS_MAC) return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'linux' && process.env.APPIMAGE) return 'linux-x64';   // the AppImage can replace itself
  return null;
}
function isPortable() { return process.platform === 'win32' && !fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall UniDesk.exe')); }
let updateState = { busy: false };
ipcMain.handle('update-check', async () => {
  if (!app.isPackaged) return { dev: true, current: localBuild() };
  try {
    const remote = JSON.parse((await get(RELEASE_BASE + 'latest.json')).toString());
    const cur = localBuild(); const key = updateKey(); const file = remote.files?.[key];
    return { current: cur, remote: { build: remote.build, version: remote.version, notes: remote.notes }, available: !!file && +remote.build > +cur.build, key, canAuto: key === 'win-installer' || key?.startsWith('mac-') || key === 'linux-x64' };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('update-install', async (e) => {
  if (!app.isPackaged || updateState.busy) return { error: 'busy' };
  updateState.busy = true;
  const send = (m) => { try { e.sender.send('update-progress', m); } catch {} };
  try {
    const remote = JSON.parse((await get(RELEASE_BASE + 'latest.json')).toString());
    const key = updateKey(), f = remote.files?.[key];
    if (!f || !/^[\w.-]+$/.test(f.name)) throw new Error('No update file for this system');
    const dir = fs.mkdtempSync(path.join(os0.tmpdir(), 'unidesk-update-'));
    const dest = path.join(dir, f.name); const out = fs.createWriteStream(dest); const hash = crypto.createHash('sha256');
    await get(RELEASE_BASE + f.name, (c, got, total) => { out.write(c); hash.update(c); send({ phase: 'download', pct: total ? Math.round(got / total * 100) : 0 }); });
    await new Promise(r => out.end(r));
    if (hash.digest('hex') !== String(f.sha256).toLowerCase()) throw new Error('Downloaded file failed its integrity check');
    send({ phase: 'install' });
    if (key === 'win-installer') {
      const installDir = path.dirname(process.execPath);
      // wait for this app to exit, run the silent installer into the same folder, then start UniDesk again
      const script = `Start-Sleep -Seconds 2; Start-Process -FilePath '${dest.replace(/'/g, "''")}' -ArgumentList '/S','/D=${installDir.replace(/'/g, "''")}' -Wait; Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}'`;
      spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore' }).unref();
    } else if (IS_MAC) {
      const bundle = path.resolve(process.execPath, '../../..'); // .../UniDesk.app
      const sh = `sleep 2; X="$(mktemp -d)"; /usr/bin/ditto -xk "${dest}" "$X" && rm -rf "${bundle}" && mv "$X/UniDesk.app" "${bundle}" && open "${bundle}"`;
      spawn('/bin/sh', ['-c', sh], { detached: true, stdio: 'ignore' }).unref();
    } else if (key === 'linux-x64') {
      // replace the AppImage file in place, then start the new one
      const img = process.env.APPIMAGE; fs.chmodSync(dest, 0o755);
      const sh = `sleep 2; mv -f '${dest.replace(/'/g, "'\\''")}' '${img.replace(/'/g, "'\\''")}' && chmod +x '${img.replace(/'/g, "'\\''")}' && '${img.replace(/'/g, "'\\''")}' >/dev/null 2>&1 &`;
      spawn('/bin/sh', ['-c', sh], { detached: true, stdio: 'ignore' }).unref();
    } else throw new Error('This copy cannot update itself');
    quitting = true; setTimeout(() => app.exit(0), 400);
    return { ok: true };
  } catch (err) { updateState.busy = false; send({ phase: 'error', message: err.message }); return { error: err.message }; }
});

// ---------- LAN mode: built-in signaling server + UDP discovery (no internet server needed) ----------
const dgram = require('dgram');
const LAN_PORT0 = +process.env.UNIDESK_LAN_PORT || 47801, BEACON_PORT = 47800;
let lan = null; const lanPeers = new Map();
function lanAddrs() {
  const out = [];
  for (const list of Object.values(os0.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a);
  return out;
}
async function startLan(id, name) {
  if (lan) { lan.id = id; return { port: lan.port }; }
  const http = require('http');
  let port = LAN_PORT0 - 1, server = null;
  for (let i = 0; i < 10 && !server; i++) {
    port++;
    server = await new Promise((res) => {
      const srv = http.createServer((req, resp) => { resp.writeHead(404); resp.end(); });
      srv.once('error', () => res(null)); // port in use: try the next one
      srv.listen(port, '0.0.0.0', () => { srv.on('error', () => {}); attachSignaling(srv, '/unidesk/peerjs'); res(srv); });
    });
  }
  if (!server) return { error: 'no free port' };
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (buf, rinfo) => {
    try {
      const m = JSON.parse(buf.toString());
      if (m.app !== 'unidesk' || !/^\d{9}$/.test(m.id) || m.id === lan?.id) return;
      lanPeers.set(m.id, { id: m.id, name: String(m.name || '').slice(0, 40), ip: rinfo.address, port: +m.port, mac: /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(m.mac || '') ? m.mac : '', seen: Date.now() });
    } catch {}
  });
  sock.on('error', () => {});
  sock.bind(BEACON_PORT, () => { try { sock.setBroadcast(true); } catch {} });
  const beacon = () => {
    const mac = (lanAddrs().find(a => a.mac && a.mac !== '00:00:00:00:00:00') || {}).mac || '';
    const msg = Buffer.from(JSON.stringify({ app: 'unidesk', id: lan.id, name: os0.hostname(), port, mac }));
    for (const a of lanAddrs()) {
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      const bcast = ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.');
      sock.send(msg, BEACON_PORT, bcast, () => {});
    }
    sock.send(msg, BEACON_PORT, '127.0.0.1', () => {}); // lets two copies on one PC see each other
    for (const [k, v] of lanPeers) if (Date.now() - v.seen > 10000) lanPeers.delete(k);
    for (const w of allPages()) w.send('lan-peers', [...lanPeers.values()]);
  };
  lan = { id, port, server, sock, timer: setInterval(beacon, 2500) };
  setTimeout(beacon, 300);
  return { port };
}
// Minimal PeerJS-compatible signaling relay (same wire protocol as peerjs-server):
// clients open ws://host:port/unidesk/peerjs?key&id&token, get OPEN, and we forward
// OFFER / ANSWER / CANDIDATE / LEAVE to the destination id with `src` added.
function attachSignaling(srv, wsPath) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const clients = new Map(); // id -> { ws, token }
  srv.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== wsPath) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = u.searchParams.get('id') || '', token = u.searchParams.get('token') || '';
      if (!/^[\w-]{1,64}$/.test(id)) return ws.close();
      const prev = clients.get(id);
      if (prev && prev.token !== token && prev.ws.readyState === 1) { ws.send(JSON.stringify({ type: 'ID-TAKEN', payload: { msg: 'ID is taken' } })); return ws.close(); }
      if (prev && prev.ws !== ws) { try { prev.ws.terminate(); } catch {} }
      clients.set(id, { ws, token });
      ws.send(JSON.stringify({ type: 'OPEN' }));
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (!m || m.type === 'HEARTBEAT' || !m.dst) return;
        if (!['OFFER', 'ANSWER', 'CANDIDATE', 'LEAVE', 'EXPIRE'].includes(m.type)) return;
        const dst = clients.get(m.dst);
        if (dst && dst.ws.readyState === 1) dst.ws.send(JSON.stringify({ type: m.type, src: id, dst: m.dst, payload: m.payload }));
        else if (m.type !== 'LEAVE' && m.type !== 'EXPIRE') ws.send(JSON.stringify({ type: 'EXPIRE', src: m.dst }));
      });
      ws.on('close', () => { if (clients.get(id)?.ws === ws) clients.delete(id); });
      ws.on('error', () => {});
    });
  });
}
ipcMain.handle('lan-start', (_e, id) => startLan(id));

// ---------- Wake-on-LAN: magic packet = 6×0xFF + 16× MAC, sent as UDP broadcast ----------
ipcMain.handle('wol', async (_e, mac) => {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) return false;
  const m = Buffer.from(hex, 'hex'), pkt = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) m.copy(pkt, 6 + i * 6);
  const sock = dgram.createSocket('udp4');
  await new Promise(r => sock.bind(0, r)); sock.setBroadcast(true);
  const targets = new Set(['255.255.255.255']);
  for (const a of lanAddrs()) { const ip = a.address.split('.').map(Number), mk = a.netmask.split('.').map(Number); targets.add(ip.map((o, i) => (o & mk[i]) | (~mk[i] & 255)).join('.')); }
  for (const t of targets) for (const port of [9, 7]) await new Promise(r => sock.send(pkt, port, t, () => r()));
  sock.close(); return true;
});


// ---------- Windows: administrator + Secure Desktop service (lock screen, UAC, Ctrl+Alt+Del) ----------
const POLICY_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';
const SVC = 'UniDeskService';
const SVC_DIR = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'UniDesk Service');
const SVC_EXE = path.join(SVC_DIR, 'UniDeskHelper.exe');
const TOKEN_FILE = path.join(process.env.ProgramData || 'C:\\ProgramData', 'UniDesk', 'service.token');
function run(cmd, args) { return new Promise(res => execFile(cmd, args, { windowsHide: true }, (err, stdout) => res({ code: err ? (err.code ?? 1) : 0, out: String(stdout || '') }))); }
let isAdminCached = null;
async function isAdmin() { if (process.platform !== 'win32') return false; if (isAdminCached === null) isAdminCached = (await run('net', ['session'])).code === 0; return isAdminCached; }
function bundledHelper() {
  const p = app.isPackaged ? path.join(process.resourcesPath, 'helper', 'UniDeskHelper.exe') : path.join(__dirname, 'native', 'UniDeskHelper.exe');
  return fs.existsSync(p) ? p : null;
}
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
async function serviceState() { const q = await run('sc', ['query', SVC]); if (q.code !== 0) return 'missing'; return /RUNNING/.test(q.out) ? 'running' : 'stopped'; }
// Install or update the service. Needs admin; the helper lives in Program Files so normal users can't replace it.
async function ensureService() {
  if (process.platform !== 'win32' || !(await isAdmin())) return { ok: false, reason: 'not-admin' };
  const src = bundledHelper(); if (!src) return { ok: false, reason: 'no-helper' };
  let state = await serviceState();
  if (state !== 'missing' && sha(src) === sha(SVC_EXE)) {
    if (state !== 'running') await run('sc', ['start', SVC]);
    return { ok: true, state: await serviceState() };
  }
  if (state === 'running') { await run('sc', ['stop', SVC]); await new Promise(r => setTimeout(r, 1500)); }
  fs.mkdirSync(SVC_DIR, { recursive: true });
  fs.copyFileSync(src, SVC_EXE);
  if (state === 'missing') {
    await run('sc', ['create', SVC, 'binPath=', `"${SVC_EXE}" service`, 'start=', 'auto', 'obj=', 'LocalSystem', 'DisplayName=', 'UniDesk Secure Desktop']);
    await run('sc', ['description', SVC, 'Lets trusted UniDesk sessions see and control the lock screen, UAC prompts and Ctrl+Alt+Del.']);
    await run('sc', ['failure', SVC, 'reset=', '86400', 'actions=', 'restart/5000/restart/5000/restart/5000']);
  }
  // allow services to simulate Ctrl+Alt+Del (SendSAS)
  await run('reg', ['add', POLICY_KEY, '/v', 'SoftwareSASGeneration', '/t', 'REG_DWORD', '/d', '1', '/f']);
  await run('sc', ['start', SVC]);
  return { ok: true, state: await serviceState() };
}
ipcMain.handle('admin-status', async () => {
  if (process.platform !== 'win32') return { supported: false };
  return { supported: true, admin: await isAdmin(), service: await serviceState(), helper: !!bundledHelper() };
});
ipcMain.handle('service-install', () => ensureService());

// --- tiny line protocol client for the service / agent (127.0.0.1 only) ---
const net = require('net');
function lineClient(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1'); let buf = Buffer.alloc(0); const waiters = [];
    const pump = () => { while (waiters.length) { const r = waiters[0](buf); if (!r) return; buf = buf.subarray(r.used); waiters.shift().done(r.value); } };
    s.on('data', d => { buf = Buffer.concat([buf, d]); pump(); });
    s.on('error', reject);
    s.on('close', () => { while (waiters.length) waiters.shift().done(null); });
    s.on('connect', () => {
      let chain = Promise.resolve();
      const line = () => new Promise(res => { const f = b => { const i = b.indexOf(10); return i < 0 ? null : { used: i + 1, value: b.subarray(0, i).toString() }; }; f.done = res; waiters.push(f); pump(); });
      const bytes = (n) => new Promise(res => { const f = b => b.length >= n ? { used: n, value: b.subarray(0, n) } : null; f.done = res; waiters.push(f); pump(); });
      const cmd = (l, withBody) => (chain = chain.then(async () => {
        if (s.destroyed) return null;
        s.write(l + '\n'); const h = await line();
        if (h && withBody && h.startsWith('OK ')) { const n = +h.split(' ').pop(); return { head: h, body: await bytes(n) }; }
        return h;
      }).catch(() => null));
      resolve({ cmd, close: () => s.destroy(), get closed() { return s.destroyed; } });
    });
  });
}
async function serviceCmd(command) {
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); // readable only by Administrators/SYSTEM
  const c = await lineClient(47810);
  await c.cmd('TOKEN ' + token);
  const r = await c.cmd(command); c.close(); return r;
}

// --- secure desktop session (host side) ---
let secure = { agent: null, timer: null, active: false, sender: null };
const VK = (() => {
  const m = { Enter: 13, NumpadEnter: 13, Escape: 27, Backspace: 8, Tab: 9, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    ShiftLeft: 0xA0, ShiftRight: 0xA1, ControlLeft: 0xA2, ControlRight: 0xA3, AltLeft: 0xA4, AltRight: 0xA5, MetaLeft: 0x5B, MetaRight: 0x5C,
    Delete: 0x2E, Insert: 0x2D, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, CapsLock: 0x14, Minus: 0xBD, Equal: 0xBB,
    BracketLeft: 0xDB, BracketRight: 0xDD, Backslash: 0xDC, Semicolon: 0xBA, Quote: 0xDE, Comma: 0xBC, Period: 0xBE, Slash: 0xBF, Backquote: 0xC0 };
  for (let i = 0; i < 26; i++) m['Key' + String.fromCharCode(65 + i)] = 65 + i;
  for (let i = 0; i <= 9; i++) { m['Digit' + i] = 48 + i; m['Numpad' + i] = 0x60 + i; }
  for (let i = 1; i <= 12; i++) m['F' + i] = 0x6F + i;
  return m;
})();
async function secureStart(sender) {
  if (process.platform !== 'win32' || secure.agent) return false;
  try {
    if ((await serviceState()) !== 'running') { const r = await ensureService(); if (!r.ok) return false; }
    const res = await serviceCmd('AGENT'); // "OK <port> <token>"
    if (!res || !res.startsWith('OK ')) return false;
    const [, port, tok] = res.split(' ');
    await new Promise(r => setTimeout(r, 700));
    const a = await lineClient(+port); if ((await a.cmd('TOKEN ' + tok)) !== 'OK') { a.close(); return false; }
    secure = { agent: a, active: false, sender, timer: null, busy: false };
    secure.timer = setInterval(secureTick, 160);
    return true;
  } catch { return false; }
}
async function secureTick() {
  const s = secure; if (!s.agent || s.busy) return; s.busy = true;
  try {
    if (s.agent.closed) return secureStop();
    const d = await s.agent.cmd('DESK'); const desk = (d || '').slice(3);
    const isSecure = !!desk && desk.toLowerCase() !== 'default';
    if (isSecure) {
      const f = await s.agent.cmd('FRAME 1600 55', true);
      if (f && f.body) s.sender?.send('secure-frame', { desk, jpeg: f.body.toString('base64') });
    } else if (s.active) s.sender?.send('secure-frame', null);
    s.active = isSecure;
  } finally { s.busy = false; }
}
function secureStop() {
  clearInterval(secure.timer);
  if (secure.agent) { secure.agent.cmd('QUIT'); setTimeout(() => secure.agent?.close(), 300); }
  secure = { agent: null, timer: null, active: false, sender: null };
}
ipcMain.handle('secure-start', (e) => secureStart(e.sender));
ipcMain.on('secure-stop', () => secureStop());
ipcMain.handle('send-cad', async () => { try { return (await serviceCmd('SAS')) === 'OK'; } catch { return false; } });
// route viewer input to the secure desktop while it is showing
function secureInput(ev) {
  const a = secure.agent; if (!a || !secure.active) return false;
  if (ev.t === 'move') a.cmd(`MOVE ${(+ev.x).toFixed(5)} ${(+ev.y).toFixed(5)}`);
  else if (ev.t === 'down' || ev.t === 'up') a.cmd(`${ev.t === 'down' ? 'DOWN' : 'UP'} ${+ev.b || 0}`);
  else if (ev.t === 'wheel') a.cmd(`WHEEL ${Math.round(-(+ev.dy || 0) * 1.2)}`);
  else if ((ev.t === 'kd' || ev.t === 'ku') && VK[ev.c]) a.cmd(`KEY ${VK[ev.c]} ${ev.t === 'kd' ? 1 : 0}`);
  else if (ev.t === 'type' && typeof ev.text === 'string') { /* typing on the lock screen: send characters as keys */
    for (const ch of ev.text.slice(0, 200)) { const code = /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /\d/.test(ch) ? 'Digit' + ch : null; if (code) { const up = ch !== ch.toLowerCase(); if (up) a.cmd('KEY 160 1'); a.cmd(`KEY ${VK[code]} 1`); a.cmd(`KEY ${VK[code]} 0`); if (up) a.cmd('KEY 160 0'); } }
  }
  return true;
}
ipcMain.handle('admin-relaunch', () => {
  if (process.platform !== 'win32') return false;
  const args = app.isPackaged ? [] : [path.resolve(process.argv[1] || '.')];
  const argList = args.length ? ` -ArgumentList '${args[0].replace(/'/g, "''")}'` : '';
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Sleep -Milliseconds 800; Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}'${argList} -Verb RunAs`], { detached: true, stdio: 'ignore' }).unref();
  quitting = true; setTimeout(() => app.exit(0), 300); return true;
});

// ---------- Draw-on-screen overlay (host side) ----------
let overlayWin = null;
// Windows 10 2004+ can leave a window out of screen capture entirely (older versions would capture it as a black box)
const DRAW_HIDDEN = process.platform === 'win32' && (+os0.release().split('.')[2] || 0) >= 19041;
function ensureOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const b = activeDisplay ? eScreen.getAllDisplays().find(d => { const p = physBounds(d); return p.x === activeDisplay.x && p.y === activeDisplay.y; }) || eScreen.getPrimaryDisplay() : eScreen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    ...b.bounds, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, fullscreenable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true }
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
  overlayWin.loadFile('overlay.html');
  overlayWin.once('ready-to-show', () => {
    overlayWin.showInactive();
    // keep the drawing out of the shared picture (the visitor already sees their own strokes); Windows only applies this once the window is shown
    if (DRAW_HIDDEN) overlayWin.setContentProtection(true);
  });
  return overlayWin;
}
ipcMain.on('draw', (_e, m) => { const o = ensureOverlay(); if (o.webContents.isLoading()) o.webContents.once('did-finish-load', () => o.webContents.send('draw', m)); else o.webContents.send('draw', m); });
ipcMain.on('draw-close', () => { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy(); overlayWin = null; });

// ---------- Plain wallpaper (host side) ----------
let u32 = null;
function user32() {
  if (!u32) {
    const lib = require('koffi').load('user32.dll');
    u32 = {
      spi: lib.func('int __stdcall SystemParametersInfoW(uint32_t uiAction, uint32_t uiParam, void *pvParam, uint32_t fWinIni)')
    };
  }
  return u32;
}
// The wallpaper is swapped for a plain colour only for this sign-in (not saved to the
// registry), so even if UniDesk crashed it comes back at the next sign-in.
const SPI_GETDESKWALLPAPER = 0x73, SPI_SETDESKWALLPAPER = 0x14, SPIF_SENDCHANGE = 0x02;
const wallFile = () => path.join(app.getPath('userData'), 'wallpaper-restore.json');
let wallSaved = null;
// Linux: GNOME-family desktops keep the wallpaper in gsettings; 'none' as picture-options shows the plain colour.
const LINUX_OPTS = ['wallpaper', 'centered', 'scaled', 'stretched', 'zoom', 'spanned'];
function linuxBgSchema() {
  const de = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  return de.includes('cinnamon') ? 'org.cinnamon.desktop.background' : de.includes('mate') ? 'org.mate.background' : 'org.gnome.desktop.background';
}
async function linuxWallOpts(schema) { const r = await run('gsettings', ['get', schema, 'picture-options']); return r.code === 0 ? r.out.trim().replace(/^'|'$/g, '') : null; }
async function linuxWallHide() {
  if (wallSaved !== null) return false;
  const schema = linuxBgSchema(), cur = await linuxWallOpts(schema);
  if (!cur || !LINUX_OPTS.includes(cur)) return false;   // no gsettings, unknown desktop, or already plain
  fs.writeFileSync(wallFile(), JSON.stringify({ linux: schema, opts: cur }));
  await run('gsettings', ['set', schema, 'picture-options', 'none']);
  if ((await linuxWallOpts(schema)) !== 'none') { fs.rmSync(wallFile(), { force: true }); return false; }
  wallSaved = cur; return true;
}
function linuxWallRestore() {
  let saved = null; try { saved = JSON.parse(fs.readFileSync(wallFile(), 'utf8')); } catch {}
  const schema = saved?.linux || linuxBgSchema(), opts = wallSaved ?? saved?.opts;
  if (!opts || !LINUX_OPTS.includes(opts) || !/^org\.(gnome\.desktop\.background|cinnamon\.desktop\.background|mate\.background)$/.test(schema)) { wallSaved = null; return false; }
  try { require('child_process').execFileSync('gsettings', ['set', schema, 'picture-options', opts], { timeout: 4000, stdio: 'ignore' }); } catch {}
  wallSaved = null; try { fs.rmSync(wallFile(), { force: true }); } catch {}
  return true;
}
function wallSet(p) { return user32().spi(SPI_SETDESKWALLPAPER, 0, Buffer.from(String(p) + '\0', 'utf16le'), SPIF_SENDCHANGE) !== 0; }
ipcMain.handle('wallpaper-hide', () => {
  if (process.platform === 'linux') return linuxWallHide().catch(() => false);
  if (process.platform !== 'win32' || wallSaved !== null) return false;
  try {
    const buf = Buffer.alloc(1040); user32().spi(SPI_GETDESKWALLPAPER, 520, buf, 0);
    const cur = buf.toString('utf16le').replace(/\0[\s\S]*$/, '');
    if (!cur) return false;                       // already a plain colour
    fs.writeFileSync(wallFile(), JSON.stringify({ path: cur }));
    if (!wallSet('')) { fs.rmSync(wallFile(), { force: true }); return false; }
    wallSaved = cur; return true;
  } catch { return false; }
});
function wallRestore() {
  if (process.platform === 'linux') return linuxWallRestore();
  if (process.platform !== 'win32') return false;
  let p = wallSaved;
  if (p === null) { try { p = JSON.parse(fs.readFileSync(wallFile(), 'utf8')).path; } catch { return false; } }  // left over from a crash
  try { if (p) wallSet(p); } catch {}
  wallSaved = null; try { fs.rmSync(wallFile(), { force: true }); } catch {}
  return true;
}
ipcMain.handle('wallpaper-restore', () => wallRestore());
app.on('will-quit', () => { wallRestore(); });
app.whenReady().then(() => setTimeout(wallRestore, 1500));
const { mouse, keyboard, Button, Key, Point } = require('@nut-tree-fork/nut-js');

mouse.config.autoDelayMs = 0;
mouse.config.mouseSpeed = 100000;
keyboard.config.autoDelayMs = 0;

app.commandLine.appendSwitch('enable-features', 'WebRtcAllowInputVolumeAdjustment,PlatformHEVCEncoderSupport');
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-Video-EnableHardwareEncoder/Enabled/');

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 780, minHeight: 540,
    title: 'UniDesk', backgroundColor: '#070a14', autoHideMenuBar: true, show: false,
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 }, vibrancy: 'under-window', visualEffectState: 'active' }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#c9d1ea', height: 46 }, backgroundMaterial: 'mica' }),
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.loadFile('index.html');
  const hidden = process.argv.includes('--hidden');
  win.once('ready-to-show', () => { if (!hidden) win.show(); });
  win.on('close', (e) => { if (mainPrefs.tray && !quitting) { e.preventDefault(); win.hide(); trayHint(); } });
}
// ---------- Session tabs ----------
// Extra sessions run as their own UniDesk page (a WebContentsView) under the main window's title bar,
// each with its own connection. The main page draws the tab strip; 0 is the main page itself.
const TAB_TOP = 46;                       // height of the main page's title bar
const tabs = new Map();                   // id -> { view, title, live, full }
let tabSeq = 0, activeTab = 0;
const tabOf = (wc) => [...tabs.entries()].find(([, t]) => t.view.webContents === wc);
const allPages = () => [win?.webContents, ...[...tabs.values()].map(t => t.view.webContents)].filter(w => w && !w.isDestroyed());
function layoutTabs() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  for (const [id, t] of tabs) {
    t.view.setBounds(t.full ? { x: 0, y: 0, width: w, height: h } : { x: 0, y: TAB_TOP, width: w, height: Math.max(0, h - TAB_TOP) });
    t.view.setVisible(id === activeTab);
  }
}
// The window's size settles a moment after fullscreen / maximize, so lay the tabs out again until it has.
// A resize sent while the window is changing state can get lost on the page's side, so we check what size
// the page really has and nudge it (1 px smaller, then exact) until it matches.
let layoutGen = 0;
function layoutSoon() {
  const gen = ++layoutGen;
  layoutTabs();
  for (const ms of [60, 200, 450]) setTimeout(() => gen === layoutGen && layoutTabs(), ms);
  const verify = async (left) => {
    if (gen !== layoutGen || !win || win.isDestroyed()) return;
    layoutTabs();
    let bad = false;
    for (const t of tabs.values()) {
      if (t.view.webContents.isDestroyed()) continue;
      const b = t.view.getBounds(); if (!b.width || !b.height) continue;
      const got = await t.view.webContents.executeJavaScript('[innerWidth, innerHeight]').catch(() => null);
      if (!got || Math.abs(got[0] * t.view.webContents.getZoomFactor() - b.width) > 2 || Math.abs(got[1] * t.view.webContents.getZoomFactor() - b.height) > 2) {
        bad = true; t.view.setBounds({ ...b, height: Math.max(1, b.height - 1) }); t.view.setBounds(b);
      }
    }
    if (bad && left > 0) setTimeout(() => verify(left - 1), 300);
  };
  setTimeout(() => verify(6), 900);
}
function sendTabs() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('tabs', { active: activeTab, list: [...tabs.entries()].map(([id, t]) => ({ id, title: t.title, live: t.live })) });
}
function selectTab(id) {
  if (id !== 0 && !tabs.has(id)) id = 0;
  activeTab = id; layoutTabs(); sendTabs();
  const wc = id ? tabs.get(id).view.webContents : win.webContents;
  if (!wc.isDestroyed()) wc.focus();
}
function closeTab(id) {
  const t = tabs.get(id); if (!t) return;
  tabs.delete(id);
  const done = () => { try { win.contentView.removeChildView(t.view); } catch {} try { t.view.webContents.close(); } catch {} };
  // end the session politely first, so the other PC sees "ended" rather than a dropped connection
  t.view.webContents.executeJavaScript("typeof role !== 'undefined' && role ? (endAll({ quiet: true }), true) : false").catch(() => false).then((ended) => setTimeout(done, ended ? 400 : 0));
  if (t.full && win.isFullScreen()) win.setFullScreen(false);
  if (activeTab === id) activeTab = 0;
  selectTab(activeTab);
}
ipcMain.handle('tab-open', (_e, target) => {
  if (!win || win.isDestroyed()) return 0;
  if (tabs.size >= 8) return 0;
  const id = ++tabSeq;
  const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  view.setBackgroundColor('#070a14');
  const t = { view, title: 'New tab', live: false, full: false };
  tabs.set(id, t);
  win.contentView.addChildView(view);
  const query = { tab: String(id) }; const tgt = String(target || '').replace(/\D/g, ''); if (tgt.length === 9) query.target = tgt;
  view.webContents.loadFile('index.html', { query });
  view.webContents.on('render-process-gone', () => closeTab(id));
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  selectTab(id);
  return id;
});
ipcMain.handle('tab-select', (_e, id) => selectTab(Number(id) || 0));
ipcMain.handle('tab-close', (_e, id) => closeTab(Number(id)));
// fullscreen for a tab: the whole window goes fullscreen and the tab covers it (title bar included)
function setTabFull(t, on) {
  if (!t || t.full === !!on) return;
  t.full = !!on;
  if (win.isFullScreen() !== t.full) win.setFullScreen(t.full);
  layoutSoon();
  if (!t.view.webContents.isDestroyed()) t.view.webContents.send('tab-fs', t.full);
}
ipcMain.handle('tab-fullscreen', (e, on) => { const hit = tabOf(e.sender); if (!hit) return false; setTabFull(hit[1], on); return hit[1].full; });
ipcMain.on('tab-state', (e, s) => {
  const hit = tabOf(e.sender); if (!hit) return;
  const [, t] = hit; t.title = String(s?.title || 'New tab').slice(0, 60); t.live = !!s?.live; sendTabs();
});

app.whenReady().then(() => {
  createWindow(); createTray();
  win.on('resize', layoutTabs);
  for (const ev of ['maximize', 'unmaximize', 'restore', 'enter-full-screen']) win.on(ev, layoutSoon);
  win.on('leave-full-screen', () => { for (const t of tabs.values()) setTabFull(t, false); layoutSoon(); });
  if (app.isPackaged) setTimeout(() => ensureService().catch(() => {}), 4000); // install/update the Secure Desktop service
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => showWin()); // macOS: clicking the Dock icon reopens the window
app.on('before-quit', () => { quitting = true; });

// ---------- Tray & startup ----------
let tray = null, quitting = false, hinted = false;
let mainPrefs = { tray: true, startup: false };
function showWin() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function trayHint() {
  if (hinted || !tray) return; hinted = true;
  try { tray.displayBalloon({ title: 'UniDesk is still running', content: 'It stays reachable in the tray. Right-click the icon to quit.', iconType: 'info' }); } catch {}
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('UniDesk');
  tray.on('click', showWin);
  updateTrayMenu('');
}
function updateTrayMenu(id) {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: id ? `Address: ${id}` : 'UniDesk', enabled: false },
    { label: 'Copy address', enabled: !!id, click: () => clipboard.writeText(id.replace(/\s/g, '')) },
    { type: 'separator' },
    { label: 'Open UniDesk', click: showWin },
    { label: 'Settings', click: () => { showWin(); win.webContents.send('open-settings'); } },
    { type: 'separator' },
    { label: 'Quit UniDesk', click: () => { quitting = true; app.quit(); } }
  ]));
}
ipcMain.on('my-id', (_e, id) => { updateTrayMenu(id); tray?.setToolTip(`UniDesk · ${id}`); });
ipcMain.on('main-prefs', (_e, p) => {
  mainPrefs = { ...mainPrefs, ...p };
  if (!app.isPackaged) return;
  if (process.platform === 'win32') {
    // UniDesk runs as administrator, and Windows ignores elevated apps in the normal Run key,
    // so start-up uses a scheduled task with highest privileges instead.
    if (mainPrefs.startup) run('schtasks', ['/create', '/f', '/tn', 'UniDesk', '/sc', 'onlogon', '/rl', 'highest', '/tr', `"${process.execPath}" --hidden`]);
    else run('schtasks', ['/delete', '/f', '/tn', 'UniDesk']);
  } else if (process.platform === 'linux') {
    // Linux has no login-item API: use an XDG autostart entry pointing at the AppImage
    const file = path.join(os0.homedir(), '.config', 'autostart', 'unidesk.desktop');
    try {
      if (mainPrefs.startup && process.env.APPIMAGE) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=UniDesk\nExec="${process.env.APPIMAGE}" --hidden\nX-GNOME-Autostart-enabled=true\n`); }
      else fs.rmSync(file, { force: true });
    } catch {}
  } else app.setLoginItemSettings({ openAtLogin: !!mainPrefs.startup, openAsHidden: true });
});
ipcMain.on('show-window', showWin);

// ---------- Unattended access: password verifier + challenge/response + lockout ----------
// We store only salt + PBKDF2-SHA256 key (never the password). A visitor proves knowledge of the
// password by returning HMAC(key, nonce) for a fresh random nonce, so nothing replayable crosses the wire.
const authFile = () => path.join(app.getPath('userData'), 'unattended.json');
const KDF_ITER = 310000;
function readAuth() { try { return JSON.parse(fs.readFileSync(authFile(), 'utf8')); } catch { return null; } }
ipcMain.handle('auth-has', () => !!readAuth());
ipcMain.handle('auth-set', (_e, pw) => {
  if (typeof pw !== 'string' || pw.length < 8) return { ok: false, error: 'Use at least 8 characters.' };
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(pw, salt, KDF_ITER, 32, 'sha256');
  fs.writeFileSync(authFile(), JSON.stringify({ salt: salt.toString('hex'), key: key.toString('hex'), iter: KDF_ITER, set: Date.now() }));
  failures.length = 0; lockedUntil = 0;
  return { ok: true };
});
ipcMain.handle('auth-clear', () => { try { fs.unlinkSync(authFile()); } catch {} return true; });

const challenges = new Map(); // peerId -> { nonce, at }
const failures = []; let lockedUntil = 0;
const MAX_FAILS = 5, WINDOW_MS = 10 * 60e3, LOCK_MS = 15 * 60e3;
const lockMins = () => Math.ceil((lockedUntil - Date.now()) / 60e3);
// One-time access code: random, kept only in memory as a PBKDF2 key, destroyed after one successful use.
// It shares the unattended password's salt (when one exists) so a single challenge covers both.
let otp = null; // { code, key: Buffer, salt }
const OTP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
ipcMain.handle('otp-new', () => {
  const bytes = crypto.randomBytes(8); let raw = '';
  for (const b of bytes) raw += OTP_ALPHABET[b % OTP_ALPHABET.length];
  const salt = readAuth()?.salt || crypto.randomBytes(16).toString('hex');
  otp = { code: raw.slice(0, 4) + '-' + raw.slice(4), salt, key: crypto.pbkdf2Sync(raw, Buffer.from(salt, 'hex'), KDF_ITER, 32, 'sha256') };
  return otp.code;
});
ipcMain.handle('otp-clear', () => { otp = null; return true; });
ipcMain.handle('auth-challenge', (_e, peerId, usePw) => {
  const a = usePw ? readAuth() : null;
  if (!a && !otp) return { none: true };
  if (otp && a && otp.salt !== a.salt) otp = null; // password was changed: old code is void
  if (Date.now() < lockedUntil) return { locked: lockMins() };
  const nonce = crypto.randomBytes(32).toString('hex');
  challenges.set(peerId, { nonce, at: Date.now(), usePw: !!a });
  return { nonce, salt: (a || otp).salt, iter: KDF_ITER };
});
const hmacOk = (key, nonce, proof) => {
  const expect = crypto.createHmac('sha256', key).update(nonce).digest();
  let got; try { got = Buffer.from(String(proof || ''), 'hex'); } catch { got = Buffer.alloc(0); }
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
};
ipcMain.handle('auth-verify', (_e, peerId, proof, codeProof) => {
  const ch = challenges.get(peerId);
  challenges.delete(peerId); // one-time nonce
  if (!ch || Date.now() - ch.at > 120e3) return { ok: false, expired: true };
  if (Date.now() < lockedUntil) return { ok: false, locked: lockMins() };
  const a = ch.usePw ? readAuth() : null;
  if (a && hmacOk(Buffer.from(a.key, 'hex'), ch.nonce, proof)) return { ok: true, via: 'password' };
  if (otp && hmacOk(otp.key, ch.nonce, codeProof)) { otp = null; return { ok: true, via: 'code' }; }
  const now = Date.now(); failures.push(now);
  while (failures.length && now - failures[0] > WINDOW_MS) failures.shift();
  if (failures.length >= MAX_FAILS) { lockedUntil = now + LOCK_MS; failures.length = 0; return { ok: false, locked: lockMins() }; }
  return { ok: false, left: MAX_FAILS - failures.length };
});
// Viewer side: derive proof locally (password never leaves this PC)
ipcMain.handle('auth-proof', (_e, pw, salt, nonce, iter) => {
  const it = Math.min(Math.max(+iter || KDF_ITER, 100000), 2000000);
  const proofFor = (secret) => crypto.createHmac('sha256', crypto.pbkdf2Sync(String(secret), Buffer.from(salt, 'hex'), it, 32, 'sha256')).update(String(nonce)).digest('hex');
  // proof for a password (exact text) and for a one-time code (case/dash-insensitive)
  return { proof: proofFor(pw), codeProof: proofFor(normCode(pw)) };
});

// ---------- Remote file browser (host side; only used when the visitor was allowed to browse) ----------
ipcMain.handle('fs-roots', () => {
  const roots = [{ name: 'Home', path: os0.homedir() }];
  if (process.platform === 'win32') { for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { const p = L + ':\\'; try { fs.accessSync(p); roots.push({ name: L + ':', path: p }); } catch {} } }
  else { roots.push({ name: '/', path: '/' }); try { for (const v of fs.readdirSync('/Volumes')) roots.push({ name: v, path: '/Volumes/' + v }); } catch {} }
  return roots;
});
ipcMain.handle('fs-list', async (_e, dir) => {
  try {
    const d = path.resolve(String(dir));
    const ents = await fs.promises.readdir(d, { withFileTypes: true });
    const out = [];
    for (const e of ents.slice(0, 3000)) {
      if (e.name.startsWith('$')) continue;
      const full = path.join(d, e.name); let st = null;
      try { st = await fs.promises.stat(full); } catch { continue; }
      out.push({ name: e.name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
    }
    out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { path: d, parent: path.dirname(d) !== d ? path.dirname(d) : null, entries: out };
  } catch (e) { return { error: e.code === 'EPERM' || e.code === 'EACCES' ? 'Access denied' : 'Cannot open this folder' }; }
});
// Changes from the visitor's file manager (needs both "browse" and "files" permissions on the host)
const cleanName = (n) => { const s = String(n || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 200); return s && s !== '.' && s !== '..' ? s : null; };
const fsErr = (e) => e.code === 'EPERM' || e.code === 'EACCES' ? 'Access denied' : e.code === 'EEXIST' ? 'Something with that name already exists' : e.code === 'ENOENT' ? 'It no longer exists' : e.code === 'EBUSY' ? 'It’s in use by another program' : 'That didn’t work';
const isRootPath = (p) => path.dirname(p) === p;
ipcMain.handle('fs-mkdir', async (_e, dir, name) => {
  const n = cleanName(name); if (!n) return { error: 'Enter a valid name' };
  try { const p = path.join(path.resolve(String(dir)), n); await fs.promises.mkdir(p); return { ok: true, path: p }; } catch (e) { return { error: fsErr(e) }; }
});
ipcMain.handle('fs-rename', async (_e, from, name) => {
  const n = cleanName(name); if (!n) return { error: 'Enter a valid name' };
  try {
    const src = path.resolve(String(from)); if (isRootPath(src)) return { error: 'A drive can’t be renamed' };
    const dst = path.join(path.dirname(src), n);
    if (dst.toLowerCase() !== src.toLowerCase() && fs.existsSync(dst)) return { error: 'Something with that name already exists' };
    await fs.promises.rename(src, dst); return { ok: true, path: dst };
  } catch (e) { return { error: fsErr(e) }; }
});
ipcMain.handle('fs-trash', async (_e, p) => {
  try {
    const t = path.resolve(String(p)); if (isRootPath(t)) return { error: 'A drive can’t be deleted' };
    if (t === path.resolve(os0.homedir())) return { error: 'The home folder can’t be deleted' };
    await fs.promises.access(t); await shell.trashItem(t); return { ok: true };   // Recycle Bin / Trash, so it can be restored
  } catch (e) { return { error: e.code ? fsErr(e) : 'Couldn’t move it to the Recycle Bin' }; }
});
ipcMain.handle('fs-stat', async (_e, f) => { try { const st = await fs.promises.stat(String(f)); return st.isFile() ? { size: st.size, name: path.basename(String(f)) } : null; } catch { return null; } });
ipcMain.handle('fs-read', async (_e, f, offset, len) => {
  const fh = await fs.promises.open(String(f), 'r');
  try { const buf = Buffer.alloc(Math.min(len, 256 * 1024)); const { bytesRead } = await fh.read(buf, 0, buf.length, offset); return { d: buf.subarray(0, bytesRead).toString('base64'), n: bytesRead }; }
  finally { await fh.close(); }
});

// Address book backup: save to / load from a .json file the user picks
ipcMain.handle('desks-export', async (_e, text) => {
  const r = await dialog.showSaveDialog(win, { title: 'Export address book', defaultPath: path.join(app.getPath('documents'), 'UniDesk address book.json'), filters: [{ name: 'UniDesk address book', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  try { fs.writeFileSync(r.filePath, String(text)); return r.filePath; } catch { return { error: 'Couldn’t save the file' }; }
});
ipcMain.handle('desks-import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import address book', properties: ['openFile'], filters: [{ name: 'UniDesk address book', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  try { const st = fs.statSync(r.filePaths[0]); if (st.size > 2 * 1024 * 1024) return { error: 'That file is too big to be an address book' }; return { text: fs.readFileSync(r.filePaths[0], 'utf8') }; } catch { return { error: 'Couldn’t read the file' }; }
});

// Remembered passwords for desks you connect to, encrypted with Windows DPAPI via safeStorage
const savedFile = () => path.join(app.getPath('userData'), 'saved-desks.json');
const readSaved = () => { try { return JSON.parse(fs.readFileSync(savedFile(), 'utf8')); } catch { return {}; } };
ipcMain.handle('pw-remember', (_e, id, pw) => {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const s = readSaved(); s[id] = safeStorage.encryptString(String(pw)).toString('base64');
  fs.writeFileSync(savedFile(), JSON.stringify(s)); return true;
});
ipcMain.handle('pw-get', (_e, id) => {
  const v = readSaved()[id]; if (!v || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(v, 'base64')); } catch { return null; }
});
ipcMain.handle('pw-forget', (_e, id) => { const s = readSaved(); if (id) delete s[id]; else for (const k in s) delete s[k]; fs.writeFileSync(savedFile(), JSON.stringify(s)); return true; });

// ---------- System info & host actions ----------
const os = require('os');
const { execFile } = require('child_process');
ipcMain.handle('sysinfo', () => {
  const rel = os.release(); const build = +rel.split('.')[2] || 0;
  return {
    host: os.hostname(),
    os: os.platform() === 'win32' ? `Windows ${build >= 22000 ? 11 : 10}` : IS_MAC ? `macOS ${process.getSystemVersion()}` : `Linux ${rel}`,
    ram: Math.round(os.totalmem() / 1073741824) + ' GB',
    cpu: (os.cpus()[0]?.model || '').replace(/\s+/g, ' ').trim(),
    cores: os.cpus().length,
    drawHidden: DRAW_HIDDEN
  };
});
// Detailed, live PC info for the visitor's info panel
const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });
let cpuPrev = cpuTimes();
const runPs = (cmd) => new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 6000 }, (err, out) => res(err ? '' : String(out))));
let slowInfo = null, slowAt = 0;   // disks, battery and OS edition change slowly: refresh at most every 30 s
async function getSlowInfo() {
  if (slowInfo && Date.now() - slowAt < 30000) return slowInfo;
  const disks = [];
  const roots = process.platform === 'win32' ? [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map(L => L + ':\\') : ['/', ...(() => { try { return fs.readdirSync('/Volumes').map(v => '/Volumes/' + v); } catch { return []; } })()];
  for (const r of roots) {
    try { const s = await fs.promises.statfs(r); const total = s.blocks * s.bsize; if (total > 0) disks.push({ name: process.platform === 'win32' ? r.slice(0, 2) : (r === '/' ? 'Macintosh HD' : path.basename(r)), total, free: s.bavail * s.bsize }); } catch {}
  }
  let battery = null, edition = '';
  if (process.platform === 'win32') {
    const out = await runPs("$b = Get-CimInstance Win32_Battery | Select-Object -First 1; $o = Get-CimInstance Win32_OperatingSystem; \"$($o.Caption)|$($o.Version)|$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)\"");
    const [cap, ver, pct, st] = out.trim().split('|');
    edition = cap ? `${cap.replace(/^Microsoft\s+/, '')} (${ver})` : '';
    if (pct) battery = { pct: +pct, charging: ['2', '6', '7', '8', '9'].includes(st) };
  } else if (IS_MAC) {
    const out = await new Promise(r => execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 4000 }, (e, o) => r(e ? '' : String(o))));
    const m = out.match(/(\d+)%;\s*([a-z ]+);/i); if (m) battery = { pct: +m[1], charging: /^charg|charged/i.test(m[2].trim()) };
  }
  slowInfo = { disks, battery, edition }; slowAt = Date.now(); return slowInfo;
}
ipcMain.handle('sysinfo-full', async () => {
  const now = cpuTimes(); const dt = now.total - cpuPrev.total;
  const cpuPct = dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - (now.idle - cpuPrev.idle) / dt) * 100))) : 0; cpuPrev = now;
  const nets = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (!a.internal && a.family === 'IPv4') nets.push({ name, ip: a.address, mac: a.mac });
  const slow = await getSlowInfo();
  return {
    host: os.hostname(), user: os.userInfo().username,
    os: slow.edition || (process.platform === 'win32' ? `Windows (${os.release()})` : IS_MAC ? `macOS ${process.getSystemVersion()}` : `Linux ${os.release()}`),
    arch: os.arch(), uptime: os.uptime(),
    cpu: (os.cpus()[0]?.model || '').replace(/\s+/g, ' ').trim(), cores: os.cpus().length, cpuPct,
    mem: { total: os.totalmem(), free: os.freemem() },
    disks: slow.disks, battery: slow.battery, nets: nets.slice(0, 8),
    displays: eScreen.getAllDisplays().map(d => ({ w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor), scale: d.scaleFactor, primary: d.id === eScreen.getPrimaryDisplay().id })),
    app: app.getVersion(), admin: process.platform === 'win32' ? await isAdmin() : null
  };
});
// Open a web link the visitor sent (http/https only)
ipcMain.handle('open-url', async (_e, u) => {
  let url; try { url = new URL(String(u)); } catch { return { error: 'That isn’t a valid web address' }; }
  if (!['http:', 'https:'].includes(url.protocol) || String(u).length > 2048) return { error: 'Only http and https links can be opened' };
  if (process.env.UNIDESK_POWER_DRYRUN === '1') return { ok: true, host: url.host, dry: true };   // tests only
  try { await shell.openExternal(url.href); return { ok: true, host: url.host }; } catch { return { error: 'The remote PC couldn’t open it' }; }
});
ipcMain.on('lock-pc', () => {
  if (process.platform === 'win32') execFile('rundll32.exe', ['user32.dll,LockWorkStation']);
  else if (IS_MAC) execFile('/usr/bin/pmset', ['displaysleepnow']); // locks when 'require password' is on
  else execFile('loginctl', ['lock-session'], () => {});
});
ipcMain.handle('reboot', () => new Promise((res) => {
  if (process.platform === 'win32') execFile('shutdown.exe', ['/r', '/t', '5', '/c', 'UniDesk: your remote partner restarted this PC'], { windowsHide: true }, (err) => res(!err));
  else if (IS_MAC) execFile('/usr/bin/osascript', ['-e', 'tell application "System Events" to restart'], (err) => res(!err));
  else linuxPower('reboot').then(res);
}));
// Linux: ask logind whether this user may do it, then do it after 3 s so the reply reaches the visitor first
function linuxPower(what) {
  return new Promise((res) => {
    if (what === 'signout') {
      const sid = process.env.XDG_SESSION_ID;
      try { spawn('/bin/sh', ['-c', sid ? `sleep 3; loginctl terminate-session '${sid.replace(/[^\w-]/g, '')}'` : 'sleep 3; loginctl terminate-user "$(id -un)"'], { detached: true, stdio: 'ignore' }).unref(); return res(true); } catch { return res(false); }
    }
    const m = { reboot: ['CanReboot', 'reboot'], sleep: ['CanSuspend', 'suspend'], shutdown: ['CanPowerOff', 'poweroff'] }[what]; if (!m) return res(false);
    execFile('busctl', ['call', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', m[0]], { timeout: 4000 }, (err, out) => {
      if (err || !/"yes"/.test(String(out))) return res(false);
      try { spawn('/bin/sh', ['-c', `sleep 3; systemctl ${m[1]}`], { detached: true, stdio: 'ignore' }).unref(); res(true); } catch { res(false); }
    });
  });
}
// Sleep / sign out / shut down. Each waits a few seconds so the reply reaches the visitor first.
// UNIDESK_POWER_DRYRUN=1 (tests only) answers without doing anything.
ipcMain.handle('power', (_e, what) => new Promise((res) => {
  if (!['sleep', 'signout', 'shutdown'].includes(what)) return res(false);
  if (process.env.UNIDESK_POWER_DRYRUN === '1') return res(true);
  const done = (err) => res(!err);
  if (process.platform === 'win32') {
    if (what === 'shutdown') return execFile('shutdown.exe', ['/s', '/t', '5', '/c', 'UniDesk: your remote partner shut down this PC'], { windowsHide: true }, done);
    const cmd = what === 'sleep'
      ? "Start-Sleep 3; Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"
      : 'Start-Sleep 3; shutdown.exe /l';
    try { spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); res(true); } catch { res(false); }
  } else if (IS_MAC) {
    const verb = { sleep: 'sleep', signout: 'log out', shutdown: 'shut down' }[what];
    try { spawn('/usr/bin/osascript', ['-e', 'delay 3', '-e', `tell application "System Events" to ${verb}`], { detached: true, stdio: 'ignore' }).unref(); res(true); } catch { res(false); }
  } else linuxPower(what).then(res);
}));

// ---------- Remote task manager ----------
// CPU % comes from the change in each process's CPU time between two refreshes.
let psPrev = { t: 0, cpu: new Map() };
ipcMain.handle('ps-list', () => new Promise((res) => {
  const done = (rows) => {
    const now = Date.now(), dt = (now - psPrev.t) / 1000, cores = os.cpus().length || 1, cpu = new Map();
    for (const r of rows) {
      cpu.set(r.pid, r.cpuSec);
      const before = psPrev.cpu.get(r.pid);
      if (r.cpuPct == null) r.cpuPct = psPrev.t && before != null && r.cpuSec != null && dt > 0 ? Math.max(0, (r.cpuSec - before) / dt / cores * 100) : 0;
      delete r.cpuSec;
    }
    psPrev = { t: now, cpu };
    const self = new Set([process.pid, ...app.getAppMetrics().map(m => m.pid)]);
    rows.forEach(r => { if (self.has(r.pid)) r.self = true; });
    res({ list: rows, mem: { total: os.totalmem(), free: os.freemem() }, cores: os.cpus().length });
  };
  if (process.platform === 'win32') {
    const ps = 'Get-Process | ForEach-Object { "$($_.Id)`t$($_.ProcessName)`t$($_.WorkingSet64)`t$($_.CPU)`t$($_.MainWindowTitle)" }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err && !out) return res({ error: 'Could not read the process list' });
      done(String(out).split(/\r?\n/).filter(Boolean).map(l => { const [pid, name, mem, c, title] = l.split('\t'); return { pid: +pid, name, mem: +mem || 0, cpuSec: c ? +String(c).replace(',', '.') : null, title: title || '' }; }).filter(r => r.pid > 4));
    });
  } else {
    execFile('/bin/ps', ['-axo', 'pid=,rss=,%cpu=,comm='], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err && !out) return res({ error: 'Could not read the process list' });
      done(String(out).split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/)).filter(Boolean).map(m => ({ pid: +m[1], mem: +m[2] * 1024, cpuPct: +m[3] / (os.cpus().length || 1), name: path.basename(m[4]), title: '' })).filter(r => r.pid > 1));
    });
  }
}));
ipcMain.handle('ps-kill', (_e, pid) => new Promise((res) => {
  pid = Math.floor(+pid);
  const self = new Set([process.pid, ...app.getAppMetrics().map(m => m.pid)]);
  if (!(pid > 4) || self.has(pid)) return res({ error: 'That process can’t be ended from UniDesk' });
  if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true }, (err, _o, se) => res(err ? { error: /access/i.test(String(se)) ? 'Access denied (run UniDesk as administrator)' : 'Could not end that process' } : { ok: true }));
  else { try { process.kill(pid); res({ ok: true }); } catch (e) { res({ error: e.code === 'EPERM' ? 'Access denied' : 'Could not end that process' }); } }
}));

// ---------- macOS permissions (Screen Recording + Accessibility) ----------
ipcMain.handle('mac-perms', (_e, prompt) => {
  if (!IS_MAC) return { screen: true, control: true };
  return {
    screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    control: systemPreferences.isTrustedAccessibilityClient(!!prompt)
  };
});
ipcMain.on('open-mac-pref', (_e, which) => {
  if (!IS_MAC) return;
  const pane = which === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility';
  shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
});

// ---------- Recording & screenshots ----------
const mediaDir = (kind) => { const d = path.join(app.getPath(kind === 'video' ? 'videos' : 'pictures'), 'UniDesk'); fs.mkdirSync(d, { recursive: true }); return d; };
const recs = new Map();
ipcMain.handle('rec-start', (_e, name) => { const id = crypto.randomUUID(); const p = path.join(mediaDir('video'), name); recs.set(id, { s: fs.createWriteStream(p), p }); return id; });
ipcMain.on('rec-chunk', (_e, id, buf) => recs.get(id)?.s.write(Buffer.from(buf)));
ipcMain.handle('rec-end', (_e, id) => new Promise(res => { const r = recs.get(id); if (!r) return res(null); r.s.end(() => { recs.delete(id); res(r.p); }); }));
// Recordings of incoming sessions (host side) go to Videos\UniDesk\Incoming
const incomingRecDir = () => { const d = path.join(mediaDir('video'), 'Incoming'); fs.mkdirSync(d, { recursive: true }); return d; };
ipcMain.handle('rec-in-start', (_e, name) => {
  const safe = path.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const id = crypto.randomUUID(), p = path.join(incomingRecDir(), safe); recs.set(id, { s: fs.createWriteStream(p), p }); return id;
});
ipcMain.on('rec-in-open', () => shell.openPath(incomingRecDir()));
// Keep the folder tidy: recordings older than the chosen number of days are moved to the Recycle Bin
ipcMain.handle('rec-in-prune', async (_e, days) => {
  const d = Number(days); if (!(d > 0)) return 0;
  let n = 0; const cut = Date.now() - d * 86400e3;
  try { for (const f of await fs.promises.readdir(incomingRecDir())) { const p = path.join(incomingRecDir(), f); try { const st = await fs.promises.stat(p); if (st.isFile() && /\.webm$/i.test(f) && st.mtimeMs < cut) { await shell.trashItem(p); n++; } } catch {} } } catch {}
  return n;
});
ipcMain.handle('save-shot', (_e, name, buf) => { const p = path.join(mediaDir('image'), name); fs.writeFileSync(p, Buffer.from(buf)); return p; });

// ---------- Theme ----------
ipcMain.handle('system-dark', () => nativeTheme.shouldUseDarkColors);
nativeTheme.on('updated', () => { for (const w of allPages()) w.send('system-theme', nativeTheme.shouldUseDarkColors); });
ipcMain.on('theme', (_e, dark) => {
  if (!win) return;
  try { win.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#c9d1ea' : '#3a4366', height: 46 }); } catch {}
  win.setBackgroundColor(dark ? '#070a14' : '#eef1f8');
});

// ---------- Screens ----------
let activeDisplay = null; // physical-pixel bounds of the display being streamed
function physBounds(d) {
  const s = IS_MAC ? 1 : d.scaleFactor; // nut.js uses points on macOS, physical pixels on Windows
  return { x: Math.round(d.bounds.x * s), y: Math.round(d.bounds.y * s), w: Math.round(d.bounds.width * s), h: Math.round(d.bounds.height * s) };
}
ipcMain.handle('screens', async (_e, withThumbs) => {
  const size = withThumbs ? { width: 320, height: 180 } : { width: 0, height: 0 };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const displays = eScreen.getAllDisplays();
  return sources.map((s, i) => {
    const d = displays.find(x => String(x.id) === String(s.display_id));
    return {
      id: s.id, name: s.name || `Screen ${i + 1}`, displayId: s.display_id,
      res: d ? `${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}` : '',
      primary: d ? d.id === eScreen.getPrimaryDisplay().id : i === 0,
      thumb: withThumbs && !s.thumbnail.isEmpty() ? 'data:image/jpeg;base64,' + s.thumbnail.toJPEG(65).toString('base64') : null
    };
  });
});
ipcMain.on('active-display', (_e, displayId) => {
  const all = eScreen.getAllDisplays();
  const d = all.find(x => String(x.id) === String(displayId)) || eScreen.getPrimaryDisplay();
  activeDisplay = physBounds(d);
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setBounds(d.bounds);   // drawings follow the screen being shared
});

// ---------- Clipboard ----------
ipcMain.handle('clipboard-read', () => clipboard.readText());
// text + a hash of any image on the clipboard (the image itself is only fetched when it changed)
const imgHash = (img) => img.isEmpty() ? null : crypto.createHash('sha1').update(img.toBitmap()).digest('hex');
ipcMain.handle('clip-state', () => ({ text: clipboard.readText(), imgHash: imgHash(clipboard.readImage()) }));
ipcMain.handle('clip-image', () => { const img = clipboard.readImage(); return img.isEmpty() ? null : img.toPNG().toString('base64'); });
ipcMain.handle('clip-write-image', (_e, b64) => { const img = nativeImage.createFromBuffer(Buffer.from(String(b64), 'base64')); if (img.isEmpty()) return null; clipboard.writeImage(img); return imgHash(clipboard.readImage()); });
ipcMain.on('clipboard-write', (_e, t) => clipboard.writeText(String(t)));

// ---------- File transfer (received files land in Downloads/UniDesk) ----------
const incoming = new Map();
const recvDir = () => { const d = path.join(app.getPath('downloads'), 'UniDesk'); fs.mkdirSync(d, { recursive: true }); return d; };
ipcMain.on('file-start', (e, { id, name, dir }) => {
  const page = e.sender;
  const safe = path.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
  // an upload from the visitor's file manager goes into the folder they were browsing
  let base = recvDir(), into = false;
  if (dir) { try { const d = path.resolve(String(dir)); if (fs.statSync(d).isDirectory()) { base = d; into = true; } } catch {} }
  let target = path.join(base, safe), n = 1;
  while (fs.existsSync(target)) { const p = path.parse(safe); target = path.join(base, `${p.name} (${n++})${p.ext}`); }
  const stream = fs.createWriteStream(target);
  stream.on('error', () => { incoming.delete(id); try { fs.unlinkSync(target); } catch {} if (!page.isDestroyed()) page.send('file-failed', path.basename(target)); });
  incoming.set(id, { stream, target, into, page });
});
ipcMain.on('file-chunk', (_e, { id, b64 }) => incoming.get(id)?.stream.write(Buffer.from(b64, 'base64')));
ipcMain.on('file-end', (_e, { id }) => {
  const f = incoming.get(id); if (!f) return;
  f.stream.end(() => { incoming.delete(id); if (!f.page.isDestroyed()) f.page.send('file-saved', f.target, f.into); });
});
ipcMain.on('show-file', (_e, p) => shell.showItemInFolder(p));

// ---------- Input injection ----------
const KEYMAP = {
  Enter: Key.Enter, NumpadEnter: Key.Enter, Escape: Key.Escape, Backspace: Key.Backspace, Tab: Key.Tab, Space: Key.Space,
  ArrowLeft: Key.Left, ArrowRight: Key.Right, ArrowUp: Key.Up, ArrowDown: Key.Down,
  ShiftLeft: Key.LeftShift, ShiftRight: Key.RightShift, ControlLeft: Key.LeftControl, ControlRight: Key.RightControl,
  AltLeft: Key.LeftAlt, AltRight: Key.RightAlt, MetaLeft: Key.LeftSuper, MetaRight: Key.RightSuper,
  Delete: Key.Delete, Insert: Key.Insert, Home: Key.Home, End: Key.End, PageUp: Key.PageUp, PageDown: Key.PageDown,
  CapsLock: Key.CapsLock, NumLock: Key.NumLock, ScrollLock: Key.ScrollLock, Pause: Key.Pause,
  Minus: Key.Minus, Equal: Key.Equal, BracketLeft: Key.LeftBracket, BracketRight: Key.RightBracket,
  Backslash: Key.Backslash, Semicolon: Key.Semicolon, Quote: Key.Quote, Comma: Key.Comma, Period: Key.Period,
  Slash: Key.Slash, Backquote: Key.Grave, PrintScreen: Key.Print, ContextMenu: Key.Menu,
  NumpadAdd: Key.Add, NumpadSubtract: Key.Subtract, NumpadMultiply: Key.Multiply, NumpadDivide: Key.Divide, NumpadDecimal: Key.Decimal
};
for (let i = 0; i < 26; i++) { const c = String.fromCharCode(65 + i); KEYMAP['Key' + c] = Key[c]; }
for (let i = 0; i <= 9; i++) { KEYMAP['Digit' + i] = Key['Num' + i]; KEYMAP['Numpad' + i] = Key['NumPad' + i]; }
for (let i = 1; i <= 24; i++) if (Key['F' + i] !== undefined) KEYMAP['F' + i] = Key['F' + i];

const BTN = [Button.LEFT, Button.MIDDLE, Button.RIGHT];
const held = new Set();
let queue = Promise.resolve();
ipcMain.on('input', (_e, ev) => {
  if (ev && ev.t === 'cad') { serviceCmd('SAS').catch(() => {}); return; }
  if (secureInput(ev)) return; // lock screen / UAC / Ctrl+Alt+Del screen is showing
  queue = queue.then(() => handle(ev)).catch(err => console.error('input', err));
});
ipcMain.on('release-all', () => { queue = queue.then(async () => { for (const k of held) await keyboard.releaseKey(k).catch(() => {}); held.clear(); }); });

async function handle(ev) {
  const d = activeDisplay || physBounds(eScreen.getPrimaryDisplay());
  switch (ev.t) {
    case 'move': await mouse.setPosition(new Point(d.x + Math.round(ev.x * (d.w - 1)), d.y + Math.round(ev.y * (d.h - 1)))); break;
    case 'down': await mouse.pressButton(BTN[ev.b] ?? Button.LEFT); break;
    case 'up': await mouse.releaseButton(BTN[ev.b] ?? Button.LEFT); break;
    case 'wheel': {
      const n = Math.max(1, Math.round(Math.abs(ev.dy) / 25));
      if (ev.dy) ev.dy > 0 ? await mouse.scrollDown(n) : await mouse.scrollUp(n);
      if (ev.dx) ev.dx > 0 ? await mouse.scrollRight(Math.max(1, Math.round(Math.abs(ev.dx) / 25))) : await mouse.scrollLeft(Math.max(1, Math.round(Math.abs(ev.dx) / 25)));
      break;
    }
    case 'kd': { const k = KEYMAP[ev.c]; if (k !== undefined) { held.add(k); await keyboard.pressKey(k); } break; }
    case 'ku': { const k = KEYMAP[ev.c]; if (k !== undefined) { held.delete(k); await keyboard.releaseKey(k); } break; }
    case 'type': if (typeof ev.text === 'string' && ev.text) await keyboard.type(ev.text.slice(0, 5000)); break;
    case 'combo': { const ks = ev.keys.map(c => KEYMAP[c]).filter(k => k !== undefined); await keyboard.pressKey(...ks); await keyboard.releaseKey(...ks); break; }
  }
}
