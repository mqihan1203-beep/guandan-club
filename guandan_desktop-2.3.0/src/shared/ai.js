(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./game-core') : root.GuandanCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GuandanAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  const LEVELS = [
    { id:'entry',  name:'入门', depth:0, topN:1,  memory:0 },
    { id:'novice', name:'新手', depth:1, topN:4,  memory:0 },
    { id:'normal', name:'普通', depth:2, topN:8,  memory:.1 },
    { id:'hard',   name:'困难', depth:3, topN:10, memory:.45 },
    { id:'pro',    name:'专业', depth:4, topN:14, memory:.8 },
    { id:'hell',   name:'地狱', depth:6, topN:20, memory:1 }
  ];
  function difficultyConfig(id){return LEVELS.find(x=>x.id===id)||LEVELS[2];}

  function shapeScoreFast(hand, levelRank) {
    const counts=new Map();let wild=0,jokers=0;
    for(const c of hand){if(core.isWild(c,levelRank)){wild++;continue;}if(c.rank==='BJ'||c.rank==='RJ'){jokers++;continue;}counts.set(c.rank,(counts.get(c.rank)||0)+1);}
    let pairs=0,triples=0,bombs=0,singles=0;
    for(const n of counts.values()){if(n>=4)bombs++;if(n>=3)triples++;else if(n>=2)pairs++;else singles++;}
    const estimatedTurns=Math.max(1,Math.ceil((hand.length-triples*2-pairs-bombs*3-wild*1.5)/2.2));
    return -hand.length*15-estimatedTurns*7+pairs*2.2+triples*4.5+bombs*7+wild*3.5+jokers*2.5-singles*.6;
  }

  function rankTotal(rank){return rank==='BJ'||rank==='RJ'?2:8;}
  function memoryProfile(state,seat){
    const own=new Map(),played=new Map();
    for(const c of state.hands[seat]||[])own.set(c.rank,(own.get(c.rank)||0)+1);
    for(const h of state.history||[]){if(h.type!=='play')continue;for(const c of h.cardData||[])played.set(c.rank,(played.get(c.rank)||0)+1);}
    const unknown=new Map();
    for(const rank of [...core.RANKS,'BJ','RJ'])unknown.set(rank,Math.max(0,rankTotal(rank)-(own.get(rank)||0)-(played.get(rank)||0)));
    const teammate=(seat+2)%4,opps=[(seat+1)%4,(seat+3)%4];
    const teammateLeft=state.hands[teammate]?.length??99,oppLeft=opps.map(s=>state.hands[s]?.length??99);
    return{unknown,teammate,opps,teammateLeft,oppLeft,oppMin:Math.min(...oppLeft)};
  }
  function unknownHigher(profile,mainValue,levelRank){
    let n=0;
    for(const [rank,count] of profile.unknown){if(core.effectiveRankValue(rank,levelRank)>mainValue)n+=count;}
    return n;
  }
  function unknownBombPressure(profile){
    let risk=0;
    for(const [rank,count] of profile.unknown){if(rank==='BJ'||rank==='RJ')continue;if(count>=4)risk+=(count-3)*.7;}
    const kings=(profile.unknown.get('BJ')||0)+(profile.unknown.get('RJ')||0);if(kings>=4)risk+=4;
    return risk;
  }
  function usesControl(cards,levelRank){return cards.some(c=>c.rank==='BJ'||c.rank==='RJ'||core.effectiveRankValue(c.rank,levelRank)>=15);}

  function immediateScore(candidate,state,seat,cfg,profile){
    const p=candidate.pattern,left=state.hands[seat].length-candidate.cards.length;
    let score=candidate.cards.length*14-p.mainValue*.23;
    if(core.isBomb(p))score+=left<=5?42:-24;
    if(left===0)score+=10000;else if(left<=2)score+=105;else if(left<=5)score+=22;
    const mate=(seat+2)%4;
    if(state.lastPlay&&state.lastPlay.seat===mate&&left>1)score-=90;
    const oppA=state.hands[(seat+1)%4]?.length??99,oppB=state.hands[(seat+3)%4]?.length??99,oppMin=Math.min(oppA,oppB);
    if(oppMin<=3)score+=p.mainValue*1.05+(core.isBomb(p)?36:0);
    if(cfg.memory>0&&profile){
      const lead=!state.lastPlay||state.lastPlay.seat===seat;
      const beaters=unknownHigher(profile,p.mainValue,state.levelRank);
      // 记牌：高难度会估计尚未出现的高牌/炸弹，不读取其他玩家暗牌。
      if(['single','pair'].includes(p.type)){
        if(lead&&profile.oppMin<=3)score-=beaters*cfg.memory*1.8;
        if(lead&&profile.oppMin>4&&profile.teammateLeft>3)score-=Math.min(beaters,10)*cfg.memory*.45;
      }
      // 推牌：队友只剩 1~2 张时，领出低单/低对，尽量把牌权送过去。
      if(lead&&profile.teammateLeft<=2&&profile.oppMin>1){
        const wanted=profile.teammateLeft===1?'single':'pair';
        if(p.type===wanted)score+=(115-p.mainValue*4)*cfg.memory;
        else if(!core.isBomb(p))score-=38*cfg.memory;
      }
      // 对手报单/报双时优先抢牌权。
      if(profile.oppMin<=2){
        if(['single','pair'].includes(p.type))score+=(p.mainValue*2.2-beaters*.8)*cfg.memory;
        if(core.isBomb(p))score+=32*cfg.memory;
      }
      // 正常阶段尽量保留王、级牌和大炸，残局/救场再动。
      if(left>7&&profile.oppMin>3&&usesControl(candidate.cards,state.levelRank))score-=18*cfg.memory;
      if(core.isBomb(p)&&left>7&&profile.oppMin>4)score-=unknownBombPressure(profile)*cfg.memory;
    }
    return score;
  }

  function futureScore(candidate,state,seat,depth,cfg,profile){
    const remain=core.removeCards(state.hands[seat],candidate.cards);let score=shapeScoreFast(remain,state.levelRank);
    if(depth<2||remain.length===0)return score;
    const maxNext=Math.min(14,3+depth*2);
    const nextMoves=core.generateCandidates(remain,state.levelRank,null)
      .filter(x=>!core.isBomb(x.pattern)||remain.length<=8)
      .sort((a,b)=>b.cards.length-a.cards.length||a.pattern.mainValue-b.pattern.mainValue)
      .slice(0,maxNext);
    if(nextMoves.length){
      let best=-Infinity;
      for(const n of nextMoves.slice(0,Math.min(nextMoves.length,depth>=5?8:4))){
        const r2=core.removeCards(remain,n.cards);
        let s=n.cards.length*(4+depth)+shapeScoreFast(r2,state.levelRank)*.17;
        if(r2.length===0)s+=500;
        if(cfg.memory>.5&&profile&&profile.teammateLeft<=2&&['single','pair'].includes(n.pattern.type))s+=(18-n.pattern.mainValue)*cfg.memory;
        best=Math.max(best,s);
      }
      if(Number.isFinite(best))score+=best;
      if(depth>=5){
        // 地狱档额外做一次“剩余手数”推演，偏好能连续成套走牌的分解。
        const best1=nextMoves[0];const r2=core.removeCards(remain,best1.cards);
        const follow=core.generateCandidates(r2,state.levelRank,null).sort((a,b)=>b.cards.length-a.cards.length||a.pattern.mainValue-b.pattern.mainValue).slice(0,6);
        if(follow.length)score+=follow[0].cards.length*10+shapeScoreFast(core.removeCards(r2,follow[0].cards),state.levelRank)*.12;
      }
    }
    return score;
  }

  function chooseReturnCard(state,seat){
    const legal=core.getLegalReturnCards(state,seat);if(!legal.length)return null;const hand=state.hands[seat];let best=null;
    for(const card of legal){const remain=core.removeCards(hand,[card]);const score=shapeScoreFast(remain,state.levelRank)-core.effectiveRankValue(card.rank,state.levelRank)*.05;if(!best||score>best.score)best={card,score};}
    return best.card;
  }

  function chooseMove(state,seat,difficulty='normal'){
    const cfg=difficultyConfig(difficulty);const target=state.lastPlay&&state.lastPlay.seat!==seat?state.lastPlay.pattern:null;
    let candidates=core.generateCandidates(state.hands[seat],state.levelRank,target);if(!candidates.length)return{action:'pass',reason:'无可压制牌型'};
    if(cfg.id==='entry'){const nonBomb=candidates.filter(c=>!core.isBomb(c.pattern));const pool=nonBomb.length?nonBomb:candidates;const pick=pool[Math.floor(Math.random()*pool.length)];return{action:'play',...pick};}
    const profile=cfg.memory?memoryProfile(state,seat):null;
    let scored=candidates.map(c=>({...c,score:immediateScore(c,state,seat,cfg,profile)+shapeScoreFast(core.removeCards(state.hands[seat],c.cards),state.levelRank)*.35}));
    scored.sort((a,b)=>b.score-a.score);const finalists=scored.slice(0,cfg.topN);
    for(const c of finalists){c.score+=futureScore(c,state,seat,cfg.depth,cfg,profile);if(cfg.id==='novice')c.score+=Math.random()*18;else if(cfg.id==='normal')c.score+=Math.random()*5;}
    finalists.sort((a,b)=>b.score-a.score);const best=finalists[0];const mate=(seat+2)%4;
    if(target&&state.lastPlay?.seat===mate&&state.hands[seat].length>2){
      const emergency=profile&&profile.oppMin<=1;
      if(!emergency){const passChance=cfg.id==='novice'?.55:cfg.id==='normal'?.76:cfg.id==='hard'?.9:.97;if(Math.random()<passChance)return{action:'pass',reason:'让队友保留牌权'};}
    }
    return{action:'play',cards:best.cards,pattern:best.pattern,score:best.score,analysis:cfg.id==='hell'?'记牌+推牌+残局两步推演':undefined};
  }

  return{LEVELS,difficultyConfig,chooseMove,chooseReturnCard,memoryProfile};
});
