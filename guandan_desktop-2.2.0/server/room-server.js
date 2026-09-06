const http = require('http');
const os = require('os');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');
const core = require('../src/shared/game-core');
const ai = require('../src/shared/ai');

const DISCOVERY_PORT = 37822;
const MULTICAST_ADDR = '239.42.42.42';
const MAX_CLIENTS = 6; // 4 个牌位 + 2 个替补/观战位
const SESSION_TTL = 2 * 60 * 1000;

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i=0;i<6;i++) s += alphabet[Math.floor(Math.random()*alphabet.length)];
  return s;
}
function randomToken() { return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,12)}`; }
function lanAddresses() {
  const out=[];
  for (const xs of Object.values(os.networkInterfaces())) for (const x of xs||[]) if (x.family==='IPv4'&&!x.internal) out.push(x.address);
  return out;
}
function safeSend(ws,obj){ if(ws&&ws.readyState===1)ws.send(JSON.stringify(obj)); }

async function createRoomServer({port=37821,roomName='掼蛋房间',advertise=false}={}) {
  const roomCode=randomCode();
  const httpServer=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end(`掼蛋联机服务器 ${roomName} / ${roomCode}\n`);});
  const wss=new WebSocketServer({server:httpServer});
  const clients=new Map();
  const sessions=new Map();
  const seats=[null,null,null,null];
  const botDifficulty=['normal','normal','normal','normal'];
  const chat=[];
  let hostClientId=null;
  let game=null;
  let botRunning=false;
  let beacon=null,beaconTimer=null;

  function gameStarted(){ return !!game; }
  function benchClients(){ return [...clients.values()].filter(c=>c.joined&&c.seat===null); }
  function seatedClients(){ return seats.filter(Boolean); }
  function cleanupSessions(){ const now=Date.now();for(const [token,s] of sessions)if(s.expires&&s.expires<now)sessions.delete(token); }
  function updateSession(c){ if(!c.reconnectToken)return;sessions.set(c.reconnectToken,{name:c.name,seat:c.seat,ready:c.ready,expires:Date.now()+SESSION_TTL}); }
  function youState(c){return{id:c.id,seat:c.seat,host:c.id===hostClientId,ready:!!c.ready,reconnectToken:c.reconnectToken};}
  function seatPublic(c){return c?{id:c.id,name:c.name,ready:!!c.ready,host:c.id===hostClientId}:null;}
  function roomPublic(){
    const seated=seatedClients();
    return {roomCode,roomName,seats:seats.map(seatPublic),bench:benchClients().map(seatPublic),chat:chat.slice(-30),gameStarted:gameStarted(),canStart:seated.length>0&&seated.every(c=>c.ready)};
  }
  function broadcastRoom(){ const room=roomPublic();for(const c of clients.values())if(c.joined)safeSend(c.ws,{type:'room',you:youState(c),room}); }
  function sendState(){ if(!game)return;for(const c of clients.values())if(c.joined)safeSend(c.ws,{type:'state',you:youState(c),state:core.publicState(game,c.seat)}); }
  function broadcast(obj){for(const c of clients.values())if(c.joined)safeSend(c.ws,obj);}
  function releaseSeat(c){if(c.seat!==null&&seats[c.seat]?.id===c.id)seats[c.seat]=null;c.seat=null;c.ready=false;updateSession(c);}
  function assignSeat(c,seat){
    if(seat<0||seat>3)return{ok:false,error:'座位不存在'};
    if(seats[seat]&&seats[seat].id!==c.id)return{ok:false,error:'这个座位已经有人了'};
    if(game&&c.seat!==null&&c.seat!==seat)return{ok:false,error:'对局进行中，已入座玩家不能换到另一个牌位'};
    if(c.seat!==null&&c.seat!==seat&&seats[c.seat]?.id===c.id)seats[c.seat]=null;
    c.seat=seat;c.ready=game?true:false;seats[seat]=c;updateSession(c);return{ok:true};
  }
  function moveToBench(c){
    if(c.seat===null)return{ok:true};
    if(benchClients().length>=2)return{ok:false,error:'替补席已满（最多 2 人）'};
    releaseSeat(c);return{ok:true};
  }
  function joinClient(c,msg){
    cleanupSessions();
    c.name=String(msg.name||'玩家').trim().slice(0,12)||'玩家';
    const supplied=String(msg.reconnectToken||'').slice(0,80);
    c.reconnectToken=supplied||randomToken();
    const prior=sessions.get(c.reconnectToken);
    let wanted=Number.isInteger(msg.seat)?msg.seat:-1;
    if(prior){c.name=String(msg.name||prior.name||c.name).slice(0,12);if((wanted<0||wanted>3)&&Number.isInteger(prior.seat))wanted=prior.seat;c.ready=!!prior.ready;}
    if(wanted>=0&&wanted<=3&&!seats[wanted])assignSeat(c,wanted);
    else {
      c.seat=null;c.ready=false;
      if(benchClients().filter(x=>x.id!==c.id).length>=2)return{ok:false,error:'房间已满：4 个牌位和 2 个替补位都有人了'};
    }
    c.joined=true;updateSession(c);return{ok:true};
  }

  async function runBots(){
    if(botRunning||!game)return;botRunning=true;
    try{
      let guard=0;
      while(game&&guard++<100){
        if(game.status==='tribute'){
          const pending=game.tribute?.entries?.filter(e=>!e.returnedCard)||[];
          const botEntry=pending.find(e=>!seats[e.receiver]);
          if(!botEntry)break;
          await new Promise(r=>setTimeout(r,180+Math.random()*220));
          const card=ai.chooseReturnCard(game,botEntry.receiver);if(!card)break;core.returnTribute(game,botEntry.receiver,card.id);sendState();continue;
        }
        if(game.status!=='playing'||seats[game.turn])break;
        const seat=game.turn;await new Promise(r=>setTimeout(r,210+Math.random()*270));
        const move=ai.chooseMove(game,seat,botDifficulty[seat]);
        if(move.action==='play')core.playCards(game,seat,move.cards.map(c=>c.id));else core.passTurn(game,seat);
        sendState();
      }
    }finally{botRunning=false;}
  }
  function startGame(levelRank='2',difficulty='normal'){
    for(let i=0;i<4;i++)botDifficulty[i]=difficulty;
    const rank=core.RANKS.includes(levelRank)?levelRank:'2';
    game=core.createInitialGame({levelRank:rank,dealer:0,teamLevels:[rank,rank],levelTeam:0,round:1});
    sendState();broadcastRoom();runBots();
  }
  function nextRound(){if(!game||game.status!=='round-finished')return{ok:false,error:'当前还不能进入下一局'};game=core.createNextRound(game);sendState();broadcastRoom();runBots();return{ok:true};}

  wss.on('connection',ws=>{
    cleanupSessions();
    if(clients.size>=MAX_CLIENTS){safeSend(ws,{type:'error',message:'房间已满（最多 4 名牌手 + 2 名替补/观战）'});return ws.close();}
    const id=Math.random().toString(36).slice(2,10);const c={id,ws,name:'玩家',seat:null,ready:false,joined:false,reconnectToken:null,kicked:false};clients.set(id,c);if(!hostClientId)hostClientId=id;
    safeSend(ws,{type:'hello',id,roomCode,roomName});

    ws.on('message',async raw=>{
      let msg;try{msg=JSON.parse(raw.toString());}catch{return;}
      if(msg.type==='join'){
        const r=joinClient(c,msg);if(!r.ok){safeSend(ws,{type:'error',message:r.error});clients.delete(id);return ws.close();}
        broadcastRoom();if(game){sendState();await runBots();}return;
      }
      if(!c.joined)return safeSend(ws,{type:'error',message:'请先进入房间'});
      if(msg.type==='takeSeat'){
        const r=assignSeat(c,Number(msg.seat));if(!r.ok)safeSend(ws,{type:'error',message:r.error});else{broadcastRoom();if(game){sendState();await runBots();}}return;
      }
      if(msg.type==='toBench'){
        const r=moveToBench(c);if(!r.ok)safeSend(ws,{type:'error',message:r.error});else{broadcastRoom();if(game){sendState();await runBots();}}return;
      }
      if(msg.type==='ready'){
        if(game)return safeSend(ws,{type:'error',message:'对局已经开始'});
        if(c.seat===null)return safeSend(ws,{type:'error',message:'替补/观战席无需准备，请先入座'});
        c.ready=!!msg.ready;updateSession(c);broadcastRoom();return;
      }
      if(msg.type==='kick'){
        if(id!==hostClientId)return safeSend(ws,{type:'error',message:'只有房主可以踢人'});
        const target=clients.get(String(msg.clientId||''));if(!target||target.id===id)return;
        target.kicked=true;if(target.reconnectToken)sessions.delete(target.reconnectToken);safeSend(target.ws,{type:'kicked',reason:'房主已将你移出房间'});try{target.ws.close();}catch{}return;
      }
      if(msg.type==='chat'){
        const message=String(msg.message||'').trim().slice(0,80);if(!message)return;
        const item={from:c.name,message,at:Date.now(),clientId:c.id,seat:c.seat};chat.push(item);if(chat.length>60)chat.shift();broadcast({type:'chat',...item});return;
      }
      if(msg.type==='start'){
        if(id!==hostClientId)return safeSend(ws,{type:'error',message:'只有房主可以开始'});
        if(game&&game.status!=='match-finished')return safeSend(ws,{type:'error',message:'当前已有对局'});
        const seated=seatedClients();if(!seated.length)return safeSend(ws,{type:'error',message:'至少需要 1 名真人入座'});
        const waiting=seated.filter(x=>!x.ready);if(waiting.length)return safeSend(ws,{type:'error',message:`还有玩家未准备：${waiting.map(x=>x.name).join('、')}`});
        startGame(msg.levelRank||'2',msg.difficulty||'normal');return;
      }
      if(msg.type==='nextRound'){
        if(id!==hostClientId)return safeSend(ws,{type:'error',message:'只有房主可以开始下一局'});const r=nextRound();if(!r.ok)safeSend(ws,{type:'error',message:r.error});return;
      }
      if(msg.type==='returnTribute'&&game&&c.seat!==null){const r=core.returnTribute(game,c.seat,String(msg.cardId||''));if(!r.ok)safeSend(ws,{type:'error',message:r.error});else{sendState();await runBots();}return;}
      if(msg.type==='play'&&game&&c.seat!==null){const r=core.playCards(game,c.seat,Array.isArray(msg.cardIds)?msg.cardIds:[]);if(!r.ok)safeSend(ws,{type:'error',message:r.error});else{sendState();await runBots();}return;}
      if(msg.type==='pass'&&game&&c.seat!==null){const r=core.passTurn(game,c.seat);if(!r.ok)safeSend(ws,{type:'error',message:r.error});else{sendState();await runBots();}return;}
    });

    ws.on('close',async()=>{
      if(c.seat!==null&&seats[c.seat]?.id===id)seats[c.seat]=null;
      if(!c.kicked)updateSession(c);else if(c.reconnectToken)sessions.delete(c.reconnectToken);
      clients.delete(id);
      if(hostClientId===id){const next=[...clients.values()].find(x=>x.joined);hostClientId=next?.id||null;}
      broadcastRoom();if(game)await runBots();
    });
  });

  await new Promise((resolve,reject)=>{httpServer.once('error',reject);httpServer.listen(port,'0.0.0.0',resolve);});
  if(advertise){
    beacon=dgram.createSocket('udp4');beacon.bind(()=>{try{beacon.setMulticastTTL(1);}catch{}
      const send=()=>{const payload=Buffer.from(JSON.stringify({type:'GUANDAN_ROOM',roomCode,roomName,port}));beacon.send(payload,0,payload.length,DISCOVERY_PORT,MULTICAST_ADDR,()=>{});};send();beaconTimer=setInterval(send,1500);
    });
  }
  return{
    info:()=>({roomCode,roomName,port,addresses:lanAddresses()}),
    close:()=>new Promise(resolve=>{if(beaconTimer)clearInterval(beaconTimer);if(beacon)try{beacon.close();}catch{}for(const c of clients.values())try{c.ws.close();}catch{}wss.close(()=>httpServer.close(()=>resolve()));setTimeout(resolve,700);})
  };
}

module.exports={createRoomServer};
