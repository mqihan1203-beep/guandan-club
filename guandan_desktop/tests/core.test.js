const assert = require('assert');
const core = require('../src/shared/game-core');
const AI = require('../src/shared/ai');

function card(id, rank, suit='S') { return { id, rank, suit, deck:0 }; }
function pattern(cards, level='2') { return core.classifyHand(cards, level); }

// 1) 炸弹层级：四炸 < 五炸 < 同花顺 < 六炸 < 七炸 < 八炸 < 四王炸
const four = pattern([card('1','A','S'),card('2','A','H'),card('3','A','C'),card('4','A','D')]);
const five = pattern([card('5','K','S'),card('6','K','H'),card('7','K','C'),card('8','K','D'),card('9','K','S')]);
const sf = pattern([card('10','5','S'),card('11','6','S'),card('12','7','S'),card('13','8','S'),card('14','9','S')]);
const six = pattern([card('15','Q','S'),card('16','Q','H'),card('17','Q','C'),card('18','Q','D'),card('19','Q','S'),card('20','Q','C')]);
const jokers = pattern([card('21','BJ','J'),card('22','BJ','J'),card('23','RJ','J'),card('24','RJ','J')]);
assert(core.canBeat(five, four));
assert(core.canBeat(sf, five));
assert(core.canBeat(six, sf));
assert(core.canBeat(jokers, six));

// 2) 升级与双下
assert.equal(core.calculateUpgrade([0,2,1,3]).upgrade, 3);
assert.equal(core.calculateUpgrade([0,2,1,3]).doubleDown, true);
assert.equal(core.calculateUpgrade([0,1,2,3]).upgrade, 2);
assert.equal(core.calculateUpgrade([0,1,3,2]).upgrade, 1);

// 3) 红桃级牌不进贡，其他级牌可进贡且牌点高于 A
const tributeHand = [card('t1','A','S'), card('t2','5','H'), card('t3','5','S'), card('t4','RJ','J')];
assert.equal(core.eligibleTributeCards(tributeHand,'5').some(c=>c.id==='t2'), false);
assert.equal(core.chooseForcedTributeCard(tributeHand,'5').id, 't4');
const withoutJoker = tributeHand.filter(c=>c.id!=='t4');
assert.equal(core.chooseForcedTributeCard(withoutJoker,'5').id, 't3');

// 4) 接风：领出者出完后，其余仍在场三家都过牌，由对家领出
const wind = core.createInitialGame({ levelRank:'2', dealer:0 });
wind.hands = [
  [card('w0','3','S')],
  [card('w1','4','S'),card('w1b','8','S')],
  [card('w2','5','S'),card('w2b','9','S')],
  [card('w3','6','S'),card('w3b','10','S')]
];
wind.turn=0; wind.leader=0; wind.lastPlay=null; wind.finished=[]; wind.status='playing'; wind.phase='playing';
assert(core.playCards(wind,0,['w0']).ok);
assert.equal(wind.finished[0],0);
assert.equal(wind.turn,1);
assert(core.passTurn(wind,1).ok);
assert(core.passTurn(wind,2).ok);
assert(core.passTurn(wind,3).ok);
assert.equal(wind.turn,2, '应由 0 号位的对家 2 号位接风');
assert.equal(wind.lastPlay,null);

// 5) 还贡合法牌：有效牌点必须 <= 10
const tributeState = {
  levelRank:'5', status:'tribute', phase:'tribute',
  hands:[
    [card('r1','3','S'),card('r2','5','S'),card('r3','J','S')],
    [],[],[card('p1','RJ','J')]
  ],
  tribute:{entries:[{payer:3,receiver:0,tributeCard:card('p1','RJ','J'),returnedCard:null}],startingSeat:3,complete:false},
  history:[], turn:3, leader:3, lastPlay:null, passCount:0
};
const legal = core.getLegalReturnCards(tributeState,0).map(c=>c.id);
assert(legal.includes('r1'));
assert(!legal.includes('r2')); // 5 是当前级牌，牌点按级牌计
assert(!legal.includes('r3'));
assert(core.returnTribute(tributeState,0,'r1').ok);
assert.equal(tributeState.status,'playing');
assert.equal(tributeState.turn,3);

// 6) 多局 AI 集成测试：出牌、贡还、下一局均不得锁死
function playOneMatch(maxRounds=18) {
  let g = core.createInitialGame({ levelRank:'2', dealer:0, teamLevels:['2','2'] });
  let rounds=0;
  while (rounds < maxRounds && g.status !== 'match-finished') {
    let guard=0;
    while (g.status === 'playing' && guard++ < 2000) {
      const seat=g.turn;
      const mv=AI.chooseMove(g,seat,'hell');
      const r=mv.action==='play' ? core.playCards(g,seat,mv.cards.map(c=>c.id)) : core.passTurn(g,seat);
      assert(r.ok, `AI 出牌失败: ${r.error||''}`);
    }
    assert(guard < 2000, '单局 AI 对战疑似死循环');
    assert(['round-finished','match-finished'].includes(g.status), `异常状态 ${g.status}`);
    rounds++;
    if (g.status === 'round-finished') {
      g=core.createNextRound(g);
      let tg=0;
      while(g.status==='tribute' && tg++<10) {
        const e=g.tribute.entries.find(x=>!x.returnedCard);
        assert(e,'贡还阶段无待处理项');
        const rc=AI.chooseReturnCard(g,e.receiver);
        assert(rc,'AI 无法选择还贡牌');
        assert(core.returnTribute(g,e.receiver,rc.id).ok);
      }
      assert(tg<10,'贡还阶段疑似死循环');
    }
  }
  return { rounds, status:g.status, teamLevels:g.teamLevels };
}
const sim=playOneMatch();
assert(sim.rounds>=1);
console.log('core.test.js PASS', sim);
