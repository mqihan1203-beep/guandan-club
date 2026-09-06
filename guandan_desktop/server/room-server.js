const http = require('http');
const os = require('os');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');
const core = require('../src/shared/game-core');
const ai = require('../src/shared/ai');

const DISCOVERY_PORT = 37822;
const MULTICAST_ADDR = '239.42.42.42';

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i=0;i<6;i++) s += alphabet[Math.floor(Math.random()*alphabet.length)];
  return s;
}
function lanAddresses() {
  const out = [];
  for (const xs of Object.values(os.networkInterfaces())) {
    for (const x of xs || []) if (x.family === 'IPv4' && !x.internal) out.push(x.address);
  }
  return out;
}
function safeSend(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

async function createRoomServer({ port = 37821, roomName = '掼蛋房间', advertise = false } = {}) {
  const roomCode = randomCode();
  const httpServer = http.createServer((req,res)=>{
    res.writeHead(200, {'content-type':'application/json; charset=utf-8'});
    res.end(JSON.stringify({ service:'guandan-room-server', roomCode, roomName }));
  });
  const wss = new WebSocketServer({ server: httpServer });
  const clients = new Map();
  const seats = [null,null,null,null];
  const botDifficulty = ['normal','normal','normal','normal'];
  let game = null;
  let hostClientId = null;
  let beacon = null;
  let beaconTimer = null;
  let botRunning = false;

  function roomSnapshot() {
    return {
      roomCode, roomName,
      seats: seats.map(s => s ? { id:s.id, name:s.name, human:true } : null),
      playing: !!game && (game.status === 'playing' || game.status === 'tribute'),
      round: game?.round || 0
    };
  }
  function broadcastRoom() {
    for (const c of clients.values()) safeSend(c.ws, { type:'room', room:roomSnapshot(), you:{ id:c.id, seat:c.seat, host:c.id===hostClientId } });
  }
  function sendState() {
    if (!game) return;
    for (const c of clients.values()) {
      safeSend(c.ws, { type:'state', state: core.publicState(game, c.seat), you:{ id:c.id, seat:c.seat, host:c.id===hostClientId } });
    }
  }

  async function runBots() {
    if (botRunning) return;
    botRunning = true;
    try {
      let guard = 0;
      while (game && guard++ < 100) {
        if (game.status === 'tribute') {
          const pending = game.tribute?.entries?.filter(e=>!e.returnedCard) || [];
          const botEntry = pending.find(e=>!seats[e.receiver]);
          if (!botEntry) break;
          await new Promise(r=>setTimeout(r,220 + Math.random()*220));
          const card = ai.chooseReturnCard(game, botEntry.receiver);
          if (!card) break;
          core.returnTribute(game, botEntry.receiver, card.id);
          sendState();
          continue;
        }
        if (game.status !== 'playing' || seats[game.turn]) break;
        const seat = game.turn;
        await new Promise(r=>setTimeout(r,240 + Math.random()*320));
        const move = ai.chooseMove(game, seat, botDifficulty[seat]);
        if (move.action === 'play') core.playCards(game, seat, move.cards.map(c=>c.id));
        else core.passTurn(game, seat);
        sendState();
      }
    } finally {
      botRunning = false;
    }
  }

  function startGame(levelRank='2', difficulty='normal') {
    for (let i=0;i<4;i++) botDifficulty[i] = difficulty;
    const rank = core.RANKS.includes(levelRank) ? levelRank : '2';
    game = core.createInitialGame({ levelRank:rank, dealer:0, teamLevels:[rank,rank], levelTeam:0, round:1 });
    sendState();
    runBots();
  }

  function nextRound() {
    if (!game || game.status !== 'round-finished') return { ok:false, error:'当前还不能进入下一局' };
    game = core.createNextRound(game);
    sendState();
    runBots();
    return { ok:true };
  }

  wss.on('connection', ws => {
    const id = Math.random().toString(36).slice(2,10);
    const c = { id, ws, name:'玩家', seat:null };
    clients.set(id,c);
    if (!hostClientId) hostClientId = id;
    safeSend(ws, { type:'hello', id, roomCode, roomName });

    ws.on('message', async raw => {
      let msg; try { msg=JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'join') {
        c.name = String(msg.name || '玩家').slice(0,12);
        let requested = Number.isInteger(msg.seat) ? msg.seat : -1;
        if (requested < 0 || requested > 3 || seats[requested]) requested = seats.findIndex(x=>!x);
        if (requested < 0) return safeSend(ws,{type:'error',message:'房间已满'});
        if (c.seat !== null) seats[c.seat] = null;
        c.seat = requested; seats[requested] = c;
        broadcastRoom();
        if (game) { sendState(); await runBots(); }
      }
      if (msg.type === 'start') {
        if (id !== hostClientId) return safeSend(ws,{type:'error',message:'只有房主可以开始'});
        startGame(msg.levelRank || '2', msg.difficulty || 'normal');
      }
      if (msg.type === 'nextRound') {
        if (id !== hostClientId) return safeSend(ws,{type:'error',message:'只有房主可以开始下一局'});
        const r=nextRound();
        if(!r.ok) safeSend(ws,{type:'error',message:r.error});
      }
      if (msg.type === 'returnTribute' && game && c.seat !== null) {
        const result = core.returnTribute(game, c.seat, String(msg.cardId || ''));
        if (!result.ok) safeSend(ws,{type:'error',message:result.error});
        else { sendState(); await runBots(); }
      }
      if (msg.type === 'play' && game && c.seat !== null) {
        const result = core.playCards(game, c.seat, Array.isArray(msg.cardIds)?msg.cardIds:[]);
        if (!result.ok) safeSend(ws,{type:'error',message:result.error});
        else { sendState(); await runBots(); }
      }
      if (msg.type === 'pass' && game && c.seat !== null) {
        const result = core.passTurn(game, c.seat);
        if (!result.ok) safeSend(ws,{type:'error',message:result.error});
        else { sendState(); await runBots(); }
      }
    });

    ws.on('close', async () => {
      if (c.seat !== null && seats[c.seat]?.id === id) seats[c.seat] = null;
      clients.delete(id);
      if (hostClientId === id) hostClientId = clients.keys().next().value || null;
      broadcastRoom();
      if (game) await runBots();
    });
  });

  await new Promise((resolve,reject)=>{
    httpServer.once('error', reject);
    httpServer.listen(port,'0.0.0.0',resolve);
  });

  if (advertise) {
    beacon = dgram.createSocket('udp4');
    beacon.bind(() => {
      try { beacon.setMulticastTTL(1); } catch (_) {}
      const send = () => {
        const payload = Buffer.from(JSON.stringify({ type:'GUANDAN_ROOM', roomCode, roomName, port }));
        beacon.send(payload, 0, payload.length, DISCOVERY_PORT, MULTICAST_ADDR, ()=>{});
      };
      send(); beaconTimer = setInterval(send, 1500);
    });
  }

  return {
    info: () => ({ roomCode, roomName, port, addresses:lanAddresses() }),
    close: () => new Promise(resolve => {
      if (beaconTimer) clearInterval(beaconTimer);
      if (beacon) try { beacon.close(); } catch (_) {}
      for (const c of clients.values()) try { c.ws.close(); } catch (_) {}
      wss.close(() => httpServer.close(()=>resolve()));
      setTimeout(resolve, 700);
    })
  };
}

module.exports = { createRoomServer };
