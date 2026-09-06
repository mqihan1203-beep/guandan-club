(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./game-core') : root.GuandanCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GuandanAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  const LEVELS = [
    { id: 'entry', name: '入门', depth: 0, topN: 1 },
    { id: 'novice', name: '新手', depth: 1, topN: 4 },
    { id: 'normal', name: '普通', depth: 2, topN: 8 },
    { id: 'hard', name: '困难', depth: 3, topN: 10 },
    { id: 'pro', name: '专业', depth: 4, topN: 12 },
    { id: 'hell', name: '地狱', depth: 5, topN: 16 }
  ];

  function difficultyConfig(id) {
    return LEVELS.find(x => x.id === id) || LEVELS[2];
  }

  function shapeScoreFast(hand, levelRank) {
    const counts = new Map();
    let wild = 0, jokers = 0;
    for (const c of hand) {
      if (core.isWild(c, levelRank)) { wild++; continue; }
      if (c.rank === 'BJ' || c.rank === 'RJ') { jokers++; continue; }
      counts.set(c.rank, (counts.get(c.rank)||0)+1);
    }
    let pairs=0, triples=0, bombs=0, singles=0;
    for (const n of counts.values()) {
      if (n>=4) bombs++;
      if (n>=3) triples++;
      else if (n>=2) pairs++;
      else singles++;
    }
    const estimatedTurns = Math.max(1, Math.ceil((hand.length - triples*2 - pairs - bombs*3 - wild*1.5) / 2.2));
    return -hand.length*15 - estimatedTurns*6 + pairs*2 + triples*4 + bombs*6 + wild*3 + jokers*2;
  }

  function immediateScore(candidate, state, seat) {
    const p = candidate.pattern;
    const left = state.hands[seat].length - candidate.cards.length;
    let score = candidate.cards.length * 14 - p.mainValue * 0.25;
    if (core.isBomb(p)) score += left <= 5 ? 35 : -22;
    if (left === 0) score += 10000;
    else if (left <= 2) score += 90;
    const mate = (seat + 2) % 4;
    if (state.lastPlay && state.lastPlay.seat === mate && left > 2) score -= 65;
    const oppA = state.hands[(seat+1)%4]?.length ?? 99;
    const oppB = state.hands[(seat+3)%4]?.length ?? 99;
    if (Math.min(oppA,oppB) <= 3) score += p.mainValue*0.8 + (core.isBomb(p)?25:0);
    return score;
  }

  function futureScore(candidate, state, seat, depth) {
    const remain = core.removeCards(state.hands[seat], candidate.cards);
    let score = shapeScoreFast(remain, state.levelRank);
    if (depth < 2 || remain.length === 0) return score;
    const nextMoves = core.generateCandidates(remain, state.levelRank, null)
      .filter(x=>!core.isBomb(x.pattern) || remain.length<=7)
      .sort((a,b)=>b.cards.length-a.cards.length || a.pattern.mainValue-b.pattern.mainValue)
      .slice(0, Math.min(10, 2+depth*2));
    if (nextMoves.length) {
      const best = nextMoves[0];
      score += best.cards.length * (4+depth);
      if (depth >= 4) score += shapeScoreFast(core.removeCards(remain,best.cards), state.levelRank)*0.18;
    }
    return score;
  }


  function chooseReturnCard(state, seat) {
    const legal = core.getLegalReturnCards(state, seat);
    if (!legal.length) return null;
    const hand = state.hands[seat];
    let best = null;
    for (const card of legal) {
      const remain = core.removeCards(hand, [card]);
      const score = shapeScoreFast(remain, state.levelRank) - core.effectiveRankValue(card.rank, state.levelRank) * 0.05;
      if (!best || score > best.score) best = { card, score };
    }
    return best.card;
  }

  function chooseMove(state, seat, difficulty = 'normal') {
    const cfg = difficultyConfig(difficulty);
    const target = state.lastPlay && state.lastPlay.seat !== seat ? state.lastPlay.pattern : null;
    let candidates = core.generateCandidates(state.hands[seat], state.levelRank, target);
    if (!candidates.length) return { action: 'pass', reason: '无可压制牌型' };

    if (cfg.id === 'entry') {
      const nonBomb = candidates.filter(c=>!core.isBomb(c.pattern));
      const pool = nonBomb.length ? nonBomb : candidates;
      const pick = pool[Math.floor(Math.random()*pool.length)];
      return { action:'play', ...pick };
    }

    let scored = candidates.map(c=>({ ...c, score: immediateScore(c,state,seat) + shapeScoreFast(core.removeCards(state.hands[seat],c.cards),state.levelRank)*0.35 }));
    scored.sort((a,b)=>b.score-a.score);
    const finalists = scored.slice(0, cfg.topN);
    for (const c of finalists) {
      c.score += futureScore(c,state,seat,cfg.depth);
      if (cfg.id==='novice') c.score += Math.random()*18;
      else if (cfg.id==='normal') c.score += Math.random()*5;
    }
    finalists.sort((a,b)=>b.score-a.score);
    const best = finalists[0];

    const mate=(seat+2)%4;
    if (target && state.lastPlay?.seat===mate && state.hands[seat].length>2 && !core.isBomb(best.pattern)) {
      const passChance = cfg.id==='novice'?0.55:cfg.id==='normal'?0.75:0.9;
      if (Math.random()<passChance) return {action:'pass',reason:'让队友保留牌权'};
    }
    return { action:'play', cards:best.cards, pattern:best.pattern, score:best.score };
  }

  return { LEVELS, difficultyConfig, chooseMove, chooseReturnCard };
});
