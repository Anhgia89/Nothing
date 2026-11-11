const { app, BrowserWindow } = require('electron');
const path = require('node:path');

let localServer;
let startServer;

async function createWindow() {
  localServer = await startServer({ host: '127.0.0.1', port: 0 });
  const address = localServer.address();
  const win = new BrowserWindow({
    width: 1160,
    height: 860,
    minWidth: 360,
    minHeight: 560,
    title: 'TruyenTruyenTV',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadURL(`http://127.0.0.1:${address.port}`);
}

app.whenReady().then(async () => {
  process.env.DATA_DIR ||= path.join(app.getPath('userData'), 'data');
  ({ startServer } = require('./server'));
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => console.error('Không thể mở TruyenTruyenTV:', error));
    }
  });
}).catch((error) => {
  console.error('Không thể khởi động TruyenTruyenTV:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  localServer?.close();
});