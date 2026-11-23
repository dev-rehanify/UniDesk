// UniDesk renderer
// ID network: PeerJS signaling -> direct P2P WebRTC (STUN hole punching), DTLS-SRTP encrypted.
// Video: screen capture, codec preference AV1 > VP9 > H264, screen-content tuning.
// Data channel: input, clipboard sync, chat, file transfer, monitor switching & quality control.
const $ = (id) => document.getElementById(id);
const IS_MAC = window.dw.platform === 'darwin';
document.documentElement.classList.add(IS_MAC ? 'mac' : 'win');
// Cmd on a Mac viewer should act as Ctrl on a Windows host, and vice versa
function mapKey(code) {
  const hostMac = /macOS/.test(remoteInfo?.os || '');
  if (IS_MAC && !hostMac) return { MetaLeft: 'ControlLeft', MetaRight: 'ControlRight', ControlLeft: 'MetaLeft', ControlRight: 'MetaRight' }[code] || code;
  if (!IS_MAC && hostMac) return { ControlLeft: 'MetaLeft', ControlRight: 'MetaRight', MetaLeft: 'ControlLeft', MetaRight: 'ControlRight' }[code] || code;
  return code;
}
const PREFIX = 'unidesk-';
const fmt = (id) => String(id).replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
const ICE = { iceServers: [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' }
], iceCandidatePoolSize: 4 };
const QUALITY = {
  speed:    { bitrate: 4_000_000,  fps: 60, hint: 'motion', pref: 'maintain-framerate',  scale: 1.5 },
  balanced: { bitrate: 10_000_000, fps: 60, hint: 'detail', pref: 'balanced',            scale: 1 },
  quality:  { bitrate: 25_000_000, fps: 60, hint: 'detail', pref: 'maintain-resolution', scale: 1 }
};

let peer, myId, role = null; // 'host' | 'viewer'
let conn = null, call = null, stream = null, control = true;
let screens = [], curScreen = 0, remoteScreens = [], connectTimer = null;

// ================= SETTINGS & THEME =================
const DEFAULTS = { theme: 'system', accent: 'violet', calm: false, quality: 'balanced', clip: true, stats: true, autoFull: false,
  audio: true, allowControl: true, allowFiles: true, allowClip: true, allowTerminal: false, unattended: false, otp: false, allowBrowse: false, tray: true, startup: false, lockOnEnd: 'never', idleMins: '0', maxMins: '0', lan: true, allowOnly: false, allowIds: '', hideWall: true, recIncoming: false, recKeep: '30' };
const ACCENTS = {
  violet: ['#5b8cff', '#a26bff'], ocean: ['#2f9bff', '#22d3c5'], sunset: ['#ff6a5b', '#ffb347'],
  emerald: ['#1fcf8f', '#3aa0ff'], rose: ['#ff4f8b', '#b36bff'], mono: ['#7b86a8', '#aab3d6']
};
let S = { ...DEFAULTS };
try { S = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ud-settings') || '{}') }; } catch {}
const saveSettings = () => { try { localStorage.setItem('ud-settings', JSON.stringify(S)); } catch {} };
let systemDark = true;

function applyTheme(animate) {
  const root = document.documentElement;
  const dark = S.theme === 'dark' || (S.theme === 'system' && systemDark);
  if (animate) { root.classList.add('theming'); clearTimeout(applyTheme._t); applyTheme._t = setTimeout(() => root.classList.remove('theming'), 500); }
  root.dataset.theme = dark ? 'dark' : 'light';
  $('themeIcon').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('themeBtn').title = dark ? 'Switch to light' : 'Switch to dark';
  window.dw.setTheme(dark);
  document.querySelectorAll('[data-theme-opt]').forEach(b => b.classList.toggle('on', b.dataset.themeOpt === S.theme));
}
function applyAll(animate) {
  applyTheme(animate);
  const [a1, a2] = ACCENTS[S.accent] || ACCENTS.violet;
  document.documentElement.style.setProperty('--a1', a1); document.documentElement.style.setProperty('--a2', a2);
  document.documentElement.classList.toggle('calm', !!S.calm);
  document.documentElement.classList.toggle('no-stats', !S.stats);
  document.querySelectorAll('[data-set]').forEach(i => { i.checked = !!S[i.dataset.set]; });
  document.querySelectorAll('[data-seg]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === S[seg.dataset.seg])));
  document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', s.dataset.accent === S.accent));
  $('allowWrap').style.display = S.allowOnly ? '' : 'none';
  $('recKeepRow').style.display = S.recIncoming ? '' : 'none';
  if (document.activeElement !== $('allowIds')) $('allowIds').value = S.allowIds || '';
}
// allow-list: 9-digit addresses, one per line
const allowedIds = () => new Set(String(S.allowIds || '').split(/[\n,;]+/).map(s => s.replace(/\D/g, '')).filter(s => s.length === 9));
const isAllowed = (peerId) => !S.allowOnly || allowedIds().has(String(peerId).replace(PREFIX, ''));
function setSetting(k, v) {
  S[k] = v; saveSettings(); applyAll(k === 'theme');
  if (role === 'host' && ['allowControl', 'allowFiles', 'allowClip', 'allowTerminal', 'allowBrowse'].includes(k)) { P = { ...P, [{ allowControl: 'control', allowFiles: 'files', allowClip: 'clip', allowTerminal: 'terminal', allowBrowse: 'browse' }[k]]: !!v }; sendPerms(); if (k === 'allowTerminal' && !v) window.dw.termStop(); }
}

// swatches
Object.entries(ACCENTS).forEach(([name, [a, b]]) => {
  const s = document.createElement('button'); s.className = 'swatch'; s.dataset.accent = name; s.title = name[0].toUpperCase() + name.slice(1);
  s.style.background = `linear-gradient(135deg, ${a}, ${b})`; s.onclick = () => setSetting('accent', name);
  $('swatches').appendChild(s);
});
document.querySelectorAll('[data-theme-opt]').forEach(b => b.onclick = () => setSetting('theme', b.dataset.themeOpt));
document.querySelectorAll('[data-set]').forEach(i => i.onchange = () => setSetting(i.dataset.set, i.checked));
document.querySelectorAll('[data-seg]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.onclick = () => setSetting(seg.dataset.seg, b.dataset.v)));
$('allowIds').addEventListener('input', () => { S.allowIds = $('allowIds').value; saveSettings(); });
$('allowIds').addEventListener('keydown', (e) => e.stopPropagation());
$('allowIds').addEventListener('blur', () => {
  const ids = [...allowedIds()]; S.allowIds = ids.map(fmt).join('\n'); saveSettings(); $('allowIds').value = S.allowIds;
});
$('themeBtn').onclick = () => setSetting('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
window.dw.onSystemTheme((d) => { systemDark = d; if (S.theme === 'system') applyTheme(true); });
window.dw.systemDark().then(d => { systemDark = d; applyTheme(false); });

// panel open/close + animated tab ink
function moveInk() {
  const on = $('stTabs').querySelector('.st-tab.on'); if (!on) return;
  $('stInk').style.left = on.offsetLeft + 'px'; $('stInk').style.width = on.offsetWidth + 'px';
}
function openSettings(page) {
  $('settings').classList.add('open'); $('settingsScrim').classList.add('show');
  if (page) showSettingsPage(page);
  $('stId').textContent = myId ? fmt(myId) : '—';
  requestAnimationFrame(moveInk);
}
function closeSettings() { $('settings').classList.remove('open'); $('settingsScrim').classList.remove('show'); if (role === 'viewer') $('stage').focus(); }
function showSettingsPage(p) {
  document.querySelectorAll('.st-tab').forEach(t => t.classList.toggle('on', t.dataset.page === p));
  document.querySelectorAll('.st-page').forEach(s => s.classList.toggle('on', s.dataset.page === p));
  moveInk();
}
document.querySelectorAll('.st-tab').forEach(t => t.onclick = () => showSettingsPage(t.dataset.page));
$('settingsBtn').onclick = () => $('settings').classList.contains('open') ? closeSettings() : openSettings();
$('settingsClose').onclick = closeSettings; $('settingsScrim').onclick = closeSettings;
window.addEventListener('resize', moveInk);
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === ',') { e.preventDefault(); e.stopPropagation(); openSettings(); }
  else if (e.key === 'Escape' && $('settings').classList.contains('open')) { e.stopPropagation(); closeSettings(); }
}, true);
$('resetSettings').onclick = () => { S = { ...DEFAULTS }; saveSettings(); applyAll(true); toast('Settings reset to defaults', 1800); };
$('clearRecents').onclick = () => { try { localStorage.removeItem('dw-recent'); } catch {} loadRecents(); toast('Recent connections cleared', 1800); };
$('newIdBtn').onclick = () => {
  if (role) return toast('End the current session first', 2000);
  if (!confirm('Get a new address? People who saved your old one will no longer be able to reach you.')) return;
  try { localStorage.removeItem('dw-id'); } catch {} peer?.destroy(); location.reload();
};
applyAll(false);

// per-session permissions (chosen on the request card; unattended sessions use the defaults from Settings)
let P = { control: true, files: true, clip: true, terminal: false, browse: false };
const defaultPerms = () => ({ control: !!S.allowControl, files: !!S.allowFiles, clip: !!S.allowClip, terminal: !!S.allowTerminal, browse: !!S.allowBrowse });
function sendPerms() {
  // taking control away also lifts the privacy screen
  if (!P.control && hostPrivacy) { hostPrivacy = false; window.dw.privacy(false); send({ t: 'privacy-r', on: false }); }
  if (!P.control && hostBlock) unblockHost();
  repPerms();
  send({ t: 'perms', ...P });
}
let remotePerms = { control: true, files: true, clip: true };

// ================= UI helpers =================
function toast(msg, ms = 3200) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}
const setStatus = (text, on) => { $('statusText').textContent = text; $('dot').classList.toggle('on', !!on); };
function showView(name) {
  $('home').classList.toggle('active', name === 'home');
  $('session').classList.toggle('active', name === 'session');
}
function renderId(id) {
  const el = $('myId'); el.innerHTML = '';
  [...fmt(id)].forEach((ch, i) => {
    const s = document.createElement('span'); s.className = 'dg'; s.textContent = ch === ' ' ? ' ' : ch;
    s.style.animationDelay = i * 45 + 'ms'; el.appendChild(s);
  });
}
function overlay(state, title, sub) {
  const o = $('connecting'); o.classList.remove('ok', 'fail', 'auth');
  if (state !== 'auth') $('authBox').classList.remove('show');
  if (!state) { o.classList.remove('show'); return; }
  o.classList.add('show'); if (state !== 'wait') o.classList.add(state);
  if (title) $('connTitle').innerHTML = title;
  $('connSub').textContent = sub || '';
}
function hint(msg) { const h = $('connHint'); h.textContent = msg; h.classList.remove('shake'); void h.offsetWidth; h.classList.add('shake'); }

// cursor-follow glow on cards
document.querySelectorAll('.card').forEach(c => c.addEventListener('pointermove', (e) => {
  const r = c.getBoundingClientRect(); c.style.setProperty('--mx', e.clientX - r.left + 'px'); c.style.setProperty('--my', e.clientY - r.top + 'px');
}));

function loadPeer() {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'node_modules/peerjs/dist/peerjs.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
function storedId() {
  let id = null; try { id = localStorage.getItem('dw-id'); } catch {}
  if (!id) { id = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000000 + 100000000); try { localStorage.setItem('dw-id', id); } catch {} }
  return id;
}

async function boot() {
  await loadPeer();
  myId = storedId();
  peer = new Peer(PREFIX + myId, await peerOptions());
  peer.on('open', () => { renderId(myId); setStatus('Online · ready', true); });
  peer.on('disconnected', () => { setStatus('Reconnecting…'); setTimeout(() => !peer.destroyed && peer.reconnect(), 1500); });
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id') { try { localStorage.removeItem('dw-id'); } catch {} location.reload(); return; }
    if (e.type === 'peer-unavailable') { failConnect('Desk not found', 'That ID is offline or does not exist.'); return; }
    console.error(e); setStatus('Network: ' + e.type);
  });
  peer.on('connection', onIncomingConn);
  peer.on('call', onIncomingCall);
  loadRecents();
}

// ================= HOST =================
let pendingHost = null;
async function onIncomingConn(c) {
  if (!isAllowed(c.peer)) { // not on the allow-list: turn away without asking
    c.on('open', () => { c.send({ t: 'blocked' }); setTimeout(() => c.close(), 300); });
    logHistory({ dir: 'in', id: fmt(c.peer.replace(PREFIX, '')), how: 'blocked' }); return;
  }
  if (role || pendingHost || hostRebooting) { c.on('open', () => { c.send({ t: 'busy' }); setTimeout(() => c.close(), 300); }); return; }
  pendingHost = c;
  c.on('close', () => { if (pendingHost === c) pendingHost = null; });
  c.on('open', async () => {
    const who = fmt(c.peer.replace(PREFIX, ''));
    let asked = false, settled = false;
    let vname = '';
    const finish = (ok, how, perms) => {
      if (settled) return; settled = true; c.off('data', pre); pendingHost = null; closeRequest();
      if (ok) acceptHost(c, who, how, perms);
      else { c.send({ t: 'denied' }); setTimeout(() => c.close(), 300); logHistory({ dir: 'in', id: who, how: 'declined' }); }
    };
    const ask = async () => {
      if (asked || settled) return; asked = true;
      chime();
      c.send({ t: 'wait' });
      const perms = await requestDialog(who, () => vname);
      if (c.open) finish(!!perms, 'approved', perms); else { pendingHost = null; closeRequest(); }
    };
    const pre = async (m) => {
      if (settled) return;
      if (m.t === 'ask') return ask();
      if (m.t === 'vinfo') { vname = String(m.name || '').slice(0, 40); refreshRequestName(vname); return; }
      if (m.t === 'auth-reply') {
        const r = await window.dw.authVerify(c.peer, m.proof, m.codeProof);
        if (r.ok) { if (r.via === 'code') rotateCode(); return finish(true, r.via === 'code' ? 'code' : 'unattended'); }
        if (r.locked) { c.send({ t: 'auth-locked', mins: r.locked }); return; }
        const ch = await window.dw.authChallenge(c.peer, usePw); // fresh nonce for the retry
        c.send({ t: 'auth-fail', left: r.left, ...ch });
      }
    };
    c.on('data', pre);
    const usePw = !!(S.unattended && await window.dw.authHas());
    if (!usePw && !(S.otp && otpCode)) return ask();
    const ch = await window.dw.authChallenge(c.peer, usePw);
    if (ch.none) return ask();
    if (ch.locked) c.send({ t: 'auth-locked', mins: ch.locked });
    else c.send({ t: 'auth', ...ch });
  });
}

async function acceptHost(c, who, how, perms) {
    role = 'host'; conn = c; hostHow = how; P = perms || defaultPerms();
    if (IS_MAC) {
      const p = await window.dw.macPerms(true);
      if (!p.screen) { toast('Allow Screen Recording for UniDesk in System Settings, then reconnect', 6000); window.dw.openMacPref('screen'); }
      else if (!p.control) toast('Allow Accessibility for UniDesk so the visitor can control this Mac', 6000);
    }
    if (how === 'unattended' || how === 'code') {
      try { new Notification('UniDesk', { body: `${who} connected with unattended access`, silent: false }); } catch {}
    }
    logHistory({ dir: 'in', id: who, how }); repStart(who, how);
    if (S.hideWall && !IS_MAC) { await window.dw.wallpaperHide().catch(() => {}); await new Promise(r => setTimeout(r, 250)); }   // Windows, and GNOME/Cinnamon/MATE on Linux
    try {
      screens = await window.dw.screens(false);
      curScreen = Math.max(0, screens.findIndex(s => s.primary));
      stream = await capture(screens[curScreen], S.audio);
      call = (c.provider || peer).call(c.peer, stream, { sdpTransform: preferCodecSdp }); // same server the visitor came in on (internet or LAN)
      tune(call.peerConnection, 'balanced');
      wireData(c); startClipSync(); sendScreens(); sendPerms(); startIdleWatch();
      if (S.recIncoming) hostRecStart(who);
      startSessionTimer();
      if (!IS_MAC) window.dw.secureStart().catch(() => {}); // stream lock screen / UAC if the service is installed
      window.dw.sysinfo().then(info => send({ t: 'info', ...info }));
      $('hostWho').textContent = who; $('hosting').classList.add('show');
      c.on('close', endAll); call.on('close', endAll);
    } catch (e) { console.error(e); toast('Screen capture failed: ' + e.message); endAll(); }
}

async function sendScreens() {
  const list = await window.dw.screens(true);
  send({ t: 'screens', cur: curScreen, list: list.map(s => ({ name: s.name, res: s.res, primary: s.primary, thumb: s.thumb })) });
}

async function capture(src, withAudio = true) {
  window.dw.setActiveDisplay(src.displayId);
  const video = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 60 } };
  let s;
  try { s = await navigator.mediaDevices.getUserMedia({ audio: withAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false, video }); }
  catch { s = await navigator.mediaDevices.getUserMedia({ audio: false, video }); }
  s.getVideoTracks()[0].contentHint = 'detail';
  return s;
}

// Reorder the video payload types in the SDP so both sides pick AV1 > VP9 > H264 > VP8.
function preferCodecSdp(sdp) {
  const lines = sdp.split('\r\n');
  const mi = lines.findIndex(l => l.startsWith('m=video')); if (mi < 0) return sdp;
  let end = lines.findIndex((l, i) => i > mi && l.startsWith('m=')); if (end < 0) end = lines.length;
  const section = lines.slice(mi, end);
  const rtpmap = {}; section.forEach(l => { const m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//); if (m) rtpmap[m[1]] = m[2].toUpperCase(); });
  const apt = {}; section.forEach(l => { const m = l.match(/^a=fmtp:(\d+) apt=(\d+)/); if (m) apt[m[1]] = m[2]; });
  const rank = { AV1: 0, VP9: 1, H264: 2, VP8: 3 };
  const parts = lines[mi].split(' '), head = parts.slice(0, 3), pts = parts.slice(3);
  const score = (pt) => { const name = rtpmap[pt] === 'RTX' ? rtpmap[apt[pt]] : rtpmap[pt]; const r = rank[name]; return (r ?? 9) * 2 + (rtpmap[pt] === 'RTX' ? 1 : 0); };
  const sorted = pts.map((pt, i) => [pt, i]).sort((a, b) => score(a[0]) - score(b[0]) || a[1] - b[1]).map(x => x[0]);
  lines[mi] = [...head, ...sorted].join(' ');
  return lines.join('\r\n');
}
function preferCodecs(pc) {
  try {
    const order = ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];
    const rank = (c) => { const i = order.indexOf(c.mimeType); return i < 0 ? 99 : i; };
    const sorted = [...RTCRtpSender.getCapabilities('video').codecs].sort((a, b) => rank(a) - rank(b));
    pc.getTransceivers().forEach(t => { if (t.sender.track?.kind === 'video') t.setCodecPreferences(sorted); });
  } catch (e) { console.warn('codec prefs', e); }
}

function tune(pc, mode) {
  const q = QUALITY[mode] || QUALITY.balanced;
  const apply = () => pc.getSenders().forEach(s => {
    if (s.track?.kind !== 'video') return;
    s.track.contentHint = q.hint;
    const p = s.getParameters(); if (!p.encodings?.length) p.encodings = [{}];
    Object.assign(p.encodings[0], { maxBitrate: q.bitrate, maxFramerate: q.fps, scaleResolutionDownBy: q.scale, priority: 'high', networkPriority: 'high' });
    p.degradationPreference = q.pref;
    s.setParameters(p).catch(() => {});
  });
  if (pc.connectionState === 'connected') apply();
  else pc.addEventListener('connectionstatechange', function f() { if (pc.connectionState === 'connected') { apply(); pc.removeEventListener('connectionstatechange', f); } });
}

async function switchMonitor(i) {
  if (!screens[i] || !call) return;
  const ns = await capture(screens[i], false);
  const track = ns.getVideoTracks()[0];
  const sender = call.peerConnection.getSenders().find(s => s.track?.kind === 'video');
  await sender.replaceTrack(track);
  const wasRec = hostRec ? hostRec.who : null; if (wasRec) await hostRecStop();
  stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t); });
  stream.addTrack(track);
  if (wasRec) hostRecStart(wasRec, true);
  curScreen = i;
  send({ t: 'screen', i });
}

// ================= VIEWER =================
function connect(idArg, isRetry) {
  if (!isRetry) { reconnectTries = 0; inSession = false; }
  const id = String(idArg || $('remoteId').value).replace(/\D/g, '');
  if (id.length !== 9) return hint('Addresses are 9 digits.');
  if (id === myId) return hint("That's your own address.");
  if (role) return;
  $('connHint').textContent = '';
  role = 'viewer'; viewerTarget = id; authTriedSaved = false; pendingPw = null; authCh = null;
  $('authPw').value = ''; $('authPw').type = 'password'; $('authEye').classList.remove('on'); $('authRemember').checked = false;
  $('authGo').disabled = false; $('authGo').querySelector('span').textContent = 'Unlock'; $('authErr').textContent = '';
  const nearby = nearbyDesk(id);
  if (!isRetry) overlay('wait', `Calling <span>${fmt(id)}</span>`, nearby ? 'Connecting over your local network…' : 'Connecting…');
  $('sessWho').textContent = fmt(id);
  startConn(id, nearby);
}
async function startConn(id, nearby) {
  const via = nearby ? await lanClientFor(nearby).catch(() => null) : null;
  if (role !== 'viewer' || viewerTarget !== id) return; // cancelled meanwhile
  viaLan = !!via;
  conn = (via || peer).connect(PREFIX + id, { reliable: true, serialization: 'json' });
  conn.on('open', () => { wireData(conn); saveRecent(id); window.dw.sysinfo().then(i => send({ t: 'vinfo', name: i.host })).catch(() => {}); });
  const myConn = conn;
  conn.on('close', () => conn === myConn && onViewerDrop());
  conn.on('error', () => conn === myConn && onViewerDrop());
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => { if (!call) failConnect('No answer', 'Your partner did not respond in time.'); }, 60000);
}
// ---- unattended access (viewer) ----
let viewerTarget = null, authCh = null, authTriedSaved = false, pendingPw = null;
async function onAuth(m) {
  authCh = m;
  if (!authTriedSaved) {
    authTriedSaved = true;
    const pw = await window.dw.pwGet(viewerTarget);
    if (pw) { overlay('wait', `Unlocking <span>${fmt(viewerTarget)}</span>`, 'Using your saved password…'); return submitAuth(pw, false, true); }
  }
  showAuth('');
}
function showAuth(err, locked) {
  overlay('auth', `<span>${fmt(viewerTarget)}</span> is protected`, 'Enter the access password or one-time code, or ask the person there to let you in.');
  $('authBox').classList.add('show'); $('authErr').textContent = err || '';
  $('authGo').disabled = !!locked; $('authPw').disabled = !!locked;
  if (err) { $('authBox').classList.remove('shake'); void $('authBox').offsetWidth; $('authBox').classList.add('shake'); }
  if (!locked) setTimeout(() => { $('authPw').focus(); $('authPw').select(); }, 120);
}
async function submitAuth(pw, remember, fromSaved) {
  if (!pw || !authCh?.nonce) return;
  $('authGo').disabled = true; $('authGo').querySelector('span').textContent = 'Checking…';
  const { proof, codeProof } = await window.dw.authProof(pw, authCh.salt, authCh.nonce, authCh.iter);
  pendingPw = { pw, remember, fromSaved };
  send({ t: 'auth-reply', proof, codeProof });
}
$('authGo').onclick = () => submitAuth($('authPw').value, $('authRemember').checked, false);
$('authPw').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('authGo').click(); });
$('authAsk').onclick = () => { send({ t: 'ask' }); $('authBox').classList.remove('show'); overlay('wait', `Calling <span>${fmt(viewerTarget)}</span>`, 'Waiting for your partner to accept…'); };
$('authEye').onclick = () => { const p = $('authPw'); p.type = p.type === 'password' ? 'text' : 'password'; $('authEye').classList.toggle('on', p.type === 'text'); };

function failConnect(title, sub) {
  clearTimeout(connectTimer);
  if (role === 'viewer' && !call) { try { conn?.close(); } catch {} conn = null; role = null; }
  if (restartWait) { restartTick(); return; } // still waiting for a restarting PC: just try again later
  overlay('fail', title, sub);
  setTimeout(() => overlay(null), 2000);
}

function onIncomingCall(c) {
  if (c.metadata?.kind === 'voice') return onVoiceCall(c); // voice chat runs as its own call, both directions
  if (role !== 'viewer' || !conn || c.peer !== conn.peer) { c.close(); return; }
  call = c; clearTimeout(connectTimer);
  c.answer(undefined, { sdpTransform: preferCodecSdp });
  c.on('stream', (s) => {
    const v = $('video'); v.srcObject = s; v.muted = false;
    if (restartWait) restartBack = Date.now(); // 'stream' fires once per track, so remember it briefly
    const afterRestart = Date.now() - restartBack < 5000;
    overlay('ok', reconnectTries || afterRestart ? 'Reconnected' : 'Connected', afterRestart ? 'The PC is back after its restart' : 'Starting session…');
    stopRestartWait();
    inSession = true; reconnectTries = 0; if (!sessStart) startSessionTimer();
    if (pendingPw?.remember) window.dw.pwRemember(viewerTarget, pendingPw.pw).then(ok => ok && toast('Password saved for this desk', 1800));
    logHistory({ dir: 'out', id: fmt(viewerTarget), how: pendingPw ? 'unattended' : 'approved' }); pendingPw = null;
    $('quality').value = S.quality; send({ t: 'quality', q: S.quality }); $('clipSync').checked = !!S.clip;
    setTimeout(() => {
      overlay(null); showView('session'); v.classList.add('playing'); $('stage').focus(); revealToolbar();
      if (S.autoFull && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    }, 650);
    startStats(); startClipSync();
    try { c.peerConnection.getReceivers().forEach(r => { if ('playoutDelayHint' in r) r.playoutDelayHint = 0; if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0; }); } catch {}
  });
  c.on('close', () => call === c && onViewerDrop());
}

// ================= DATA CHANNEL =================
let lastClip = null;
function wireData(c) {
  const parts = new Map();
  c.on('data', (raw) => {
    lastRx = Date.now();
    // reassemble messages that send() split into pieces (the data channel drops messages of 16 KB or more)
    let m = raw;
    if (raw && raw.t === '_c') {
      let e = parts.get(raw.id); if (!e) { e = { s: new Array(raw.n), got: 0 }; parts.set(raw.id, e); }
      if (e.s[raw.i] === undefined) { e.s[raw.i] = raw.s; e.got++; }
      if (e.got < raw.n) return;
      parts.delete(raw.id);
      try { m = JSON.parse(e.s.join('')); } catch { return; }
    }
    if (role === 'host' && m.t !== 'thumbs') lastActivity = Date.now();
    switch (m.t) {
      case 'bye': byeReceived = true; break;
      case 'fs': if (role === 'host') onFsRequest(m); break;
      case 'fs-r': if (role === 'viewer') onFsReply(m); break;
      case 'paused': if (role === 'viewer') setPausedView(!!m.on); break;
      case 'ci': if (role === 'host' ? P.clip : $('clipSync').checked) onClipImageChunk(m); break;
      case 'voice-off': onVoiceOff(); break;
      case 'req-control': if (role === 'host' && !P.control) askControl(); break;
      case 'sf': if (role === 'viewer') onSecureChunk(m); break;
      case 'sf-end': if (role === 'viewer') secureOff(); break;
      case 'draw': if (role === 'host') window.dw.draw(m); break;
      case 'info':
        if (role !== 'viewer') break;
        remoteInfo = m;
        $('deskInfo').textContent = `${m.host} · ${m.os} · ${m.ram} RAM · ${m.cores} cores`;
        $('sessWho').textContent = `${m.host} · ${fmt(viewerTarget)}`;
        nameDeskIfUnnamed(viewerTarget, m.host); break;
      case 'denied': failConnect('Declined', 'Your partner declined the request.'); break;
      case 'blocked': if (role === 'viewer' && !call) { stopRestartWait(); failConnect('Not allowed', 'That desk only accepts connections from approved addresses.'); } break;
      case 'ps': if (role === 'host') onPsRequest(m); break;
      case 'ps-r': if (role === 'viewer') onFsReply(m); break;
      case 'reboot': if (role === 'host') onRebootRequest(); break;
      case 'reboot-r': if (role === 'viewer') onRebootReply(m); break;
      case 'busy': failConnect('Busy', 'That desk is already in a session.'); break;
      case 'wait': if (role === 'viewer' && !call) { $('authBox').classList.remove('show'); overlay('wait', `Calling <span>${fmt(viewerTarget)}</span>`, 'Waiting for your partner to accept…'); } break;
      case 'auth': if (role === 'viewer') onAuth(m); break;
      case 'auth-fail':
        if (role !== 'viewer') break;
        authCh = m; $('authGo').querySelector('span').textContent = 'Unlock';
        if (pendingPw?.fromSaved) { window.dw.pwForget(viewerTarget); showAuth('Your saved password no longer works.'); }
        else showAuth(`Wrong password or code · ${m.left} ${m.left === 1 ? 'try' : 'tries'} left`);
        pendingPw = null; break;
      case 'auth-locked':
        if (role !== 'viewer') break;
        $('authGo').querySelector('span').textContent = 'Unlock'; pendingPw = null;
        showAuth(`Too many wrong attempts. Unattended access is locked for ${m.mins} min. You can still ask for permission.`, true); break;
      case 'screens': remoteScreens = m.list; curScreen = m.cur; renderScreens(); break;
      case 'screen': curScreen = m.i; renderScreens(); setTimeout(() => $('video').classList.remove('switching'), 250); toast(`Now viewing Screen ${m.i + 1}`, 1600); break;
      case 'thumbs': if (role === 'host') sendScreens(); break;
      case 'clip': if (role === 'host' && !P.clip) break; repN('clipIn'); lastClip = m.text; window.dw.clipWrite(m.text); if (role === 'viewer') addClipHist(m.text); break;
      case 'chat': addChat(m.text, false); repN('chatIn'); break;
      case 'perms': {
        const was = remotePerms; remotePerms = m;
        if (!m.control && was.control !== false) toast('Partner allows view only', 2600);
        if (m.control && was.control === false) toast('Partner enabled remote control', 2200);
        $('ctrlBtn').disabled = false; $('ctrlBtn').style.opacity = '';
        $('ctrlBtn').innerHTML = m.control ? '<svg class="ic"><use href="#i-mouse"/></svg><span>Control</span>' : '<svg class="ic"><use href="#i-mouse"/></svg><span>Request control</span>';
        $('ctrlBtn').classList.toggle('on', !m.control);
        $('fileBtn').disabled = !m.files; $('fileBtn').style.opacity = m.files ? '' : '.4';
        $('termBtn').style.display = m.terminal ? '' : 'none';
        $('browseBtn').style.display = m.browse ? '' : 'none'; if (!m.browse) toggleBrowse(false);
        $('tmBtn').style.display = m.control ? '' : 'none'; if (!m.control) toggleTm(false);
        $('privBtn').style.display = m.control ? '' : 'none'; if (!m.control) setPrivBtn(false);
        $('blockBtn').style.display = m.control ? '' : 'none'; if (!m.control) setBlockBtn(false);
        $('piBtn').style.display = m.control ? '' : 'none'; if (!m.control) togglePi(false);
        fbButtons();
        if (!m.terminal) toggleTerm(false);
        if (m.terminal && !was.terminal) toast('Partner allowed the remote terminal', 2200);
        break;
      }
      case 'monitor': if (role === 'host') switchMonitor(m.i); break;
      case 'quality': if (role === 'host') tune(call.peerConnection, m.q); break;
      case 'hb': break;
      case 'pi': if (role === 'host') onPiRequest(m); break;
      case 'pi-r': if (role === 'viewer') onFsReply(m); break;
      case 'rec-on': if (role === 'viewer') { $('recBadge').classList.add('show'); if (!m.again) toast('Your partner is recording this session', 3200); } break;
      case 'power': if (role === 'host') onPowerRequest(m); break;
      case 'power-r': if (role === 'viewer') onPowerReply(m); break;
      case 'block': if (role === 'host') onBlockRequest(m); break;
      case 'block-r': if (role === 'viewer') onBlockReply(m); break;
      case 'privacy': if (role === 'host') onPrivacyRequest(m); break;
      case 'privacy-r': if (role === 'viewer') onPrivacyReply(m); break;
      case 'file-start': if (role === 'host' && !P.files) break; if (role !== 'host' || !P.browse) delete m.dir; window.dw.fileStart(m); toast(`Receiving ${m.name}…`); repN('filesIn'); repN('bytesIn', +m.size || 0); repEv(`Sent you the file ${String(m.name).slice(0, 120)} (${fmtSize(+m.size || 0)})${m.dir ? ' into ' + String(m.dir).slice(0, 120) : ''}`); break;
      case 'file-chunk': if (role === 'host' && !P.files) break; window.dw.fileChunk(m); break;
      case 'file-end': if (role === 'host' && !P.files) break; window.dw.fileEnd(m); break;
      case 'term-in': if (role === 'host' && P.terminal) { window.dw.termInput(String(m.d || '')); String(m.d || '').split('\n').map(s => s.trim()).filter(Boolean).forEach(s => repEv('Ran in the terminal: ' + s)); } break;
      case 'term-out': if (role === 'viewer') termWrite(m.d); break;
      default: if (role === 'host' && P.control && !hostPaused) window.dw.input(m);
    }
  });
}
// The PeerJS data channel silently drops messages of 16 KB or more, so large messages are split
// into <12 KB pieces here and put back together in wireData().
const MAX_MSG = 12000; let msgSeq = 0;
function send(m) {
  if (!conn?.open) return false;
  const s = JSON.stringify(m);
  if (s.length <= MAX_MSG) { conn.send(m); return true; }
  const id = ++msgSeq, n = Math.ceil(s.length / MAX_MSG);
  for (let i = 0; i < n; i++) conn.send({ t: '_c', id, i, n, s: s.slice(i * MAX_MSG, (i + 1) * MAX_MSG) });
  return true;
}
const sendInput = (m) => role === 'viewer' && control && send(m);

// ---- screens switcher ----
function renderScreens() {
  const grid = $('screensGrid'); grid.innerHTML = '';
  $('screenLabel').textContent = remoteScreens.length > 1 ? `Screen ${curScreen + 1} / ${remoteScreens.length}` : 'Screen';
  remoteScreens.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'scr' + (i === curScreen ? ' active' : ''); b.style.animationDelay = i * 50 + 'ms';
    b.innerHTML = `<div class="th"${s.thumb ? ` style="background-image:url('${s.thumb}')"` : ''}>${s.thumb ? '' : '<svg class="ic xl"><use href="#i-screen"/></svg>'}</div>
      ${s.primary ? '<span class="tag">Primary</span>' : ''}
      <div class="meta"><span class="num">${i + 1}</span>Screen ${i + 1}<span class="res">${s.res || ''}</span></div>`;
    b.onclick = () => selectScreen(i);
    grid.appendChild(b);
  });
}
function selectScreen(i) {
  if (i === curScreen || i < 0 || i >= remoteScreens.length) { closePanel(); return; }
  $('video').classList.add('switching');
  send({ t: 'monitor', i }); closePanel();
}
function openPanel() { send({ t: 'thumbs' }); $('screensPanel').classList.add('open'); $('screensBtn').classList.add('on'); }
function closePanel() { $('screensPanel').classList.remove('open'); $('screensBtn').classList.remove('on'); $('stage').focus(); }
$('screensBtn').onclick = (e) => { e.stopPropagation(); $('screensPanel').classList.contains('open') ? closePanel() : openPanel(); };
$('stage').addEventListener('pointerdown', () => $('screensPanel').classList.contains('open') && closePanel());

// ---- clipboard ----
let clipTimer;
function startClipSync() {
  clearInterval(clipTimer);
  window.dw.clipState().then(st => { lastClip = st.text; lastImgHash = st.imgHash; });
  clipTimer = setInterval(async () => {
    if (role === 'host' ? !P.clip : (!$('clipSync').checked || remotePerms.clip === false)) return;
    const st = await window.dw.clipState(); const t = st.text;
    // Text and images replace each other on the clipboard, so a new one of either kind clears the memory
    // of the other: copying image A, then text, then image A again must send A again (and the same for text).
    if (t && t !== lastClip && t.length < 1_000_000) { lastClip = t; lastImgHash = null; send({ t: 'clip', text: t }); repN('clipOut'); }
    else if (!t && st.imgHash && st.imgHash !== lastImgHash && !ciSending) {
      ciSending = true; try { if (await sendClipImage()) { lastImgHash = st.imgHash; lastClip = ''; } } finally { ciSending = false; }
    }
  }, 700);
}

// ---- files ----
window.dw.onFileSaved((p, into) => {
  if (into) { toast(`Your partner uploaded ${p.split(/[\\/]/).pop()} to ${p.split(/[\\/]/).slice(-2, -1)[0] || 'a folder'}`, 3200); return; }
  toast('Saved: ' + p.split(/[\\/]/).pop(), 4500); window.dw.showFile(p);
});
window.dw.onFileFailed((n) => toast(`Couldn’t save ${n}`, 3000));
async function sendFiles(list, dir) {
  const bar = $('progressBar'); $('progress').classList.add('show');
  for (const f of list) {
    const id = crypto.randomUUID(), CH = 48 * 1024;
    send({ t: 'file-start', id, name: f.name, size: f.size, ...(dir ? { dir } : {}) });
    const buf = new Uint8Array(await f.arrayBuffer());
    for (let o = 0; o < buf.length; o += CH) {
      let bin = ''; const part = buf.subarray(o, o + CH);
      for (let i = 0; i < part.length; i += 8192) bin += String.fromCharCode.apply(null, part.subarray(i, i + 8192));
      send({ t: 'file-chunk', id, b64: btoa(bin) });
      const dc = conn?.dataChannel; while (dc && dc.bufferedAmount > 4 * 1024 * 1024) await new Promise(r => setTimeout(r, 20));
      bar.style.width = ((o + part.length) / buf.length * 100) + '%';
    }
    send({ t: 'file-end', id }); toast(`Sent ${f.name}`); repN('filesOut'); repN('bytesOut', f.size); repEv(`You sent the file ${String(f.name).slice(0, 120)} (${fmtSize(f.size)})`);
  }
  setTimeout(() => { $('progress').classList.remove('show'); bar.style.width = 0; }, 600);
}

// ---- chat ----
function addChat(text, mine) {
  $('chatLog').querySelector('.chat-empty')?.remove();
  const d = document.createElement('div'); d.className = 'msg' + (mine ? ' mine' : ''); d.textContent = text;
  $('chatLog').appendChild(d); $('chatLog').scrollTop = 1e9;
  if (!mine && !$('chat').classList.contains('open')) { $('chatBadge').classList.add('show'); toast('💬 ' + text); }
}
function toggleChat(force) {
  const open = $('chat').classList.toggle('open', force);
  if (open) { $('chatBadge').classList.remove('show'); setTimeout(() => $('chatInput').focus(), 200); }
}
function sendChat() { const v = $('chatInput').value.trim(); if (!v) return; send({ t: 'chat', text: v }); addChat(v, true); repN('chatOut'); $('chatInput').value = ''; }
$('chatBtn').onclick = () => toggleChat(); $('hostChat').onclick = () => toggleChat(); $('chatClose').onclick = () => toggleChat(false);
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') sendChat(); if (e.key === 'Escape') toggleChat(false); });

// ---- reconnect / idle / lock ----
let inSession = false, byeReceived = false, reconnectTries = 0, hostHow = null, lastActivity = 0, idleTimer = null, limitWarned = false;
const MAX_RETRIES = 3;
function onViewerDrop() {
  if (role !== 'viewer') return;
  if (inSession && !byeReceived && reconnectTries < MAX_RETRIES) {
    const id = viewerTarget; reconnectTries++;
    endAll({ silent: true });
    overlay('wait', `Reconnecting <span>${fmt(id)}</span>`, `Connection dropped · attempt ${reconnectTries} of ${MAX_RETRIES}`);
    setTimeout(() => connect(id, true), 1200 * reconnectTries);
    return;
  }
  const dropped = inSession && !byeReceived;
  endAll();
  if (dropped) toast('Connection lost', 2600);
}
const limitText = (m) => m >= 60 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`;
function startIdleWatch() {
  clearInterval(idleTimer); lastActivity = Date.now(); limitWarned = false;
  idleTimer = setInterval(() => {
    const mins = +S.idleMins || 0;
    if (role === 'host' && mins > 0 && Date.now() - lastActivity > mins * 60e3) {
      send({ t: 'chat', text: `Session ended after ${mins} min of inactivity.` });
      repWhy = `Ended after ${mins} min of inactivity`; toast(`Session ended: idle for ${mins} min`, 4000); endAll(); return;
    }
    // Session length limit: warn the visitor a minute before, then end the session.
    const max = +S.maxMins || 0;
    if (role === 'host' && max > 0 && sessStart) {
      const left = max * 60e3 - (Date.now() - sessStart);
      if (left <= 0) {
        send({ t: 'chat', text: `Session ended: this PC allows sessions of up to ${limitText(max)}.` });
        repWhy = `Ended at the ${limitText(max)} time limit`; toast(`Session ended: time limit of ${limitText(max)} reached`, 4000); endAll();
      } else if (left <= 60e3 && !limitWarned) {
        limitWarned = true;
        send({ t: 'chat', text: `This session will end in about 1 minute (this PC allows sessions of up to ${limitText(max)}).` });
        toast('The session will end in about 1 minute (time limit)', 4000);
      }
    }
  }, 5000);
}

function endAll(opts = {}) {
  const wasHost = role === 'host', how = hostHow;
  if (wasHost && sessRep) sessRep.why = repWhy || (byeReceived ? 'The visitor ended the session' : 'The connection closed');
  send({ t: 'bye' });
  clearInterval(idleTimer); hostHow = null;
  if (wasHost) { window.dw.drawClose(); window.dw.secureStop(); window.dw.termStop(); window.dw.wallpaperRestore(); hostRecStop(); }
  $('recBadge').classList.remove('show');
  if (wasHost || hostBlock) { hostBlock = false; clearInterval(blockWatch); window.dw.blockInput(false); }
  setBlockBtn(false); $('blockBtn').style.display = 'none'; clearInterval(hbTimer);
  togglePi(false); $('piBtn').style.display = 'none'; $('piBody').innerHTML = ''; toggleSn(false); clipHist = [];
  if (wasHost || hostPrivacy) { hostPrivacy = false; window.dw.privacy(false); }
  setPrivBtn(false); $('privBtn').style.display = 'none'; fbAskClose();
  hostPaused = false; $('pauseBtn').classList.remove('on'); $('pauseLabel').textContent = 'Pause'; setPausedView(false); toggleBrowse(false); $('browseBtn').style.display = 'none'; toggleTm(false);
  stopVoice(true); ctrlAsk = false; $('ctrlReq').classList.remove('show');
  if (!opts.silent) { stopSessionTimer(); sessStart = 0; }
  toggleTerm(false); $('termOut').textContent = ''; $('termBtn').style.display = 'none';
  secureOff();
  setDrawMode(false); drawLayer.apply({ k: 'clear' });
  if (!opts.silent) { inSession = false; }
  byeReceived = false;
  window.dw.releaseAll(); clearTimeout(connectTimer);
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  closeHistory(); pendingPw = null;
  $('stage').classList.remove('actual'); $('scaleBtn').classList.remove('on'); $('scaleLabel').textContent = 'Fit';
  clearInterval(clipTimer); clearInterval(statsTimer);
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  try { call?.close(); } catch {} try { conn?.close(); } catch {}
  const wasViewer = role === 'viewer' && $('session').classList.contains('active');
  call = conn = null; role = null; remoteScreens = [];
  $('video').srcObject = null; $('video').classList.remove('playing', 'switching');
  $('hosting').classList.remove('show'); toggleChat(false); closePanel(); overlay(null);
  $('stats').textContent = '';
  if (document.fullscreenElement && !opts.silent) document.exitFullscreen();
  showView('home');
  if (wasViewer && !opts.silent && !opts.quiet) toast('Session ended');
  if (wasHost && (S.lockOnEnd === 'always' || (S.lockOnEnd === 'unattended' && how === 'unattended'))) {
    setTimeout(() => window.dw.lockPc(), 400);
  }
  viaLan = false;
  if (pendingUpdate && !opts.silent) setTimeout(() => { if (!role) runForcedUpdate(); }, 1500);
}

// ================= VIEWER INPUT =================
function norm(e) {
  const v = $('video'), r = v.getBoundingClientRect(), img = $('secureImg');
  // while a secure screen is shown, map against the secure image (primary monitor) instead of the video
  const vw = (secureOn && img.naturalWidth) || v.videoWidth || r.width, vh = (secureOn && img.naturalHeight) || v.videoHeight || r.height, sc = Math.min(r.width / vw, r.height / vh);
  const w = vw * sc, h = vh * sc, ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
  return { x: Math.min(1, Math.max(0, (e.clientX - ox) / w)), y: Math.min(1, Math.max(0, (e.clientY - oy) / h)) };
}
const video = $('video');
let pendingMove = null;
video.addEventListener('pointermove', (e) => { const evs = e.getCoalescedEvents?.() || [e]; pendingMove = norm(evs[evs.length - 1] || e); });
(function pump() { if (pendingMove) { sendInput({ t: 'move', ...pendingMove }); pendingMove = null; } requestAnimationFrame(pump); })();
video.addEventListener('pointerdown', (e) => { e.preventDefault(); $('stage').focus(); sendInput({ t: 'move', ...norm(e) }); sendInput({ t: 'down', b: e.button }); });
video.addEventListener('pointerup', (e) => { e.preventDefault(); sendInput({ t: 'up', b: e.button }); });
video.addEventListener('contextmenu', (e) => e.preventDefault());
video.addEventListener('wheel', (e) => { e.preventDefault(); sendInput({ t: 'wheel', dy: e.deltaY, dx: e.deltaX }); }, { passive: false });
$('stage').addEventListener('keydown', (e) => {
  e.preventDefault();
  if (e.ctrlKey && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const n = remoteScreens.length; if (n > 1) selectScreen((curScreen + (e.key === 'ArrowRight' ? 1 : -1) + n) % n); return;
  }
  if (e.ctrlKey && e.altKey && /^Digit[1-9]$/.test(e.code)) { selectScreen(+e.code.slice(5) - 1); return; }
  if (e.ctrlKey && e.altKey && e.code === 'KeyS') { $('shotBtn').click(); return; }
  sendInput({ t: 'kd', c: mapKey(e.code) });
});
$('stage').addEventListener('keyup', (e) => { e.preventDefault(); sendInput({ t: 'ku', c: mapKey(e.code) }); });
$('stage').addEventListener('blur', () => role === 'viewer' && window.dw.releaseAll());
let dragDepth = 0;
$('stage').addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropHint').classList.add('show'); });
$('stage').addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').classList.remove('show'); } });
$('stage').addEventListener('dragover', (e) => e.preventDefault());
$('stage').addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('dropHint').classList.remove('show'); if (e.dataTransfer.files.length) sendFiles(e.dataTransfer.files); });

// ---- auto-hiding toolbar ----
let tbTimer;
function revealToolbar() {
  $('toolbar').classList.remove('hidden'); clearTimeout(tbTimer);
  tbTimer = setTimeout(() => {
    if ($('toolbar').matches(':hover') || $('screensPanel').classList.contains('open') || document.activeElement?.tagName === 'SELECT') return revealToolbar();
    $('toolbar').classList.add('hidden');
  }, 2600);
}
$('session').addEventListener('pointermove', (e) => { if (e.clientY - $('session').getBoundingClientRect().top < 80) revealToolbar(); });
$('hotzone').addEventListener('pointerenter', revealToolbar);
$('toolbar').addEventListener('pointerenter', revealToolbar);

// ================= UI wiring =================
$('quality').onchange = (e) => { send({ t: 'quality', q: e.target.value }); toast(`Quality: ${e.target.selectedOptions[0].text}`, 1600); $('stage').focus(); };
$('remoteId').addEventListener('input', (e) => { e.target.value = fmt(e.target.value.replace(/\D/g, '').slice(0, 9)); });
$('remoteId').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
$('connectBtn').onclick = () => connect();
const copyId = () => { if (!myId) return; navigator.clipboard.writeText(myId); toast('Address copied to clipboard', 1800); };
$('myId').onclick = copyId; $('copyBtn').onclick = copyId;
$('cancelBtn').onclick = () => { stopRestartWait(); clearTimeout(connectTimer); try { conn?.close(); } catch {} conn = null; role = null; overlay(null); };
$('endBtn').onclick = () => endAll(); $('stopHost').onclick = () => { repWhy = 'You ended the session'; endAll(); };
$('fullBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
document.addEventListener('fullscreenchange', () => { document.body.classList.toggle('fs', !!document.fullscreenElement); revealToolbar(); });
$('ctrlBtn').onclick = () => {
  if (remotePerms.control === false) { send({ t: 'req-control' }); toast('Asked your partner for control', 2000); return; }
  control = !control;
  $('ctrlBtn').innerHTML = control ? '<svg class="ic"><use href="#i-mouse"/></svg><span>Control</span>' : '<svg class="ic"><use href="#i-eye"/></svg><span>View only</span>';
  $('ctrlBtn').classList.toggle('on', !control); toast(control ? 'Remote control enabled' : 'View-only mode', 1600);
};
$('fileBtn').onclick = () => $('filePick').click();
$('filePick').onchange = (e) => { if (e.target.files.length) sendFiles(e.target.files); e.target.value = ''; };
$('clipSync').onchange = (e) => toast(e.target.checked ? 'Clipboard sync on' : 'Clipboard sync off', 1500);
$('combo').onchange = async (e) => {
  const v = e.target.value; e.target.value = '';
  if (v === 'cad') {
    if (!control || remotePerms.control === false) toast('Remote control is off', 1600);
    else { sendInput({ t: 'cad' }); toast('Sent Ctrl+Alt+Del (needs the UniDesk service on the remote PC)', 2600); }
  } else if (v === 'typeclip') {
    const text = await window.dw.clipRead();
    if (!text) toast('Your clipboard is empty', 1600);
    else if (!control || remotePerms.control === false) toast('Remote control is off', 1600);
    else { sendInput({ t: 'type', text: text.slice(0, 5000) }); toast(`Typing ${Math.min(text.length, 5000)} characters…`, 1600); }
  } else if (v === 'snippets') {
    toggleSn(true);
  } else if (v === 'openurl') {
    if (!control || remotePerms.control === false) toast('Remote control is off', 1600);
    else { togglePi(true); setTimeout(() => $('piUrlIn').focus(), 350); }
  } else if (v === 'sleep' || v === 'signout' || v === 'shutdown') {
    const what = { sleep: 'Put {pc} to sleep?', signout: 'Sign out the user on {pc}?\n\nUnsaved work in their open apps may be lost.', shutdown: 'Shut down {pc}?\n\nYou won’t be able to reconnect until someone turns it on (or you wake it with Wake-on-LAN).' }[v].replace('{pc}', remoteInfo?.host || 'the remote PC');
    if (!control || remotePerms.control === false) toast('Remote control is off', 1600);
    else if (confirm(what)) send({ t: 'power', what: v });
  } else if (v === 'reboot') {
    if (!control || remotePerms.control === false) toast('Remote control is off', 1600);
    else if (confirm(`Restart ${remoteInfo?.host || 'the remote PC'}?\n\nUniDesk will wait for it to come back and reconnect automatically (up to 5 minutes).`)) send({ t: 'reboot' });
  } else {
    const map = { tm: ['ControlLeft', 'ShiftLeft', 'Escape'], win: ['MetaLeft'], alttab: ['AltLeft', 'Tab'], lock: ['MetaLeft', 'KeyL'], desk: ['MetaLeft', 'KeyD'], run: ['MetaLeft', 'KeyR'], explorer: ['MetaLeft', 'KeyE'], settings: ['MetaLeft', 'KeyI'] };
    if (map[v]) sendInput({ t: 'combo', keys: map[v] });
  }
  $('stage').focus();
};
document.addEventListener('keydown', (e) => { if (e.key === 'F11' && role === 'viewer') { e.preventDefault(); $('fullBtn').click(); } }, true);

// ================= ADDRESS BOOK =================
// desks: [{ id, name, fav, last }] — migrates the old plain-id recents list
let remoteInfo = null;
function readDesks() {
  let d = null; try { d = JSON.parse(localStorage.getItem('ud-desks') || 'null'); } catch {}
  if (!d) {
    let old = []; try { old = JSON.parse(localStorage.getItem('dw-recent') || '[]'); } catch {}
    d = old.map((id, i) => ({ id, name: '', fav: false, last: Date.now() - i }));
  }
  return d;
}
function writeDesks(d) { try { localStorage.setItem('ud-desks', JSON.stringify(d)); } catch {} loadRecents(); }
function loadRecents() {
  const all = readDesks().sort((a, b) => (b.fav - a.fav) || (b.last - a.last));
  const box = $('recents'); box.innerHTML = '';
  $('recentsTitle').textContent = all.some(x => x.fav) ? 'Desks' : 'Recent';
  const q = $('deskSearch').value.trim().toLowerCase(), qd = q.replace(/\D/g, '');
  $('deskSearch').hidden = all.length < 5 && !q;
  const d = q ? all.filter(x => (x.name || '').toLowerCase().includes(q) || (x.note || '').toLowerCase().includes(q) || (qd && x.id.includes(qd))) : all;
  if (!all.length) { box.innerHTML = '<span class="empty">No saved desks yet</span>'; return; }
  if (!d.length) { box.innerHTML = '<span class="empty">No desks match your search</span>'; return; }
  d.slice(0, q ? 30 : 8).forEach((x, i) => {
    const el = document.createElement('div'); el.className = 'desk' + (x.fav ? ' fav' : ''); el.style.animationDelay = i * 40 + 'ms';
    el.innerHTML = `<button class="desk-main" title="Connect"><span class="desk-av">${(x.name || '#')[0].toUpperCase()}</span>
        <span class="desk-txt"><b></b><small class="mono">${fmt(x.id)}</small>${x.note ? '<small class="desk-note"></small>' : ''}</span></button>
      <div class="desk-acts">
        ${x.mac && !nearbyDesk(x.id) ? '<button class="wake" title="Wake up this PC (Wake-on-LAN)">⏻</button>' : ''}
        <button class="mini star" title="${x.fav ? 'Unpin' : 'Pin to top'}">${x.fav ? '★' : '☆'}</button>
        <button class="mini" title="Name and notes">✎</button>
        <button class="mini" title="Remove">✕</button>
      </div>`;
    el.querySelector('b').textContent = x.name || 'Unnamed desk';
    if (x.note) { el.querySelector('.desk-note').textContent = x.note.replace(/\s+/g, ' '); el.querySelector('.desk-main').title = 'Connect\n\n' + x.note; }
    el.querySelector('.desk-main').onclick = () => connect(x.id);
    const [star, ren, del] = el.querySelectorAll('.mini');
    const wk = el.querySelector('.wake'); if (wk) wk.onclick = (e) => { e.stopPropagation(); wakeDesk(x); };
    star.onclick = () => { const all = readDesks(); const t = all.find(y => y.id === x.id); t.fav = !t.fav; writeDesks(all); };
    ren.onclick = () => openNameDialog(x.id, x.name, x.note);
    del.onclick = () => { writeDesks(readDesks().filter(y => y.id !== x.id)); window.dw.pwForget(x.id); toast('Desk removed', 1400); };
    box.appendChild(el);
  });
}
function saveRecent(id) {
  const all = readDesks(); const t = all.find(x => x.id === id);
  if (t) t.last = Date.now(); else all.push({ id, name: '', fav: false, last: Date.now() });
  const keep = all.sort((a, b) => (b.fav - a.fav) || (b.last - a.last)).filter((x, i) => x.fav || x.name || x.mac || x.note || i < 12);
  writeDesks(keep);
}
function nameDeskIfUnnamed(id, name) {
  const all = readDesks(); const t = all.find(x => x.id === id);
  if (t && !t.name && name) { t.name = String(name).slice(0, 40); writeDesks(all); }
}
let renaming = null;
function openNameDialog(id, name, note) {
  renaming = id; $('nameInput').value = name || ''; $('noteInput').value = note || ''; $('nameDialog').classList.add('show');
  setTimeout(() => { $('nameInput').focus(); $('nameInput').select(); }, 120);
}
function closeNameDialog() { $('nameDialog').classList.remove('show'); renaming = null; }
$('nameCancel').onclick = closeNameDialog;
$('nameSave').onclick = () => {
  const all = readDesks(); const t = all.find(x => x.id === renaming);
  if (t) { t.name = $('nameInput').value.trim().slice(0, 40); const n = $('noteInput').value.trim().slice(0, 300); if (n) t.note = n; else delete t.note; writeDesks(all); }
  closeNameDialog();
};
$('nameInput').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('nameSave').click(); if (e.key === 'Escape') closeNameDialog(); });
$('noteInput').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('nameSave').click(); if (e.key === 'Escape') closeNameDialog(); });

// ================= STATS =================
let statsTimer, lastBytes = 0, lastTs = 0;
function startStats() {
  clearInterval(statsTimer); lastBytes = lastTs = 0;
  statsTimer = setInterval(async () => {
    const pc = call?.peerConnection; if (!pc) return;
    const rep = await pc.getStats(); let fps = 0, w = 0, h = 0, kbps = 0, rtt = 0, codecId, path = 'P2P';
    const byId = new Map(); rep.forEach(s => byId.set(s.id, s));
    rep.forEach(s => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        fps = s.framesPerSecond || 0; w = s.frameWidth || 0; h = s.frameHeight || 0; codecId = s.codecId;
        if (lastTs) kbps = ((s.bytesReceived - lastBytes) * 8) / (s.timestamp - lastTs);
        lastBytes = s.bytesReceived; lastTs = s.timestamp;
      }
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        rtt = (s.currentRoundTripTime || 0) * 1000;
        if (byId.get(s.localCandidateId)?.candidateType === 'relay') path = 'Relay';
      }
    });
    const codec = (byId.get(codecId)?.mimeType || '').replace('video/', '');
    updateSignal(rtt, fps);
    $('stats').textContent = `${codec} · ${w}×${h} · ${Math.round(fps)} fps · ${(kbps / 1000).toFixed(1)} Mbps · ${Math.round(rtt)} ms · ${viaLan ? 'LAN' : path}`;
  }, 1000);
}

// ================= SESSION HISTORY =================
let currentLog = null;
function readHistory() { try { return JSON.parse(localStorage.getItem('ud-history') || '[]'); } catch { return []; } }
function logHistory(entry) {
  const h = readHistory(); const e = { ...entry, start: Date.now(), end: null };
  if (entry.how !== 'declined' && entry.how !== 'blocked') currentLog = e.start; else e.end = e.start;
  h.unshift(e); try { localStorage.setItem('ud-history', JSON.stringify(h.slice(0, 50))); } catch {}
  renderHistory();
}
function closeHistory() {
  if (!currentLog) { sessRep = null; repWhy = ''; return; }
  const h = readHistory(); const e = h.find(x => x.start === currentLog); if (e) e.end = Date.now();
  let saved = false;
  if (e && sessRep) { const { lastP, ...r } = sessRep; e.report = r; saved = true; }
  h.forEach((x, i) => { if (i >= 20) delete x.report; });   // keep full reports for the latest 20 sessions
  try { localStorage.setItem('ud-history', JSON.stringify(h)); } catch {}
  currentLog = null; sessRep = null; repWhy = ''; renderHistory();
  if (saved) toast('Session report saved in Settings › Session history', 3200);
}
function dur(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`; }
function renderHistory() {
  const box = $('historyList'); if (!box) return;
  const h = readHistory().slice(0, 20); box.innerHTML = '';
  if (!h.length) { box.innerHTML = '<div class="row"><div class="txt"><span>No sessions yet.</span></div></div>'; return; }
  const labels = { approved: 'Approved', unattended: 'Unattended', code: 'One-time code', declined: 'Declined', blocked: 'Blocked' };
  h.forEach(e => {
    const r = document.createElement('div'); r.className = 'row hist';
    const when = new Date(e.start).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    r.innerHTML = `<span class="hdir ${e.dir}">${e.dir === 'in' ? '↘' : '↗'}</span>
      <div class="txt"><b class="mono">${e.id}</b><span>${e.dir === 'in' ? 'Connected to you' : 'You connected'} · ${when}${e.end && e.how !== 'declined' && e.how !== 'blocked' ?' · ' + dur(e.end - e.start) : ''}</span></div>
      <span class="htag ${e.how}">${labels[e.how] || e.how}</span>${e.report ? '<button class="link-btn rep-btn">Report</button>' : ''}`;
    if (e.report) r.querySelector('.rep-btn').onclick = () => openReport(e);
    box.appendChild(r);
  });
}
// ================= SESSION REPORT (host) =================
// What a visitor did on this PC: files, file changes, terminal commands, ended programs, links, power.
// Stored only on this PC, with the session's history entry.
let sessRep = null, repWhy = '';
function repStart(who, how) { sessRep = { who, how, perms: { ...P }, ev: [], n: { chatIn: 0, chatOut: 0, clipIn: 0, clipOut: 0, filesIn: 0, filesOut: 0, bytesIn: 0, bytesOut: 0 }, lastP: null }; repWhy = ''; }
function repEv(text) { if (role !== 'host' || !sessRep || !text) return; if (sessRep.ev.length < 300) sessRep.ev.push({ t: Date.now(), d: String(text).slice(0, 240) }); else sessRep.cut = true; }
function repN(k, by = 1) { if (role === 'host' && sessRep) sessRep.n[k] += by; }
const PERM_NAMES = { control: 'control', files: 'files', clip: 'clipboard', terminal: 'terminal', browse: 'file browsing' };
function repPerms() {
  if (role !== 'host' || !sessRep) return;
  const was = sessRep.lastP; sessRep.lastP = { ...P };
  if (!was) { sessRep.perms = { ...P }; return; }
  const on = Object.keys(PERM_NAMES).filter(k => P[k] && !was[k]), off = Object.keys(PERM_NAMES).filter(k => !P[k] && was[k]);
  if (on.length) repEv('You allowed ' + on.map(k => PERM_NAMES[k]).join(', '));
  if (off.length) repEv('You took away ' + off.map(k => PERM_NAMES[k]).join(', '));
}
const HOW_TEXT = { approved: 'You accepted the request', unattended: 'Unattended access (password)', code: 'One-time code' };
function reportText(e) {
  const r = e.report, at = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const allowed = Object.keys(PERM_NAMES).filter(k => r.perms?.[k]).map(k => PERM_NAMES[k]).join(', ') || 'view only';
  const lines = [
    'UniDesk session report',
    `Visitor: ${e.id}`,
    `Started: ${new Date(e.start).toLocaleString()}`,
    `Length: ${e.end ? dur(e.end - e.start) : 'unknown'}`,
    `How they got in: ${HOW_TEXT[e.how] || e.how}`,
    `Allowed at the start: ${allowed}`,
    `Ended: ${r.why || 'unknown'}`,
    `Files: ${r.n.filesIn} received (${fmtSize(r.n.bytesIn)}), ${r.n.filesOut} sent (${fmtSize(r.n.bytesOut)})`,
    `Clipboard: ${r.n.clipIn} copied to this PC, ${r.n.clipOut} copied from it`,
    `Chat: ${r.n.chatIn} messages received, ${r.n.chatOut} sent`,
    '',
    r.ev.length ? 'What happened:' : 'No files, commands or other actions.',
    ...r.ev.map(x => `  ${at(x.t)}  ${x.d}`),
  ];
  if (r.cut) lines.push('  (more actions were not recorded: the report keeps the first 300)');
  return lines.join('\n');
}
let repOpen = null;
function openReport(e) {
  repOpen = e; const r = e.report;
  $('repSub').textContent = `${e.id} · ${new Date(e.start).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${e.end ? dur(e.end - e.start) : ''}`;
  const allowed = Object.keys(PERM_NAMES).filter(k => r.perms?.[k]).map(k => PERM_NAMES[k]).join(', ') || 'view only';
  const facts = [['How they got in', HOW_TEXT[e.how] || e.how], ['Allowed', allowed], ['Ended', r.why || 'unknown'],
    ['Files', `${r.n.filesIn} received · ${r.n.filesOut} sent`], ['Clipboard', `${r.n.clipIn} in · ${r.n.clipOut} out`], ['Chat', `${r.n.chatIn} received · ${r.n.chatOut} sent`]];
  $('repFacts').innerHTML = facts.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  const at = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('repList').innerHTML = r.ev.length ? r.ev.map(x => `<li><time>${at(x.t)}</time><span>${esc(x.d)}</span></li>`).join('') + (r.cut ? '<li class="more"><span>More actions happened but only the first 300 are kept.</span></li>' : '')
    : '<li class="none"><span>No files, commands or other actions in this session.</span></li>';
  $('repDialog').classList.add('show');
}
$('repClose').onclick = () => { $('repDialog').classList.remove('show'); repOpen = null; };
$('repCopy').onclick = () => { if (!repOpen) return; window.dw.clipWrite(reportText(repOpen)); toast('Report copied as text', 1600); };
$('repDialog').addEventListener('keydown', (ev) => { if (ev.key === 'Escape') $('repClose').click(); });
$('repDialog').addEventListener('click', (ev) => { if (ev.target === $('repDialog')) $('repClose').click(); });
$('clearHistory').onclick = () => { try { localStorage.removeItem('ud-history'); } catch {} renderHistory(); toast('History cleared', 1500); };
renderHistory();

// ================= UNATTENDED SETTINGS UI =================
async function refreshAuthUi() {
  const has = await window.dw.authHas();
  $('pwState').textContent = has ? 'Password is set' : 'No password set yet';
  $('pwBtn').textContent = has ? 'Change' : 'Set password';
  $('pwRemove').style.display = has ? '' : 'none';
  if (!has && S.unattended) { S.unattended = false; saveSettings(); applyAll(); }
  $('unattendedBadge').classList.toggle('show', !!(S.unattended && has));
}
function pwStrength(p) {
  let s = 0; if (p.length >= 8) s++; if (p.length >= 12) s++; if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++; if (/\d/.test(p)) s++; if (/[^A-Za-z0-9]/.test(p)) s++;
  return Math.min(4, s);
}
function openPwDialog() {
  $('pw1').value = $('pw2').value = ''; $('pwErr').textContent = ''; updateMeter();
  $('pwDialog').classList.add('show'); setTimeout(() => $('pw1').focus(), 150);
}
function closePwDialog() { $('pwDialog').classList.remove('show'); }
function updateMeter() {
  const s = pwStrength($('pw1').value), names = ['Too weak', 'Weak', 'Okay', 'Strong', 'Very strong'];
  $('pwMeter').dataset.s = $('pw1').value ? s : -1; $('pwMeterTxt').textContent = $('pw1').value ? names[s] : '';
}
$('pw1').addEventListener('input', updateMeter);
['pw1', 'pw2'].forEach(id => $(id).addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('pwSave').click(); if (e.key === 'Escape') closePwDialog(); }));
$('pwBtn').onclick = openPwDialog; $('pwCancel').onclick = closePwDialog;
$('pwSave').onclick = async () => {
  const a = $('pw1').value, b = $('pw2').value;
  if (a.length < 8) return ($('pwErr').textContent = 'Use at least 8 characters.');
  if (pwStrength(a) < 2) return ($('pwErr').textContent = 'Too easy to guess: mix letters, numbers and symbols.');
  if (a !== b) return ($('pwErr').textContent = "The passwords don't match.");
  const r = await window.dw.authSet(a);
  if (!r.ok) return ($('pwErr').textContent = r.error);
  closePwDialog(); S.unattended = true; saveSettings(); applyAll(); refreshAuthUi();
  toast('Unattended access is on', 2200);
};
$('pwRemove').onclick = async () => {
  if (!confirm('Remove the password and turn off unattended access?')) return;
  await window.dw.authClear(); S.unattended = false; saveSettings(); applyAll(); refreshAuthUi(); toast('Unattended access turned off', 2000);
};
// turning the switch on without a password opens the dialog instead
document.querySelector('[data-set="unattended"]').addEventListener('change', async (e) => {
  if (e.target.checked && !(await window.dw.authHas())) { S.unattended = false; saveSettings(); applyAll(); openPwDialog(); }
  refreshAuthUi();
});
$('forgetSaved').onclick = async () => { await window.dw.pwForget(null); toast('Saved desk passwords removed', 1800); };
refreshAuthUi();

// main-process prefs (tray, startup) + tray integration
const pushMainPrefs = () => window.dw.mainPrefs({ tray: !!S.tray, startup: !!S.startup });
pushMainPrefs();
document.querySelectorAll('[data-set="tray"],[data-set="startup"]').forEach(i => i.addEventListener('change', pushMainPrefs));
window.dw.onOpenSettings(() => openSettings('security'));

// ================= RECORD / SCREENSHOT / SCALE =================
let recorder = null, recId = null, recStartAt = 0, recTick = null;
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
$('shotBtn').onclick = async () => {
  const v = $('video'); if (!v.videoWidth) return;
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const p = await window.dw.saveShot(`UniDesk ${viewerTarget} ${stamp()}.png`, await blob.arrayBuffer());
  $('stage').classList.remove('flash'); void $('stage').offsetWidth; $('stage').classList.add('flash');
  toast('Screenshot saved to Pictures\\UniDesk', 2200); window.dw.showFile(p); $('stage').focus();
};
$('recBtn').onclick = async () => {
  if (recorder) { recorder.stop(); return; }
  const src = $('video').srcObject; if (!src) return;
  const mime = ['video/webm;codecs=av1,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(src, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  recId = await window.dw.recStart(`UniDesk ${viewerTarget} ${stamp()}.webm`);
  recorder.ondataavailable = async (e) => { if (e.data.size) window.dw.recChunk(recId, await e.data.arrayBuffer()); };
  recorder.onstop = async () => {
    clearInterval(recTick); $('recBtn').classList.remove('recording'); $('recTime').textContent = '';
    await new Promise(r => setTimeout(r, 300));
    const p = await window.dw.recEnd(recId); recorder = null; recId = null;
    if (p) { toast('Recording saved to Videos\\UniDesk', 2600); window.dw.showFile(p); }
  };
  recorder.start(1000); recStartAt = Date.now(); $('recBtn').classList.add('recording');
  recTick = setInterval(() => { const s = Math.floor((Date.now() - recStartAt) / 1000); $('recTime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 500);
  toast('Recording started', 1500); $('stage').focus();
};
$('scaleBtn').onclick = () => {
  const actual = $('stage').classList.toggle('actual');
  $('scaleBtn').classList.toggle('on', actual); $('scaleLabel').textContent = actual ? '100%' : 'Fit';
  toast(actual ? 'Actual size: scroll to pan' : 'Fit to window', 1500); $('stage').focus();
};

// ================= NETWORK (custom signaling + TURN) =================
const NET_DEFAULT = { host: '', port: '', path: '/', secure: true, turnUrls: '', turnUser: '' };
function net() { return { ...NET_DEFAULT, ...(S.net || {}) }; }
async function peerOptions() {
  const n = net(), iceServers = [...ICE.iceServers];
  if (n.turnUrls.trim()) {
    const cred = await window.dw.pwGet('__turn__');
    iceServers.push({ urls: n.turnUrls.split(/[\s,]+/).filter(Boolean), username: n.turnUser || undefined, credential: cred || undefined });
  }
  const o = { config: { ...ICE, iceServers }, debug: 0 };
  if (n.host.trim()) Object.assign(o, { host: n.host.trim(), port: +n.port || (n.secure ? 443 : 80), path: n.path || '/', secure: !!n.secure });
  return o;
}
function fillNetForm() {
  const n = net();
  $('netHost').value = n.host; $('netPort').value = n.port; $('netPath').value = n.path; $('netSecure').checked = !!n.secure;
  $('turnUrls').value = n.turnUrls; $('turnUser').value = n.turnUser; $('turnPass').value = '';
  $('netState').textContent = n.host ? `Custom server: ${n.host}` : 'Default public server (0.peerjs.com)';
  $('turnState').textContent = n.turnUrls ? 'Relay configured' : 'No relay: direct P2P only';
}
$('netSave').onclick = async () => {
  if (role) return toast('End the current session first', 2000);
  const host = $('netHost').value.trim(), urls = $('turnUrls').value.trim();
  if (host && !/^[a-z0-9.-]+$/i.test(host)) return toast('Server host should look like peer.example.com', 2600);
  if (urls && !urls.split(/[\s,]+/).every(u => /^turns?:/.test(u))) return toast('TURN URLs start with turn: or turns:', 2600);
  S.net = { host, port: $('netPort').value.trim(), path: $('netPath').value.trim() || '/', secure: $('netSecure').checked, turnUrls: urls, turnUser: $('turnUser').value.trim() };
  if ($('turnPass').value) await window.dw.pwRemember('__turn__', $('turnPass').value);
  saveSettings(); toast('Saved: reconnecting to the network…', 1600); setTimeout(() => { peer?.destroy(); location.reload(); }, 700);
};
$('netReset').onclick = async () => {
  if (role) return toast('End the current session first', 2000);
  S.net = { ...NET_DEFAULT }; await window.dw.pwForget('__turn__'); saveSettings(); fillNetForm(); toast('Back to default network', 1500);
  setTimeout(() => { peer?.destroy(); location.reload(); }, 700);
};
document.querySelectorAll('#netForm input').forEach(i => i.addEventListener('keydown', (e) => e.stopPropagation()));
fillNetForm();

// ================= INVITE LINKS =================
const inviteUrl = () => `https://dev-rehanify.github.io/UniDesk/connect.html#${myId}`;
$('inviteBtn').onclick = () => { if (!myId) return; navigator.clipboard.writeText(inviteUrl()); toast('Invite link copied: anyone who opens it connects to you (you still approve)', 3200); };
// Control this PC from a phone: a QR code that opens the mobile viewer with this address filled in
const phoneUrl = () => `https://dev-rehanify.github.io/UniDesk/m/?id=${myId}`;
let qrLib = null;
const loadQr = () => qrLib || (qrLib = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'node_modules/qrcode-generator/qrcode.js'; s.onload = () => res(window.qrcode); s.onerror = rej; document.head.appendChild(s); }));
async function showPhoneQr(force) {
  const pop = $('qrPop'), open = force ?? !pop.classList.contains('show');
  pop.classList.toggle('show', open); $('phoneBtn').classList.toggle('on', open);
  if (!open || !myId) return;
  try {
    const qrcode = await loadQr(); const qr = qrcode(0, 'M'); qr.addData(phoneUrl()); qr.make();
    $('qrBox').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    $('qrBox').dataset.url = phoneUrl();
  } catch { $('qrBox').textContent = 'QR code unavailable'; }
  placeQr();
}
// keep the popup next to its button and fully inside the window (below it if there's room, otherwise above)
function placeQr() {
  const pop = $('qrPop'); if (!pop.classList.contains('show')) return;
  const b = $('phoneBtn').getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight, gap = 10, m = 8;
  let top = b.bottom + gap; if (top + h > innerHeight - m) top = b.top - gap - h; top = Math.max(m, Math.min(top, innerHeight - m - h));
  const left = Math.max(m, Math.min(b.right - w, innerWidth - m - w));
  pop.style.top = top + 'px'; pop.style.left = left + 'px';
}
window.addEventListener('resize', placeQr);
document.body.appendChild($('qrPop'));   // out of the card: a transformed parent would clip it and break fixed positioning
$('phoneBtn').onclick = (e) => { e.stopPropagation(); showPhoneQr(); };
$('qrPop').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { if ($('qrPop').classList.contains('show')) showPhoneQr(false); });
$('qrCopy').onclick = () => { navigator.clipboard.writeText(phoneUrl()); toast('Phone link copied: open it on your phone to control this PC', 2600); };
const peerReady = () => new Promise((res) => {
  if (peer?.open) return res(true);
  const t = setTimeout(() => res(false), 15000);
  peer?.once('open', () => { clearTimeout(t); res(true); });
});
async function connectFromLink(id) {
  if (!id || id === myId) return;
  if (!(await peerReady())) return toast('Not online yet: try the invite link again in a moment', 3000);
  if (role) return toast(`Finish this session to connect to ${fmt(id)}`, 2600);
  $('remoteId').value = fmt(id); showView('home'); connect(id);
}
window.dw.onDeepLink(connectFromLink);

// ================= FORCED AUTO-UPDATE =================
// Builds are numbered by CI; a newer build of the same version is still an update.
let pendingUpdate = null, updating = false;
async function checkUpdate() {
  const r = await window.dw.updateCheck().catch(() => null);
  const v = await window.dw.appVersion();
  const b = r?.current?.build;
  $('aboutVersion').textContent = `Version ${v}${b ? ` (build ${b})` : r?.dev ? ' (development)' : ''} · Free forever`;
  if (!r?.available) return;
  pendingUpdate = r;
  if (role) { // never interrupt a session: install right after it ends
    $('updateBtn').classList.add('show'); $('updateLabel').textContent = 'Update after session';
    $('updateBtn').onclick = () => toast('UniDesk will update as soon as this session ends', 2400);
    return;
  }
  runForcedUpdate();
}
function runForcedUpdate() {
  if (!pendingUpdate || updating) return;
  updating = true;
  const u = pendingUpdate;
  $('updScreen').classList.add('show');
  $('updTitle').textContent = 'Updating UniDesk';
  $('updSub').textContent = `A new build (${u.remote.build}) is available. This takes about a minute and UniDesk will restart itself.`;
  if (!u.canAuto) { // portable copy: cannot replace itself
    $('updBar').parentElement.style.display = 'none';
    $('updSub').textContent = 'A required update is available. Download the new version to keep using UniDesk.';
    $('updAction').style.display = ''; $('updAction').textContent = 'Download update';
    $('updAction').onclick = () => window.dw.openExternal('https://github.com/dev-rehanify/UniDesk/releases/latest');
    return;
  }
  $('updAction').style.display = 'none';
  window.dw.updateInstall();
}
window.dw.onUpdateProgress((m) => {
  if (m.phase === 'download') { $('updBar').style.width = m.pct + '%'; $('updPct').textContent = `Downloading… ${m.pct}%`; }
  else if (m.phase === 'install') { $('updBar').style.width = '100%'; $('updPct').textContent = 'Installing and restarting…'; }
  else if (m.phase === 'error') {
    updating = false; $('updPct').textContent = 'Update failed: ' + m.message;
    $('updAction').style.display = ''; $('updAction').textContent = 'Try again'; $('updAction').onclick = runForcedUpdate;
  }
});
setInterval(() => { if (!updating) checkUpdate(); }, 30 * 60e3);

// ================= LAN MODE =================
let viaLan = false, lanHostPeer = null; const nearbyMap = new Map(), lanClients = new Map();
function nearbyDesk(id) { if (S.lan === false) return null; const d = nearbyMap.get(id); return d && Date.now() - d.seen < 10000 ? d : null; }
function lanClientFor(d) {
  const key = `${d.ip}:${d.port}`;
  if (lanClients.has(key)) return lanClients.get(key);
  const pr = new Promise((res, rej) => {
    const p = new Peer(PREFIX + myId, { host: d.ip, port: d.port, path: '/unidesk/', secure: false, config: { iceServers: [] }, debug: 0 });
    const t = setTimeout(() => { rej(new Error('timeout')); p.destroy(); lanClients.delete(key); }, 4000);
    p.on('open', () => { clearTimeout(t); res(p); });
    p.on('error', (e) => { clearTimeout(t); rej(e); p.destroy(); lanClients.delete(key); });
    p.on('call', onIncomingCall);
    p.on('disconnected', () => { p.destroy(); lanClients.delete(key); });
  });
  lanClients.set(key, pr);
  return pr;
}
async function startLanHost() {
  if (S.lan === false || lanHostPeer) return;
  const r = await window.dw.lanStart(myId);
  if (!r?.port) return;
  lanHostPeer = new Peer(PREFIX + myId, { host: '127.0.0.1', port: r.port, path: '/unidesk/', secure: false, config: { iceServers: [] }, debug: 0 });
  lanHostPeer.on('connection', onIncomingConn);
  lanHostPeer.on('call', onIncomingCall);
  lanHostPeer.on('open', () => $('lanState').textContent = `On: others on your network can find this desk (port ${r.port})`);
  lanHostPeer.on('error', () => {});
}
window.dw.onLanPeers((list) => {
  nearbyMap.clear(); list.forEach(d => nearbyMap.set(d.id, d));
  renderNearby();
});
function renderNearby() {
  const box = $('nearby'), list = S.lan === false ? [] : [...nearbyMap.values()];
  $('nearbyWrap').style.display = list.length ? '' : 'none';
  box.innerHTML = '';
  list.forEach(d => {
    const b = document.createElement('button'); b.className = 'near';
    b.innerHTML = `<span class="near-dot"></span><span class="desk-txt"><b></b><small class="mono">${fmt(d.id)}</small></span>`;
    b.querySelector('b').textContent = d.name || 'Nearby desk';
    b.onclick = () => connect(d.id);
    box.appendChild(b);
  });
}

// ================= ADMIN & UAC (Windows) =================
async function refreshAdminUi() {
  const s = await window.dw.adminStatus().catch(() => null);
  if (!s?.supported) { $('adminGroup').style.display = 'none'; return; }
  $('adminState').textContent = s.admin ? 'Yes: visitors can control admin apps and Task Manager' : 'No: start UniDesk as administrator for full control';
  $('adminBtn').style.display = s.admin ? 'none' : '';
  const label = { running: 'Running: lock screen, UAC prompts and Ctrl+Alt+Del work in sessions', stopped: 'Installed but stopped', missing: 'Not installed yet' }[s.service] || s.service;
  $('svcState').textContent = s.helper ? label : 'Available in the installed app';
  $('svcBtn').style.display = s.admin && s.helper && s.service !== 'running' ? '' : 'none';
}
$('svcBtn').onclick = async () => {
  $('svcBtn').disabled = true; const r = await window.dw.serviceInstall(); $('svcBtn').disabled = false;
  toast(r.ok ? 'Secure Desktop service is running' : 'Could not install the service: ' + (r.reason || 'unknown'), 2600); refreshAdminUi();
};

// ================= SECURE DESKTOP (lock screen / UAC / Ctrl+Alt+Del) =================
// Host: frames come from the SYSTEM agent via main; split into chunks small enough for the data channel.
const SF_CHUNK = 48 * 1024; let sfSeq = 0;
window.dw.onSecureFrame((f) => {
  if (role !== 'host') return;
  if (!f) return send({ t: 'sf-end' });
  const id = ++sfSeq, n = Math.ceil(f.jpeg.length / SF_CHUNK);
  for (let i = 0; i < n; i++) send({ t: 'sf', id, i, n, k: f.desk, d: f.jpeg.slice(i * SF_CHUNK, (i + 1) * SF_CHUNK) });
});
// Viewer: reassemble and show over the video
let secureOn = false; const sfParts = new Map();
function onSecureChunk(m) {
  let e = sfParts.get(m.id); if (!e) { e = { parts: new Array(m.n), got: 0 }; sfParts.set(m.id, e); }
  if (!e.parts[m.i]) { e.parts[m.i] = m.d; e.got++; }
  if (e.got < m.n) return;
  sfParts.delete(m.id); for (const k of sfParts.keys()) if (k < m.id) sfParts.delete(k);
  $('secureImg').src = 'data:image/jpeg;base64,' + e.parts.join('');
  if (!secureOn) {
    secureOn = true; $('stage').classList.add('secure');
    const what = /winlogon/i.test(m.k) ? 'the lock screen or a security prompt' : 'a secure screen';
    $('secureBanner').textContent = `The remote PC is showing ${what}. You can still control it.`;
  }
}
function secureOff() { secureOn = false; sfParts.clear(); $('stage').classList.remove('secure'); $('secureImg').removeAttribute('src'); }
$('adminBtn').onclick = () => { if (role) return toast('End the current session first', 2000); window.dw.adminRelaunch(); };
refreshAdminUi();

// ================= CHIME =================
function chime() {
  try {
    const ac = new AudioContext(), t = ac.currentTime;
    [[880, 0], [1318.5, .14]].forEach(([f, d]) => {
      const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(.18, t + d + .02); g.gain.exponentialRampToValueAtTime(.001, t + d + .5);
      o.connect(g).connect(ac.destination); o.start(t + d); o.stop(t + d + .55);
    });
    setTimeout(() => ac.close(), 1200);
  } catch {}
}

// ================= DRAW ON REMOTE SCREEN =================
const drawCanvas = $('drawLayer'); const drawLayer = StrokeLayer(drawCanvas);
const PENS = ['#ff4f8b', '#ffd23f', '#3dd6ff', '#2ee59d'];
let drawMode = false, penIdx = 0, strokeId = null, lastPt = 0;
function placeDrawLayer() {
  const v = $('video'), r = v.getBoundingClientRect(), sr = $('stage').getBoundingClientRect();
  if (!v.videoWidth) return;
  const sc = Math.min(r.width / v.videoWidth, r.height / v.videoHeight), w = v.videoWidth * sc, h = v.videoHeight * sc;
  Object.assign(drawCanvas.style, { left: (r.left - sr.left + (r.width - w) / 2 + $('stage').scrollLeft) + 'px', top: (r.top - sr.top + (r.height - h) / 2 + $('stage').scrollTop) + 'px', width: w + 'px', height: h + 'px' });
  drawLayer.fit();
}
function setDrawMode(on) {
  drawMode = !!on; $('drawBtn').classList.toggle('on', drawMode); drawCanvas.classList.toggle('active', drawMode);
  if (drawMode) placeDrawLayer();
}
$('drawBtn').onclick = () => { setDrawMode(!drawMode); toast(drawMode ? 'Draw mode: your strokes appear on their screen · double-click to clear' : 'Draw mode off', 2200); $('stage').focus(); };
$('penColor').onclick = (e) => { e.stopPropagation(); penIdx = (penIdx + 1) % PENS.length; $('penColor').style.background = PENS[penIdx]; };
$('penColor').style.background = PENS[0];
const drawPt = (e) => { const r = drawCanvas.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
function drawMsg(m) { drawLayer.apply(m); send({ t: 'draw', ...m }); }
drawCanvas.addEventListener('pointerdown', (e) => { if (!drawMode) return; drawCanvas.setPointerCapture(e.pointerId); strokeId = Math.random().toString(36).slice(2); drawMsg({ k: 'start', id: strokeId, color: PENS[penIdx], ...drawPt(e) }); });
drawCanvas.addEventListener('pointermove', (e) => { if (!strokeId) return; const now = performance.now(); if (now - lastPt < 12) return; lastPt = now; drawMsg({ k: 'pt', id: strokeId, ...drawPt(e) }); });
const endStroke = () => { if (strokeId) { drawMsg({ k: 'end', id: strokeId }); strokeId = null; } };
drawCanvas.addEventListener('pointerup', endStroke); drawCanvas.addEventListener('pointercancel', endStroke);
drawCanvas.addEventListener('dblclick', () => drawMsg({ k: 'clear' }));
window.addEventListener('resize', () => drawMode && placeDrawLayer());
$('video').addEventListener('loadedmetadata', () => drawMode && placeDrawLayer());

// host can send files back to the viewer
$('hostFile').onclick = () => $('filePick').click();

boot().then(async () => {
  window.dw.myId(fmt(myId));
  if (await peerReady()) startLanHost(); else setTimeout(startLanHost, 3000);
  connectFromLink(await window.dw.takePendingLink());
  checkUpdate();
}).catch(e => setStatus('Failed to start: ' + e.message));

document.querySelector('[data-set="lan"]').addEventListener('change', () => {
  renderNearby();
  if (!role) { toast('Restarting the network…', 1400); setTimeout(() => location.reload(), 800); }
  else toast('LAN mode changes apply after this session', 2200);
});
// ================= REQUEST CARD (host) =================
let reqResolve = null, reqTimer = null;
function requestDialog(who, getName) {
  return new Promise((resolve) => {
    reqResolve = resolve;
    window.dw.showWindow();
    try { if (document.hidden) new Notification('UniDesk', { body: `${who} wants to connect to this computer` }); } catch {}
    $('reqWho').textContent = who; refreshRequestName(getName());
    $('reqControl').checked = !!S.allowControl; $('reqView').checked = !S.allowControl;
    $('reqFiles').checked = !!S.allowFiles; $('reqClip').checked = !!S.allowClip; $('reqTerm').checked = false; $('reqBrowse').checked = false;
    $('reqCard').classList.add('show');
    let left = 30; $('reqCount').textContent = left;
    clearInterval(reqTimer);
    reqTimer = setInterval(() => { left--; $('reqCount').textContent = left; $('reqRing').style.strokeDashoffset = String(113 * (1 - left / 30)); if (left <= 0) answerRequest(null); }, 1000);
    $('reqRing').style.strokeDashoffset = '0';
    setTimeout(() => $('reqAccept').focus(), 100);
  });
}
function refreshRequestName(name) { $('reqName').textContent = name ? `from ${name}` : ''; }
function answerRequest(perms) { const r = reqResolve; reqResolve = null; closeRequest(); if (r) r(perms); }
function closeRequest() { clearInterval(reqTimer); $('reqCard').classList.remove('show'); }
$('reqAccept').onclick = () => answerRequest({ control: $('reqControl').checked, files: $('reqFiles').checked, clip: $('reqClip').checked, terminal: $('reqTerm').checked, browse: $('reqBrowse').checked });
$('reqDecline').onclick = () => answerRequest(null);
$('reqTerm').addEventListener('change', (e) => { if (e.target.checked && !$('reqControl').checked) { $('reqControl').checked = true; } });
$('reqView').addEventListener('change', () => { if ($('reqView').checked) $('reqTerm').checked = false; });

// ================= REMOTE TERMINAL =================
// Host: a shell runs as this user; output streams to the viewer. Viewer: simple console panel.
window.dw.onTermOut((d) => { if (role === 'host' && P.terminal) send({ t: 'term-out', d }); });
function termWrite(d) {
  const out = $('termOut'); const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 8;
  out.textContent += d; if (out.textContent.length > 200000) out.textContent = out.textContent.slice(-150000);
  if (atBottom) out.scrollTop = out.scrollHeight;
}
function toggleTerm(force) {
  const open = $('term').classList.toggle('open', force);
  $('termBtn').classList.toggle('on', open);
  if (open) setTimeout(() => $('termIn').focus(), 150); else if (role === 'viewer') $('stage').focus();
}
const termHist = []; let termHi = 0;
$('termBtn').onclick = () => toggleTerm();
$('termClose').onclick = () => toggleTerm(false);
$('termClear').onclick = () => { $('termOut').textContent = ''; };
$('termIn').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { const v = $('termIn').value; termWrite('> ' + v + '\n'); send({ t: 'term-in', d: v + '\n' }); if (v) termHist.push(v); termHi = termHist.length; $('termIn').value = ''; }
  else if (e.key === 'ArrowUp') { if (termHi > 0) $('termIn').value = termHist[--termHi]; e.preventDefault(); }
  else if (e.key === 'ArrowDown') { termHi = Math.min(termHist.length, termHi + 1); $('termIn').value = termHist[termHi] || ''; e.preventDefault(); }
  else if (e.key === 'Escape') toggleTerm(false);
});

// ================= SYSTEM KEYS IN FULLSCREEN =================
document.addEventListener('fullscreenchange', async () => {
  if (document.fullscreenElement && role === 'viewer' && navigator.keyboard?.lock) {
    try { await navigator.keyboard.lock(); toast('System keys (Alt+Tab, Windows key…) now go to the remote PC · hold Esc to exit fullscreen', 3200); } catch {}
  } else if (!document.fullscreenElement) { try { navigator.keyboard?.unlock(); } catch {} }
});

// ================= WAKE-ON-LAN =================
window.dw.onLanPeers((list) => {
  // remember each nearby desk's network card so it can be woken later
  const all = readDesks(); let changed = false;
  for (const d of list) { const x = all.find(y => y.id === d.id); if (x && d.mac && x.mac !== d.mac) { x.mac = d.mac; changed = true; } }
  if (changed) writeDesks(all);
});
async function wakeDesk(x) {
  const r = await window.dw.wol(x.mac);
  toast(r ? `Wake signal sent to ${x.name || fmt(x.id)}. It may take a minute to come online` : 'Could not send the wake signal', 3000);
}
// ================= VOICE CHAT =================
let micStream = null, voiceCall = null;
function voiceUi() {
  const on = !!micStream;
  for (const id of ['micBtn', 'hostMic']) { const b = $(id); if (b) { b.classList.toggle('on', on); b.title = on ? 'Mute microphone' : 'Talk (microphone)'; } }
  $('hostMicLabel').textContent = on ? 'Mute' : 'Talk';
}
async function startVoice() {
  if (!conn?.open) return;
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch { toast('Microphone not available or blocked', 2400); return; }
  if (voiceCall) { try { voiceCall.close(); } catch {} voiceCall = null; }
  voiceCall = (conn.provider || peer).call(conn.peer, micStream, { metadata: { kind: 'voice' } });
  wireVoice(voiceCall); voiceUi(); toast('Microphone on: your partner can hear you', 1800);
}
function stopVoice(silent) {
  micStream?.getTracks().forEach(t => t.stop()); micStream = null;
  if (voiceCall) { try { voiceCall.close(); } catch {} voiceCall = null; }
  $('voiceAudio').srcObject = null;
  if (!silent) send({ t: 'voice-off' });
  voiceUi();
}
function wireVoice(c) {
  c.on('stream', (s) => { $('voiceAudio').srcObject = s; $('voiceAudio').play().catch(() => {}); });
  c.on('close', () => { if (voiceCall === c) { voiceCall = null; $('voiceAudio').srcObject = null; } });
}
function onVoiceCall(c) {
  if (!role || !conn || c.peer !== conn.peer) { c.close(); return; }
  if (voiceCall && voiceCall !== c) { try { voiceCall.close(); } catch {} }
  voiceCall = c; c.answer(micStream || undefined); wireVoice(c);
  if (!micStream) toast('Your partner turned on their microphone · press Talk to answer', 2600);
}
function onVoiceOff() {
  $('voiceAudio').srcObject = null;
  if (micStream) { const s = micStream; micStream = null; s.getTracks().forEach(t => t.stop()); startVoice(); } // keep my side talking
}
$('micBtn').onclick = () => micStream ? stopVoice() : startVoice();
$('hostMic').onclick = () => micStream ? stopVoice() : startVoice();

// ================= IMAGE CLIPBOARD =================
let lastImgHash = null, ciSending = false; const ciParts = new Map();
// Returns true when the image is dealt with (sent, or too big to send); false when the clipboard
// couldn't be read just now (another app had it open), so the sync loop tries again on its next tick.
async function sendClipImage() {
  const b64 = await window.dw.clipImage(); if (!b64) return false;
  if (b64.length > 12_000_000) return true;
  const id = Date.now(), CH = 48 * 1024, n = Math.ceil(b64.length / CH);
  for (let i = 0; i < n; i++) send({ t: 'ci', id, i, n, d: b64.slice(i * CH, (i + 1) * CH) });
  return true;
}
async function onClipImageChunk(m) {
  let e = ciParts.get(m.id); if (!e) { e = { parts: new Array(m.n), got: 0 }; ciParts.set(m.id, e); }
  if (!e.parts[m.i]) { e.parts[m.i] = m.d; e.got++; }
  if (e.got < m.n) return;
  ciParts.delete(m.id);
  lastImgHash = await window.dw.clipWriteImage(e.parts.join('')); lastClip = '';
  toast('Image copied from your partner', 1600);
}

// ================= SIGNAL + TIMER =================
function updateSignal(rtt, fps) {
  const q = rtt && rtt < 90 && fps >= 20 ? 3 : rtt < 220 && fps >= 10 ? 2 : 1;
  $('signal').dataset.q = q; $('signal').title = ['', 'Weak connection', 'OK connection', 'Excellent connection'][q] + ` · ${Math.round(rtt)} ms`;
}
let sessStart = 0, sessTick = null;
function startSessionTimer() {
  sessStart = Date.now(); clearInterval(sessTick);
  const fmtT = (ms) => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600); return (h ? h + ':' : '') + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  sessTick = setInterval(() => { const v = fmtT(Date.now() - sessStart); $('sessTime').textContent = v; $('hostTime').textContent = v; }, 1000);
}
function stopSessionTimer() { clearInterval(sessTick); $('sessTime').textContent = ''; $('hostTime').textContent = ''; }

// ================= REQUEST CONTROL =================
let ctrlAsk = false;
function askControl() {
  if (ctrlAsk) return; ctrlAsk = true; chime(); window.dw.showWindow();
  $('ctrlReq').classList.add('show');
}
function answerControl(ok) {
  ctrlAsk = false; $('ctrlReq').classList.remove('show');
  if (ok && role === 'host') { P = { ...P, control: true }; sendPerms(); toast('You gave your partner control', 1800); }
  else send({ t: 'chat', text: 'Control request declined.' });
}
$('ctrlAllow').onclick = () => answerControl(true);
$('ctrlDeny').onclick = () => answerControl(false);
// ================= ONE-TIME ACCESS CODE =================
let otpCode = null;
async function rotateCode() {
  if (!S.otp) { otpCode = null; await window.dw.otpClear(); $('otpRow').style.display = 'none'; return; }
  otpCode = await window.dw.otpNew();
  $('otpRow').style.display = ''; $('otpCode').textContent = otpCode;
  $('otpCode').classList.remove('flip'); void $('otpCode').offsetWidth; $('otpCode').classList.add('flip');
}
$('otpRefresh').onclick = () => { rotateCode(); toast('New one-time code', 1400); };
$('otpCode').onclick = () => { if (otpCode) { navigator.clipboard.writeText(otpCode); toast('Code copied', 1400); } };
document.querySelector('[data-set="otp"]').addEventListener('change', () => rotateCode());
rotateCode();

// ================= PAUSE SHARING (host) =================
let hostPaused = false;
$('pauseBtn').onclick = () => {
  if (role !== 'host' || !call) return;
  hostPaused = !hostPaused;
  call.peerConnection.getSenders().forEach(s => { if (s.track?.kind === 'video') s.track.enabled = !hostPaused; });
  window.dw.releaseAll(); if (hostPaused && hostBlock) unblockHost();
  send({ t: 'paused', on: hostPaused });
  $('pauseBtn').classList.toggle('on', hostPaused); $('pauseLabel').textContent = hostPaused ? 'Resume' : 'Pause';
  toast(hostPaused ? 'Sharing paused: your partner sees a paused screen and can’t control' : 'Sharing resumed', 2200);
};
function setPausedView(on) { $('stage').classList.toggle('paused', on); }

// ================= REMOTE FILE BROWSER =================
// Viewer asks, host answers from its disk (only when allowed); downloads reuse the file-transfer channel.
let fsReq = 0; const fsWait = new Map(); let fsCwd = null;
function fsAsk(op, data) { return new Promise((res) => { const rid = ++fsReq; fsWait.set(rid, res); send({ t: 'fs', op, rid, ...data }); setTimeout(() => { if (fsWait.has(rid)) { fsWait.delete(rid); res({ error: 'No answer from the remote PC' }); } }, 15000); }); }
function onFsReply(m) { const f = fsWait.get(m.rid); if (f) { fsWait.delete(m.rid); f(m); } }
async function onFsRequest(m) {
  const reply = (d) => send({ t: 'fs-r', rid: m.rid, ...d });
  if (!P.browse) return reply({ error: 'Browsing is not allowed' });
  if (m.op === 'roots') return reply({ roots: await window.dw.fsRoots() });
  if (m.op === 'list') return reply(await window.dw.fsList(m.path));
  if (m.op === 'mkdir' || m.op === 'rename' || m.op === 'trash') {
    if (!P.files) return reply({ error: 'Your partner hasn’t allowed file changes' });
    const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
    const r = m.op === 'mkdir' ? await window.dw.fsMkdir(m.path, m.name) : m.op === 'rename' ? await window.dw.fsRename(m.path, m.name) : await window.dw.fsTrash(m.path);
    if (r.ok) repEv(m.op === 'mkdir' ? `Created the folder ${r.path}` : m.op === 'rename' ? `Renamed ${m.path} to ${base(r.path)}` : `Moved ${m.path} to the ${/Mac/.test(navigator.userAgent) ? 'Trash' : 'Recycle Bin'}`);
    if (r.ok) toast(m.op === 'mkdir' ? `Your partner created the folder ${base(r.path)}` : m.op === 'rename' ? `Your partner renamed ${base(m.path)} to ${base(r.path)}` : `Your partner moved ${base(m.path)} to the ${/Mac/.test(navigator.userAgent) ? 'Trash' : 'Recycle Bin'}`, 3000);
    return reply(r);
  }
  if (m.op === 'get') {
    const st = await window.dw.fsStat(m.path); if (!st) return reply({ error: 'File not found' });
    if (st.size > 2 * 1024 ** 3) return reply({ error: 'Files over 2 GB are not supported' });
    reply({ ok: true, size: st.size }); repN('filesOut'); repN('bytesOut', st.size); repEv(`Downloaded ${String(m.path).slice(0, 200)} (${fmtSize(st.size)})`);
    const id = crypto.randomUUID(); send({ t: 'file-start', id, name: st.name, size: st.size });
    for (let off = 0; off < st.size || off === 0; ) {
      const r = await window.dw.fsRead(m.path, off, 48 * 1024); if (!r || !r.n) break;
      send({ t: 'file-chunk', id, b64: r.d }); off += r.n;
      const dc = conn?.dataChannel; while (dc && dc.bufferedAmount > 4 * 1024 * 1024) await new Promise(r => setTimeout(r, 20));
      if (!conn?.open || off >= st.size) break;
    }
    send({ t: 'file-end', id });
  }
}
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
async function browseTo(dir) {
  $('fbList').innerHTML = '<div class="fb-msg">Loading…</div>';
  const r = dir ? await fsAsk('list', { path: dir }) : null;
  if (!dir || r?.error) {
    const roots = await fsAsk('roots', {});
    if (r?.error) toast(r.error, 2200);
    fsCwd = null; $('fbPath').textContent = 'This PC'; $('fbUp').disabled = true; fbButtons(); fbAskClose();
    $('fbList').innerHTML = '';
    (roots.roots || []).forEach(x => addFbRow({ name: x.name, dir: true, path: x.path }, true));
    if (roots.error) $('fbList').innerHTML = `<div class="fb-msg">${roots.error}</div>`;
    return;
  }
  fsCwd = r; $('fbPath').textContent = r.path; $('fbUp').disabled = false; fbButtons(); fbAskClose();
  $('fbList').innerHTML = r.entries.length ? '' : '<div class="fb-msg">This folder is empty</div>';
  const sep = r.path.includes('\\') ? '\\' : '/';
  r.entries.forEach(e => addFbRow({ ...e, path: r.path.replace(/[\\/]$/, '') + sep + e.name }));
}
function addFbRow(e, isRoot) {
  const row = document.createElement('button'); row.className = 'fb-row' + (e.dir ? ' dir' : '');
  const acts = isRoot ? '' : '<span class="fb-act" data-a="ren" title="Rename"><svg class="ic"><use href="#i-pen"/></svg></span><span class="fb-act del" data-a="del" title="Move to ${binName()}"><svg class="ic"><use href="#i-trash"/></svg></span>';
  row.innerHTML = `<span class="fb-ic">${e.dir ? (isRoot ? '💽' : '📁') : '📄'}</span><span class="fb-name"></span><span class="fb-meta">${e.dir ? '' : fmtSize(e.size)}</span>${e.dir ? '' : '<span class="fb-dl">Download</span>'}${acts}`;
  row.querySelector('.fb-name').textContent = e.name;
  row.onclick = async (ev) => {
    const a = ev.target.closest('.fb-act')?.dataset.a;
    if (a) {
      ev.stopPropagation();
      if (remotePerms.files === false) return toast('Your partner hasn’t allowed file changes', 2200);
      if (a === 'ren') return fbAskOpen('rename', e);
      if (!confirm(`Move “${e.name}” to the ${binName()} on the remote PC?\n\nIt can be restored from there.`)) return;
      row.classList.add('busy');
      const r = await fsAsk('trash', { path: e.path });
      if (r.error) { row.classList.remove('busy'); return toast(r.error, 2400); }
      toast(`Moved ${e.name} to the ${binName()}`, 2000); return browseTo(fsCwd?.path || null);
    }
    if (e.dir) return browseTo(e.path);
    const r = await fsAsk('get', { path: e.path });
    toast(r.error ? r.error : `Downloading ${e.name} (${fmtSize(r.size)}) to Downloads\\UniDesk…`, 2600);
  };
  $('fbList').appendChild(row);
}
function toggleBrowse(force) {
  const open = $('fb').classList.toggle('open', force);
  $('browseBtn').classList.toggle('on', open);
  if (open && !$('fbList').children.length) browseTo(null);
}
$('browseBtn').onclick = () => toggleBrowse();
$('fbClose').onclick = () => toggleBrowse(false);
$('fbUp').onclick = () => browseTo(fsCwd?.parent || null);
$('fbHome').onclick = () => browseTo(null);

// ================= REMOTE TASK MANAGER =================
// Viewer asks for the host's process list (needs the control permission) and can end a process.
function psAsk(op, data) { return new Promise((res) => { const rid = ++fsReq; fsWait.set(rid, res); send({ t: 'ps', op, rid, ...data }); setTimeout(() => { if (fsWait.has(rid)) { fsWait.delete(rid); res({ error: 'No answer from the remote PC' }); } }, 15000); }); }
async function onPsRequest(m) {
  const reply = (d) => send({ t: 'ps-r', rid: m.rid, ...d });
  if (!P.control || hostPaused) return reply({ error: 'Your partner hasn’t allowed control' });
  if (m.op === 'list') {
    const r = await window.dw.psList();
    if (r.list) r.list = r.list.map(p => ({ ...p, cpuPct: Math.round(p.cpuPct * 10) / 10, title: (p.title || '').slice(0, 80) }));
    return reply(r);
  }
  if (m.op === 'kill') {
    const r = await window.dw.psKill(m.pid);
    if (r.ok) { toast(`Your partner ended ${String(m.name || 'a process').slice(0, 40)}`, 2600); repEv(`Ended the program ${String(m.name || 'unknown').slice(0, 60)} (PID ${m.pid})`); }
    return reply(r);
  }
}
let tmData = null, tmSort = 'mem', tmTimer = null, tmBusy = false;
async function refreshTm() {
  if (tmBusy) return; tmBusy = true;
  const r = await psAsk('list', {}); tmBusy = false;
  if (!$('tm').classList.contains('open')) return;
  if (r.error) { $('tmList').innerHTML = `<div class="fb-msg"></div>`; $('tmList').firstChild.textContent = r.error; return; }
  tmData = r; renderTm();
}
function renderTm() {
  if (!tmData) return;
  const q = $('tmSearch').value.trim().toLowerCase();
  const list = tmData.list.filter(p => !q || p.name.toLowerCase().includes(q) || String(p.pid) === q || p.title.toLowerCase().includes(q));
  const by = { name: (a, b) => a.name.localeCompare(b.name), pid: (a, b) => a.pid - b.pid, cpu: (a, b) => b.cpuPct - a.cpuPct || b.mem - a.mem, mem: (a, b) => b.mem - a.mem }[tmSort];
  list.sort(by);
  const cpu = tmData.list.reduce((s, p) => s + (p.cpuPct || 0), 0), used = tmData.mem.total - tmData.mem.free;
  $('tmCpu').textContent = Math.min(100, cpu).toFixed(0) + '%';
  $('tmMem').textContent = `${fmtSize(used)} / ${fmtSize(tmData.mem.total)}`;
  $('tmMemBar').style.width = (used / tmData.mem.total * 100).toFixed(1) + '%';
  $('tmCount').textContent = tmData.list.length;
  const box = $('tmList'), first = !box.querySelector('.tm-row'); box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="fb-msg">No matching processes</div>'; return; }
  list.slice(0, 300).forEach((p, i) => {
    const row = document.createElement('div'); row.className = 'tm-row' + (p.self ? ' self' : ''); row.dataset.pid = p.pid;
    if (first) row.style.animationDelay = Math.min(i, 20) * 15 + 'ms'; else row.style.animation = 'none';
    row.innerHTML = `<div class="n"><span></span><small></small></div><span class="v">${p.pid}</span><span class="v${p.cpuPct >= 10 ? ' hot' : ''}">${p.cpuPct.toFixed(1)}%</span><span class="v">${fmtSize(p.mem)}</span><button class="k">End</button>`;
    row.querySelector('.n span').textContent = p.name;
    const sm = row.querySelector('.n small'); if (p.title) sm.textContent = p.title; else sm.remove();
    row.querySelector('.k').onclick = async () => {
      if (!confirm(`End ${p.name} (PID ${p.pid}) on the remote PC?\n\nUnsaved work in it will be lost.`)) return;
      row.classList.add('gone');
      const r = await psAsk('kill', { pid: p.pid, name: p.name });
      if (r.error) { row.classList.remove('gone'); toast(r.error, 2600); } else { toast(`Ended ${p.name}`, 1800); setTimeout(refreshTm, 600); }
    };
    box.appendChild(row);
  });
}
function toggleTm(force) {
  const open = $('tm').classList.toggle('open', force);
  $('tmBtn').classList.toggle('on', open);
  clearInterval(tmTimer);
  if (open) { if (!tmData) $('tmList').innerHTML = '<div class="fb-msg">Loading…</div>'; refreshTm(); tmTimer = setInterval(refreshTm, 3000); }
  else tmData = null;
}
$('tmBtn').onclick = () => toggleTm();
$('tmClose').onclick = () => toggleTm(false);
$('tmRefresh').onclick = () => refreshTm();
$('tmSearch').addEventListener('input', renderTm);
$('tmSearch').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') toggleTm(false); });
$('tmHead').querySelectorAll('[data-sort]').forEach(b => b.onclick = () => {
  tmSort = b.dataset.sort; $('tmHead').querySelectorAll('[data-sort]').forEach(x => x.classList.toggle('on', x === b)); renderTm();
});

// ================= REMOTE RESTART & AUTO-RECONNECT =================
let hostRebooting = false, restartWait = null, restartTimer = null, restartBack = 0;
async function onRebootRequest() {
  if (!P.control || hostPaused) return send({ t: 'reboot-r', error: 'Your partner hasn’t allowed control' });
  const ok = await window.dw.reboot();
  if (!ok) return send({ t: 'reboot-r', error: 'The remote PC refused to restart' });
  const unattended = !!(S.unattended && await window.dw.authHas());
  send({ t: 'reboot-r', ok: true, unattended, startup: !!S.startup });
  hostRebooting = true; repEv('Restarted this PC'); repWhy = 'The PC was restarted'; toast('Your partner is restarting this PC…', 5000);
  setTimeout(() => { hostRebooting = false; }, 120e3); // in case the restart was cancelled
  setTimeout(endAll, 800);
}
function onRebootReply(m) {
  if (m.error) return toast(m.error, 2600);
  if (!m.startup) toast('Heads-up: UniDesk isn’t set to start with Windows there, so someone may need to open it', 5000);
  else if (!m.unattended) toast('Unattended access is off there, so someone will need to accept when it’s back', 5000);
  startRestartWait(viewerTarget);
}
function startRestartWait(id) {
  restartWait = { id, since: Date.now(), until: Date.now() + 5 * 60e3, next: Date.now() + 25e3 };
  byeReceived = true; endAll({ quiet: true });
  clearInterval(restartTimer); restartTimer = setInterval(restartTick, 1000); restartTick();
}
function restartTick() {
  const w = restartWait; if (!w) return;
  const now = Date.now();
  if (now > w.until) { stopRestartWait(); overlay('fail', 'Still offline', 'The PC didn’t come back within 5 minutes.'); setTimeout(() => overlay(null), 2600); return; }
  if (role) return; // an attempt is in progress; its own overlay is showing
  const s = Math.round((now - w.since) / 1000);
  overlay('wait', `Restarting <span>${fmt(w.id)}</span>`, `Waiting for the PC to come back · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  if (now >= w.next) { w.next = now + 8000; connect(w.id, true); }
}
function stopRestartWait() { restartWait = null; clearInterval(restartTimer); }

// ================= PRIVACY SCREEN =================
// The visitor blacks out the host's monitors; the host's capture still shows the real desktop.
let hostPrivacy = false, privOn = false;
function setPrivBtn(on) { privOn = on; $('privBtn').classList.toggle('on', on); $('privBtn').title = on ? 'Privacy screen is on: click to show their screen again' : 'Privacy screen: black out the remote monitor'; }
$('privBtn').onclick = () => {
  if (remotePerms.control === false) return toast('Remote control is off', 1600);
  $('privBtn').disabled = true; send({ t: 'privacy', on: !privOn });
  setTimeout(() => { $('privBtn').disabled = false; }, 4000);
};
async function onPrivacyRequest(m) {
  const reply = (d) => send({ t: 'privacy-r', ...d });
  if (m.on && (!P.control || hostPaused)) return reply({ on: false, error: 'Your partner hasn’t allowed control' });
  const r = await window.dw.privacy(!!m.on, 'Your partner');
  const wasPriv = hostPrivacy; hostPrivacy = !!(r.ok && r.on);
  if (hostPrivacy !== wasPriv) repEv(hostPrivacy ? 'Turned on the privacy screen' : 'Turned off the privacy screen');
  reply({ on: hostPrivacy, error: r.ok ? undefined : (r.error || 'The privacy screen isn’t available on that PC') });
}
function onPrivacyReply(m) {
  $('privBtn').disabled = false;
  if (m.error) { setPrivBtn(false); return toast(m.error, 2400); }
  const was = privOn; setPrivBtn(!!m.on);
  if (m.on && !was) toast('Privacy screen on: their monitor is black, you still see it', 2600);
  else if (!m.on && was) toast(m.local ? 'Your partner turned the privacy screen off' : 'Privacy screen off', 2200);
}
window.dw.onPrivacyEnded(() => { if (!hostPrivacy) return; hostPrivacy = false; send({ t: 'privacy-r', on: false, local: true }); toast('Your screen is visible again', 2000); });

// ================= ADDRESS BOOK SEARCH & BACKUP =================
$('deskSearch').addEventListener('input', loadRecents);
$('deskSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; loadRecents(); }
  if (e.key === 'Enter') { const first = $('recents').querySelector('.desk-main'); if (first) first.click(); }
});
function exportDesksData() {
  const desks = readDesks().map(x => ({ id: x.id, name: x.name || '', fav: !!x.fav, last: x.last || 0, ...(x.mac ? { mac: x.mac } : {}), ...(x.note ? { note: x.note } : {}) }));
  return JSON.stringify({ app: 'UniDesk', kind: 'address-book', version: 1, exported: new Date().toISOString(), desks }, null, 2);
}
// Merge an exported address book into this one; returns how many desks were added / updated
function importDesksData(text) {
  let data; try { data = JSON.parse(text); } catch { return { error: 'That file isn’t a UniDesk address book' }; }
  const list = Array.isArray(data) ? data : data?.desks;
  if (!Array.isArray(list)) return { error: 'That file isn’t a UniDesk address book' };
  const all = readDesks(); let added = 0, updated = 0;
  for (const raw of list.slice(0, 2000)) {
    const id = String(raw?.id ?? '').replace(/\D/g, ''); if (id.length !== 9) continue;
    const note = String(raw.note || '').trim().slice(0, 300), name = String(raw.name || '').slice(0, 60), mac = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(raw.mac || '') ? raw.mac : undefined;
    const t = all.find(x => x.id === id);
    if (!t) { all.push({ id, name, fav: !!raw.fav, last: Number(raw.last) || 0, ...(mac ? { mac } : {}), ...(note ? { note } : {}) }); added++; continue; }
    let ch = false;
    if (name && !t.name) { t.name = name; ch = true; }
    if (raw.fav && !t.fav) { t.fav = true; ch = true; }
    if (mac && !t.mac) { t.mac = mac; ch = true; }
    if (note && !t.note) { t.note = note; ch = true; }
    if (ch) updated++;
  }
  writeDesks(all); return { added, updated };
}
$('deskExport').onclick = async () => {
  const n = readDesks().length; if (!n) return toast('Your address book is empty', 1800);
  const r = await window.dw.desksExport(exportDesksData());
  if (r?.error) toast(r.error, 2400); else if (r) { toast(`Exported ${n} desk${n === 1 ? '' : 's'}`, 2000); window.dw.showFile(r); }
};
$('deskImport').onclick = async () => {
  const f = await window.dw.desksImport(); if (!f) return;
  if (f.error) return toast(f.error, 2400);
  const r = importDesksData(f.text);
  toast(r.error || (r.added || r.updated ? `Added ${r.added} desk${r.added === 1 ? '' : 's'}${r.updated ? `, updated ${r.updated}` : ''}` : 'Nothing new: you already have all those desks'), 2600);
};

// ================= TEXT SNIPPETS =================
// Saved texts the visitor can type on the remote PC with one click (stored only on this PC).
const readSn = () => { try { const v = JSON.parse(localStorage.getItem('ud-snippets') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeSn = (v) => { try { localStorage.setItem('ud-snippets', JSON.stringify(v.slice(0, 200))); } catch {} renderSn(); };
// Texts copied on the remote PC during this session (newest first). Kept in memory only, cleared when the session ends.
let clipHist = [];
function addClipHist(text) {
  if (typeof text !== 'string' || !text.trim()) return;
  clipHist = [text, ...clipHist.filter(x => x !== text)].slice(0, 20);
  if ($('sn').classList.contains('open')) renderSn();
}
function renderClipHist(box) {
  if (!clipHist.length) return;
  const h = document.createElement('div'); h.className = 'sn-sec'; h.textContent = 'Copied on their PC'; box.appendChild(h);
  clipHist.forEach((text) => {
    const el = document.createElement('div'); el.className = 'sn-item clip';
    el.innerHTML = '<div class="t"><small></small></div><button class="btn-soft" data-a="copy" title="Put it on your clipboard">Copy</button><button class="btn-soft" data-a="type" title="Type it on their PC">Type</button><button class="btn-soft" data-a="save" title="Keep it as a snippet">Save</button>';
    el.querySelector('small').textContent = text.replace(/\s+/g, ' ').slice(0, 120);
    el.title = text.slice(0, 500);
    el.querySelector('[data-a=copy]').onclick = () => { lastClip = text; window.dw.clipWrite(text); toast('Copied to your clipboard', 1400); };
    el.querySelector('[data-a=type]').onclick = () => typeSnippet({ name: 'copied text', text });
    el.querySelector('[data-a=save]').onclick = () => {
      if (readSn().some(s => s.text === text)) return toast('Already in your snippets', 1400);
      writeSn([{ id: crypto.randomUUID(), name: '', text: text.slice(0, 5000) }, ...readSn()]); toast('Saved as a snippet', 1400);
    };
    box.appendChild(el);
  });
  const s = document.createElement('div'); s.className = 'sn-sec'; s.textContent = 'Your snippets'; box.appendChild(s);
}
function renderSn() {
  const list = readSn(), box = $('snList'); box.innerHTML = '';
  renderClipHist(box);
  if (!list.length) { box.insertAdjacentHTML('beforeend', '<div class="fb-msg">No snippets yet. Save text you type often, like a command or an email address.</div>'); return; }
  list.forEach((s) => {
    const el = document.createElement('div'); el.className = 'sn-item';
    el.innerHTML = '<div class="t"><b></b><small></small></div><button class="btn-soft" data-a="type">Type</button><span class="fb-act del" data-a="del" title="Delete"><svg class="ic"><use href="#i-trash"/></svg></span>';
    el.querySelector('b').textContent = s.name || s.text.split('\n')[0].slice(0, 40);
    el.querySelector('small').textContent = s.text.replace(/\s+/g, ' ').slice(0, 90);
    el.querySelector('[data-a=type]').onclick = () => typeSnippet(s);
    el.querySelector('[data-a=del]').onclick = () => { writeSn(readSn().filter(x => x.id !== s.id)); toast('Snippet deleted', 1400); };
    box.appendChild(el);
  });
}
function typeSnippet(s) {
  if (role !== 'viewer' || !conn) return toast('Connect to a desk first', 1600);
  if (!control || remotePerms.control === false) return toast('Remote control is off', 1600);
  sendInput({ t: 'type', text: s.text.slice(0, 5000) }); toast(`Typing ${s.name || 'snippet'}…`, 1600);
  $('stage').focus();
}
function toggleSn(force) {
  const open = $('sn').classList.toggle('open', force);
  if (open) renderSn();
}
$('snClose').onclick = () => toggleSn(false);
['snName', 'snText', 'piUrlIn'].forEach(id => $(id).addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { if (id === 'piUrlIn') togglePi(false); else toggleSn(false); } if (e.key === 'Enter' && id === 'snText' && (e.ctrlKey || e.metaKey)) $('snAdd').requestSubmit(); }));
$('snAdd').onsubmit = (e) => {
  e.preventDefault();
  const text = $('snText').value; if (!text.trim()) return $('snText').focus();
  writeSn([{ id: crypto.randomUUID(), name: $('snName').value.trim().slice(0, 60), text: text.slice(0, 5000) }, ...readSn()]);
  $('snName').value = ''; $('snText').value = ''; toast('Snippet saved', 1400);
};

// ================= REMOTE PC INFO & OPEN A LINK =================
// Needs the control permission on the host, like the task manager.
function piAsk(op, data) { return new Promise((res) => { const rid = ++fsReq; fsWait.set(rid, res); send({ t: 'pi', op, rid, ...data }); setTimeout(() => { if (fsWait.has(rid)) { fsWait.delete(rid); res({ error: 'No answer from the remote PC' }); } }, 15000); }); }
async function onPiRequest(m) {
  const reply = (d) => send({ t: 'pi-r', rid: m.rid, ...d });
  if (!P.control || hostPaused) return reply({ error: 'Your partner hasn’t allowed control' });
  if (m.op === 'info') return reply({ info: await window.dw.sysinfoFull() });
  if (m.op === 'url') {
    const r = await window.dw.openUrl(m.url);
    if (r.ok) { toast(`Your partner opened ${r.host} in your browser`, 3000); repEv('Opened a link: ' + String(m.url).slice(0, 200)); }
    return reply(r);
  }
}
let piTimer = null, piBusy = false, piFirst = true;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const fmtUp = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), mi = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${mi}m` : `${mi}m`; };
const bar = (pct, hot = pct >= 90) => `<div class="pi-bar${hot ? ' hot' : ''}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;   // red = nearly full (usage) or nearly empty (battery)
async function refreshPi() {
  if (piBusy) return; piBusy = true;
  const r = await piAsk('info', {}); piBusy = false;
  if (!$('pi').classList.contains('open')) return;
  const body = $('piBody');
  if (r.error || !r.info) { body.innerHTML = `<div class="fb-msg">${esc(r.error || 'No info')}</div>`; return; }
  const i = r.info, usedMem = i.mem.total - i.mem.free, memPct = Math.round(usedMem / i.mem.total * 100);
  const cards = [
    `<div class="pi-card wide"><h4>Computer</h4><div class="v">${esc(i.host)}</div><div class="s">${esc(i.os)} · ${esc(i.arch)} · signed in as ${esc(i.user)}</div></div>`,
    `<div class="pi-card"><h4>CPU</h4><div class="v">${i.cpuPct}%</div><div class="s">${esc(i.cpu)} · ${i.cores} cores</div>${bar(i.cpuPct)}</div>`,
    `<div class="pi-card"><h4>Memory</h4><div class="v">${memPct}%</div><div class="s">${fmtSize(usedMem)} of ${fmtSize(i.mem.total)}</div>${bar(memPct)}</div>`,
    `<div class="pi-card"><h4>Up for</h4><div class="v">${fmtUp(i.uptime)}</div><div class="s">since ${new Date(Date.now() - i.uptime * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div></div>`,
    `<div class="pi-card"><h4>Battery</h4><div class="v">${i.battery ? i.battery.pct + '%' : 'None'}</div><div class="s">${i.battery ? (i.battery.charging ? 'Plugged in' : 'On battery') : 'Desktop PC or no battery found'}</div>${i.battery ? bar(i.battery.pct, i.battery.pct <= 15) : ''}</div>`
  ];
  if (i.disks?.length) cards.push(`<div class="pi-card wide"><h4>Disks</h4>${i.disks.map(d => { const pct = Math.round((d.total - d.free) / d.total * 100); return `<div class="pi-row"><span>${esc(d.name)}</span><span>${fmtSize(d.free)} free of ${fmtSize(d.total)}</span></div>${bar(pct)}`; }).join('')}</div>`);
  if (i.nets?.length) cards.push(`<div class="pi-card wide"><h4>Network</h4>${i.nets.map(n => `<div class="pi-row"><span>${esc(n.name)}</span><span class="mono">${esc(n.ip)} · ${esc(n.mac)}</span></div>`).join('')}</div>`);
  cards.push(`<div class="pi-card wide"><h4>Screens & UniDesk</h4>${i.displays.map((d, k) => `<div class="pi-row"><span>Screen ${k + 1}${d.primary ? ' (main)' : ''}</span><span>${d.w} × ${d.h} · ${Math.round(d.scale * 100)}%</span></div>`).join('')}<div class="pi-row"><span>UniDesk</span><span>${esc(i.app)}${i.admin === true ? ' · administrator' : i.admin === false ? ' · not administrator' : ''}</span></div></div>`);
  body.classList.toggle('first', piFirst); piFirst = false;
  body.innerHTML = cards.join('');
}
function togglePi(force) {
  const open = $('pi').classList.toggle('open', force);
  $('piBtn').classList.toggle('on', open);
  clearInterval(piTimer);
  if (open) { if (!$('piBody').children.length || $('piBody').querySelector('.fb-msg')) { piFirst = true; $('piBody').innerHTML = '<div class="fb-msg">Loading…</div>'; } refreshPi(); piTimer = setInterval(refreshPi, 5000); }
}
$('piBtn').onclick = () => togglePi();
$('piClose').onclick = () => togglePi(false);
$('piUrl').onsubmit = async (e) => {
  e.preventDefault();
  let u = $('piUrlIn').value.trim(); if (!u) return;
  if (!/^[a-z][a-z\d+.-]*:/i.test(u)) u = 'https://' + u;
  const btn = $('piUrl').querySelector('button'); btn.disabled = true;
  const r = await piAsk('url', { url: u }); btn.disabled = false;
  if (r.error) return toast(r.error, 2600);
  toast(`Opened ${r.host} on their PC`, 2000); $('piUrlIn').value = '';
};

// ================= RECORD INCOMING SESSIONS (host) =================
// A security record of what visitors did on this PC. The visitor is always told.
let hostRec = null;
async function hostRecStart(who, again) {
  if (hostRec || !stream) return;
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  let rec; try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 }); } catch { return; }
  const id = await window.dw.recInStart(`Incoming ${String(who).replace(/\D/g, '') || 'visitor'} ${stamp()}.webm`);
  const me = { rec, id, who, done: null };
  me.done = new Promise((res) => { rec.onstop = async () => { await new Promise(r => setTimeout(r, 300)); await window.dw.recEnd(id); res(); }; });
  rec.ondataavailable = async (e) => { if (e.data.size) window.dw.recChunk(id, await e.data.arrayBuffer()); };
  rec.start(2000); hostRec = me;
  send({ t: 'rec-on', again: !!again });
  if (!again) toast('Recording this session to Videos\\UniDesk\\Incoming', 2400);
}
async function hostRecStop() {
  const r = hostRec; if (!r) return; hostRec = null;
  try { if (r.rec.state !== 'inactive') r.rec.stop(); else await window.dw.recEnd(r.id); } catch {}
  await r.done;
}
$('recInOpen').onclick = () => window.dw.recInOpen();
setTimeout(() => { if (S.recKeep && S.recKeep !== '0') window.dw.recInPrune(S.recKeep); }, 8000);

// ================= SLEEP / SIGN OUT / SHUT DOWN =================
async function onPowerRequest(m) {
  const reply = (d) => send({ t: 'power-r', what: m.what, ...d });
  if (!P.control || hostPaused) return reply({ error: 'Your partner hasn’t allowed control' });
  if (!['sleep', 'signout', 'shutdown'].includes(m.what)) return;
  const ok = await window.dw.power(m.what);
  if (!ok) return reply({ error: 'The remote PC refused' });
  reply({ ok: true }); repEv({ sleep: 'Put this PC to sleep', signout: 'Signed out the user', shutdown: 'Shut down this PC' }[m.what]); repWhy = 'The PC was put to sleep, signed out or shut down';
  toast({ sleep: 'Your partner is putting this PC to sleep…', signout: 'Your partner is signing you out…', shutdown: 'Your partner is shutting down this PC…' }[m.what], 5000);
  setTimeout(endAll, 800);
}
function onPowerReply(m) {
  if (m.error) return toast(m.error, 2600);
  toast({ sleep: 'The PC is going to sleep. Wake it from your address book with Wake-on-LAN.', signout: 'The user is being signed out', shutdown: 'The PC is shutting down' }[m.what] || 'Done', 4000);
}

// ================= BLOCK THEIR MOUSE & KEYBOARD =================
// The visitor can lock out the host's physical input; the visitor's own input still works.
// Safety: lifted when control is taken away, sharing is paused, the session ends, or the
// visitor goes silent for 15 s. Ctrl+Alt+Del on the host always lifts it (Windows rule).
let hostBlock = false, blockOn = false, lastRx = 0, hbTimer = null, blockWatch = null;
function setBlockBtn(on) {
  blockOn = on; $('blockBtn').classList.toggle('on', on);
  $('blockBtn').title = on ? 'Their mouse & keyboard are blocked: click to give them back' : 'Block their mouse & keyboard';
  clearInterval(hbTimer); if (on) hbTimer = setInterval(() => send({ t: 'hb' }), 4000);
}
$('blockBtn').onclick = () => {
  if (remotePerms.control === false) return toast('Remote control is off', 1600);
  $('blockBtn').disabled = true; send({ t: 'block', on: !blockOn });
  setTimeout(() => { $('blockBtn').disabled = false; }, 4000);
};
function unblockHost(tell = true) {
  hostBlock = false; clearInterval(blockWatch); window.dw.blockInput(false);
  if (tell) send({ t: 'block-r', on: false, auto: true });
}
async function onBlockRequest(m) {
  const reply = (d) => send({ t: 'block-r', ...d });
  if (m.on && (!P.control || hostPaused)) return reply({ on: false, error: 'Your partner hasn’t allowed control' });
  const r = await window.dw.blockInput(!!m.on);
  const wasBlock = hostBlock; hostBlock = !!(r.ok && r.on); clearInterval(blockWatch);
  if (hostBlock !== wasBlock) repEv(hostBlock ? 'Blocked your mouse and keyboard' : 'Gave your mouse and keyboard back');
  if (hostBlock) { lastRx = Date.now(); blockWatch = setInterval(() => { if (hostBlock && Date.now() - lastRx > 15000) { unblockHost(false); toast('Your mouse and keyboard work again', 2400); } }, 2000); }
  reply({ on: hostBlock, error: r.ok ? undefined : r.error });
}
function onBlockReply(m) {
  $('blockBtn').disabled = false;
  if (m.error) { setBlockBtn(false); return toast(m.error, 2600); }
  const was = blockOn; setBlockBtn(!!m.on);
  if (m.on && !was) toast('Their mouse and keyboard are blocked. Pressing Ctrl+Alt+Del there gives them back.', 3200);
  else if (!m.on && was) toast(m.auto ? 'Their mouse and keyboard work again' : 'Unblocked their mouse and keyboard', 2200);
}

// ================= FILE MANAGER ACTIONS (viewer) =================
const binName = () => /mac|darwin/i.test(remoteInfo?.os || '') ? 'Trash' : 'Recycle Bin';
let fbMode = null, fbTarget = null;
function fbButtons() {
  const can = !!fsCwd && remotePerms.files !== false;
  $('fbNew').disabled = $('fbUpload').disabled = !can;
}
function fbAskOpen(mode, entry) {
  fbMode = mode; fbTarget = entry || null;
  $('fbAskOk').textContent = mode === 'rename' ? 'Rename' : 'Create';
  $('fbAskIn').value = mode === 'rename' ? entry.name : 'New folder';
  $('fbAsk').classList.add('show');
  const inp = $('fbAskIn'); inp.focus();
  const dot = mode === 'rename' && !entry.dir ? entry.name.lastIndexOf('.') : -1;
  inp.setSelectionRange(0, dot > 0 ? dot : inp.value.length);
}
function fbAskClose() { fbMode = fbTarget = null; $('fbAsk').classList.remove('show'); }
$('fbAskX').onclick = fbAskClose;
$('fbAskIn').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); fbAskClose(); } });
$('fbAsk').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('fbAskIn').value.trim(); if (!name || !fsCwd) return;
  if (fbMode === 'rename' && name === fbTarget.name) return fbAskClose();
  $('fbAskOk').disabled = true;
  const r = fbMode === 'rename' ? await fsAsk('rename', { path: fbTarget.path, name }) : await fsAsk('mkdir', { path: fsCwd.path, name });
  $('fbAskOk').disabled = false;
  if (r.error) return toast(r.error, 2400);
  toast(fbMode === 'rename' ? `Renamed to ${name}` : `Created ${name}`, 1800);
  fbAskClose(); browseTo(fsCwd.path);
};
$('fbNew').onclick = () => fsCwd && fbAskOpen('mkdir');
async function fbUpload(files) {
  if (!fsCwd || !files.length) return;
  if (remotePerms.files === false) return toast('Your partner hasn’t allowed file transfer', 2200);
  const dir = fsCwd.path; await sendFiles(files, dir);
  setTimeout(() => { if (fsCwd?.path === dir && $('fb').classList.contains('open')) browseTo(dir); }, 900);
}
$('fbUpload').onclick = () => $('fbPick').click();
$('fbPick').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; fbUpload(f); };
{
  let depth = 0; const fb = $('fb');
  fb.addEventListener('dragenter', (e) => { if (!fsCwd || !e.dataTransfer.types.includes('Files')) return; e.preventDefault(); depth++; fb.classList.add('dropping'); });
  fb.addEventListener('dragover', (e) => { if (fsCwd) e.preventDefault(); });
  fb.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; fb.classList.remove('dropping'); } });
  fb.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); depth = 0; fb.classList.remove('dropping'); if (e.dataTransfer.files.length) fbUpload([...e.dataTransfer.files]); });
}