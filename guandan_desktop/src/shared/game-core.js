(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GuandanCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SUITS = ['S', 'H', 'C', 'D'];
  const SUIT_SYMBOL = { S: '♠', H: '♥', C: '♣', D: '♦', J: '🃏' };
  const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));
  RANK_VALUE.BJ = 16;
  RANK_VALUE.RJ = 17;

  function makeDeck() {
    const cards = [];
    let id = 1;
    for (let deck = 0; deck < 2; deck++) {
      for (const suit of SUITS) {
        for (const rank of RANKS) cards.push({ id: `c${id++}`, suit, rank, deck });
      }
      cards.push({ id: `c${id++}`, suit: 'J', rank: 'BJ', deck });
      cards.push({ id: `c${id++}`, suit: 'J', rank: 'RJ', deck });
    }
    return cards;
  }

  function shuffle(cards, rng = Math.random) {
    const out = cards.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function isWild(card, levelRank) {
    return card && card.suit === 'H' && card.rank === levelRank;
  }

  function effectiveRankValue(rank, levelRank) {
    if (rank === 'BJ') return 16;
    if (rank === 'RJ') return 17;
    if (rank === levelRank) return 15;
    return RANK_VALUE[rank] || 0;
  }

  function sortCards(cards, levelRank) {
    return cards.slice().sort((a, b) => {
      const av = effectiveRankValue(a.rank, levelRank);
      const bv = effectiveRankValue(b.rank, levelRank);
      if (av !== bv) return av - bv;
      const sa = SUITS.indexOf(a.suit), sb = SUITS.indexOf(b.suit);
      return sa - sb;
    });
  }

  function rankCounts(cards) {
    const map = new Map();
    for (const c of cards) map.set(c.rank, (map.get(c.rank) || 0) + 1);
    return map;
  }

  function cloneWithRank(card, rank, suit) {
    return { ...card, rank, suit: suit || card.suit, _wildAs: rank };
  }

  function comparePatternStrength(a, b) {
    if (!a) return -1;
    if (!b) return 1;
    if (a.power !== b.power) return a.power - b.power;
    if ((a.bombSize || 0) !== (b.bombSize || 0)) return (a.bombSize || 0) - (b.bombSize || 0);
    return (a.mainValue || 0) - (b.mainValue || 0);
  }

  function expandWildAssignments(cards, levelRank, evaluator) {
    const wilds = cards.filter(c => isWild(c, levelRank));
    if (wilds.length === 0) return evaluator(cards);
    const fixed = cards.filter(c => !isWild(c, levelRank));
    const choices = RANKS;
    let best = null;
    function rec(idx, assigned) {
      if (idx === wilds.length) {
        const result = evaluator(fixed.concat(assigned));
        if (result && (!best || comparePatternStrength(result, best) > 0)) best = result;
        return;
      }
      for (const rank of choices) {
        assigned.push(cloneWithRank(wilds[idx], rank));
        rec(idx + 1, assigned);
        assigned.pop();
      }
    }
    rec(0, []);
    return best;
  }

  function straightHigh(ranks) {
    const vals = [...new Set(ranks.map(r => RANK_VALUE[r]).filter(Boolean))].sort((a,b)=>a-b);
    if (vals.length !== 5) return null;
    if (vals.join(',') === '2,3,4,5,14') return 5; // A2345
    for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[0] + i) return null;
    return vals[4];
  }

  // 常见竞赛口径：四炸 < 五炸 < 同花顺 < 六炸 < 七炸 < 八炸 < 四王炸。
  function bombPower(size) {
    if (size === 4) return 74;
    if (size === 5) return 75;
    if (size >= 6) return 70 + size; // 76 / 77 / 78
    return 0;
  }

  function evaluateNoWild(cards, originalCards, levelRank) {
    const n = cards.length;
    if (!n) return null;
    if (n === 4 && cards.every(c => c.rank === 'RJ' || c.rank === 'BJ')) {
      return { type: 'jokerBomb', name: '四王炸', power: 100, bombSize: 99, mainValue: 99, length: 4 };
    }
    const counts = rankCounts(cards);
    const maxEntry = [...counts.entries()].sort((a,b)=>b[1]-a[1])[0];
    const rv = r => effectiveRankValue(r, levelRank);

    if (counts.size === 1 && n >= 4 && n <= 8 && !['BJ','RJ'].includes(maxEntry[0])) {
      return { type: 'bomb', name: `${n}张炸弹`, power: bombPower(n), bombSize: n, mainValue: rv(maxEntry[0]), length: n };
    }

    if (n === 5) {
      const high = straightHigh(cards.map(c => c.rank));
      const fixedSuits = originalCards.map(c => isWild(c, levelRank) ? null : c.suit).filter(Boolean);
      const sameFixedSuit = fixedSuits.length === 0 || fixedSuits.every(s => s === fixedSuits[0]);
      if (high && sameFixedSuit) {
        return { type: 'straightFlush', name: '同花顺', power: 75.5, bombSize: 5.5, mainValue: high, length: 5 };
      }
    }

    if (n === 1) {
      const c = cards[0];
      return { type: 'single', name: '单张', power: 10, mainValue: rv(c.rank), length: 1 };
    }
    if (n === 2 && counts.size === 1) {
      return { type: 'pair', name: '对子', power: 20, mainValue: rv(maxEntry[0]), length: 2 };
    }
    if (n === 3 && counts.size === 1) {
      return { type: 'triple', name: '三张', power: 30, mainValue: rv(maxEntry[0]), length: 3 };
    }
    if (n === 5) {
      const nums = [...counts.values()].sort((a,b)=>a-b);
      if (nums.join(',') === '2,3') {
        const tripleRank = [...counts.entries()].find(([,c]) => c === 3)[0];
        return { type: 'fullHouse', name: '三带二', power: 40, mainValue: rv(tripleRank), length: 5 };
      }
      const high = straightHigh(cards.map(c => c.rank));
      if (high) return { type: 'straight', name: '顺子', power: 45, mainValue: high, length: 5 };
    }

    if (n === 6) {
      const nums = [...counts.values()].sort((a,b)=>a-b);
      if (counts.size === 3 && nums.every(x => x === 2)) {
        const vals = [...counts.keys()].map(r => RANK_VALUE[r]).sort((a,b)=>a-b);
        if (vals[1] === vals[0] + 1 && vals[2] === vals[0] + 2) {
          return { type: 'threePairs', name: '三连对', power: 50, mainValue: Math.max(...vals), length: 6 };
        }
      }
      if (counts.size === 2 && nums.every(x => x === 3)) {
        const vals = [...counts.keys()].map(r => RANK_VALUE[r]).sort((a,b)=>a-b);
        if (vals[1] === vals[0] + 1) {
          return { type: 'twoTriples', name: '钢板', power: 55, mainValue: vals[1], length: 6 };
        }
      }
    }
    return null;
  }

  function classifyHand(cards, levelRank) {
    if (!Array.isArray(cards) || cards.length === 0) return null;
    const original = cards.slice();
    return expandWildAssignments(original, levelRank, assigned => evaluateNoWild(assigned, original, levelRank));
  }

  function isBomb(pattern) {
    return pattern && ['bomb', 'straightFlush', 'jokerBomb'].includes(pattern.type);
  }

  function canBeat(candidate, target) {
    if (!candidate) return false;
    if (!target) return true;
    const cb = isBomb(candidate), tb = isBomb(target);
    if (cb && !tb) return true;
    if (!cb && tb) return false;
    if (cb && tb) {
      if (candidate.power !== target.power) return candidate.power > target.power;
      return candidate.mainValue > target.mainValue;
    }
    return candidate.type === target.type && candidate.length === target.length && candidate.mainValue > target.mainValue;
  }

  function cardText(card) {
    if (card.rank === 'BJ') return '小王';
    if (card.rank === 'RJ') return '大王';
    return `${SUIT_SYMBOL[card.suit] || ''}${card.rank}`;
  }

  function normalizeTeamLevels(teamLevels, fallback = '2') {
    if (!Array.isArray(teamLevels) || teamLevels.length !== 2) return [fallback, fallback];
    return teamLevels.map(r => RANKS.includes(r) ? r : fallback);
  }

  function dealHands(levelRank, seedRandom = Math.random) {
    const deck = shuffle(makeDeck(), seedRandom);
    const hands = [[],[],[],[]];
    deck.forEach((c, i) => hands[i % 4].push(c));
    for (let i = 0; i < 4; i++) hands[i] = sortCards(hands[i], levelRank);
    return hands;
  }

  function createInitialGame({
    levelRank = '2', dealer = 0, seedRandom = Math.random,
    teamLevels = null, levelTeam = 0, round = 1
  } = {}) {
    const levels = normalizeTeamLevels(teamLevels, levelRank);
    const currentRank = RANKS.includes(levelRank) ? levelRank : levels[levelTeam] || '2';
    levels[levelTeam] = currentRank;
    return {
      levelRank: currentRank,
      teamLevels: levels,
      levelTeam,
      dealer,
      turn: dealer,
      leader: dealer,
      lastPlay: null,
      passCount: 0,
      hands: dealHands(currentRank, seedRandom),
      finished: [],
      history: [{ type:'roundStart', round, levelRank:currentRank, at:Date.now() }],
      round,
      status: 'playing',
      phase: 'playing',
      result: null,
      previousResult: null,
      tribute: null,
      matchWinner: null
    };
  }

  function nextActiveSeat(state, from) {
    for (let k = 1; k <= 4; k++) {
      const s = (from + k) % 4;
      if (!state.finished.includes(s)) return s;
    }
    return from;
  }

  function activeSeats(state) {
    return [0,1,2,3].filter(s => !state.finished.includes(s));
  }

  function finishSeat(state, seat) {
    if (!state.finished.includes(seat)) {
      state.finished.push(seat);
      state.history.push({ type:'finish', seat, position:state.finished.length, at:Date.now() });
    }
  }

  function calculateUpgrade(finishOrder) {
    const first = finishOrder[0];
    const teammate = (first + 2) % 4;
    const matePos = finishOrder.indexOf(teammate);
    const upgrade = matePos === 1 ? 3 : matePos === 2 ? 2 : 1;
    return {
      winningTeam: first % 2,
      upgrade,
      doubleDown: matePos === 1,
      first,
      second: finishOrder[1],
      third: finishOrder[2],
      last: finishOrder[3],
      finishOrder: finishOrder.slice()
    };
  }

  function nextLevelRank(levelRank, steps) {
    const idx = RANKS.indexOf(levelRank);
    if (idx < 0) return '2';
    return RANKS[Math.min(RANKS.length - 1, idx + Math.max(0, steps || 0))];
  }

  function finalizeRound(state) {
    const result = calculateUpgrade(state.finished);
    const team = result.winningTeam;
    const before = state.teamLevels[team];
    let after = before;
    let matchWinner = null;
    let passedA = false;

    // “A级必打”：在 A 级取得头游且搭档为二游/三游才算过 A；头游+末游留在 A。
    if (before === 'A') {
      if (result.upgrade >= 2) {
        matchWinner = team;
        passedA = true;
      }
    } else {
      after = nextLevelRank(before, result.upgrade);
      state.teamLevels[team] = after;
    }

    result.levelBefore = before;
    result.levelAfter = after;
    result.passedA = passedA;
    result.matchWinner = matchWinner;
    state.result = result;
    state.matchWinner = matchWinner;
    state.status = matchWinner === null ? 'round-finished' : 'match-finished';
    state.phase = state.status;
    state.history.push({ type:'roundResult', ...result, at:Date.now() });
  }

  function playCards(state, seat, cardIds) {
    if (state.status !== 'playing') return { ok: false, error: state.status === 'tribute' ? '请先完成贡还牌' : '牌局未进行' };
    if (seat !== state.turn) return { ok: false, error: '还没轮到你' };
    const hand = state.hands[seat];
    const cards = cardIds.map(id => hand.find(c => c.id === id)).filter(Boolean);
    if (cards.length !== cardIds.length || cards.length === 0) return { ok: false, error: '请选择有效手牌' };
    const pattern = classifyHand(cards, state.levelRank);
    if (!pattern) return { ok: false, error: '这组牌不符合掼蛋牌型' };
    if (state.lastPlay && state.lastPlay.seat !== seat && !canBeat(pattern, state.lastPlay.pattern)) {
      return { ok: false, error: '当前牌型压不过上一手' };
    }
    const idSet = new Set(cardIds);
    state.hands[seat] = hand.filter(c => !idSet.has(c.id));
    state.lastPlay = { seat, cards, pattern };
    state.leader = seat;
    state.passCount = 0;
    state.history.push({ type: 'play', seat, cards: cards.map(cardText), pattern: pattern.name, at: Date.now() });

    if (state.hands[seat].length === 0) finishSeat(state, seat);
    if (state.finished.length >= 3) {
      const last = [0,1,2,3].find(s => !state.finished.includes(s));
      if (last !== undefined) finishSeat(state, last);
      finalizeRound(state);
      return { ok: true, finished: true, pattern, result:state.result };
    }
    state.turn = nextActiveSeat(state, seat);
    return { ok: true, pattern };
  }

  function requiredPassesForCurrentTrick(state) {
    if (!state.lastPlay) return 0;
    return activeSeats(state).filter(s => s !== state.lastPlay.seat).length;
  }

  function borrowWindSeat(state, finishedLeader) {
    const mate = (finishedLeader + 2) % 4;
    if (!state.finished.includes(mate)) return mate;
    return nextActiveSeat(state, finishedLeader);
  }

  function passTurn(state, seat) {
    if (state.status !== 'playing') return { ok: false, error: state.status === 'tribute' ? '请先完成贡还牌' : '牌局未进行' };
    if (seat !== state.turn) return { ok: false, error: '还没轮到你' };
    if (!state.lastPlay || state.lastPlay.seat === seat) return { ok: false, error: '你是领出方，不能不出' };
    state.passCount++;
    state.history.push({ type: 'pass', seat, at: Date.now() });

    const needed = requiredPassesForCurrentTrick(state);
    if (state.passCount >= needed) {
      const lead = state.leader;
      state.lastPlay = null;
      state.passCount = 0;
      state.turn = state.finished.includes(lead) ? borrowWindSeat(state, lead) : lead;
      state.leader = state.turn;
      if (state.finished.includes(lead)) state.history.push({ type:'borrowWind', from:lead, seat:state.turn, at:Date.now() });
    } else {
      state.turn = nextActiveSeat(state, seat);
    }
    return { ok: true };
  }

  function tributeCardValue(card, levelRank) {
    return effectiveRankValue(card.rank, levelRank);
  }

  function eligibleTributeCards(hand, levelRank) {
    // 红桃级牌（逢人配）不作为贡牌；其余牌按单张牌点比较。
    return hand.filter(c => !isWild(c, levelRank));
  }

  function chooseForcedTributeCard(hand, levelRank) {
    const eligible = eligibleTributeCards(hand, levelRank);
    if (!eligible.length) return null;
    return eligible.slice().sort((a,b) => tributeCardValue(b, levelRank) - tributeCardValue(a, levelRank))[0];
  }

  function hasTwoBigJokers(hand) {
    return hand.filter(c => c.rank === 'RJ').length >= 2;
  }

  function isReturnEligible(card, levelRank) {
    return effectiveRankValue(card.rank, levelRank) <= 10;
  }

  function getPendingReturnEntry(state, receiver) {
    if (!state.tribute || !Array.isArray(state.tribute.entries)) return null;
    return state.tribute.entries.find(e => e.receiver === receiver && !e.returnedCard) || null;
  }

  function getLegalReturnCards(state, receiver) {
    if (!state || state.status !== 'tribute' || !getPendingReturnEntry(state, receiver)) return [];
    let legal = state.hands[receiver].filter(c => isReturnEligible(c, state.levelRank));
    // 极端牌型兜底：如果没有 10 及以下，允许还当前手中最低非王牌，避免流程锁死。
    if (!legal.length) {
      legal = state.hands[receiver]
        .filter(c => c.rank !== 'BJ' && c.rank !== 'RJ')
        .sort((a,b)=>effectiveRankValue(a.rank,state.levelRank)-effectiveRankValue(b.rank,state.levelRank))
        .slice(0,1);
    }
    return legal;
  }

  function moveCard(state, from, to, card) {
    state.hands[from] = state.hands[from].filter(c => c.id !== card.id);
    state.hands[to].push(card);
    state.hands[to] = sortCards(state.hands[to], state.levelRank);
  }

  function resolveTributeTie(first, payers) {
    // 同点贡牌时按座次顺序处理：优先由头游的下家（+1 座）进贡给头游。
    const preferred = (first + 1) % 4;
    return payers.includes(preferred) ? preferred : payers.slice().sort((a,b)=>a-b)[0];
  }

  function prepareTribute(state, previousResult) {
    if (!previousResult) {
      state.status = 'playing'; state.phase = 'playing';
      return;
    }
    const order = previousResult.finishOrder;
    const first = order[0];
    const last = order[3];
    const doubleDown = !!previousResult.doubleDown;
    const tribute = {
      mode: doubleDown ? 'double' : 'single',
      anti: false,
      first,
      entries: [],
      startingSeat: first,
      complete: false
    };

    if (!doubleDown) {
      const payer = last;
      if (hasTwoBigJokers(state.hands[payer])) {
        tribute.anti = true;
        tribute.complete = true;
        tribute.startingSeat = first;
        state.tribute = tribute;
        state.status = 'playing'; state.phase = 'playing';
        state.turn = first; state.leader = first;
        state.history.push({ type:'antiTribute', mode:'single', seats:[payer], at:Date.now() });
        return;
      }
      const card = chooseForcedTributeCard(state.hands[payer], state.levelRank);
      if (!card) throw new Error('无法确定贡牌');
      moveCard(state, payer, first, card);
      tribute.entries.push({ payer, receiver:first, tributeCard:card, returnedCard:null });
      tribute.startingSeat = payer;
    } else {
      const payers = [order[2], order[3]];
      const receivers = [order[0], order[1]];
      const bigJokers = payers.reduce((sum,s)=>sum+state.hands[s].filter(c=>c.rank==='RJ').length,0);
      if (bigJokers >= 2) {
        tribute.anti = true;
        tribute.complete = true;
        tribute.startingSeat = first;
        state.tribute = tribute;
        state.status = 'playing'; state.phase = 'playing';
        state.turn = first; state.leader = first;
        state.history.push({ type:'antiTribute', mode:'double', seats:payers.slice(), at:Date.now() });
        return;
      }
      const offers = payers.map(payer => ({ payer, card:chooseForcedTributeCard(state.hands[payer], state.levelRank) }));
      if (offers.some(x=>!x.card)) throw new Error('无法确定双贡贡牌');
      const [a,b] = offers;
      const av = tributeCardValue(a.card,state.levelRank), bv = tributeCardValue(b.card,state.levelRank);
      let firstDonor;
      if (av > bv) firstDonor = a.payer;
      else if (bv > av) firstDonor = b.payer;
      else firstDonor = resolveTributeTie(first, payers);
      const secondDonor = payers.find(x=>x!==firstDonor);
      const byPayer = new Map(offers.map(x=>[x.payer,x.card]));
      const e1 = { payer:firstDonor, receiver:receivers[0], tributeCard:byPayer.get(firstDonor), returnedCard:null };
      const e2 = { payer:secondDonor, receiver:receivers[1], tributeCard:byPayer.get(secondDonor), returnedCard:null };
      // 先同时确定贡牌，再完成转移，避免第二个选择受第一笔转移影响。
      moveCard(state, e1.payer, e1.receiver, e1.tributeCard);
      moveCard(state, e2.payer, e2.receiver, e2.tributeCard);
      tribute.entries.push(e1,e2);
      tribute.startingSeat = firstDonor;
    }

    state.tribute = tribute;
    state.status = 'tribute';
    state.phase = 'tribute';
    state.turn = tribute.startingSeat;
    state.leader = tribute.startingSeat;
    for (const e of tribute.entries) {
      state.history.push({ type:'tribute', payer:e.payer, receiver:e.receiver, card:cardText(e.tributeCard), at:Date.now() });
    }
  }

  function returnTribute(state, receiver, cardId) {
    if (state.status !== 'tribute') return { ok:false, error:'当前不在还贡阶段' };
    const entry = getPendingReturnEntry(state, receiver);
    if (!entry) return { ok:false, error:'你当前不需要还贡' };
    const card = state.hands[receiver].find(c=>c.id===cardId);
    if (!card) return { ok:false, error:'请选择自己手中的牌' };
    const legalIds = new Set(getLegalReturnCards(state, receiver).map(c=>c.id));
    if (!legalIds.has(cardId)) return { ok:false, error:'还贡牌应为 10 或以下的合法牌' };
    moveCard(state, receiver, entry.payer, card);
    entry.returnedCard = card;
    state.history.push({ type:'returnTribute', payer:receiver, receiver:entry.payer, card:cardText(card), at:Date.now() });

    const pending = state.tribute.entries.some(e=>!e.returnedCard);
    if (!pending) {
      state.tribute.complete = true;
      state.status = 'playing';
      state.phase = 'playing';
      state.turn = state.tribute.startingSeat;
      state.leader = state.turn;
      state.lastPlay = null;
      state.passCount = 0;
      state.history.push({ type:'tributeComplete', startingSeat:state.turn, at:Date.now() });
    }
    return { ok:true, complete:!pending };
  }

  function createNextRound(previousState, { seedRandom = Math.random } = {}) {
    if (!previousState || previousState.status !== 'round-finished') throw new Error('当前牌局不能进入下一局');
    const result = previousState.result;
    const levelTeam = result.winningTeam;
    const teamLevels = previousState.teamLevels.slice();
    const levelRank = teamLevels[levelTeam];
    const first = result.finishOrder[0];
    const state = {
      levelRank,
      teamLevels,
      levelTeam,
      dealer:first,
      turn:first,
      leader:first,
      lastPlay:null,
      passCount:0,
      hands:dealHands(levelRank, seedRandom),
      finished:[],
      history:[{ type:'roundStart', round:previousState.round+1, levelRank, at:Date.now() }],
      round:previousState.round+1,
      status:'tribute',
      phase:'tribute',
      result:null,
      previousResult:{ ...result, finishOrder:result.finishOrder.slice() },
      tribute:null,
      matchWinner:null
    };
    prepareTribute(state, result);
    return state;
  }

  function publicState(state, seat = null) {
    const pending = seat === null ? null : getPendingReturnEntry(state, seat);
    const legalReturnIds = seat === null ? [] : getLegalReturnCards(state, seat).map(c=>c.id);
    return {
      levelRank: state.levelRank,
      teamLevels: state.teamLevels ? state.teamLevels.slice() : [state.levelRank,state.levelRank],
      levelTeam: state.levelTeam ?? 0,
      dealer: state.dealer,
      turn: state.turn,
      leader: state.leader,
      lastPlay: state.lastPlay ? { seat: state.lastPlay.seat, cards: state.lastPlay.cards, pattern: state.lastPlay.pattern } : null,
      passCount: state.passCount,
      handCounts: state.hands.map(h => h.length),
      myHand: seat === null ? [] : state.hands[seat],
      finished: state.finished.slice(),
      history: state.history.slice(-50),
      round: state.round,
      status: state.status,
      phase: state.phase,
      result: state.result,
      previousResult: state.previousResult,
      matchWinner: state.matchWinner,
      tribute: state.tribute ? {
        mode: state.tribute.mode,
        anti: state.tribute.anti,
        first: state.tribute.first,
        startingSeat: state.tribute.startingSeat,
        complete: state.tribute.complete,
        entries: state.tribute.entries.map(e=>({
          payer:e.payer, receiver:e.receiver,
          tributeCard:e.tributeCard,
          returnedCard:e.returnedCard
        }))
      } : null,
      pendingReturnForMe: pending ? { payer:pending.payer, receiver:pending.receiver, tributeCard:pending.tributeCard } : null,
      legalReturnCardIds: legalReturnIds
    };
  }

  function allocatePattern(byRank, wilds, needs) {
    const out = [];
    let wi = 0;
    const used = new Set();
    for (const [rank, count] of needs) {
      const group = (byRank.get(rank) || []).filter(c => !used.has(c.id));
      const take = group.slice(0, Math.min(group.length, count));
      take.forEach(c => { out.push(c); used.add(c.id); });
      for (let k = take.length; k < count; k++) {
        while (wi < wilds.length && used.has(wilds[wi].id)) wi++;
        if (wi >= wilds.length) return null;
        out.push(wilds[wi]); used.add(wilds[wi].id); wi++;
      }
    }
    return out;
  }

  function generateCandidates(hand, levelRank, targetPattern = null) {
    const candidates = [];
    const seen = new Set();
    function add(cards) {
      if (!cards || !cards.length) return;
      const ids = cards.map(c=>c.id).sort().join(',');
      if (seen.has(ids)) return;
      const pattern = classifyHand(cards, levelRank);
      if (!pattern) return;
      if (targetPattern && !canBeat(pattern, targetPattern)) return;
      seen.add(ids);
      candidates.push({ cards, pattern });
    }

    hand.forEach(c => add([c]));
    const wilds = hand.filter(c => isWild(c, levelRank));
    const byRank = new Map();
    for (const rank of RANKS) byRank.set(rank, []);
    for (const c of hand) {
      if (!isWild(c, levelRank) && !['BJ','RJ'].includes(c.rank)) byRank.get(c.rank).push(c);
    }

    for (const rank of RANKS) {
      const group = byRank.get(rank) || [];
      for (const n of [2,3]) {
        if (group.length + wilds.length >= n) add(group.slice(0, Math.min(group.length,n)).concat(wilds.slice(0, Math.max(0,n-group.length))));
      }
      for (let n=4; n<=Math.min(8, group.length + wilds.length); n++) {
        add(group.slice(0, Math.min(group.length,n)).concat(wilds.slice(0, Math.max(0,n-group.length))));
      }
    }
    if (wilds.length >= 2) {
      add(wilds.slice(0,2));
      if (wilds.length >= 3) add(wilds.slice(0,3));
    }

    const jokers = hand.filter(c => c.rank === 'BJ' || c.rank === 'RJ');
    if (jokers.length === 4) add(jokers);

    for (const tr of RANKS) {
      for (const pr of RANKS) {
        if (tr === pr) continue;
        add(allocatePattern(byRank, wilds, [[tr,3],[pr,2]]));
      }
    }

    const straightSeqs = [
      ['A','2','3','4','5'], ['2','3','4','5','6'], ['3','4','5','6','7'], ['4','5','6','7','8'],
      ['5','6','7','8','9'], ['6','7','8','9','10'], ['7','8','9','10','J'], ['8','9','10','J','Q'],
      ['9','10','J','Q','K'], ['10','J','Q','K','A']
    ];
    for (const seq of straightSeqs) {
      add(allocatePattern(byRank, wilds, seq.map(r=>[r,1])));
      for (const suit of SUITS) {
        const suitMap = new Map();
        for (const r of RANKS) suitMap.set(r, (byRank.get(r)||[]).filter(c=>c.suit===suit));
        add(allocatePattern(suitMap, wilds, seq.map(r=>[r,1])));
      }
    }

    const linear = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    for (let i=0;i<=linear.length-3;i++) add(allocatePattern(byRank, wilds, [[linear[i],2],[linear[i+1],2],[linear[i+2],2]]));
    for (let i=0;i<=linear.length-2;i++) add(allocatePattern(byRank, wilds, [[linear[i],3],[linear[i+1],3]]));

    return candidates;
  }

  function removeCards(hand, cards) {
    const ids = new Set(cards.map(c=>c.id));
    return hand.filter(c=>!ids.has(c.id));
  }

  return {
    SUITS, SUIT_SYMBOL, RANKS, RANK_VALUE,
    makeDeck, shuffle, isWild, sortCards, classifyHand, canBeat, isBomb, cardText,
    createInitialGame, createNextRound, playCards, passTurn, calculateUpgrade, nextLevelRank,
    publicState, generateCandidates, removeCards, effectiveRankValue,
    getLegalReturnCards, returnTribute, chooseForcedTributeCard, eligibleTributeCards,
    requiredPassesForCurrentTrick, borrowWindSeat
  };
});
