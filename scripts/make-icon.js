// Renders assets/logo.svg to PNG icons using Electron itself (no extra deps).
// Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo.svg'), 'utf8');
  const out = [['build/icon.png', 1024]];
  for (const [file, size] of out) {
    const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, useContentSize: true,
      webPreferences: { offscreen: true } });
    const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(r => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    const target = path.join(__dirname, '..', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, img.resize({ width: size, height: size }).toPNG());
    console.log('wrote', file);
    win.destroy();
  }
  app.quit();
});
