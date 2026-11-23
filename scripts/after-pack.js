// electron-builder afterPack hook (Linux only).
// Newer Ubuntu releases (24.04+) block the unprivileged user namespaces Chromium's sandbox needs, and an
// AppImage can't ship a root-owned chrome-sandbox, so Electron aborts at start. This puts a tiny launcher
// in front of the real binary that adds --no-sandbox only on systems where the sandbox can't work.
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(ctx) {
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
