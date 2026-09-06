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

// 7) 地狱 AI 的决策只依赖自己的手牌、公开出牌记录和各家剩余张数；不读取对手暗牌内容
const hiddenA = core.createInitialGame({ levelRank:'2', dealer:0 });
const hiddenB = JSON.parse(JSON.stringify(hiddenA));
hiddenA.turn = hiddenB.turn = 0;
hiddenA.lastPlay = hiddenB.lastPlay = null;
// 只交换两个对手的暗牌内容，保持每家张数、我方手牌、公开历史完全一致
[hiddenB.hands[1], hiddenB.hands[3]] = [hiddenB.hands[3], hiddenB.hands[1]];
const hellA = AI.chooseMove(hiddenA,0,'hell');
const hellB = AI.chooseMove(hiddenB,0,'hell');
assert.equal(hellA.action, hellB.action);
if (hellA.action === 'play') assert.deepEqual(hellA.cards.map(c=>c.id), hellB.cards.map(c=>c.id));
console.log('hell AI hidden-card independence PASS');

// 8) 房间码：局域网 / 公网都能只靠房间码还原 IP 与端口
const net = require('../src/shared/network-code');
for (const mode of ['lan','public']) {
  const code = net.encodeRoomCode(mode,'192.168.0.100',37821);
  const decoded = net.decodeRoomCode(net.prettyRoomCode(code));
  assert.equal(decoded.mode, mode);
  assert.equal(decoded.ip, '192.168.0.100');
  assert.equal(decoded.port, 37821);
  assert.equal(decoded.roomCode, code);
}
console.log('room code roundtrip PASS');

// 9) 各家门前出牌：同一墩内保留各家最后一次已出的牌，新一墩领出时清空上一墩
const table = core.createInitialGame({ levelRank:'2', dealer:0 });
table.hands = [
  [card('a0','3','S'),card('a0b','7','S')],
  [card('a1','4','S'),card('a1b','8','S')],
  [card('a2','5','S'),card('a2b','9','S')],
  [card('a3','6','S'),card('a3b','10','S')]
];
table.turn=0;table.leader=0;table.lastPlay=null;table.tablePlays=[null,null,null,null];table.finished=[];table.status='playing';table.phase='playing';
assert(core.playCards(table,0,['a0']).ok);
assert.equal(table.tablePlays[0].cards[0].id,'a0');
assert(core.playCards(table,1,['a1']).ok);
assert.equal(table.tablePlays[1].cards[0].id,'a1');
assert(core.passTurn(table,2).ok);
assert(core.passTurn(table,3).ok);
assert(core.passTurn(table,0).ok);
assert.equal(table.lastPlay,null);
assert(core.playCards(table,1,['a1b']).ok);
assert.equal(table.tablePlays[0],null,'新一墩开始时应清掉上一墩门前牌');
assert.equal(table.tablePlays[1].cards[0].id,'a1b');
console.log('table play zones PASS');
