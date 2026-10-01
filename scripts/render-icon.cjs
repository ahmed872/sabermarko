// Renders build/icon.svg to build/icon.png (512x512) using Electron's renderer.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, '../build/icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  writeFileSync(join(__dirname, '../build/icon.png'), img.resize({ width: 512, height: 512 }).toPNG());
  app.quit();
});
