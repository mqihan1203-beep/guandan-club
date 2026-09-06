const core = window.GuandanCore;
const AI = window.GuandanAI;
const networkCode = window.GuandanNetwork;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const storage = {
  getItem(k){ try { return window.storage.getItem(k); } catch { return null; } },
  setItem(k,v){ try { window.storage.setItem(k,v); } catch {} }
};

const defaultNames = ['你','阿岚','小满','老周'];
const fanrenNames = ['韩立','南宫婉','紫灵','银月','厉飞雨','墨彩环','陈巧倩','元瑶','慕沛灵','大衍神君','向之礼','风希','曲魂','董萱儿','梅凝','凌玉灵','冰凤','小极宫主'];
let seatNames = defaultNames.slice();
let localGame = null;
let selected = new Set();
let autoPlay = false;
let online = false;
let connected = false;
let socket = null;
let onlineState = null;
let mySeat = 0;
let myClientId = null;
let isHost = false;
let discovered = new Map();
let botBusy = false;
let currentRoomCode = '';
let roomSnapshot = null;
let desiredSeat = 0;
let networkMode = 'lan';
let lastServerUrl = storage.getItem('guandan:lastServerUrl') || '';
let lastRoomCode = storage.getItem('guandan:lastRoomCode') || '';
let pendingJoinRoomCode = '';
let reconnectToken = storage.getItem('guandan:reconnectToken') || crypto.randomUUID?.() || `r_${Math.random().toString(36).slice(2)}${Date.now()}`;
let chatMessages = [];
let manualSort = false;
let manualOrder = [];
let draggingCardId = null;
let soundEnabled = storage.getItem('guandan:sound') !== 'off';
let audioCtx = null;
let lastFxKey = '';
let lastRenderedRound = null;
let lastResultKey = '';

storage.setItem('guandan:reconnectToken', reconnectToken);

for (const r of core.RANKS) {
  const op = document.createElement('option');
  op.value = r; op.textContent = r;
  $('#levelRankSelect').appendChild(op);
}

function esc(v='') {
  return String(v).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function clampName(v='') { return String(v).trim().slice(0,12) || '玩家'; }
function setStatus(text, isError=false) {
  const el = $('#statusText');
  el.textContent = text;
  el.style.color = isError ? '#f08a84' : '';
}
function currentState() { return online ? onlineState : localGame; }
function me() { return online ? mySeat : 0; }
function isSpectator() { return online && (mySeat === null || mySeat === undefined); }
function myTeam() { return isSpectator() ? 0 : (me() % 2); }
function seatCount(state, seat) {
  if (!state) return 0;
  return online ? (state.handCounts?.[seat] ?? 0) : (state.hands?.[seat]?.length ?? 0);
}
function myHand(state) { return online ? (state?.myHand || []) : (state?.hands?.[0] || []); }
function seatName(seat) { return seatNames[seat] || `玩家${seat+1}`; }
function positionName(n) { return ['头游','二游','三游','末游'][n-1] || `第${n}名`; }
function pendingReturn(state) {
  if (!state || state.status !== 'tribute' || isSpectator()) return null;
  if (online) return state.pendingReturnForMe || null;
  const legal = core.getLegalReturnCards(state, 0);
  if (!legal.length) return null;
  return { receiver:0, legalIds:legal.map(c=>c.id) };
}
function canActOnHand(state) {
  if (!state || isSpectator()) return false;
  if (state.status === 'tribute') return !!pendingReturn(state);
  return state.status === 'playing' && state.turn === me();
}

function ensureAudio() {
  if (!soundEnabled) return null;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
    return audioCtx;
  } catch { return null; }
}
function tone(freq, duration=.07, gain=.025, type='sine', delay=0) {
  const ctx = ensureAudio(); if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
  g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + delay + .008);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + duration);
  o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + delay); o.stop(ctx.currentTime + delay + duration + .02);
}
function playSound(kind) {
  if (!soundEnabled) return;
  if (kind === 'play') { tone(520,.06,.025,'triangle'); tone(690,.06,.018,'triangle',.055); }
  else if (kind === 'pass') tone(210,.09,.018,'sine');
  else if (kind === 'chat') tone(820,.045,.012,'sine');
  else if (kind === 'win') { [523,659,784,1047].forEach((f,i)=>tone(f,.16,.022,'triangle',i*.09)); }
  else if (kind === 'lose') { [392,330,262].forEach((f,i)=>tone(f,.18,.018,'sine',i*.11)); }
}
function updateSoundButton() {
  $('#soundToggleBtn').textContent = soundEnabled ? '🔊 音效' : '🔇 静音';
}

function getDisplayHand(state) {
  const hand = myHand(state);
  if (!manualSort) return core.sortCards(hand, state.levelRank);
  const ids = new Set(hand.map(c=>c.id));
  manualOrder = manualOrder.filter(id=>ids.has(id));
  for (const c of core.sortCards(hand,state.levelRank)) if (!manualOrder.includes(c.id)) manualOrder.push(c.id);
  const byId = new Map(hand.map(c=>[c.id,c]));
  return manualOrder.map(id=>byId.get(id)).filter(Boolean);
}
function setManualMode(on) {
  manualSort = on;
  if (on) {
    const state = currentState();
    if (state) manualOrder = getDisplayHand(state).map(c=>c.id);
  }
  $('#manualSortBtn').classList.toggle('active', on);
  $('#autoSortBtn').classList.toggle('active', !on);
  setStatus(on ? '手动排序已开启：拖动手牌即可调整位置' : '已恢复自动排序');
  render();
}
function moveManualCard(fromId, toId) {
  if (!manualSort || fromId === toId) return;
  const a = manualOrder.indexOf(fromId), b = manualOrder.indexOf(toId);
  if (a < 0 || b < 0) return;
  manualOrder.splice(a,1);
  manualOrder.splice(b,0,fromId);
  render();
}

function arrangePriority(pattern) {
  const p = { jokerBomb:110, straightFlush:105, bomb:100, twoTriples:90, threePairs:86, fullHouse:82, straight:78, triple:60, pair:50, single:10 };
  return p[pattern?.type] || 0;
}
function smartArrangeHand() {
  const state=currentState(); if(!state||isSpectator())return setStatus('观战时没有可整理的手牌',true);
  const hand=myHand(state); if(!hand.length)return;
  const candidates=core.generateCandidates(hand,state.levelRank,null)
    .filter(x=>x.cards.length>=2)
    .sort((a,b)=>arrangePriority(b.pattern)-arrangePriority(a.pattern)||b.cards.length-a.cards.length||b.pattern.mainValue-a.pattern.mainValue);
  const used=new Set(), groups=[];
  for(const c of candidates){
    if(c.cards.some(x=>used.has(x.id)))continue;
    c.cards.forEach(x=>used.add(x.id)); groups.push(c);
  }
  const leftovers=core.sortCards(hand.filter(c=>!used.has(c.id)),state.levelRank);
  manualSort=true;
  manualOrder=groups.flatMap(g=>core.sortCards(g.cards,state.levelRank).map(c=>c.id)).concat(leftovers.map(c=>c.id));
  $('#manualSortBtn').classList.add('active'); $('#autoSortBtn').classList.remove('active');
  const counts={}; for(const g of groups)counts[g.pattern.name]=(counts[g.pattern.name]||0)+1;
  const summary=Object.entries(counts).map(([k,v])=>`${k}${v>1?`×${v}`:''}`).slice(0,6).join(' · ');
  setStatus(summary?`一键摆牌完成：${summary}`:'一键摆牌完成：当前以对子/单张为主，可继续手动拖动');
  render();
}

function renderCard(c, selectable=false, index=0, dealAnim=false) {
  const div = document.createElement('div');
  div.className = 'card ' + ((c.suit==='H'||c.suit==='D')?'red ':'') + (core.isWild(c,(currentState()?.levelRank)||'2')?'wild-card ':'');
  if (selectable && selected.has(c.id)) div.classList.add('selected');
  if (dealAnim) div.classList.add('deal-in');
  div.style.setProperty('--card-index', index);
  const rank = c.rank==='BJ'?'JOKER':c.rank==='RJ'?'JOKER':c.rank;
  const suit = c.rank==='BJ'?'小王':c.rank==='RJ'?'大王':(core.SUIT_SYMBOL[c.suit]||'');
  div.innerHTML = `<div class="rank">${esc(rank)}</div><div class="suit">${esc(suit)}</div>`;
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
    div.oncontextmenu = e => {
      e.preventDefault(); e.stopPropagation();
      const state=currentState();
      if(!state||!canActOnHand(state))return;
      if(!selected.has(c.id)){
        selected.clear(); selected.add(c.id); render();
      }
      setTimeout(playerPlay,0);
    };
  }
  if (manualSort && selectable) {
    div.draggable = true;
    div.ondragstart = e => { draggingCardId = c.id; div.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; };
    div.ondragend = () => { draggingCardId=null; div.classList.remove('dragging'); $$('.drop-target').forEach(x=>x.classList.remove('drop-target')); };
    div.ondragover = e => { e.preventDefault(); div.classList.add('drop-target'); };
    div.ondragleave = () => div.classList.remove('drop-target');
    div.ondrop = e => { e.preventDefault(); div.classList.remove('drop-target'); if (draggingCardId) moveManualCard(draggingCardId,c.id); };
  }
  return div;
}

function historyToHtml(h) {
  if (h.type === 'play') return `<b>${esc(seatName(h.seat))}</b>：${esc(h.pattern)} · ${(h.cards||[]).map(esc).join(' ')}`;
  if (h.type === 'pass') return `<b>${esc(seatName(h.seat))}</b>：不出`;
  if (h.type === 'finish') return `<b>${esc(seatName(h.seat))}</b> 获得 ${positionName(h.position)}`;
  if (h.type === 'borrowWind') return `${esc(seatName(h.from))} 出完后无人压制，<b>${esc(seatName(h.seat))}</b> 接风领出`;
  if (h.type === 'tribute') return `${esc(seatName(h.payer))} 向 ${esc(seatName(h.receiver))} 进贡：<b>${esc(h.card)}</b>`;
  if (h.type === 'returnTribute') return `${esc(seatName(h.payer))} 向 ${esc(seatName(h.receiver))} 还贡：<b>${esc(h.card)}</b>`;
  if (h.type === 'antiTribute') return `<b>抗贡</b>：${(h.seats||[]).map(s=>esc(seatName(s))).join('、')} 满足大王条件`;
  if (h.type === 'tributeComplete') return `贡还牌完成，由 <b>${esc(seatName(h.startingSeat))}</b> 先出`;
  if (h.type === 'roundStart') return `第 ${h.round} 局开始 · 本局打 <b>${esc(h.levelRank)}</b>`;
  if (h.type === 'roundResult') {
    const mine = h.winningTeam === myTeam();
    return `<b>${mine?'我方':'对方'}</b>本局取胜，升级 ${h.upgrade} 级${h.doubleDown?'（双下）':''}`;
  }
  return '';
}
function renderActivity(state) {
  const feed = $('#activityFeed');
  const wasNearBottom = feed.scrollHeight-feed.scrollTop-feed.clientHeight < 70;
  feed.innerHTML = '';
  const events = [];
  for (const h of (state?.history || []).slice(-35)) events.push({kind:'game',at:h.at||0,data:h});
  for (const m of chatMessages.slice(-35)) events.push({kind:'chat',at:m.at||0,data:m});
  events.sort((a,b)=>a.at-b.at);
  if (!events.length) events.push({kind:'game',at:0,data:{type:'custom'}});
  for (const ev of events) {
    const x = document.createElement('div');
    if (ev.kind === 'chat') {
      x.className = 'chat-item';
      const d = new Date(ev.at||Date.now());
      x.innerHTML = `<span class="chat-time">${d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</span><b>${esc(ev.data.from)}</b>：${esc(ev.data.message)}`;
    } else {
      x.className = 'log-item';
      x.innerHTML = ev.data.type==='custom' ? '首局开场，和队友一起争取上游。' : historyToHtml(ev.data);
    }
    feed.appendChild(x);
  }
  if (wasNearBottom || !feed.dataset.rendered) requestAnimationFrame(()=>{feed.scrollTop=feed.scrollHeight; feed.dataset.rendered='1';});
}

function renderTributeCenter(state) {
  const lp = $('#lastPlay'); lp.innerHTML = '';
  $('#turnTip').textContent = '贡还牌阶段';
  const entries = state.tribute?.entries || [];
  if (!entries.length) { lp.textContent = state.tribute?.anti ? '本局抗贡' : '准备贡牌…'; return; }
  const wrap = document.createElement('div'); wrap.className = 'tribute-summary';
  for (const e of entries) {
    const row = document.createElement('div');
    row.textContent = `${seatName(e.payer)} → ${seatName(e.receiver)}：${core.cardText(e.tributeCard)}${e.returnedCard?` · 还 ${core.cardText(e.returnedCard)}`:' · 等待还贡'}`;
    wrap.appendChild(row);
  }
  lp.appendChild(wrap);
}
function renderTablePlays(state) {
  for(let seat=0;seat<4;seat++){
    const box=$(`#seatPlay${seat}`); if(!box)continue; box.innerHTML='';
    const play=state?.tablePlays?.[seat];
    if(!play?.cards?.length)continue;
    play.cards.forEach((c,i)=>box.appendChild(renderCard(c,false,i,false)));
    const label=document.createElement('span'); label.className='seat-play-label'; label.textContent=play.pattern?.name||''; box.appendChild(label);
  }
}

function resultMessage(state) {
  const r = state.result; if (!r) return '';
  const mine = r.winningTeam === myTeam();
  const tag = r.doubleDown ? '双下，升 3 级' : `升级 ${r.upgrade} 级`;
  return `${mine?'我方':'对方'}取得头游，${tag}：${r.levelBefore} → ${r.levelAfter}`;
}
function triggerPlayFx(text) {
  const fx=$('#playFx'); fx.innerHTML=`<div class="fx-badge">${esc(text)}</div>`;
  fx.classList.remove('show'); void fx.offsetWidth; fx.classList.add('show');
}
function maybeHistoryEffects(state) {
  const h = state?.history?.[state.history.length-1]; if (!h) return;
  const key=`${h.type}:${h.at||0}:${h.seat??''}:${state.round}`;
  if (!lastFxKey) { lastFxKey=key; return; }
  if (key===lastFxKey) return;
  lastFxKey=key;
  if (h.type==='play') { triggerPlayFx(`${seatName(h.seat)} · ${h.pattern}`); playSound('play'); }
  else if (h.type==='pass') playSound('pass');
  if (h.type==='roundResult') showResult(state);
}
function showResult(state) {
  if (!state?.result) return;
  const key=`${state.round}:${state.result.winningTeam}:${state.status}`; if (key===lastResultKey) return; lastResultKey=key;
  const mine = state.result.winningTeam===myTeam();
  $('#resultKicker').textContent = state.status==='match-finished' ? '整场比赛结束' : `第 ${state.round} 局结算`;
  $('#resultTitle').textContent = mine ? '漂亮！我方拿下这一局' : '这一局对方占先';
  $('#resultText').textContent = state.status==='match-finished' ? `${mine?'我方':'对方'}成功过 A。` : resultMessage(state);
  $('#resultOverlay').classList.add('show'); $('#resultOverlay').setAttribute('aria-hidden','false');
  playSound(mine?'win':'lose');
}
function hideResult(){ $('#resultOverlay').classList.remove('show'); $('#resultOverlay').setAttribute('aria-hidden','true'); }

function render() {
  const state = currentState(); if (!state) return;
  selected = new Set([...selected].filter(id => myHand(state).some(c=>c.id===id)));
  for (let i=0;i<4;i++) {
    const count=seatCount(state,i);
    $(`#count${i}`).textContent = count===0 ? '已出完' : (count<=10 ? `剩 ${count} 张` : '');
    document.querySelector(`.seat[data-seat="${i}"]`)?.classList.toggle('active', state.status==='playing' && state.turn===i);
    $(`#name${i}`).textContent = seatName(i);
  }
  $('#handCount').textContent = isSpectator() ? '观战模式 · 不显示暗牌' : `我的手牌 ${myHand(state).length} 张`;
  $('#wildLabel').textContent = `♥${state.levelRank} 逢人配 · 第 ${state.round} 局`;
  const levels = state.teamLevels || [state.levelRank,state.levelRank];
  if (isSpectator()) {
    $('#ourLevel').textContent = levels[0]; $('#oppLevel').textContent = levels[1];
    $('#ourTeamNames').textContent = `${seatName(0)} & ${seatName(2)}`; $('#oppTeamNames').textContent = `${seatName(1)} & ${seatName(3)}`;
  } else {
    const self=me(), mate=(self+2)%4, oppA=(self+1)%4, oppB=(self+3)%4;
    $('#ourLevel').textContent = levels[myTeam()]; $('#oppLevel').textContent = levels[1-myTeam()];
    $('#ourTeamNames').textContent = `${seatName(self)} & ${seatName(mate)}`; $('#oppTeamNames').textContent = `${seatName(oppA)} & ${seatName(oppB)}`;
  }
  const handEl=$('#hand'); handEl.innerHTML='';
  const displayHand=getDisplayHand(state), selectable=canActOnHand(state), dealAnim=lastRenderedRound!==state.round;
  displayHand.forEach((c,i)=>handEl.appendChild(renderCard(c,selectable,i,dealAnim)));
  lastRenderedRound=state.round;
  renderTablePlays(state);
  if (state.status==='tribute') renderTributeCenter(state);
  else if (state.lastPlay) {
    $('#turnTip').textContent=`${seatName(state.lastPlay.seat)} · ${state.lastPlay.pattern.name}`;
    $('#lastPlay').textContent=`当前牌权：${state.lastPlay.pattern.name} · 轮到 ${seatName(state.turn)}`;
  } else {
    $('#turnTip').textContent = state.status==='playing' ? (isSpectator()?'观战中':state.turn===me()?'轮到你领出':'等待领出') : '本局结算';
    $('#lastPlay').textContent = state.status==='playing' ? '新一轮 · 出过的牌显示在各家门前' : '牌局结束';
  }
  const needReturn=pendingReturn(state);
  $('#playBtn').textContent=needReturn?'还贡 Enter':'出牌 Enter';
  $('#playBtn').disabled=isSpectator() || !(needReturn || (state.status==='playing'&&state.turn===me()));
  $('#passBtn').disabled=isSpectator() || !(state.status==='playing'&&state.turn===me()&&!!state.lastPlay&&state.lastPlay.seat!==me());
  $('#hintBtn').disabled=isSpectator() || !(needReturn || (state.status==='playing'&&state.turn===me()));
  $('#clearBtn').disabled=!selected.size;
  if (isSpectator()) setStatus('正在观战。可以在右侧聊天；出现空位时可在联机大厅补位。');
  else if (state.status==='tribute') {
    if (needReturn) setStatus('轮到你还贡：请选择 1 张 10 或以下的合法牌');
    else { const e=state.tribute?.entries?.find(x=>!x.returnedCard); setStatus(e?`等待 ${seatName(e.receiver)} 还贡…`:'正在处理贡还牌…'); }
    if(online){$('#newGameBtn').textContent=isHost?'重新开局':'房主可重开';$('#newGameBtn').disabled=!isHost;}
    else{$('#newGameBtn').textContent='贡还牌中';$('#newGameBtn').disabled=true;}
  } else if (state.status==='round-finished') {
    setStatus(`${resultMessage(state)}。${online?(isHost?'点击“下一局”继续':'等待房主开始下一局'):'点击“下一局”继续'}`);
    $('#newGameBtn').textContent=online&&!isHost?'等待下一局':'下一局'; $('#newGameBtn').disabled=online&&!isHost;
  } else if (state.status==='match-finished') {
    setStatus(`${state.matchWinner===myTeam()?'我方':'对方'}已成功过 A，整场比赛结束。`);
    $('#newGameBtn').textContent=online&&!isHost?'比赛结束':'重新开赛'; $('#newGameBtn').disabled=online&&!isHost;
  } else {
    $('#newGameBtn').textContent=online?(isHost?'重新开局':'房主可重开'):'重新开局'; $('#newGameBtn').disabled=online&&!isHost;
    if (!online && state.turn===0) setStatus('轮到你出牌');
    else if (online && state.turn===mySeat) setStatus('轮到你出牌');
    else setStatus(`等待 ${seatName(state.turn)} 出牌…`);
  }
  $('#roomBadge').textContent=online?`联机 · ${currentRoomCode||'房间'} · 第${state.round}局 · 打${state.levelRank}`:`单机 · AI 对战 · 第${state.round}局 · 打${state.levelRank}`;
  $('#connectionDot').textContent=online?(connected?'联机':'已断线'):'单机'; $('#connectionDot').className=`connection-dot ${online&&connected?'online':'offline'}`;
  renderActivity(state); maybeHistoryEffects(state);
}

async function newLocalGame() {
  online=false; connected=false; closeSocket(false); selected.clear(); manualOrder=[]; chatMessages=[]; roomSnapshot=null; mySeat=0; myClientId=null; isHost=false;
  seatNames=defaultNames.slice(); localGame=core.createInitialGame({levelRank:'2',dealer:0,teamLevels:['2','2'],levelTeam:0});
  lastFxKey=''; lastResultKey=''; lastRenderedRound=null; render();
  if(autoPlay)setTimeout(()=>doHint(true),250);
}
async function advanceLocalRound(){ if(!localGame||localGame.status!=='round-finished')return; selected.clear(); manualOrder=[]; hideResult(); localGame=core.createNextRound(localGame); render(); await runLocalBots(); }
function executeLocalAiTurn(seat, difficulty){
  const beforeTurn=localGame?.turn;
  const beforeHistory=localGame?.history?.length||0;
  const move=AI.chooseMove(localGame,seat,difficulty);
  let result;
  if(move.action==='play'&&Array.isArray(move.cards)&&move.cards.length){
    result=core.playCards(localGame,seat,move.cards.map(c=>c.id));
  }else{
    result=core.passTurn(localGame,seat);
  }
  if(result?.ok)return true;
  const target=localGame.lastPlay&&localGame.lastPlay.seat!==seat?localGame.lastPlay.pattern:null;
  const legal=core.generateCandidates(localGame.hands[seat],localGame.levelRank,target)
    .sort((a,b)=>core.isBomb(a.pattern)-core.isBomb(b.pattern)||a.pattern.mainValue-b.pattern.mainValue||b.cards.length-a.cards.length);
  if(legal.length){
    result=core.playCards(localGame,seat,legal[0].cards.map(c=>c.id));
    if(result?.ok)return true;
  }
  if(target){
    result=core.passTurn(localGame,seat);
    if(result?.ok)return true;
  }
  const first=localGame.hands[seat]?.[0];
  if(first){
    result=core.playCards(localGame,seat,[first.id]);
    if(result?.ok)return true;
  }
  console.error('AI turn failed', {seat,beforeTurn,beforeHistory,move,result});
  return false;
}

async function runLocalBots(){
  if(botBusy||online||!localGame)return; botBusy=true;
  try{
    let guard=0;
    while(localGame&&guard++<180){
      if(localGame.status==='tribute'){
        const pendingEntries=localGame.tribute?.entries?.filter(e=>!e.returnedCard)||[]; const botEntry=pendingEntries.find(e=>e.receiver!==0); if(!botEntry)break;
        await new Promise(r=>setTimeout(r,220)); const card=AI.chooseReturnCard(localGame,botEntry.receiver); if(!card)break;
        const rr=core.returnTribute(localGame,botEntry.receiver,card.id); if(!rr?.ok)break; render(); continue;
      }
      if(localGame.status!=='playing'||localGame.turn===0)break;
      await new Promise(r=>setTimeout(r,250)); const seat=localGame.turn;
      if(!executeLocalAiTurn(seat,$('#difficultySelect').value))break;
      render();
    }
    if(autoPlay&&localGame){const humanNeedsReturn=localGame.status==='tribute'&&!!pendingReturn(localGame);const humanTurn=localGame.status==='playing'&&localGame.turn===0;if(humanNeedsReturn||humanTurn){await new Promise(r=>setTimeout(r,180));doHint(true);}}
  }finally{
    botBusy=false;
    if(!online&&localGame&&localGame.status==='playing'&&localGame.turn!==0){
      setTimeout(()=>runLocalBots(),60);
    }
  }
}
function playerPlay(){
  const state=currentState(); if(!state||isSpectator())return; const ids=[...selected];
  if(state.status==='tribute'){
    if(!pendingReturn(state))return setStatus('你当前不需要还贡',true); if(ids.length!==1)return setStatus('还贡时请选择 1 张牌',true);
    if(online){send({type:'returnTribute',cardId:ids[0]});selected.clear();return;}
    const r=core.returnTribute(localGame,0,ids[0]);if(!r.ok)return setStatus(r.error,true);selected.clear();render();runLocalBots();return;
  }
  if(state.status!=='playing')return setStatus('当前不能出牌',true);if(!ids.length)return setStatus('请先选择要出的牌',true);
  if(online){send({type:'play',cardIds:ids});selected.clear();return;}
  const r=core.playCards(localGame,0,ids);if(!r.ok)return setStatus(r.error,true);selected.clear();render();runLocalBots();
}
function playerPass(){const state=currentState();if(!state||state.status!=='playing'||isSpectator())return setStatus('当前不能不出',true);if(online){send({type:'pass'});selected.clear();return;}const r=core.passTurn(localGame,0);if(!r.ok)return setStatus(r.error,true);selected.clear();render();runLocalBots();}
function doHint(andPlay=false){
  const state=currentState();if(!state||isSpectator())return;const seat=me();
  if(state.status==='tribute'){
    if(!pendingReturn(state))return setStatus('当前无需你还贡',true);let card=null;
    if(online){const legal=new Set(state.legalReturnCardIds||[]);card=myHand(state).filter(c=>legal.has(c.id)).sort((a,b)=>core.effectiveRankValue(a.rank,state.levelRank)-core.effectiveRankValue(b.rank,state.levelRank))[0];}
    else card=AI.chooseReturnCard(localGame,0);if(!card)return setStatus('没有可用的还贡牌',true);selected=new Set([card.id]);render();if(andPlay)playerPlay();return;
  }
  if(state.status!=='playing'||state.turn!==seat)return setStatus('还没轮到你',true);
  if(online){const target=state.lastPlay&&state.lastPlay.seat!==seat?state.lastPlay.pattern:null;const cs=core.generateCandidates(state.myHand,state.levelRank,target).sort((a,b)=>core.isBomb(a.pattern)-core.isBomb(b.pattern)||a.pattern.mainValue-b.pattern.mainValue||b.cards.length-a.cards.length);if(!cs.length){if(andPlay)playerPass();else setStatus('没有能压住的牌');return;}selected=new Set(cs[0].cards.map(c=>c.id));render();if(andPlay)playerPlay();return;}
  const mv=AI.chooseMove(localGame,0,$('#difficultySelect').value);if(mv.action==='pass'){if(andPlay)playerPass();else setStatus('AI 建议：不出');return;}selected=new Set(mv.cards.map(c=>c.id));render();if(andPlay)playerPlay();
}

function send(obj){if(socket&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(obj));}
function closeSocket(markDisconnected=true){if(socket){try{socket.onclose=null;socket.close();}catch{}socket=null;}if(markDisconnected)connected=false;}
function maybeAutoOnline(){if(!autoPlay||isSpectator())return;const state=currentState();if(!state)return;if((state.status==='playing'&&state.turn===mySeat)||(state.status==='tribute'&&pendingReturn(state)))setTimeout(()=>{if(online&&connected&&autoPlay)doHint(true);},190);}

function connect(url, mode=networkMode, roomCode=lastRoomCode){
  closeSocket(false); url=String(url||'').trim(); if(!/^wss?:\/\//i.test(url))url='ws://'+url;
  const cleanCode=networkCode.normalizeRoomCode(roomCode||'');
  if(!cleanCode)return setRoomMessage('请先输入房间码',true);
  pendingJoinRoomCode=cleanCode;
  let joinedThisConnection=false;
  let connectErrorText='';
  try{socket=new WebSocket(url);}catch(e){return setRoomMessage(`连接失败：${e.message}`,true);}
  networkMode=mode; lastServerUrl=url; lastRoomCode=cleanCode;
  storage.setItem('guandan:lastServerUrl',url); storage.setItem('guandan:lastRoomCode',cleanCode); storage.setItem('guandan:lastNetworkMode',mode);
  $('#roomState').textContent='正在通过房间码连接…'; connected=false; renderLobby();
  socket.onopen=()=>{
    connected=true;
    const name=clampName($('#playerNameInput').value);storage.setItem('guandan:nickname',name);
    send({type:'join',name,seat:desiredSeat,reconnectToken,roomCode:cleanCode});
  };
  socket.onmessage=e=>{
    let msg;try{msg=JSON.parse(e.data);}catch{return;}
    if(msg.type==='hello'){
      const serverCode=networkCode.normalizeRoomCode(msg.roomCode||'');
      if(serverCode!==cleanCode){connectErrorText='房间码与目标房间不匹配，请重新输入';setRoomMessage(connectErrorText,true);closeSocket(false);return;}
      currentRoomCode=serverCode;$('#roomState').textContent=`已连接 ${msg.roomName} · 房间码 ${networkCode.prettyRoomCode(serverCode)}`;
    }
    if(msg.type==='room'){
      joinedThisConnection=true;
      online=true;connected=true;mySeat=msg.you.seat;desiredSeat=(msg.you.seat===null||msg.you.seat===undefined)?-1:msg.you.seat;myClientId=msg.you.id;isHost=!!msg.you.host;
      currentRoomCode=networkCode.normalizeRoomCode(msg.room.roomCode||currentRoomCode);roomSnapshot=msg.room;
      lastRoomCode=currentRoomCode||lastRoomCode;storage.setItem('guandan:lastRoomCode',lastRoomCode);
      if(msg.you.reconnectToken&&msg.you.reconnectToken!==reconnectToken){reconnectToken=msg.you.reconnectToken;storage.setItem('guandan:reconnectToken',reconnectToken);}
      seatNames=msg.room.seats.map((x,i)=>x?x.name:`AI-${['一','二','三','四'][i]}`);
      chatMessages=(msg.room.chat||chatMessages).slice(-40); renderLobby(); if(onlineState)render();
    }
    if(msg.type==='state'){joinedThisConnection=true;online=true;connected=true;mySeat=msg.you.seat;myClientId=msg.you.id;isHost=!!msg.you.host;onlineState=msg.state;selected.clear();render();renderLobby();maybeAutoOnline();}
    if(msg.type==='chat'){chatMessages.push({from:msg.from,message:msg.message,at:msg.at||Date.now(),clientId:msg.clientId});chatMessages=chatMessages.slice(-50);playSound('chat');renderActivity(currentState());}
    if(msg.type==='left'){completeLeaveRoom('已退出联机房间');return;}
    if(msg.type==='kicked'){setStatus(`你已被房主移出房间${msg.reason?`：${msg.reason}`:''}`,true);setTimeout(()=>completeLeaveRoom('已被房主移出房间'),60);}
    if(msg.type==='error'){connectErrorText=msg.message||'服务器返回错误';setStatus(connectErrorText,true);$('#roomState').textContent=connectErrorText;}
  };
  socket.onclose=()=>{
    connected=false;
    if(!joinedThisConnection){
      const text=connectErrorText||(mode==='lan'
        ?'无法连接到房主。请确认两台电脑在同一 Wi-Fi/路由器，并允许 Windows 防火墙“专用网络”。'
        :'无法连接到房主公网端口。若房主路由器未开启 UPnP/端口映射，或宽带是 CGNAT，公网直连会失败。');
      $('#roomState').textContent=text;setStatus(text,true);
    }else{
      $('#roomState').textContent='连接已断开，可点击“断线重连”';
      if(online)setStatus('联机连接已断开，牌桌会保留当前画面',true);
    }
    $('#reconnectBtn').classList.remove('hidden');renderLobby();
  };
  socket.onerror=()=>{
    connectErrorText=mode==='lan'
      ?'连接失败：正在使用的局域网地址不可达，或 Windows 防火墙阻止了 37821 端口。'
      :'连接失败：房主公网 37821 端口不可达。房主需要 UPnP 自动映射成功或手动端口映射；CGNAT 无法直接建公网房。';
    setRoomMessage(connectErrorText,true);
  };
}

function setLobbyInfo(t){$('#hostInfo').textContent=t;}
function setPublicLobbyInfo(t){$('#publicHostInfo').textContent=t;}
function setRoomMessage(t,isError=false){$('#roomState').textContent=t;if(isError)setStatus(t,true);}
function setNetworkMode(mode){
  networkMode=mode;$$('.network-tab').forEach(b=>b.classList.toggle('active',b.dataset.network===mode));$('#lanNetworkPanel').classList.toggle('active',mode==='lan');$('#publicNetworkPanel').classList.toggle('active',mode==='public');$('#lobbyNetworkBadge').textContent=mode==='lan'?'局域网':'公网';
  if(mode==='lan'&&window.desktopAPI)window.desktopAPI.startDiscovery().catch(()=>{});renderLobby();
}
function activeDiscoveredRoom(code){
  const clean=networkCode.normalizeRoomCode(code);return [...discovered.values()].find(x=>Date.now()-x.lastSeen<6000&&networkCode.normalizeRoomCode(x.roomCode)===clean)||null;
}
async function joinRoomByCode(rawCode,mode){
  const clean=networkCode.normalizeRoomCode(rawCode||'');if(!clean)return setRoomMessage('请输入房间码',true);
  let decoded;
  try{decoded=networkCode.decodeRoomCode(clean);}catch(e){return setRoomMessage(`房间码无效：${e.message}`,true);}
  if(decoded.mode!==mode)return setRoomMessage(decoded.mode==='lan'?'这是局域网房间码，请切换到“局域网”':'这是公网房间码，请切换到“公网”',true);
  if(mode==='lan'){
    const nearby=activeDiscoveredRoom(clean);
    if(nearby){connect(`ws://${nearby.host}:${nearby.port}`,'lan',clean);return;}
    if(window.desktopAPI?.resolveLanRoom){
      setRoomMessage('正在局域网内自动查找这个房间…');
      try{
        const found=await window.desktopAPI.resolveLanRoom(clean);
        if(found?.ok&&found.url){setRoomMessage(found.method==='subnet-scan'?'已找到房主，正在连接…':'正在连接房主…');connect(found.url,'lan',clean);return;}
        return setRoomMessage(found?.error||'没有找到这个局域网房间',true);
      }catch(e){return setRoomMessage(`局域网查找失败：${e.message}`,true);}
    }
  }
  connect(decoded.url,mode,decoded.roomCode);
}
function renderDiscovered(){
  const box=$('#discoveredRooms');box.innerHTML='';const active=[...discovered.values()].filter(x=>Date.now()-x.lastSeen<6000);
  if(!active.length){box.innerHTML='<span class="muted">正在搜索同一局域网中的房间…</span>';return;}
  for(const r of active){
    const div=document.createElement('div');div.className='room-item';const span=document.createElement('span');
    span.innerHTML=`<b>${esc(r.roomName)}</b><br><small>房间码 ${esc(networkCode.prettyRoomCode(r.roomCode))}</small>`;
    const btn=document.createElement('button');btn.textContent='加入';btn.onclick=()=>{setNetworkMode('lan');$('#lanRoomCodeInput').value=networkCode.prettyRoomCode(r.roomCode);joinRoomByCode(r.roomCode,'lan');};
    div.append(span,btn);box.appendChild(div);
  }
}
function renderLobby(){
  $('#lobbyNetworkBadge').textContent=networkMode==='lan'?'局域网':'公网';
  $('#lobbyRoomCode').textContent=networkCode.prettyRoomCode(roomSnapshot?.roomCode||currentRoomCode)||'------';
  $('#lobbyRoomTitle').textContent=roomSnapshot?.roomName||'在这里，等你入座';
  const started=!!roomSnapshot?.gameStarted;
  $('#lobbyReadyBadge').textContent=connected?(started?'对局中':(isSpectator()?'替补观战':(roomSnapshot?.seats?.[mySeat]?.ready?'已准备':'等待准备'))):(online?'已断线':'未连接');
  $('#reconnectBtn').classList.toggle('hidden',connected||!lastServerUrl||!lastRoomCode);
  const seats=roomSnapshot?.seats||[null,null,null,null];
  $$('.lobby-seat').forEach((card,i)=>{
    const x=seats[i];card.classList.toggle('occupied',!!x);card.classList.toggle('me',!!x&&x.id===myClientId);card.classList.toggle('selected',!connected&&desiredSeat===i);
    const team=i%2===0?'绿队':'蓝队';
    if(x){
      const ready=x.ready?'已准备':'未准备';const host=x.host?' · 房主':'';const kick=isHost&&x.id!==myClientId?`<span class="kick-hit" data-kick="${esc(x.id)}" title="踢出">×</span>`:'';
      card.innerHTML=`<span>${i+1} 号位 · ${team}${kick}</span><b>${esc(x.name)}</b><small>${started?'对局中':ready}${host}</small>`;
    }else card.innerHTML=`<span>${i+1} 号位 · ${team}</span><b>＋ 点击入座</b><small>${connected&&started?'空位 · 可替补':'空位'}</small>`;
  });
  $$('.kick-hit').forEach(x=>x.onclick=e=>{e.stopPropagation();send({type:'kick',clientId:x.dataset.kick});});
  const bench=roomSnapshot?.bench||[];const benchBox=$('#benchList');benchBox.innerHTML='';
  if(!bench.length)benchBox.innerHTML='<span class="muted">暂无替补</span>';
  else for(const b of bench){const chip=document.createElement('span');chip.className='bench-chip'+(b.id===myClientId?' me':'');chip.innerHTML=`${esc(b.name)}${b.host?' · 房主':''}`;if(isHost&&b.id!==myClientId){const k=document.createElement('button');k.textContent='×';k.title='踢出';k.onclick=()=>send({type:'kick',clientId:b.id});chip.appendChild(k);}benchBox.appendChild(chip);}
  const mine=mySeat!==null?seats[mySeat]:null;
  $('#readyBtn').disabled=!connected||isSpectator()||started;$('#readyBtn').textContent=mine?.ready?'取消准备':'准备';
  $('#startOnlineBtn').style.display=isHost&&!started?'':'none';$('#startOnlineBtn').disabled=!connected||!isHost||!(roomSnapshot?.canStart??false)||started;
  $('#restartOnlineBtn').style.display=isHost&&started?'':'none';$('#restartOnlineBtn').disabled=!connected||!isHost||!started;
  $('#leaveRoomBtn').disabled=!connected&&!online;
  $('#toBenchBtn').disabled=!connected||isSpectator();
  if(roomSnapshot){const seatText=seats.map((x,i)=>`${i+1}号位：${x?x.name:'AI/空位'}`).join('　');$('#roomState').textContent=`${roomSnapshot.roomName} · ${seatText}${bench.length?` · 替补 ${bench.length}/2`:''}`;}
}

function completeLeaveRoom(note='已退出联机房间'){
  closeSocket(false);connected=false;online=false;onlineState=null;roomSnapshot=null;currentRoomCode='';mySeat=0;myClientId=null;isHost=false;desiredSeat=0;seatNames=defaultNames.slice();selected.clear();chatMessages=[];
  newLocalGame().then(()=>{renderLobby();$('#roomState').textContent=note;});
}
function leaveOnlineRoom(){
  if(!online&&!connected)return setRoomMessage('当前没有加入联机房间');
  if(connected)send({type:'leave'});
  setTimeout(()=>completeLeaveRoom('已退出联机房间'),90);
}

function randomNickname(){const current=$('#playerNameInput').value;let next=current;for(let i=0;i<8&&next===current;i++)next=fanrenNames[Math.floor(Math.random()*fanrenNames.length)];$('#playerNameInput').value=next;storage.setItem('guandan:nickname',next);}
function sendChat(){
  const input=$('#chatInput');const message=input.value.trim().slice(0,80);if(!message)return;input.value='';
  if(online&&connected){send({type:'chat',message});return;}
  chatMessages.push({from:'你',message,at:Date.now()});renderActivity(currentState());
  const replies=['稳一点，这手有机会。','收到，继续看牌。','好牌不急，慢慢打。','这轮我帮你守一下牌权。','先看对面还剩几张。'];
  if(!online&&Math.random()<0.45)setTimeout(()=>{chatMessages.push({from:seatName(2),message:replies[Math.floor(Math.random()*replies.length)],at:Date.now()});playSound('chat');renderActivity(currentState());},500+Math.random()*500);
}

async function handleMainNewGame(){
  const state=currentState();
  if(online){
    if(!state)return setStatus('当前还没有联机牌局',true);
    if(!isHost)return setStatus('只有房主可以重新开局或开始下一局',true);
    hideResult();
    if(state.status==='round-finished'){send({type:'nextRound'});return;}
    if(!confirm('确定要重新开局吗？当前牌局进度会被清空，所有玩家留在房间里。'))return;
    send({type:'restartMatch',levelRank:$('#levelRankSelect').value||'2',difficulty:$('#difficultySelect').value});
    return;
  }
  if(localGame?.status==='round-finished')return advanceLocalRound();
  hideResult();await newLocalGame();
}

$('#playBtn').onclick=playerPlay;$('#passBtn').onclick=playerPass;$('#hintBtn').onclick=()=>doHint(false);$('#clearBtn').onclick=()=>{selected.clear();render();};
$('#autoBtn').onclick=()=>{autoPlay=!autoPlay;$('#autoBtn').textContent=autoPlay?'取消托管':'托管';if(autoPlay){const state=currentState();if(state&&!isSpectator()&&((state.status==='playing'&&state.turn===me())||(state.status==='tribute'&&pendingReturn(state))))doHint(true);}};
$('#newGameBtn').onclick=handleMainNewGame;$('#difficultySelect').onchange=()=>setStatus(`AI 难度已切换为：${$('#difficultySelect').selectedOptions[0].textContent}`);
$('#arrangeHandBtn').onclick=smartArrangeHand;$('#manualSortBtn').onclick=()=>setManualMode(true);$('#autoSortBtn').onclick=()=>setManualMode(false);
$('#hand').oncontextmenu=e=>{if(e.target===$('#hand')){e.preventDefault();if(selected.size)playerPlay();}};
$('#soundToggleBtn').onclick=()=>{soundEnabled=!soundEnabled;storage.setItem('guandan:sound',soundEnabled?'on':'off');updateSoundButton();if(soundEnabled)playSound('play');};
$('#openLobbyBtn').onclick=async()=>{$('#lobbyDialog').showModal();setNetworkMode(storage.getItem('guandan:lastNetworkMode')||networkMode);renderLobby();};$('#closeLobbyBtn').onclick=()=>$('#lobbyDialog').close();
$('#rulesBtn').onclick=()=>$('#rulesDialog').showModal();$('#closeRulesBtn').onclick=()=>$('#rulesDialog').close();$('#closeResultBtn').onclick=hideResult;$('#resultOverlay').onclick=e=>{if(e.target===$('#resultOverlay'))hideResult();};
$$('.network-tab').forEach(b=>b.onclick=()=>setNetworkMode(b.dataset.network));$('#randomNameBtn').onclick=randomNickname;
$$('.lobby-seat').forEach(card=>card.onclick=()=>{const seat=Number(card.dataset.lobbySeat);desiredSeat=seat;if(connected)send({type:'takeSeat',seat});else renderLobby();});
$('#toBenchBtn').onclick=()=>{desiredSeat=-1;if(connected)send({type:'toBench'});else renderLobby();};
$('#readyBtn').onclick=()=>{const mine=roomSnapshot?.seats?.[mySeat];send({type:'ready',ready:!mine?.ready});};
$('#reconnectBtn').onclick=()=>{if(lastServerUrl&&lastRoomCode)connect(lastServerUrl,storage.getItem('guandan:lastNetworkMode')||networkMode,lastRoomCode);};
$('#leaveRoomBtn').onclick=()=>{if(confirm('确定退出当前联机房间吗？'))leaveOnlineRoom();};
$('#restartOnlineBtn').onclick=()=>{if(!isHost)return;if(confirm('确定重新开局吗？所有玩家会留在房间，当前牌局进度将清空。')){hideResult();send({type:'restartMatch',levelRank:$('#levelRankSelect').value||'2',difficulty:$('#difficultySelect').value});$('#lobbyDialog').close();}};
$('#sendChatBtn').onclick=sendChat;$('#chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();sendChat();}});
$('#lobbyRoomCode').onclick=async()=>{const code=networkCode.prettyRoomCode(roomSnapshot?.roomCode||currentRoomCode);if(!code||code==='------')return;try{await navigator.clipboard.writeText(code);setRoomMessage(`已复制房间码 ${code}`);}catch{}};

$('#hostLanBtn').onclick=async()=>{
  if(!window.desktopAPI)return setLobbyInfo('网页版无法创建本机局域网服务器，请使用 Windows 桌面版。');
  try{
    const info=await window.desktopAPI.startLanServer({roomName:$('#roomNameInput').value,port:Number($('#portInput').value)});
    const code=networkCode.normalizeRoomCode(info.roomCode);currentRoomCode=code;lastRoomCode=code;$('#lanRoomCodeInput').value=networkCode.prettyRoomCode(code);
    setLobbyInfo(`房间已创建 · 房间码 ${networkCode.prettyRoomCode(code)}\n把这个房间码发给同一局域网里的朋友即可。`);
    connect(`ws://127.0.0.1:${info.port}`,'lan',code);
  }catch(e){setLobbyInfo(`创建失败：${e.message}`);}
};
$('#joinLanCodeBtn').onclick=()=>joinRoomByCode($('#lanRoomCodeInput').value,'lan');
$('#lanRoomCodeInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();joinRoomByCode(e.currentTarget.value,'lan');}});

$('#hostPublicBtn').onclick=async()=>{
  if(!window.desktopAPI)return setPublicLobbyInfo('网页版无法把本机作为公网服务器，请使用 Windows 桌面版。');
  setPublicLobbyInfo('正在创建公网房间并识别公网 IPv4…');
  try{
    const info=await window.desktopAPI.startPublicServer({roomName:$('#publicRoomNameInput').value,port:Number($('#publicPortInput').value),publicIp:$('#publicIpInput').value.trim()});
    const code=networkCode.normalizeRoomCode(info.roomCode);currentRoomCode=code;lastRoomCode=code;$('#publicRoomCodeInput').value=networkCode.prettyRoomCode(code);
    setPublicLobbyInfo(`公网房间已创建 · 房间码 ${networkCode.prettyRoomCode(code)}\n${info.note||'把房间码发给朋友即可。'}`);
    connect(`ws://127.0.0.1:${info.port}`,'public',code);
  }catch(e){setPublicLobbyInfo(`创建失败：${e.message}`);setRoomMessage(`公网建房失败：${e.message}`,true);}
};
$('#joinPublicCodeBtn').onclick=()=>joinRoomByCode($('#publicRoomCodeInput').value,'public');
$('#publicRoomCodeInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();joinRoomByCode(e.currentTarget.value,'public');}});
$('#startOnlineBtn').onclick=()=>{if(!socket)return setRoomMessage('请先通过房间码进入房间',true);if(!isHost)return setRoomMessage('只有房主可以开始',true);send({type:'start',levelRank:$('#levelRankSelect').value,difficulty:$('#difficultySelect').value});$('#lobbyDialog').close();};

if(window.desktopAPI){window.desktopAPI.onDiscoveredRoom(r=>{discovered.set(`${r.host}:${r.port}`,r);renderDiscovered();});setInterval(renderDiscovered,1500);}
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&!$('#lobbyDialog').open&&!$('#rulesDialog').open&&document.activeElement!==$('#chatInput'))playerPlay();if((e.key==='p'||e.key==='P')&&!$('#lobbyDialog').open)playerPass();if((e.key==='h'||e.key==='H')&&!$('#lobbyDialog').open)doHint(false);});

desiredSeat=0;
$('#playerNameInput').value=storage.getItem('guandan:nickname')||fanrenNames[Math.floor(Math.random()*fanrenNames.length)];
if(lastRoomCode){const pretty=networkCode.prettyRoomCode(lastRoomCode);try{const d=networkCode.decodeRoomCode(lastRoomCode);if(d.mode==='lan')$('#lanRoomCodeInput').value=pretty;else $('#publicRoomCodeInput').value=pretty;}catch{}}
updateSoundButton();renderLobby();newLocalGame();
