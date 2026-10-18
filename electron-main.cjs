const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('node:path');

const isExternal = (url) => /^https?:\/\//i.test(url);
function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 960, minWidth: 360, minHeight: 620,
    show: false, backgroundColor: '#f8f5ef', title: 'Nuvola Diary',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (url.startsWith('file://') && url !== current) return;
    if (isExternal(url)) { event.preventDefault(); shell.openExternal(url); }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  app.commandLine.appendSwitch('enable-features', 'Vulkan,UseSkiaRenderer');
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
