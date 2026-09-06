const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const { createRoomServer } = require('../server/room-server');

let mainWindow;
let roomServer = null;
let discoverySocket = null;
const DISCOVERY_PORT = 37822;

function getLanAddresses() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const [name, entries] of Object.entries(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) {
        result.push({ name, address: net.address });
      }
    }
  }
  return result;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 930,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0b1712',
    title: '掼蛋俱乐部',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

ipcMain.handle('lan:start', async (_event, options = {}) => {
  if (roomServer) {
    return roomServer.info();
  }
  const port = Number(options.port) || 37821;
  const roomName = String(options.roomName || '掼蛋房间').slice(0, 24);
  roomServer = await createRoomServer({ port, roomName, advertise: true });
  return { ...roomServer.info(), addresses: getLanAddresses() };
});

ipcMain.handle('lan:stop', async () => {
  if (!roomServer) return { ok: true };
  await roomServer.close();
  roomServer = null;
  return { ok: true };
});

ipcMain.handle('lan:info', async () => ({
  running: !!roomServer,
  server: roomServer ? roomServer.info() : null,
  addresses: getLanAddresses()
}));

ipcMain.handle('lan:discover:start', async () => {
  if (discoverySocket) return { ok: true };
  discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  discoverySocket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString('utf8'));
      if (data && data.type === 'GUANDAN_ROOM') {
        mainWindow?.webContents.send('lan:room', {
          ...data,
          host: rinfo.address,
          lastSeen: Date.now()
        });
      }
    } catch (_) {}
  });
  await new Promise((resolve, reject) => {
    discoverySocket.once('error', reject);
    discoverySocket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
      try { discoverySocket.addMembership('239.42.42.42'); } catch (_) {}
      resolve();
    });
  });
  return { ok: true };
});

ipcMain.handle('lan:discover:stop', async () => {
  if (!discoverySocket) return { ok: true };
  try { discoverySocket.close(); } catch (_) {}
  discoverySocket = null;
  return { ok: true };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  if (discoverySocket) try { discoverySocket.close(); } catch (_) {}
  if (roomServer) roomServer.close().catch(() => {});
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
