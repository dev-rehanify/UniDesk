// electron-builder afterPack hook.
// 1. Every platform: delete native binaries that are only for other systems, so downloads stay small.
//    nut.js loads just the libnut build for the running system, and koffi is only used on Windows.
// 2. Linux: newer Ubuntu releases (24.04+) block the unprivileged user namespaces Chromium's sandbox needs, and an
//    AppImage can't ship a root-owned chrome-sandbox, so Electron aborts at start. This puts a tiny launcher
//    in front of the real binary that adds --no-sandbox only on systems where the sandbox can't work.
const fs = require('fs');
const path = require('path');

function prune(ctx) {
  const plat = ctx.electronPlatformName;                  // win32 | darwin | linux
  const res = plat === 'darwin'
    ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(ctx.appOutDir, 'resources');
  const nm = path.join(res, 'app.asar.unpacked', 'node_modules');
  if (!fs.existsSync(nm)) throw new Error('afterPack: unpacked modules not found at ' + nm);
  const gone = [];
  const rm = (p) => { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); gone.push(path.relative(nm, p)); } };
  // libnut: keep only this system's build (it may sit at the top level or nested under libnut)
  for (const base of [path.join(nm, '@nut-tree-fork'), path.join(nm, '@nut-tree-fork', 'libnut', 'node_modules', '@nut-tree-fork')]) {
    for (const p of ['win32', 'darwin', 'linux']) if (p !== plat) rm(path.join(base, 'libnut-' + p));
  }
  // koffi: only Windows uses it (user32.dll calls); elsewhere drop it, on Windows drop the other systems' builds
  const koffi = path.join(nm, 'koffi', 'build', 'koffi');
  if (plat !== 'win32') rm(path.join(nm, 'koffi'));
  else if (fs.existsSync(koffi)) for (const d of fs.readdirSync(koffi)) if (d !== 'win32_x64') rm(path.join(koffi, d));
  // clipboardy helper programs: Windows needs the .exe files, Linux may need xsel, macOS needs neither
  const fb = path.join(nm, 'clipboardy', 'fallbacks');
  if (plat !== 'win32') rm(path.join(fb, 'windows'));
  if (plat !== 'linux') rm(path.join(fb, 'linux'));
  console.log('  • afterPack removed (not for ' + plat + '): ' + (gone.join(', ') || 'nothing'));
}

exports.default = async function afterPack(ctx) {
  prune(ctx);
  if (ctx.electronPlatformName !== 'linux') return;
  const name = ctx.packager.executableName;               // "unidesk"
  const bin = path.join(ctx.appOutDir, name);
  const real = path.join(ctx.appOutDir, name + '.bin');
  if (!fs.existsSync(bin)) throw new Error('afterPack: executable not found at ' + bin);
  fs.renameSync(bin, real);
  fs.writeFileSync(bin, `#!/bin/bash
# UniDesk launcher: start without Chromium's sandbox only where the system blocks it.
HERE="$(dirname "$(readlink -f "$0")")"
NOSANDBOX=0
if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = "1" ]; then NOSANDBOX=1; fi
if [ -r /proc/sys/kernel/unprivileged_userns_clone ] && [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = "0" ]; then NOSANDBOX=1; fi
if [ "$NOSANDBOX" = "1" ]; then exec "$HERE/${name}.bin" --no-sandbox "$@"; fi
exec "$HERE/${name}.bin" "$@"
`, { mode: 0o755 });
};
