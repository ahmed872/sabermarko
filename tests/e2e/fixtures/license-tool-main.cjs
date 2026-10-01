// Minimal Electron host for tests/e2e/license-tool.spec.ts: opens the vendor's offline license tool in Chromium
// and saves downloads (the generated private key) into SBM_TOOL_DOWNLOADS without a dialog.
const { app, BrowserWindow, session } = require('electron');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

app.whenReady().then(() => {
  session.defaultSession.on('will-download', (_e, item) => item.setSavePath(join(process.env.SBM_TOOL_DOWNLOADS, item.getFilename())));
  const win = new BrowserWindow({ width: 900, height: 900, show: false });
  void win.loadURL(pathToFileURL(resolve(__dirname, '../../../tools/license/license-tool.html')).href);
});
