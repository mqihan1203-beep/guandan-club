const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const https = require('https');
const { createRoomServer } = require('../server/room-server');
const networkCode = require('../src/shared/network-code');

let mainWindow;
let roomServer = null;
let roomServerMode = null;
let discoverySocket = null;
const DISCOVERY_PORT = 37822;

function getLanAddresses() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const [name, entries] of Object.entries(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal && networkCode.isIPv4(net.address)) result.push({ name, address: net.address });
    }
  }
  return result;
}

function routeLanAddress() {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const finish = value => { try { sock.close(); } catch (_) {} resolve(value || null); };
    const timer = setTimeout(() => finish(null), 900);
    sock.once('error', () => { clearTimeout(timer); finish(null); });
    try {
      sock.connect(53, '8.8.8.8', () => {
        clearTimeout(timer);
        try { finish(sock.address().address); } catch (_) { finish(null); }
      });
    } catch (_) { clearTimeout(timer); finish(null); }
  });
}

function privateScore(ip) {
  if (/^192\.168\./.test(ip)) return 30;
  const m = ip.match(/^172\.(\d+)\./); if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 20;
  if (/^10\./.test(ip)) return 10;
  if (/^169\.254\./.test(ip)) return -20;
  return 0;
}

async function preferredLanAddress() {
  const routed = await routeLanAddress();
  if (routed && networkCode.isIPv4(routed) && routed !== '127.0.0.1') return routed;
  const addresses = getLanAddresses().map(x => x.address);
  if (!addresses.length) throw new Error('没有找到可用的局域网 IPv4 地址，请先连接 Wi-Fi 或网线');
  return addresses.slice().sort((a,b)=>privateScore(b)-privateScore(a))[0];
}

function requestText(url, timeout = 3500) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'GuandanClub/2.3' } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { data += d; if (data.length > 4096) req.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function detectPublicIPv4(manual = '') {
  manual = String(manual || '').trim();
  if (manual) {
    if (!networkCode.isIPv4(manual)) throw new Error('手动填写的公网 IPv4 不正确');
    return manual;
  }
  const endpoints = ['https://4.ipw.cn','https://api.ipify.org','https://checkip.amazonaws.com'];
  for (const url of endpoints) {
    try {
      const text = await requestText(url);
      const m = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
      if (m && networkCode.isIPv4(m[0])) return m[0];
    } catch (_) {}
  }
  throw new Error('无法自动获取公网 IPv4。可展开“高级设置”手动填写；同时确认路由器已把 TCP 端口映射到这台电脑。');
}

async function stopRoomServer() {
  if (!roomServer) return;
  await roomServer.close();
  roomServer = null;
  roomServerMode = null;
}

async function startRoomServer({ mode, port, roomName, roomCode, advertise }) {
  await stopRoomServer();
  roomServer = await createRoomServer({ port, roomName, roomCode, advertise });
  roomServerMode = mode;
  return roomServer;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480, height: 930, minWidth: 1120, minHeight: 720,
    backgroundColor: '#0b1712', title: '掼蛋俱乐部', icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

ipcMain.handle('lan:start', async (_event, options = {}) => {
  const port = Number(options.port) || 37821;
  const roomName = String(options.roomName || '掼蛋房间').slice(0, 24);
  const lanIp = await preferredLanAddress();
  const roomCode = networkCode.encodeLanRoomCode(lanIp, port);
  const server = await startRoomServer({ mode: 'lan', port, roomName, roomCode, advertise: true });
  return { ...server.info(), mode: 'lan', lanIp, roomCode, addresses: getLanAddresses() };
});

ipcMain.handle('public:start', async (_event, options = {}) => {
  const port = Number(options.port) || 37821;
  const roomName = String(options.roomName || '掼蛋房间').slice(0, 24);
  const publicIp = await detectPublicIPv4(options.publicIp);
  const roomCode = networkCode.encodePublicRoomCode(publicIp, port);
  const server = await startRoomServer({ mode: 'public', port, roomName, roomCode, advertise: false });
  return {
    ...server.info(), mode: 'public', publicIp, roomCode,
    note: '房间码已包含公网 IPv4 和端口。若朋友无法加入，请检查 Windows 防火墙与路由器 TCP 端口映射；运营商 CGNAT 网络不能直接作为公网房主。'
  };
});

ipcMain.handle('room:stop', async () => { await stopRoomServer(); return { ok: true }; });
ipcMain.handle('room:info', async () => ({ running: !!roomServer, mode: roomServerMode, server: roomServer ? roomServer.info() : null, addresses: getLanAddresses() }));

ipcMain.handle('lan:discover:start', async () => {
  if (discoverySocket) return { ok: true };
  discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  discoverySocket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString('utf8'));
      if (data && data.type === 'GUANDAN_ROOM') mainWindow?.webContents.send('lan:room', { ...data, host: rinfo.address, lastSeen: Date.now() });
    } catch (_) {}
  });
  await new Promise((resolve, reject) => {
    discoverySocket.once('error', reject);
    discoverySocket.bind(DISCOVERY_PORT, '0.0.0.0', () => { try { discoverySocket.addMembership('239.42.42.42'); } catch (_) {} resolve(); });
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
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (discoverySocket) try { discoverySocket.close(); } catch (_) {}
  if (roomServer) roomServer.close().catch(() => {});
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
