const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, clipboard, screen: eScreen, shell, nativeTheme, Tray, Menu, safeStorage, nativeImage, systemPreferences } = require('electron');
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
  return null;
}
function isPortable() { return process.platform === 'win32' && !fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall UniDesk.exe')); }
let updateState = { busy: false };
ipcMain.handle('update-check', async () => {
  if (!app.isPackaged) return { dev: true, current: localBuild() };
  try {
    const remote = JSON.parse((await get(RELEASE_BASE + 'latest.json')).toString());
    const cur = localBuild(); const key = updateKey(); const file = remote.files?.[key];
    return { current: cur, remote: { build: remote.build, version: remote.version, notes: remote.notes }, available: !!file && +remote.build > +cur.build, key, canAuto: key === 'win-installer' || key?.startsWith('mac-') };
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
      lanPeers.set(m.id, { id: m.id, name: String(m.name || '').slice(0, 40), ip: rinfo.address, port: +m.port, seen: Date.now() });
    } catch {}
  });
  sock.on('error', () => {});
  sock.bind(BEACON_PORT, () => { try { sock.setBroadcast(true); } catch {} });
  const beacon = () => {
    const msg = Buffer.from(JSON.stringify({ app: 'unidesk', id: lan.id, name: os0.hostname(), port }));
    for (const a of lanAddrs()) {
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      const bcast = ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.');
      sock.send(msg, BEACON_PORT, bcast, () => {});
    }
    sock.send(msg, BEACON_PORT, '127.0.0.1', () => {}); // lets two copies on one PC see each other
    for (const [k, v] of lanPeers) if (Date.now() - v.seen > 10000) lanPeers.delete(k);
    win?.webContents.send('lan-peers', [...lanPeers.values()]);
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
ipcMain.handle('lan-info', () => ({ port: lan?.port || null, ips: lanAddrs().map(a => a.address) }));

// ---------- Windows: admin mode + UAC prompts on the normal desktop ----------
const UAC_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';
function run(cmd, args) { return new Promise(res => execFile(cmd, args, { windowsHide: true }, (err, stdout) => res({ code: err ? (err.code ?? 1) : 0, out: String(stdout || '') }))); }
ipcMain.handle('admin-status', async () => {
  if (process.platform !== 'win32') return { supported: false };
  const admin = (await run('net', ['session'])).code === 0;
  const q = await run('reg', ['query', UAC_KEY, '/v', 'PromptOnSecureDesktop']);
  const m = /PromptOnSecureDesktop\s+REG_DWORD\s+0x(\d+)/i.exec(q.out);
  return { supported: true, admin, uacOnNormalDesktop: m ? m[1] === '0' : false };
});
ipcMain.handle('admin-relaunch', () => {
  if (process.platform !== 'win32') return false;
  const args = app.isPackaged ? [] : [path.resolve(process.argv[1] || '.')];
  const argList = args.length ? ` -ArgumentList '${args[0].replace(/'/g, "''")}'` : '';
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Sleep -Milliseconds 800; Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}'${argList} -Verb RunAs`], { detached: true, stdio: 'ignore' }).unref();
  quitting = true; setTimeout(() => app.exit(0), 300); return true;
});
ipcMain.handle('uac-normal-desktop', async (_e, on) => {
  if (process.platform !== 'win32') return { ok: false };
  // Windows shows its own UAC consent for this change; nothing happens without the user's approval.
  const regArgs = `add ${UAC_KEY} /v PromptOnSecureDesktop /t REG_DWORD /d ${on ? 0 : 1} /f`;
  const r = await run('powershell.exe', ['-NoProfile', '-Command', `try { Start-Process reg -ArgumentList '${regArgs}' -Verb RunAs -Wait -WindowStyle Hidden; exit 0 } catch { exit 1 }`]);
  return { ok: r.code === 0 };
});

// ---------- Draw-on-screen overlay (host side) ----------
let overlayWin = null;
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
  overlayWin.once('ready-to-show', () => overlayWin.showInactive());
  return overlayWin;
}
ipcMain.on('draw', (_e, m) => { const o = ensureOverlay(); if (o.webContents.isLoading()) o.webContents.once('did-finish-load', () => o.webContents.send('draw', m)); else o.webContents.send('draw', m); });
ipcMain.on('draw-close', () => { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy(); overlayWin = null; });
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
app.whenReady().then(() => { createWindow(); createTray(); });
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
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!mainPrefs.startup, args: ['--hidden'] });
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
ipcMain.handle('auth-challenge', (_e, peerId) => {
  const a = readAuth(); if (!a) return { none: true };
  if (Date.now() < lockedUntil) return { locked: lockMins() };
  const nonce = crypto.randomBytes(32).toString('hex');
  challenges.set(peerId, { nonce, at: Date.now() });
  return { nonce, salt: a.salt, iter: a.iter };
});
ipcMain.handle('auth-verify', (_e, peerId, proof) => {
  const a = readAuth(), ch = challenges.get(peerId);
  challenges.delete(peerId); // one-time nonce
  if (!a || !ch || Date.now() - ch.at > 120e3) return { ok: false, expired: true };
  if (Date.now() < lockedUntil) return { ok: false, locked: lockMins() };
  const expect = crypto.createHmac('sha256', Buffer.from(a.key, 'hex')).update(ch.nonce).digest();
  let got; try { got = Buffer.from(String(proof), 'hex'); } catch { got = Buffer.alloc(0); }
  const ok = got.length === expect.length && crypto.timingSafeEqual(got, expect);
  if (ok) return { ok: true };
  const now = Date.now(); failures.push(now);
  while (failures.length && now - failures[0] > WINDOW_MS) failures.shift();
  if (failures.length >= MAX_FAILS) { lockedUntil = now + LOCK_MS; failures.length = 0; return { ok: false, locked: lockMins() }; }
  return { ok: false, left: MAX_FAILS - failures.length };
});
// Viewer side: derive proof locally (password never leaves this PC)
ipcMain.handle('auth-proof', (_e, pw, salt, nonce, iter) => {
  const key = crypto.pbkdf2Sync(String(pw), Buffer.from(salt, 'hex'), Math.min(Math.max(+iter || KDF_ITER, 100000), 2000000), 32, 'sha256');
  return crypto.createHmac('sha256', key).update(String(nonce)).digest('hex');
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
    cores: os.cpus().length
  };
});
ipcMain.on('lock-pc', () => {
  if (process.platform === 'win32') execFile('rundll32.exe', ['user32.dll,LockWorkStation']);
  else if (IS_MAC) execFile('/usr/bin/pmset', ['displaysleepnow']); // locks when 'require password' is on
});

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
ipcMain.handle('save-shot', (_e, name, buf) => { const p = path.join(mediaDir('image'), name); fs.writeFileSync(p, Buffer.from(buf)); return p; });

// ---------- Theme ----------
ipcMain.handle('system-dark', () => nativeTheme.shouldUseDarkColors);
nativeTheme.on('updated', () => win?.webContents.send('system-theme', nativeTheme.shouldUseDarkColors));
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
});

ipcMain.handle('confirm', async (_e, msg) => {
  win.show(); win.focus();
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Accept', 'Decline'], defaultId: 1, cancelId: 1, title: 'UniDesk', message: msg
  });
  return r.response === 0;
});

// ---------- Clipboard ----------
ipcMain.handle('clipboard-read', () => clipboard.readText());
ipcMain.on('clipboard-write', (_e, t) => clipboard.writeText(String(t)));

// ---------- File transfer (received files land in Downloads/UniDesk) ----------
const incoming = new Map();
const recvDir = () => { const d = path.join(app.getPath('downloads'), 'UniDesk'); fs.mkdirSync(d, { recursive: true }); return d; };
ipcMain.on('file-start', (_e, { id, name }) => {
  const safe = path.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
  let target = path.join(recvDir(), safe), n = 1;
  while (fs.existsSync(target)) { const p = path.parse(safe); target = path.join(recvDir(), `${p.name} (${n++})${p.ext}`); }
  incoming.set(id, { stream: fs.createWriteStream(target), target });
});
ipcMain.on('file-chunk', (_e, { id, b64 }) => incoming.get(id)?.stream.write(Buffer.from(b64, 'base64')));
ipcMain.on('file-end', (_e, { id }) => {
  const f = incoming.get(id); if (!f) return;
  f.stream.end(() => { incoming.delete(id); win.webContents.send('file-saved', f.target); });
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
ipcMain.on('input', (_e, ev) => { queue = queue.then(() => handle(ev)).catch(err => console.error('input', err)); });
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
