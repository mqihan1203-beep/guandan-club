const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const https = require('https');
const net = require('net');
const NodeWebSocket = require('ws');
const { createRoomServer } = require('../server/room-server');
const networkCode = require('../src/shared/network-code');

let mainWindow;
let roomServer = null;
let roomServerMode = null;
let discoverySocket = null;
let upnpClient = null;
let upnpMappedPort = null;
const DISCOVERY_PORT = 37822;

function isPrivateIPv4(ip) {
  if (!networkCode.isIPv4(ip)) return false;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  return false;
}

function isVirtualInterface(name='') {
  return /(vmware|virtualbox|vethernet|hyper-v|wsl|tailscale|zerotier|hamachi|tap|tun|wintun|vpn|loopback)/i.test(name);
}

function getLanAddresses() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const [name, entries] of Object.entries(nets)) {
    for (const x of entries || []) {
      if (x.family === 'IPv4' && !x.internal && networkCode.isIPv4(x.address)) {
        result.push({ name, address: x.address, netmask: x.netmask || '', cidr: x.cidr || '', virtual: isVirtualInterface(name) });
      }
    }
  }
  return result;
}

function routeLanAddress() {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = value => { if (done) return; done = true; try { sock.close(); } catch (_) {} resolve(value || null); };
    const timer = setTimeout(() => finish(null), 700);
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
  if (/^192\.168\./.test(ip)) return 40;
  const m = ip.match(/^172\.(\d+)\./); if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 30;
  if (/^10\./.test(ip)) return 20;
  if (/^169\.254\./.test(ip)) return -50;
  return 0;
}

function interfaceScore(item, routed) {
  let score = privateScore(item.address);
  if (item.virtual) score -= 180;
  if (/(wi-?fi|wlan|无线|ethernet|以太网|本地连接)/i.test(item.name)) score += 80;
  if (routed && item.address === routed) score += item.virtual ? 5 : 55;
  if (/^192\.168\.137\./.test(item.address) && item.address !== routed) score -= 35;
  return score;
}

async function preferredLanAddress() {
  const items = getLanAddresses();
  if (!items.length) throw new Error('没有找到可用的局域网 IPv4 地址，请先连接 Wi-Fi 或网线');
  const routed = await routeLanAddress();
  items.sort((a,b)=>interfaceScore(b,routed)-interfaceScore(a,routed));
  return items[0].address;
}

function requestText(url, timeout = 3500) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'GuandanClub/2.3.1' } }, res => {
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
  throw new Error('无法自动获取公网 IPv4。可展开“高级设置”手动填写。');
}

function upnpCall(client, method, arg) {
  return new Promise((resolve, reject) => {
    const cb = (err, value) => err ? reject(err) : resolve(value);
    try {
      if (arg === undefined) client[method](cb);
      else client[method](arg, cb);
    } catch (e) { reject(e); }
  });
}

async function clearUpnpMapping() {
  if (!upnpClient) return;
  try { if (upnpMappedPort) await upnpCall(upnpClient, 'portUnmapping', { public: upnpMappedPort, protocol: 'TCP' }); } catch (_) {}
  try { if (typeof upnpClient.close === 'function') upnpClient.close(); } catch (_) {}
  upnpClient = null; upnpMappedPort = null;
}

async function tryUpnpMapping(port) {
  await clearUpnpMapping();
  try {
    const { createClient } = require('nat-upnp-2');
    const client = createClient({ timeout: 4500 });
    await upnpCall(client, 'portMapping', {
      public: port,
      private: port,
      protocol: 'TCP',
      ttl: 0,
      description: 'Guandan Club'
    });
    let externalIp = null;
    try { externalIp = await upnpCall(client, 'externalIp'); } catch (_) {}
    upnpClient = client; upnpMappedPort = port;
    return { ok: true, externalIp: networkCode.isIPv4(externalIp) ? externalIp : null };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function tcpOpen(ip, port, timeout=180) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = ok => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} resolve(ok); };
    sock.setTimeout(timeout);
    sock.once('connect', ()=>finish(true));
    sock.once('timeout', ()=>finish(false));
    sock.once('error', ()=>finish(false));
    try { sock.connect(port, ip); } catch (_) { finish(false); }
  });
}

function probeRoom(url, expectedCode, timeout=700) {
  return new Promise(resolve => {
    let ws, done=false;
    const finish = ok => { if (done) return; done=true; clearTimeout(timer); try { ws?.terminate?.(); } catch (_) {} resolve(ok); };
    const timer=setTimeout(()=>finish(false),timeout);
    try { ws = new NodeWebSocket(url, { handshakeTimeout: timeout }); } catch (_) { return finish(false); }
    ws.on('message', raw => {
      try {
        const msg=JSON.parse(raw.toString());
        if (msg.type==='hello' && networkCode.normalizeRoomCode(msg.roomCode)===networkCode.normalizeRoomCode(expectedCode)) finish(true);
      } catch (_) {}
    });
    ws.on('error',()=>finish(false));
    ws.on('close',()=>finish(false));
  });
}

async function resolveLanRoom(roomCode) {
  const decoded = networkCode.decodeLanRoomCode(roomCode);
  const expected = decoded.roomCode;
  if (await probeRoom(decoded.url, expected, 700)) return { ok:true, url:decoded.url, ip:decoded.ip, port:decoded.port, method:'room-code' };
  const prefixes=[];
  for (const item of getLanAddresses().filter(x=>isPrivateIPv4(x.address)&&!x.virtual)) {
    const p=item.address.split('.');
    const prefix=p.slice(0,3).join('.');
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  for (const item of getLanAddresses().filter(x=>isPrivateIPv4(x.address)&&x.virtual)) {
    const p=item.address.split('.');
    const prefix=p.slice(0,3).join('.');
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  for (const prefix of prefixes.slice(0,4)) {
    const ips=Array.from({length:254},(_,i)=>`${prefix}.${i+1}`);
    for (let start=0; start<ips.length; start+=48) {
      const batch=ips.slice(start,start+48);
      const opened=(await Promise.all(batch.map(async ip=>({ip,open:await tcpOpen(ip,decoded.port,160)})))).filter(x=>x.open);
      for (const x of opened) {
        const url=`ws://${x.ip}:${decoded.port}`;
        if (await probeRoom(url, expected, 650)) return { ok:true, url, ip:x.ip, port:decoded.port, method:'subnet-scan' };
      }
    }
  }
  return { ok:false, error:'没有在当前局域网找到这个房间。请确认两台电脑连接同一个 Wi-Fi/路由器，并在 Windows 防火墙中允许“掼蛋俱乐部”使用专用网络。' };
}

async function stopRoomServer() {
  await clearUpnpMapping();
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

ipcMain.handle('lan:resolve', async (_event, roomCode) => resolveLanRoom(roomCode));

ipcMain.handle('public:start', async (_event, options = {}) => {
  const port = Number(options.port) || 37821;
  const roomName = String(options.roomName || '掼蛋房间').slice(0, 24);
  const lanIp = await preferredLanAddress();
  const mapping = await tryUpnpMapping(port);
  let publicIp = mapping.externalIp;
  if (!networkCode.isIPv4(publicIp) || isPrivateIPv4(publicIp)) publicIp = await detectPublicIPv4(options.publicIp);
  const roomCode = networkCode.encodePublicRoomCode(publicIp, port);
  const server = await startRoomServer({ mode: 'public', port, roomName, roomCode, advertise: false });
  const mapping2 = await tryUpnpMapping(port);
  const upnpOk = mapping2.ok;
  return {
    ...server.info(), mode: 'public', publicIp, roomCode, upnp: upnpOk,
    note: upnpOk
      ? '已尝试通过 UPnP 自动开放路由器 TCP 端口。把房间码发给朋友即可；请让朋友用手机热点/其他网络测试，不要只在同一 Wi-Fi 内测试公网模式。'
      : `路由器未能自动开放端口（${mapping2.error || 'UPnP 不可用'}）。若公网玩家仍无法加入，需要在路由器手动把 TCP ${port} 映射到本机 ${lanIp}:${port}；若宽带处于 CGNAT，则房主电脑无法直接作为公网服务器。`
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
    discoverySocket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
      try { discoverySocket.setBroadcast(true); } catch (_) {}
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
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (discoverySocket) try { discoverySocket.close(); } catch (_) {}
  clearUpnpMapping().catch(()=>{});
  if (roomServer) roomServer.close().catch(() => {});
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
