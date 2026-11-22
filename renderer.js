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
  audio: true, allowControl: true, allowFiles: true, allowClip: true, unattended: false, tray: true, startup: false, lockOnEnd: 'never', idleMins: '0', lan: true };
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
}
function setSetting(k, v) {
  S[k] = v; saveSettings(); applyAll(k === 'theme');
  if (role === 'host' && ['allowControl', 'allowFiles', 'allowClip'].includes(k)) sendPerms();
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

function sendPerms() { send({ t: 'perms', control: !!S.allowControl, files: !!S.allowFiles, clip: !!S.allowClip }); }
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
  if (role || pendingHost) { c.on('open', () => { c.send({ t: 'busy' }); setTimeout(() => c.close(), 300); }); return; }
  pendingHost = c;
  c.on('close', () => { if (pendingHost === c) pendingHost = null; });
  c.on('open', async () => {
    const who = fmt(c.peer.replace(PREFIX, ''));
    let asked = false, settled = false;
    const finish = (ok, how) => {
      if (settled) return; settled = true; c.off('data', pre); pendingHost = null;
      if (ok) acceptHost(c, who, how);
      else { c.send({ t: 'denied' }); setTimeout(() => c.close(), 300); logHistory({ dir: 'in', id: who, how: 'declined' }); }
    };
    const ask = async () => {
      if (asked || settled) return; asked = true;
      chime();
      c.send({ t: 'wait' });
      const ok = await window.dw.confirm(`${who} wants to view and control this computer.\n\nOnly accept if you know and trust this person.`);
      if (c.open) finish(ok, 'approved'); else pendingHost = null;
    };
    const pre = async (m) => {
      if (settled) return;
      if (m.t === 'ask') return ask();
      if (m.t === 'auth-reply') {
        const r = await window.dw.authVerify(c.peer, m.proof);
        if (r.ok) return finish(true, 'unattended');
        if (r.locked) { c.send({ t: 'auth-locked', mins: r.locked }); return; }
        const ch = await window.dw.authChallenge(c.peer); // fresh nonce for the retry
        c.send({ t: 'auth-fail', left: r.left, ...ch });
      }
    };
    c.on('data', pre);
    const unattended = S.unattended && await window.dw.authHas();
    if (!unattended) return ask();
    const ch = await window.dw.authChallenge(c.peer);
    if (ch.locked) c.send({ t: 'auth-locked', mins: ch.locked });
    else c.send({ t: 'auth', ...ch });
  });
}

async function acceptHost(c, who, how) {
    role = 'host'; conn = c; hostHow = how;
    if (IS_MAC) {
      const p = await window.dw.macPerms(true);
      if (!p.screen) { toast('Allow Screen Recording for UniDesk in System Settings, then reconnect', 6000); window.dw.openMacPref('screen'); }
      else if (!p.control) toast('Allow Accessibility for UniDesk so the visitor can control this Mac', 6000);
    }
    if (how === 'unattended') {
      try { new Notification('UniDesk', { body: `${who} connected with unattended access`, silent: false }); } catch {}
    }
    logHistory({ dir: 'in', id: who, how });
    try {
      screens = await window.dw.screens(false);
      curScreen = Math.max(0, screens.findIndex(s => s.primary));
      stream = await capture(screens[curScreen], S.audio);
      call = (c.provider || peer).call(c.peer, stream, { sdpTransform: preferCodecSdp }); // same server the visitor came in on (internet or LAN)
      tune(call.peerConnection, 'balanced');
      wireData(c); startClipSync(); sendScreens(); sendPerms(); startIdleWatch();
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
  stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t); });
  stream.addTrack(track);
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
  conn.on('open', () => { wireData(conn); saveRecent(id); });
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
  overlay('auth', `<span>${fmt(viewerTarget)}</span> is protected`, 'Enter the unattended-access password, or ask the person there to let you in.');
  $('authBox').classList.add('show'); $('authErr').textContent = err || '';
  $('authGo').disabled = !!locked; $('authPw').disabled = !!locked;
  if (err) { $('authBox').classList.remove('shake'); void $('authBox').offsetWidth; $('authBox').classList.add('shake'); }
  if (!locked) setTimeout(() => { $('authPw').focus(); $('authPw').select(); }, 120);
}
async function submitAuth(pw, remember, fromSaved) {
  if (!pw || !authCh?.nonce) return;
  $('authGo').disabled = true; $('authGo').querySelector('span').textContent = 'Checking…';
  const proof = await window.dw.authProof(pw, authCh.salt, authCh.nonce, authCh.iter);
  pendingPw = { pw, remember, fromSaved };
  send({ t: 'auth-reply', proof });
}
$('authGo').onclick = () => submitAuth($('authPw').value, $('authRemember').checked, false);
$('authPw').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('authGo').click(); });
$('authAsk').onclick = () => { send({ t: 'ask' }); $('authBox').classList.remove('show'); overlay('wait', `Calling <span>${fmt(viewerTarget)}</span>`, 'Waiting for your partner to accept…'); };
$('authEye').onclick = () => { const p = $('authPw'); p.type = p.type === 'password' ? 'text' : 'password'; $('authEye').classList.toggle('on', p.type === 'text'); };

function failConnect(title, sub) {
  clearTimeout(connectTimer);
  if (role === 'viewer' && !call) { try { conn?.close(); } catch {} conn = null; role = null; }
  overlay('fail', title, sub);
  setTimeout(() => overlay(null), 2000);
}

function onIncomingCall(c) {
  if (role !== 'viewer' || !conn || c.peer !== conn.peer) { c.close(); return; }
  call = c; clearTimeout(connectTimer);
  c.answer(undefined, { sdpTransform: preferCodecSdp });
  c.on('stream', (s) => {
    const v = $('video'); v.srcObject = s; v.muted = false;
    overlay('ok', reconnectTries ? 'Reconnected' : 'Connected', 'Starting session…');
    inSession = true; reconnectTries = 0;
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
  c.on('data', (m) => {
    if (role === 'host' && m.t !== 'thumbs') lastActivity = Date.now();
    switch (m.t) {
      case 'bye': byeReceived = true; break;
      case 'draw': if (role === 'host') window.dw.draw(m); break;
      case 'info':
        if (role !== 'viewer') break;
        remoteInfo = m;
        $('deskInfo').textContent = `${m.host} · ${m.os} · ${m.ram} RAM · ${m.cores} cores`;
        $('sessWho').textContent = `${m.host} · ${fmt(viewerTarget)}`;
        nameDeskIfUnnamed(viewerTarget, m.host); break;
      case 'denied': failConnect('Declined', 'Your partner declined the request.'); break;
      case 'busy': failConnect('Busy', 'That desk is already in a session.'); break;
      case 'wait': if (role === 'viewer' && !call) { $('authBox').classList.remove('show'); overlay('wait', `Calling <span>${fmt(viewerTarget)}</span>`, 'Waiting for your partner to accept…'); } break;
      case 'auth': if (role === 'viewer') onAuth(m); break;
      case 'auth-fail':
        if (role !== 'viewer') break;
        authCh = m; $('authGo').querySelector('span').textContent = 'Unlock';
        if (pendingPw?.fromSaved) { window.dw.pwForget(viewerTarget); showAuth('Your saved password no longer works.'); }
        else showAuth(`Wrong password · ${m.left} ${m.left === 1 ? 'try' : 'tries'} left`);
        pendingPw = null; break;
      case 'auth-locked':
        if (role !== 'viewer') break;
        $('authGo').querySelector('span').textContent = 'Unlock'; pendingPw = null;
        showAuth(`Too many wrong attempts. Unattended access is locked for ${m.mins} min. You can still ask for permission.`, true); break;
      case 'screens': remoteScreens = m.list; curScreen = m.cur; renderScreens(); break;
      case 'screen': curScreen = m.i; renderScreens(); setTimeout(() => $('video').classList.remove('switching'), 250); toast(`Now viewing Screen ${m.i + 1}`, 1600); break;
      case 'thumbs': if (role === 'host') sendScreens(); break;
      case 'clip': if (role === 'host' && !S.allowClip) break; lastClip = m.text; window.dw.clipWrite(m.text); break;
      case 'chat': addChat(m.text, false); break;
      case 'perms': {
        const was = remotePerms; remotePerms = m;
        if (!m.control && was.control !== false) toast('Partner allows view only', 2600);
        if (m.control && was.control === false) toast('Partner enabled remote control', 2200);
        $('ctrlBtn').disabled = !m.control; $('ctrlBtn').style.opacity = m.control ? '' : '.4';
        $('fileBtn').disabled = !m.files; $('fileBtn').style.opacity = m.files ? '' : '.4';
        break;
      }
      case 'monitor': if (role === 'host') switchMonitor(m.i); break;
      case 'quality': if (role === 'host') tune(call.peerConnection, m.q); break;
      case 'file-start': if (role === 'host' && !S.allowFiles) break; window.dw.fileStart(m); toast(`Receiving ${m.name}…`); break;
      case 'file-chunk': if (role === 'host' && !S.allowFiles) break; window.dw.fileChunk(m); break;
      case 'file-end': if (role === 'host' && !S.allowFiles) break; window.dw.fileEnd(m); break;
      default: if (role === 'host' && S.allowControl) window.dw.input(m);
    }
  });
}
const send = (m) => conn?.open && conn.send(m);
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
  window.dw.clipRead().then(t => (lastClip = t));
  clipTimer = setInterval(async () => {
    if (role === 'host' ? !S.allowClip : (!$('clipSync').checked || remotePerms.clip === false)) return;
    const t = await window.dw.clipRead();
    if (t && t !== lastClip && t.length < 1_000_000) { lastClip = t; send({ t: 'clip', text: t }); }
  }, 600);
}

// ---- files ----
window.dw.onFileSaved((p) => { toast('Saved: ' + p.split(/[\\/]/).pop(), 4500); window.dw.showFile(p); });
async function sendFiles(list) {
  const bar = $('progressBar'); $('progress').classList.add('show');
  for (const f of list) {
    const id = crypto.randomUUID(), CH = 48 * 1024;
    send({ t: 'file-start', id, name: f.name, size: f.size });
    const buf = new Uint8Array(await f.arrayBuffer());
    for (let o = 0; o < buf.length; o += CH) {
      let bin = ''; const part = buf.subarray(o, o + CH);
      for (let i = 0; i < part.length; i += 8192) bin += String.fromCharCode.apply(null, part.subarray(i, i + 8192));
      send({ t: 'file-chunk', id, b64: btoa(bin) });
      const dc = conn?.dataChannel; while (dc && dc.bufferedAmount > 4 * 1024 * 1024) await new Promise(r => setTimeout(r, 20));
      bar.style.width = ((o + part.length) / buf.length * 100) + '%';
    }
    send({ t: 'file-end', id }); toast(`Sent ${f.name}`);
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
function sendChat() { const v = $('chatInput').value.trim(); if (!v) return; send({ t: 'chat', text: v }); addChat(v, true); $('chatInput').value = ''; }
$('chatBtn').onclick = () => toggleChat(); $('hostChat').onclick = () => toggleChat(); $('chatClose').onclick = () => toggleChat(false);
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') sendChat(); if (e.key === 'Escape') toggleChat(false); });

// ---- reconnect / idle / lock ----
let inSession = false, byeReceived = false, reconnectTries = 0, hostHow = null, lastActivity = 0, idleTimer = null;
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
function startIdleWatch() {
  clearInterval(idleTimer); lastActivity = Date.now();
  idleTimer = setInterval(() => {
    const mins = +S.idleMins || 0;
    if (role === 'host' && mins > 0 && Date.now() - lastActivity > mins * 60e3) {
      send({ t: 'chat', text: `Session ended after ${mins} min of inactivity.` });
      toast(`Session ended: idle for ${mins} min`, 4000); endAll();
    }
  }, 15000);
}

function endAll(opts = {}) {
  const wasHost = role === 'host', how = hostHow;
  send({ t: 'bye' });
  clearInterval(idleTimer); hostHow = null;
  if (wasHost) window.dw.drawClose();
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
  const v = $('video'), r = v.getBoundingClientRect();
  const vw = v.videoWidth || r.width, vh = v.videoHeight || r.height, sc = Math.min(r.width / vw, r.height / vh);
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
$('cancelBtn').onclick = () => { clearTimeout(connectTimer); try { conn?.close(); } catch {} conn = null; role = null; overlay(null); };
$('endBtn').onclick = () => endAll(); $('stopHost').onclick = () => endAll();
$('fullBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
document.addEventListener('fullscreenchange', () => { document.body.classList.toggle('fs', !!document.fullscreenElement); revealToolbar(); });
$('ctrlBtn').onclick = () => {
  control = !control;
  $('ctrlBtn').innerHTML = control ? '<svg class="ic"><use href="#i-mouse"/></svg><span>Control</span>' : '<svg class="ic"><use href="#i-eye"/></svg><span>View only</span>';
  $('ctrlBtn').classList.toggle('on', !control); toast(control ? 'Remote control enabled' : 'View-only mode', 1600);
};
$('fileBtn').onclick = () => $('filePick').click();
$('filePick').onchange = (e) => { if (e.target.files.length) sendFiles(e.target.files); e.target.value = ''; };
$('clipSync').onchange = (e) => toast(e.target.checked ? 'Clipboard sync on' : 'Clipboard sync off', 1500);
$('combo').onchange = async (e) => {
  const v = e.target.value; e.target.value = '';
  if (v === 'typeclip') {
    const text = await window.dw.clipRead();
    if (!text) toast('Your clipboard is empty', 1600);
    else if (!control || remotePerms.control === false) toast('Remote control is off', 1600);
    else { sendInput({ t: 'type', text: text.slice(0, 5000) }); toast(`Typing ${Math.min(text.length, 5000)} characters…`, 1600); }
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
  const d = readDesks().sort((a, b) => (b.fav - a.fav) || (b.last - a.last));
  const box = $('recents'); box.innerHTML = '';
  $('recentsTitle').textContent = d.some(x => x.fav) ? 'Desks' : 'Recent';
  if (!d.length) { box.innerHTML = '<span class="empty">No saved desks yet</span>'; return; }
  d.slice(0, 8).forEach((x, i) => {
    const el = document.createElement('div'); el.className = 'desk' + (x.fav ? ' fav' : ''); el.style.animationDelay = i * 40 + 'ms';
    el.innerHTML = `<button class="desk-main" title="Connect"><span class="desk-av">${(x.name || '#')[0].toUpperCase()}</span>
        <span class="desk-txt"><b></b><small class="mono">${fmt(x.id)}</small></span></button>
      <div class="desk-acts">
        <button class="mini star" title="${x.fav ? 'Unpin' : 'Pin to top'}">${x.fav ? '★' : '☆'}</button>
        <button class="mini" title="Rename">✎</button>
        <button class="mini" title="Remove">✕</button>
      </div>`;
    el.querySelector('b').textContent = x.name || 'Unnamed desk';
    el.querySelector('.desk-main').onclick = () => connect(x.id);
    const [star, ren, del] = el.querySelectorAll('.mini');
    star.onclick = () => { const all = readDesks(); const t = all.find(y => y.id === x.id); t.fav = !t.fav; writeDesks(all); };
    ren.onclick = () => openNameDialog(x.id, x.name);
    del.onclick = () => { writeDesks(readDesks().filter(y => y.id !== x.id)); window.dw.pwForget(x.id); toast('Desk removed', 1400); };
    box.appendChild(el);
  });
}
function saveRecent(id) {
  const all = readDesks(); const t = all.find(x => x.id === id);
  if (t) t.last = Date.now(); else all.push({ id, name: '', fav: false, last: Date.now() });
  const keep = all.sort((a, b) => (b.fav - a.fav) || (b.last - a.last)).filter((x, i) => x.fav || i < 12);
  writeDesks(keep);
}
function nameDeskIfUnnamed(id, name) {
  const all = readDesks(); const t = all.find(x => x.id === id);
  if (t && !t.name && name) { t.name = String(name).slice(0, 40); writeDesks(all); }
}
let renaming = null;
function openNameDialog(id, name) {
  renaming = id; $('nameInput').value = name || ''; $('nameDialog').classList.add('show');
  setTimeout(() => { $('nameInput').focus(); $('nameInput').select(); }, 120);
}
function closeNameDialog() { $('nameDialog').classList.remove('show'); renaming = null; }
$('nameCancel').onclick = closeNameDialog;
$('nameSave').onclick = () => {
  const all = readDesks(); const t = all.find(x => x.id === renaming);
  if (t) { t.name = $('nameInput').value.trim().slice(0, 40); writeDesks(all); }
  closeNameDialog();
};
$('nameInput').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('nameSave').click(); if (e.key === 'Escape') closeNameDialog(); });

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
    $('stats').textContent = `${codec} · ${w}×${h} · ${Math.round(fps)} fps · ${(kbps / 1000).toFixed(1)} Mbps · ${Math.round(rtt)} ms · ${viaLan ? 'LAN' : path}`;
  }, 1000);
}

// ================= SESSION HISTORY =================
let currentLog = null;
function readHistory() { try { return JSON.parse(localStorage.getItem('ud-history') || '[]'); } catch { return []; } }
function logHistory(entry) {
  const h = readHistory(); const e = { ...entry, start: Date.now(), end: null };
  if (entry.how !== 'declined') currentLog = e.start; else e.end = e.start;
  h.unshift(e); try { localStorage.setItem('ud-history', JSON.stringify(h.slice(0, 50))); } catch {}
  renderHistory();
}
function closeHistory() {
  if (!currentLog) return;
  const h = readHistory(); const e = h.find(x => x.start === currentLog); if (e) e.end = Date.now();
  try { localStorage.setItem('ud-history', JSON.stringify(h)); } catch {} currentLog = null; renderHistory();
}
function dur(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`; }
function renderHistory() {
  const box = $('historyList'); if (!box) return;
  const h = readHistory().slice(0, 20); box.innerHTML = '';
  if (!h.length) { box.innerHTML = '<div class="row"><div class="txt"><span>No sessions yet.</span></div></div>'; return; }
  const labels = { approved: 'Approved', unattended: 'Unattended', declined: 'Declined' };
  h.forEach(e => {
    const r = document.createElement('div'); r.className = 'row hist';
    const when = new Date(e.start).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    r.innerHTML = `<span class="hdir ${e.dir}">${e.dir === 'in' ? '↘' : '↗'}</span>
      <div class="txt"><b class="mono">${e.id}</b><span>${e.dir === 'in' ? 'Connected to you' : 'You connected'} · ${when}${e.end && e.how !== 'declined' ? ' · ' + dur(e.end - e.start) : ''}</span></div>
      <span class="htag ${e.how}">${labels[e.how] || e.how}</span>`;
    box.appendChild(r);
  });
}
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
  $('adminState').textContent = s.admin ? 'Yes: visitors can control admin apps and Task Manager' : 'No: admin windows and UAC prompts can’t be controlled';
  $('adminBtn').style.display = s.admin ? 'none' : '';
  $('uacState').textContent = s.uacOnNormalDesktop ? 'On: UAC prompts appear where visitors can see and click them' : 'Off: UAC prompts appear on the secure desktop (visitors see a frozen screen)';
  $('uacBtn').textContent = s.uacOnNormalDesktop ? 'Turn off' : 'Turn on';
  $('uacBtn').onclick = async () => {
    const r = await window.dw.uacNormalDesktop(!s.uacOnNormalDesktop);
    toast(r.ok ? 'Updated' : 'Cancelled: Windows needs your approval for this', 2200); refreshAdminUi();
  };
}
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