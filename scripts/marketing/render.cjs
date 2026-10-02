// Renders scripts/marketing/posts.html to PNG images in docs/marketing/sa/ (one image per post).
// Run: npx electron scripts/marketing/render.cjs   (xvfb-run on a headless Linux box)
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const OUT = join(__dirname, '../../docs/marketing/sa');
const POSTS = [['hero', 1080], ['pack', 1080], ['expiry', 1080], ['profit', 1080], ['features', 1080], ['offer', 1080], ['trial', 1080], ['story', 1920]];
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => { /* keep running between posts */ });
app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  let n = 0;
  for (const [id, h] of POSTS) {
    const win = new BrowserWindow({ show: false, width: 1080, height: h, useContentSize: true, webPreferences: { offscreen: true } });
    await win.loadFile(join(__dirname, 'posts.html'), { hash: id });
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))))');
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1080, height: h });
    writeFileSync(join(OUT, `${String(++n).padStart(2, '0')}-${id}.png`), img.toPNG());
    win.destroy();
  }
  console.log(`rendered ${n} images`);
  app.quit();
});
