const core = window.GuandanCore;
const AI = window.GuandanAI;
const $ = s => document.querySelector(s);

const defaultNames = ['你','阿岚','小满','老周'];
let seatNames = defaultNames.slice();
let localGame = null;
let selected = new Set();
let autoPlay = false;
let online = false;
let socket = null;
let onlineState = null;
let mySeat = 0;
let isHost = false;
let discovered = new Map();
let botBusy = false;
let currentRoomCode = '';

for (const r of core.RANKS) {
  const op = document.createElement('option');
  op.value = r; op.textContent = r;
  $('#levelRankSelect').appendChild(op);
}

function esc(v='') {
  return String(v).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function setStatus(text, isError=false) {
  const el = $('#statusText');
  el.textContent = text;
  el.style.color = isError ? '#f08a84' : '';
}
function currentState() { return online ? onlineState : localGame; }
function me() { return online ? mySeat : 0; }
function myTeam() { return me() % 2; }
function seatCount(state, seat) {
  if (!state) return 0;
  return online ? (state.handCounts?.[seat] ?? 0) : (state.hands?.[seat]?.length ?? 0);
}
function myHand(state) { return online ? (state?.myHand || []) : (state?.hands?.[0] || []); }
function seatName(seat) { return seatNames[seat] || `玩家${seat+1}`; }
function positionName(n) { return ['头游','二游','三游','末游'][n-1] || `第${n}名`; }
function pendingReturn(state) {
  if (!state || state.status !== 'tribute') return null;
  if (online) return state.pendingReturnForMe || null;
  const legal = core.getLegalReturnCards(state, 0);
  if (!legal.length) return null;
  return { receiver:0, legalIds:legal.map(c=>c.id) };
}
function canActOnHand(state) {
  if (!state) return false;
  if (state.status === 'tribute') return !!pendingReturn(state);
  return state.status === 'playing' && state.turn === me();
}

function renderCard(c, selectable=false) {
  const div = document.createElement('div');
  div.className = 'card ' + ((c.suit==='H'||c.suit==='D')?'red ':'') + (core.isWild(c,(currentState()?.levelRank)||'2')?'wild-card ':'');
  if (selectable && selected.has(c.id)) div.classList.add('selected');
  const rank = c.rank==='BJ'?'JOKER':c.rank==='RJ'?'JOKER':c.rank;
  const suit = c.rank==='BJ'?'小王':c.rank==='RJ'?'大王':(core.SUIT_SYMBOL[c.suit]||'');
  div.innerHTML = `<div class="rank">${rank}</div><div class="suit">${suit}</div>`;
  if (selectable) {
    div.onclick = () => {
      const state = currentState();
      if (state?.status === 'tribute') {
        if (selected.has(c.id)) selected.clear();
        else { selected.clear(); selected.add(c.id); }
      } else {
        selected.has(c.id) ? selected.delete(c.id) : selected.add(c.id);
      }
      render();
    };
  }
  return div;
}

function addLog(html) {
  const x = document.createElement('div');
  x.className = 'log-item';
  x.innerHTML = html;
  $('#log').appendChild(x);
}

function renderLogs(state) {
  $('#log').innerHTML = '';
  const hist = (state?.history || []).slice().reverse();
  if (!hist.length) { addLog('首局开场，和队友一起争取上游。'); return; }
  for (const h of hist) {
    if (h.type === 'play') addLog(`<b>${esc(seatName(h.seat))}</b>：${esc(h.pattern)} · ${h.cards.map(esc).join(' ')}`);
    else if (h.type === 'pass') addLog(`<b>${esc(seatName(h.seat))}</b>：不出`);
    else if (h.type === 'finish') addLog(`<b>${esc(seatName(h.seat))}</b> 获得 ${positionName(h.position)}`);
    else if (h.type === 'borrowWind') addLog(`${esc(seatName(h.from))} 出完后无人压制，<b>${esc(seatName(h.seat))}</b> 接风领出`);
    else if (h.type === 'tribute') addLog(`${esc(seatName(h.payer))} 向 ${esc(seatName(h.receiver))} 进贡：<b>${esc(h.card)}</b>`);
    else if (h.type === 'returnTribute') addLog(`${esc(seatName(h.payer))} 向 ${esc(seatName(h.receiver))} 还贡：<b>${esc(h.card)}</b>`);
    else if (h.type === 'antiTribute') addLog(`<b>抗贡</b>：${(h.seats||[]).map(s=>esc(seatName(s))).join('、')} 满足大王条件，由上局头游领出`);
    else if (h.type === 'tributeComplete') addLog(`贡还牌完成，由 <b>${esc(seatName(h.startingSeat))}</b> 先出`);
    else if (h.type === 'roundStart') addLog(`第 ${h.round} 局开始 · 本局打 <b>${esc(h.levelRank)}</b>`);
    else if (h.type === 'roundResult') {
      const mine = h.winningTeam === myTeam();
      addLog(`<b>${mine?'我方':'对方'}</b>本局取胜，升级 ${h.upgrade} 级${h.doubleDown?'（双下）':''}`);
    }
  }
}

function renderTributeCenter(state) {
  const lp = $('#lastPlay');
  lp.innerHTML = '';
  $('#turnTip').textContent = '贡还牌阶段';
  const entries = state.tribute?.entries || [];
  if (!entries.length) {
    lp.textContent = state.tribute?.anti ? '本局抗贡' : '准备贡牌…';
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'tribute-summary';
  for (const e of entries) {
    const row = document.createElement('div');
    const tributeText = core.cardText(e.tributeCard);
    const returned = e.returnedCard ? ` · 还 ${core.cardText(e.returnedCard)}` : ' · 等待还贡';
    row.textContent = `${seatName(e.payer)} → ${seatName(e.receiver)}：${tributeText}${returned}`;
    wrap.appendChild(row);
  }
  lp.appendChild(wrap);
}

function resultMessage(state) {
  const r = state.result;
  if (!r) return '';
  const mine = r.winningTeam === myTeam();
  const tag = r.doubleDown ? '双下，升 3 级' : `升级 ${r.upgrade} 级`;
  return `${mine?'我方':'对方'}取得头游，${tag}：${r.levelBefore} → ${r.levelAfter}`;
}

function render() {
  const state = currentState();
  if (!state) return;
  const self = me();
  selected = new Set([...selected].filter(id => myHand(state).some(c=>c.id===id)));

  for (let i=0;i<4;i++) {
    $(`#count${i}`).textContent = `剩 ${seatCount(state,i)} 张`;
    document.querySelector(`.seat[data-seat="${i}"]`)?.classList.toggle('active', state.status==='playing' && state.turn===i);
  }

  $('#handCount').textContent = `我的手牌 ${myHand(state).length} 张`;
  $('#wildLabel').textContent = `♥${state.levelRank} 逢人配 · 第 ${state.round} 局`;
  const levels = state.teamLevels || [state.levelRank,state.levelRank];
  $('#ourLevel').textContent = levels[myTeam()];
  $('#oppLevel').textContent = levels[1-myTeam()];
  const mate = (self+2)%4;
  const oppA = (self+1)%4, oppB=(self+3)%4;
  if ($('#ourTeamNames')) $('#ourTeamNames').textContent = `${seatName(self)} & ${seatName(mate)}`;
  if ($('#oppTeamNames')) $('#oppTeamNames').textContent = `${seatName(oppA)} & ${seatName(oppB)}`;

  const handEl = $('#hand');
  handEl.innerHTML = '';
  const selectable = canActOnHand(state);
  core.sortCards(myHand(state), state.levelRank).forEach(c => handEl.appendChild(renderCard(c, selectable)));

  if (state.status === 'tribute') {
    renderTributeCenter(state);
  } else if (state.lastPlay) {
    $('#turnTip').textContent = `${seatName(state.lastPlay.seat)} · ${state.lastPlay.pattern.name}`;
    const lp = $('#lastPlay'); lp.innerHTML='';
    state.lastPlay.cards.forEach(c=>lp.appendChild(renderCard(c,false)));
  } else {
    $('#turnTip').textContent = state.status==='playing' ? (state.turn===self?'轮到你领出':'等待领出') : '本局结算';
    $('#lastPlay').textContent = state.status==='playing' ? '新一轮' : '牌局结束';
  }

  const needReturn = pendingReturn(state);
  $('#playBtn').textContent = needReturn ? '还贡 Enter' : '出牌 Enter';
  $('#playBtn').disabled = !(needReturn || (state.status==='playing' && state.turn===self));
  $('#passBtn').disabled = !(state.status==='playing' && state.turn===self && !!state.lastPlay && state.lastPlay.seat!==self);
  $('#hintBtn').disabled = !(needReturn || (state.status==='playing' && state.turn===self));
  $('#clearBtn').disabled = !selected.size;

  if (state.status === 'tribute') {
    if (needReturn) setStatus('轮到你还贡：请选择 1 张 10 或以下的合法牌，然后点“还贡”');
    else {
      const e = state.tribute?.entries?.find(x=>!x.returnedCard);
      setStatus(e ? `等待 ${seatName(e.receiver)} 还贡…` : '正在处理贡还牌…');
    }
    $('#newGameBtn').textContent = '贡还牌中';
    $('#newGameBtn').disabled = true;
  } else if (state.status === 'round-finished') {
    setStatus(`${resultMessage(state)}。${online?(isHost?'点击“下一局”继续':'等待房主开始下一局'):'点击“下一局”继续'}`);
    $('#newGameBtn').textContent = online && !isHost ? '等待下一局' : '下一局';
    $('#newGameBtn').disabled = online && !isHost;
  } else if (state.status === 'match-finished') {
    const mine = state.matchWinner === myTeam();
    setStatus(`${mine?'我方':'对方'}已成功过 A，整场比赛结束。`);
    $('#newGameBtn').textContent = online && !isHost ? '比赛结束' : '重新开赛';
    $('#newGameBtn').disabled = online && !isHost;
  } else {
    $('#newGameBtn').textContent = online ? '本局进行中' : '重新开局';
    $('#newGameBtn').disabled = online;
    if (state.turn === self) setStatus('轮到你出牌');
    else setStatus(`等待 ${seatName(state.turn)} 出牌…`);
  }

  $('#roomBadge').textContent = online
    ? `联机 · ${currentRoomCode || '房间'} · 第${state.round}局 · 打${state.levelRank}`
    : `单机 · AI 对战 · 第${state.round}局 · 打${state.levelRank}`;
  renderLogs(state);
}

async function newLocalGame() {
  online = false;
  closeSocket();
  selected.clear();
  seatNames = defaultNames.slice();
  for (let i=0;i<4;i++) $(`#name${i}`).textContent=seatNames[i];
  localGame = core.createInitialGame({ levelRank:'2', dealer:0, teamLevels:['2','2'], levelTeam:0 });
  render();
  if (autoPlay) setTimeout(()=>doHint(true),250);
}

async function advanceLocalRound() {
  if (!localGame || localGame.status !== 'round-finished') return;
  selected.clear();
  localGame = core.createNextRound(localGame);
  render();
  await runLocalBots();
}

async function runLocalBots() {
  if (botBusy || online || !localGame) return;
  botBusy = true;
  try {
    let guard = 0;
    while (localGame && guard++ < 80) {
      if (localGame.status === 'tribute') {
        const pendingEntries = localGame.tribute?.entries?.filter(e=>!e.returnedCard) || [];
        const botEntry = pendingEntries.find(e=>e.receiver!==0);
        if (!botEntry) break;
        await new Promise(r=>setTimeout(r,280));
        const card = AI.chooseReturnCard(localGame, botEntry.receiver);
        if (!card) break;
        core.returnTribute(localGame, botEntry.receiver, card.id);
        render();
        continue;
      }
      if (localGame.status !== 'playing' || localGame.turn === 0) break;
      await new Promise(r=>setTimeout(r,320));
      const seat = localGame.turn;
      const move = AI.chooseMove(localGame, seat, $('#difficultySelect').value);
      if (move.action === 'play') core.playCards(localGame, seat, move.cards.map(c=>c.id));
      else core.passTurn(localGame, seat);
      render();
    }
    if (autoPlay && localGame) {
      const humanNeedsReturn = localGame.status==='tribute' && !!pendingReturn(localGame);
      const humanTurn = localGame.status==='playing' && localGame.turn===0;
      if (humanNeedsReturn || humanTurn) {
        await new Promise(r=>setTimeout(r,220));
        doHint(true);
      }
    }
  } finally {
    botBusy = false;
  }
}

function playerPlay() {
  const state = currentState();
  if (!state) return;
  const ids = [...selected];

  if (state.status === 'tribute') {
    if (!pendingReturn(state)) return setStatus('你当前不需要还贡', true);
    if (ids.length !== 1) return setStatus('还贡时请选择 1 张牌', true);
    if (online) {
      send({ type:'returnTribute', cardId:ids[0] });
      selected.clear();
      return;
    }
    const r = core.returnTribute(localGame, 0, ids[0]);
    if (!r.ok) return setStatus(r.error, true);
    selected.clear(); render(); runLocalBots();
    return;
  }

  if (state.status !== 'playing') return setStatus('当前不能出牌', true);
  if (!ids.length) return setStatus('请先选择要出的牌', true);
  if (online) {
    send({ type:'play', cardIds:ids });
    selected.clear();
    return;
  }
  const r = core.playCards(localGame, 0, ids);
  if (!r.ok) return setStatus(r.error, true);
  selected.clear(); render(); runLocalBots();
}

function playerPass() {
  const state=currentState();
  if (!state || state.status!=='playing') return setStatus('当前不能不出', true);
  if (online) { send({type:'pass'}); selected.clear(); return; }
  const r = core.passTurn(localGame,0);
  if (!r.ok) return setStatus(r.error,true);
  selected.clear(); render(); runLocalBots();
}

function doHint(andPlay=false) {
  const state = currentState();
  if (!state) return;
  const seat = me();

  if (state.status === 'tribute') {
    if (!pendingReturn(state)) return setStatus('当前无需你还贡', true);
    let card = null;
    if (online) {
      const legal = new Set(state.legalReturnCardIds || []);
      card = myHand(state).filter(c=>legal.has(c.id)).sort((a,b)=>core.effectiveRankValue(a.rank,state.levelRank)-core.effectiveRankValue(b.rank,state.levelRank))[0];
    } else card = AI.chooseReturnCard(localGame,0);
    if (!card) return setStatus('没有可用的还贡牌',true);
    selected = new Set([card.id]);
    render();
    if (andPlay) playerPlay();
    return;
  }

  if (state.status !== 'playing' || state.turn !== seat) return setStatus('还没轮到你', true);
  if (online) {
    const target = state.lastPlay && state.lastPlay.seat!==seat ? state.lastPlay.pattern : null;
    const cs = core.generateCandidates(state.myHand,state.levelRank,target)
      .sort((a,b)=>core.isBomb(a.pattern)-core.isBomb(b.pattern) || a.pattern.mainValue-b.pattern.mainValue || b.cards.length-a.cards.length);
    if (!cs.length) { if (andPlay) playerPass(); else setStatus('没有能压住的牌'); return; }
    selected = new Set(cs[0].cards.map(c=>c.id));
    render(); if (andPlay) playerPlay();
    return;
  }
  const mv = AI.chooseMove(localGame,0,$('#difficultySelect').value);
  if (mv.action === 'pass') { if (andPlay) playerPass(); else setStatus('AI 建议：不出'); return; }
  selected = new Set(mv.cards.map(c=>c.id));
  render(); if (andPlay) playerPlay();
}

function send(obj) { if (socket && socket.readyState===WebSocket.OPEN) socket.send(JSON.stringify(obj)); }
function closeSocket() { if (socket) { try { socket.close(); } catch {} socket=null; } }

function maybeAutoOnline() {
  if (!autoPlay) return;
  const state = currentState();
  if (!state) return;
  if ((state.status==='playing' && state.turn===mySeat) || (state.status==='tribute' && pendingReturn(state))) {
    setTimeout(()=>{ if (online && autoPlay) doHint(true); },220);
  }
}

function connect(url) {
  closeSocket();
  try { socket = new WebSocket(url); }
  catch(e) { return setLobbyInfo(`连接地址无效：${e.message}`); }
  $('#roomState').textContent='正在连接…';
  socket.onopen=()=>send({type:'join',name:$('#playerNameInput').value||'玩家',seat:Number($('#seatSelect').value)});
  socket.onmessage=e=>{
    let msg; try { msg=JSON.parse(e.data); } catch { return; }
    if (msg.type==='hello') {
      currentRoomCode=msg.roomCode||'';
      $('#roomState').textContent=`已连接 ${msg.roomName} · 房间码 ${msg.roomCode}`;
    }
    if (msg.type==='room') {
      online=true; mySeat=msg.you.seat??0; isHost=!!msg.you.host; currentRoomCode=msg.room.roomCode||currentRoomCode;
      seatNames = msg.room.seats.map((s,i)=>s?s.name:`AI-${['一','二','三','四'][i]}`);
      if (msg.room.seats[mySeat]) seatNames[mySeat]=msg.room.seats[mySeat].name;
      const seatText=msg.room.seats.map((s,i)=>`${i+1}号位：${s?s.name:'AI'}`).join('　');
      msg.room.seats.forEach((s,i)=>{ const el=$(`#name${i}`); if(el) el.textContent=seatNames[i]; });
      $('#roomState').textContent=`${msg.room.roomName} · ${msg.room.roomCode} · ${seatText}`;
      if (onlineState) render();
    }
    if (msg.type==='state') {
      online=true; mySeat=msg.you.seat??0; isHost=!!msg.you.host; onlineState=msg.state; selected.clear();
      render(); maybeAutoOnline();
    }
    if (msg.type==='error') { setStatus(msg.message,true); $('#roomState').textContent=msg.message; }
  };
  socket.onclose=()=>{ if (online) setStatus('联机连接已断开',true); };
  socket.onerror=()=>{ $('#roomState').textContent='连接失败，请检查 IP、端口和防火墙'; };
}

function setLobbyInfo(t) { $('#hostInfo').textContent=t; }
function renderDiscovered() {
  const box=$('#discoveredRooms'); box.innerHTML='';
  const active=[...discovered.values()].filter(x=>Date.now()-x.lastSeen<6000);
  if(!active.length){ box.innerHTML='<span class="muted">正在搜索同一局域网中的房间…</span>'; return; }
  for(const r of active){
    const div=document.createElement('div'); div.className='room-item';
    const span=document.createElement('span');
    const b=document.createElement('b'); b.textContent=r.roomName;
    const br=document.createElement('br');
    const sm=document.createElement('small'); sm.textContent=`${r.host}:${r.port} · ${r.roomCode}`;
    span.append(b,br,sm); div.appendChild(span);
    const btn=document.createElement('button'); btn.textContent='加入';
    btn.onclick=()=>{const url=`ws://${r.host}:${r.port}`;$('#serverUrlInput').value=url;connect(url)};
    div.appendChild(btn); box.appendChild(div);
  }
}

async function handleMainNewGame() {
  const state=currentState();
  if (online) {
    if (!state) return;
    if (!isHost) return setStatus('只有房主可以开始下一局',true);
    if (state.status==='round-finished') send({type:'nextRound'});
    else if (state.status==='match-finished') send({type:'start',levelRank:'2',difficulty:$('#difficultySelect').value});
    return;
  }
  if (localGame?.status==='round-finished') return advanceLocalRound();
  await newLocalGame();
}

$('#playBtn').onclick=playerPlay;
$('#passBtn').onclick=playerPass;
$('#hintBtn').onclick=()=>doHint(false);
$('#clearBtn').onclick=()=>{selected.clear();render()};
$('#autoBtn').onclick=()=>{
  autoPlay=!autoPlay;
  $('#autoBtn').textContent=autoPlay?'取消托管':'托管';
  if(autoPlay) {
    const state=currentState();
    if (state && ((state.status==='playing'&&state.turn===me()) || (state.status==='tribute'&&pendingReturn(state)))) doHint(true);
  }
};
$('#newGameBtn').onclick=handleMainNewGame;
$('#difficultySelect').onchange=()=>setStatus(`AI 难度已切换为：${$('#difficultySelect').selectedOptions[0].textContent}`);
$('#openLobbyBtn').onclick=async()=>{ $('#lobbyDialog').showModal(); if(window.desktopAPI) await window.desktopAPI.startDiscovery(); };
$('#closeLobbyBtn').onclick=()=>$('#lobbyDialog').close();
$('#rulesBtn').onclick=()=>$('#rulesDialog').showModal();
$('#closeRulesBtn').onclick=()=>$('#rulesDialog').close();

$('#hostLanBtn').onclick=async()=>{
  if(!window.desktopAPI) return setLobbyInfo('网页版无法创建本机服务器，请使用 Windows 桌面版。');
  try{
    const info=await window.desktopAPI.startLanServer({roomName:$('#roomNameInput').value,port:Number($('#portInput').value)});
    const ips=(info.addresses||[]).map(x=>typeof x==='string'?x:x.address);
    setLobbyInfo(`房间已创建 · 房间码 ${info.roomCode}\n局域网地址：${ips.map(ip=>`ws://${ip}:${info.port}`).join(' / ')}`);
    const url=`ws://127.0.0.1:${info.port}`; $('#serverUrlInput').value=url; connect(url);
  }catch(e){ setLobbyInfo(`创建失败：${e.message}`); }
};
$('#connectBtn').onclick=()=>{
  let u=$('#serverUrlInput').value.trim();
  if(!u) return setLobbyInfo('请输入 ws://IP:端口');
  if(!/^wss?:\/\//i.test(u)) u='ws://'+u;
  connect(u);
};
$('#startOnlineBtn').onclick=()=>{
  if(!socket) return setLobbyInfo('请先连接房间');
  if(!isHost) return setLobbyInfo('只有房主可以开始');
  send({type:'start',levelRank:$('#levelRankSelect').value,difficulty:$('#difficultySelect').value});
  $('#lobbyDialog').close();
};

if(window.desktopAPI){
  window.desktopAPI.onDiscoveredRoom(r=>{discovered.set(`${r.host}:${r.port}`,r);renderDiscovered()});
  setInterval(renderDiscovered,1500);
}

document.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!$('#lobbyDialog').open) playerPlay();
  if((e.key==='p'||e.key==='P')&&!$('#lobbyDialog').open) playerPass();
  if((e.key==='h'||e.key==='H')&&!$('#lobbyDialog').open) doHint(false);
});

newLocalGame();
