// Prints docs/user-guide/guide.html to docs/user-guide/SaberMarko-User-Guide.pdf with Electron's Chromium
// (full Arabic shaping and RTL). Run: npx electron scripts/guide/build-pdf.cjs  (xvfb-run on a headless Linux box)
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const dir = join(__dirname, '../../docs/user-guide');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 1600 });
  await win.loadFile(join(dir, 'guide.html'));
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))))');
  const pdf = await win.webContents.printToPDF({
    pageSize: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: '<div style="width:100%;font-size:8px;color:#7a8594;padding:0 15mm;display:flex;justify-content:space-between;direction:rtl"><span>دليل الاستخدام — سابر ماركو 1.1.1</span><span>صفحة <span class="pageNumber"></span> من <span class="totalPages"></span></span></div>',
  });
  writeFileSync(join(dir, 'SaberMarko-User-Guide.pdf'), pdf);
  console.log(`PDF written: ${(pdf.length / 1024 / 1024).toFixed(1)} MB`);
  app.quit();
});
