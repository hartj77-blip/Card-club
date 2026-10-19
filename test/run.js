// Engine tests: hand evaluation, meld finding, and long bot-vs-bot simulations
// that check every game runs to completion and chips are conserved.
const assert = require('assert');
const { bestHand, compareScores, describe } = require('../server/handeval');
const holdem = require('../server/games/holdem');
const spades = require('../server/games/spades');
const gin = require('../server/games/ginrummy');
const blackjack = require('../server/games/blackjack');
const yahtzee = require('../server/games/yahtzee');
const hearts = require('../server/games/hearts');
const solitaire = require('../server/games/solitaire');
const war = require('../server/games/war');
const { newDeck } = require('../server/cards');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n`, e); process.exitCode = 1; }
}

function makeCtx(chips) {
  return {
    getChips: (id) => chips[id] || 0,
    setChips: (id, v) => { chips[id] = v; },
    addChips: (id, d) => { chips[id] = (chips[id] || 0) + d; },
    log: () => {},
  };
}

const score = (cards) => bestHand(cards.split(' ')).score;

console.log('Hand evaluation');
test('categories', () => {
  assert.strictEqual(describe(score('AS KS QS JS TS 2D 3C')), 'Royal Flush');
  assert.strictEqual(score('5S 4S 3S 2S AS KD KC')[0], 8);
  assert.strictEqual(score('9S 9H 9D 9C 2S 3D 4C')[0], 7);
  assert.strictEqual(score('9S 9H 9D 4C 4S 3D 2C')[0], 6);
  assert.strictEqual(score('2H 7H 9H JH KH 3D 4C')[0], 5);
  assert.strictEqual(score('AS 2D 3C 4H 5S KD KC')[0], 4);
  assert.strictEqual(score('AS 2D 3C 4H 5S KD KC')[1], 5);
  assert.strictEqual(score('7S 7D 7C 2H 9S KD QC')[0], 3);
  assert.strictEqual(score('7S 7D 9C 9H 2S KD QC')[0], 2);
  assert.strictEqual(score('7S 7D 9C 3H 2S KD QC')[0], 1);
  assert.strictEqual(score('7S 4D 9C 3H 2S KD QC')[0], 0);
});
test('tiebreaks', () => {
  assert(compareScores(score('AS AD KC 7H 2S 3D 4C'), score('AS AD QC 7H 2S 3D 4C')) > 0);
  assert(compareScores(score('6S 5D 4C 3H 2S 9D 9C'), score('AS 2D 3C 4H 5S 9D 9C')) > 0);
  assert.strictEqual(compareScores(score('AS KD 7C 7H 2S 3D 4C'), score('AH KC 7D 7S 2D 3H 4S')), 0);
  assert(compareScores(score('KS KD 4C 4H 2S 2D AC'), score('KS KD 4C 4H 3S 3D QC')) > 0);
});

console.log('Gin melds');
test('finds sets and runs', () => {
  const b = gin.bestMelds(['AS', '2S', '3S', '7H', '7D', '7C', 'KD', 'QD', 'JD', '5C']);
  assert.strictEqual(b.deadwood, 5);
  assert.strictEqual(b.melds.length, 3);
});
test('shares a card between a set and a run optimally', () => {
  // 7S can go in the 7-set or the 5-6-7 run; best is set of 7s (H,D,C) + run 5S6S7S.
  const b = gin.bestMelds(['5S', '6S', '7S', '7H', '7D', '7C', '2C', '3D', '4H', '9C']);
  assert.strictEqual(b.deadwood, 18);
});
test('lay off extends runs and sets', () => {
  const r = gin.layOff([['4H', '5H', '6H'], ['9S', '9D', '9C']], ['3H', '7H', '9H', 'KC']);
  assert.deepStrictEqual(r.remaining, ['KC']);
});

// Drive a game with autoAction until it waits on nobody (or the step limit).
function drive(mod, state, ids, ctx, steps, onIdle) {
  for (let i = 0; i < steps; i++) {
    const waiting = mod.waitingOn(state);
    if (!waiting.length) { if (!onIdle(state)) return i; continue; }
    const id = waiting[0];
    const a = mod.autoAction(state, id, true, ctx);
    assert(a, `no auto action for ${id}`);
    mod.act(state, id, a, ctx);
  }
  return steps;
}

console.log('Simulations');
test("hold'em: 3000 hands, chips conserved, side pots settle", () => {
  for (let table = 0; table < 30; table++) {
    const n = 2 + (table % 8);
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const chips = {};
    ids.forEach((id, i) => { chips[id] = 200 + i * 150; });
    const total = Object.values(chips).reduce((a, b) => a + b, 0);
    const ctx = makeCtx(chips);
    const s = holdem.create(ids.map((id) => ({ id, name: id })), { smallBlind: 5, bigBlind: 10 }, ctx);
    let hands = 0;
    drive(holdem, s, ids, ctx, 200000, (st) => {
      assert.strictEqual(Object.values(chips).reduce((a, b) => a + b, 0), total, 'chips not conserved');
      if (st.hand.phase === 'waiting' || hands++ >= 100) return false;
      holdem.act(st, ids[0], { type: 'next' }, ctx);
      return true;
    });
    for (const v of Object.values(chips)) assert(v >= 0);
    holdem.view(s, ids[0], ctx);
  }
});
test("hold'em: min raise and turn enforcement", () => {
  const chips = { a: 1000, b: 1000, c: 1000 };
  const ctx = makeCtx(chips);
  const s = holdem.create([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }], { smallBlind: 10, bigBlind: 20 }, ctx);
  const first = holdem.waitingOn(s)[0];
  const other = ['a', 'b', 'c'].find((x) => x !== first);
  assert.throws(() => holdem.act(s, other, { type: 'call' }, ctx), /not your turn/);
  assert.throws(() => holdem.act(s, first, { type: 'check' }, ctx), /call or fold/);
  assert.throws(() => holdem.act(s, first, { type: 'raise', amount: 30 }, ctx), /Minimum raise/);
  holdem.act(s, first, { type: 'raise', amount: 40 }, ctx);
  assert.strictEqual(s.hand.currentBet, 40);
});
test("hold'em bots: win estimates match known odds", () => {
  const avg = (hole, board, opp) => { let t = 0; for (let i = 0; i < 8; i++) t += holdem.estimateEquity(hole, board, opp); return t / 8; };
  const near = (v, want) => assert(Math.abs(v - want) < 0.04, `got ${v.toFixed(3)}, expected ~${want}`);
  near(avg(['AS', 'AH'], [], 1), 0.85);
  near(avg(['7S', '2H'], [], 1), 0.35);
  near(avg(['AS', 'AH'], [], 3), 0.64);
});
test("hold'em bots: never shove a deep stack with a below-average hand", () => {
  const ids = ['a', 'b', 'c', 'd'];
  const chips = {};
  const ctx = makeCtx(chips);
  const reset = () => ids.forEach((i) => { chips[i] = 1000; });
  reset();
  const s = holdem.create(ids.map((id) => ({ id, name: id })), { smallBlind: 10, bigBlind: 20 }, ctx);
  let hands = 0;
  let shoves = 0;
  while (hands < 300) {
    const w = holdem.waitingOn(s);
    if (!w.length) {
      hands++;
      if (ids.filter((i) => chips[i] > 0).length < 2 || s.hand.phase === 'waiting') reset();
      holdem.act(s, 'a', { type: 'next' }, ctx);
      continue;
    }
    const h = s.hand;
    const p = h.players[h.toAct];
    const opp = h.players.filter((x) => !x.folded).length - 1;
    const deep = p.stack + p.bet >= 15 * s.options.bigBlind;
    const a = holdem.autoAction(s, w[0], true, ctx);
    const before = p.allIn;
    holdem.act(s, w[0], a, ctx);
    if (!before && p.allIn && deep && a.type === 'raise') {
      shoves++;
      assert(holdem.estimateEquity(p.hole, h.board, opp) > 1 / (opp + 1), 'bot shoved a weak hand');
    }
  }
  assert(shoves < 60, `too many shoves: ${shoves}`);
});
test('spades: 40 full games to completion', () => {
  for (let g = 0; g < 40; g++) {
    const ids = ['a', 'b', 'c', 'd'];
    const ctx = makeCtx({});
    const s = spades.create(ids.map((id) => ({ id, name: id })), { target: 300 }, ctx);
    drive(spades, s, ids, ctx, 100000, (st) => {
      if (st.over) return false;
      spades.act(st, 'a', { type: 'next' }, ctx);
      return true;
    });
    assert(s.over, 'game did not finish');
    assert.strictEqual(s.over.winners.length, 2);
    for (const r of s.history) assert.strictEqual(r.tricks.reduce((a, b) => a + b, 0), 13);
  }
});
test('spades: must follow suit and cannot lead unbroken spades', () => {
  const ctx = makeCtx({});
  const s = spades.create(['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })), { target: 500 }, ctx);
  s.round.hands = [['AS', '2H'], ['3H', 'KS'], ['4H', '5D'], ['6H', '7C']];
  s.round.phase = 'playing';
  s.round.turn = 0;
  assert.deepStrictEqual(spades.legalCards(s, 0), ['2H']);
  spades.act(s, 'a', { type: 'play', card: '2H' }, ctx);
  assert.throws(() => spades.act(s, 'b', { type: 'play', card: 'KS' }, ctx), /can't play/);
});
test('spades bots: bid Nil only with a hand that can duck', () => {
  const ctx = makeCtx({});
  const s = spades.create(['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })), { target: 500 }, ctx);
  s.round.turn = 0;
  s.round.hands[0] = ['2S', '5S', '2H', '4H', '6H', '7H', '3D', '5D', '6D', '2C', '3C', '4C', '7C'];
  assert.strictEqual(spades.autoAction(s, 'a').bid, 0, 'weak low hand should bid Nil');
  s.round.hands[0] = ['AS', 'KS', 'QS', '9S', 'AH', 'KH', '4H', 'AD', '5D', '6D', '2C', '3C', '4C'];
  assert(spades.autoAction(s, 'a').bid >= 5, 'strong hand should bid high');
});
test('spades bots: shed winners instead of taking bags once the bid is made', () => {
  const ctx = makeCtx({});
  const s = spades.create(['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })), { target: 500 }, ctx);
  const r = s.round;
  r.phase = 'playing';
  r.bids = [2, 3, 2, 3];
  r.tricks = [3, 4, 1, 1]; // we've made our 4; they have 5 of 6, so there's no setting them
  r.hands = [['KH', '3H', '4D', '5C'], ['2H', '6D', '7C', '8C'], ['QH', '9D', '9C', 'TC'], ['5H', 'TD', 'JC', 'QC']];
  r.trick = [{ seat: 3, card: '5H' }];
  r.turn = 0;
  r.played = [];
  // Opponents' 5H leads; KH would win (a bag). Expect the bot to duck with 3H.
  assert.strictEqual(spades.autoAction(s, 'a').card, '3H');
});
test('gin bots: avoid discarding a card the opponent is collecting', () => {
  const ctx = makeCtx({});
  const s = gin.create([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], { target: 100 }, ctx);
  const r = s.round;
  r.turn = 0;
  r.phase = 'discard';
  r.takenFromDiscard = null;
  r.hands[0] = ['AS', '2S', '3S', '4D', '5D', '6D', 'JC', 'JD', 'JH', '9H', '8C'];
  r.known[1] = ['TH']; // opponent picked up the 10 of hearts, so the 9 of hearts would help them
  // Rebuild the rest of the deal around this hand so no card appears twice.
  const rest = newDeck().filter((c) => !r.hands[0].includes(c) && c !== 'TH' && c !== 'KS');
  r.hands[1] = ['TH'].concat(rest.slice(0, 9));
  r.discard = ['KS'];
  r.stock = rest.slice(9, 24); // 15 left: mid-hand
  const a = gin.autoAction(s, 'a');
  assert.strictEqual(a.type, 'discard');
  assert.strictEqual(a.card, '8C', 'should keep the 9H away from the opponent even though it scores 1 more');
});
test('gin rummy: 60 full games to completion', () => {
  for (let g = 0; g < 60; g++) {
    const ctx = makeCtx({});
    const s = gin.create([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], { target: 100 }, ctx);
    drive(gin, s, ['a', 'b'], ctx, 200000, (st) => {
      if (st.over) return false;
      const r = st.round;
      if (r.result && r.result.type === 'biggin') assert.strictEqual(r.hands[r.result.knocker].length, 11);
      else for (const h of r.hands) assert.strictEqual(h.length, 10);
      gin.act(st, 'a', { type: 'next' }, ctx);
      return true;
    });
    assert(s.over);
    gin.view(s, 'a');
  }
});
test('blackjack: 2000 rounds, payouts sane', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const chips = {};
  ids.forEach((id) => { chips[id] = 100000; });
  const ctx = makeCtx(chips);
  const s = blackjack.create(ids.map((id) => ({ id, name: id })), { minBet: 10, maxBet: 500, decks: 2 }, ctx);
  let rounds = 0;
  drive(blackjack, s, ids, ctx, 400000, (st) => {
    if (rounds++ >= 2000) return false;
    assert.strictEqual(st.phase, 'settled');
    for (const id of ids) blackjack.view(st, id, ctx);
    blackjack.act(st, 'a', { type: 'next' }, ctx);
    return true;
  });
  assert(rounds >= 2000);
  const { handTotal } = blackjack;
  assert.deepStrictEqual(handTotal(['AS', 'AD', '9C']), { total: 21, soft: true });
  assert.deepStrictEqual(handTotal(['KS', 'QD', '5C']), { total: 25, soft: false });
});

console.log('Yahtzee');
test('scores every box correctly', () => {
  const r = yahtzee.rawScore;
  assert.strictEqual(r('fives', [5, 5, 2, 5, 1]), 15);
  assert.strictEqual(r('threeKind', [4, 4, 4, 2, 1]), 15);
  assert.strictEqual(r('threeKind', [4, 4, 3, 2, 1]), 0);
  assert.strictEqual(r('fourKind', [6, 6, 6, 6, 1]), 25);
  assert.strictEqual(r('fullHouse', [2, 2, 3, 3, 3]), 25);
  assert.strictEqual(r('fullHouse', [3, 3, 3, 3, 3]), 0);
  assert.strictEqual(r('smallStraight', [3, 4, 5, 6, 6]), 30);
  assert.strictEqual(r('smallStraight', [1, 2, 3, 5, 6]), 0);
  assert.strictEqual(r('largeStraight', [1, 2, 3, 4, 5]), 40);
  assert.strictEqual(r('yahtzee', [2, 2, 2, 2, 2]), 50);
  assert.strictEqual(r('chance', [1, 2, 3, 4, 6]), 16);
});
test('upper bonus at 63 and joker / Yahtzee bonus rules', () => {
  const card = Object.fromEntries(['ones', 'twos', 'threes', 'fours', 'fives', 'sixes', 'threeKind', 'fourKind', 'fullHouse', 'smallStraight', 'largeStraight', 'yahtzee', 'chance'].map((c) => [c, null]));
  Object.assign(card, { ones: 3, twos: 6, threes: 9, fours: 12, fives: 15, sixes: 18 });
  assert.strictEqual(yahtzee.totals(card, 0).bonus, 35);
  // Extra Yahtzee with its upper box filled: lower boxes score full joker value.
  const c2 = { ...card, yahtzee: 50 };
  const opts = yahtzee.options(c2, [4, 4, 4, 4, 4]);
  assert.strictEqual(opts.fullHouse, 25);
  assert.strictEqual(opts.largeStraight, 40);
  assert(!('fours' in opts));
  // With the matching upper box open, it must go there.
  const c3 = { ...c2, fours: null };
  assert.deepStrictEqual(Object.keys(yahtzee.options(c3, [4, 4, 4, 4, 4])), ['fours']);
  // The bonus is awarded through act().
  const s = yahtzee.create([{ id: 'a', name: 'a' }]);
  s.cards[0].yahtzee = 50;
  s.rollsLeft = 1;
  s.dice = [6, 6, 6, 6, 6];
  yahtzee.act(s, 'a', { type: 'score', category: 'sixes' }, makeCtx({}));
  assert.strictEqual(s.yahtzeeBonus[0], 100);
});
test('turn rules: roll first, max three rolls, held dice stay put', () => {
  const ctx = makeCtx({});
  const s = yahtzee.create([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }]);
  assert.throws(() => yahtzee.act(s, 'a', { type: 'score', category: 'chance' }, ctx), /Roll first/);
  assert.throws(() => yahtzee.act(s, 'b', { type: 'roll' }, ctx), /not your turn/);
  yahtzee.act(s, 'a', { type: 'roll' }, ctx);
  const kept = s.dice[0];
  yahtzee.act(s, 'a', { type: 'hold', index: 0 }, ctx);
  yahtzee.act(s, 'a', { type: 'roll' }, ctx);
  yahtzee.act(s, 'a', { type: 'roll' }, ctx);
  assert.strictEqual(s.dice[0], kept);
  assert.throws(() => yahtzee.act(s, 'a', { type: 'roll' }, ctx), /No rolls left/);
  yahtzee.act(s, 'a', { type: 'score', category: 'chance' }, ctx);
  assert.strictEqual(s.turn, 1);
});
test('bots finish 60 three-player games with sensible scores', () => {
  const ctx = makeCtx({});
  let total = 0;
  for (let g = 0; g < 60; g++) {
    const s = yahtzee.create(['a', 'b', 'c'].map((id) => ({ id, name: id })));
    for (let i = 0; i < 1000 && !s.over; i++) {
      const id = yahtzee.waitingOn(s)[0];
      yahtzee.act(s, id, yahtzee.autoAction(s, id), ctx);
    }
    assert(s.over, 'game did not finish');
    for (let i = 0; i < 3; i++) {
      assert(Object.values(s.cards[i]).every((v) => v !== null), 'scorecard not full');
      total += yahtzee.totals(s.cards[i], s.yahtzeeBonus[i]).total;
    }
  }
  assert(total / 180 > 190, `bots average only ${(total / 180).toFixed(0)}`);
});

console.log('Hearts, Solitaire, War');
test('hearts: 100 bot games finish, every hand is worth 26', () => {
  const ctx = makeCtx({});
  for (let g = 0; g < 100; g++) {
    const s = hearts.create(['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })), { target: 100 }, ctx);
    for (let i = 0; i < 20000 && !s.over; i++) {
      const w = hearts.waitingOn(s);
      if (!w.length) { hearts.act(s, 'a', { type: 'next' }, ctx); continue; }
      hearts.act(s, w[0], hearts.autoAction(s, w[0]), ctx);
    }
    assert(s.over, 'game did not finish');
    for (const h of s.history) {
      assert.strictEqual(h.taken.reduce((x, y) => x + y, 0), 26);
      assert.strictEqual(h.delta.reduce((x, y) => x + y, 0), h.shooter >= 0 ? 78 : 26);
    }
  }
});
test('hearts: 2 of clubs leads, no points on trick one, hearts must be broken', () => {
  const ctx = makeCtx({});
  const s = hearts.create(['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })), { target: 100 }, ctx);
  const r = s.round;
  r.phase = 'playing';
  r.hands = [['2C', '3H', '4D'], ['QS', 'AH', '9D'], ['5C', '6C', '7C'], ['8C', '9C', 'KH']];
  r.turn = 0;
  r.trickNo = 0;
  assert.deepStrictEqual(hearts.legalCards(s, 0), ['2C']);
  hearts.act(s, 'a', { type: 'play', card: '2C' }, ctx);
  // Seat 1 is void in clubs but can't dump points on the first trick.
  assert.deepStrictEqual(hearts.legalCards(s, 1), ['9D']);
  // Later, hearts can't be led until broken (unless that's all you have).
  r.trick = []; r.trickNo = 1; r.turn = 3; r.hands[3] = ['KH', '9C'];
  assert.deepStrictEqual(hearts.legalCards(s, 3), ['9C']);
});
test('hearts: shooting the moon gives everyone else 26', () => {
  const ctx = makeCtx({});
  const s = hearts.create(['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })), { target: 100 }, ctx);
  const r = s.round;
  r.phase = 'playing';
  r.hands = [['AH'], ['2C'], ['3C'], ['4C']];
  r.taken = [25, 0, 0, 0]; // queen of spades (13) and 12 hearts already
  r.trickNo = 12; r.turn = 0; r.trick = [];
  r.heartsBroken = true;
  for (const [id, c] of [['a', 'AH'], ['b', '2C'], ['c', '3C'], ['d', '4C']]) hearts.act(s, id, { type: 'play', card: c }, ctx);
  assert.deepStrictEqual(s.scores, [0, 26, 26, 26]);
});
test('solitaire: legal moves, undo, and no cards lost over 300 auto-played deals', () => {
  assert(solitaire.canTableau({ cards: ['8H'], up: 0 }, '7S'));
  assert(!solitaire.canTableau({ cards: ['8H'], up: 0 }, '7D'));
  assert(solitaire.canTableau({ cards: [], up: 0 }, 'KC'));
  assert(!solitaire.canTableau({ cards: [], up: 0 }, 'QC'));
  for (let g = 0; g < 300; g++) {
    const s = solitaire.create([{ id: 'a', name: 'a' }], { draw: g % 2 ? 3 : 1 });
    for (let i = 0; i < 400 && !s.over; i++) {
      let moved = false;
      for (let p = 0; p < 7 && !moved; p++) {
        const pile = s.tableau[p];
        if (!pile.cards.length) continue;
        const from = { type: 'tableau', pile: p, index: pile.cards.length - 1 };
        const to = solitaire.autoDestination(s, from);
        if (to && to.type === 'foundation') { solitaire.act(s, 'a', { type: 'move', from, to }); moved = true; }
      }
      if (!moved) {
        try { solitaire.act(s, 'a', { type: 'draw' }); } catch { solitaire.act(s, 'a', { type: 'resign' }); }
      }
      const all = [...s.stock, ...s.waste, ...Object.values(s.foundations).flat(), ...s.tableau.flatMap((x) => x.cards)];
      assert.strictEqual(new Set(all).size, 52);
    }
    if (!s.over) solitaire.act(s, 'a', { type: 'resign' });
    assert(s.over.summary.includes('a '));
  }
  const s = solitaire.create([{ id: 'a', name: 'a' }], { draw: 1 });
  const before = JSON.stringify(s.tableau);
  solitaire.act(s, 'a', { type: 'draw' });
  solitaire.act(s, 'a', { type: 'undo' });
  assert.strictEqual(JSON.stringify(s.tableau), before);
  assert.strictEqual(s.stock.length, 24);
  assert.throws(() => solitaire.act(s, 'someone-else', { type: 'draw' }), /watching/);
});
test('war: 500 games keep all 52 cards and always finish', () => {
  const ctx = makeCtx({});
  for (let g = 0; g < 500; g++) {
    const s = war.create([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], { maxRounds: 300 }, ctx);
    while (!s.over) {
      for (const id of war.waitingOn(s)) war.act(s, id, war.autoAction(s, id), ctx);
      assert.strictEqual(s.piles[0].length + s.piles[1].length, 52);
    }
    assert(s.round <= 300);
  }
});


// --- Room-level tests: the same code path real players hit through protocol.js ---
const { Rooms, GAMES } = require('../server/rooms');

function makeRooms() {
  const rooms = new Rooms({ storage: { load: () => null, save() {} } });
  rooms.scheduleAuto = () => {}; // drive bots by hand so tests stay synchronous
  rooms.save = () => {};
  return rooms;
}
function fakeConn(id, name) {
  const sent = [];
  return { player: { id, name }, readyState: 1, roomCode: null, sent, send: (m) => sent.push(JSON.parse(m)) };
}
// A room with `humans` connected players plus `bots` bots, game selected.
function setupRoom(gameId, humans, bots) {
  const rooms = makeRooms();
  const conns = Array.from({ length: humans }, (_, i) => fakeConn(`p${i}`, `P${i}`));
  const room = rooms.create(conns[0].player);
  for (const c of conns) rooms.join(room.code, c);
  for (let i = 0; i < bots; i++) rooms.command(room.code, conns[0], { t: 'addBot' });
  rooms.command(room.code, conns[0], { t: 'selectGame', game: gameId });
  return { rooms, room, conns };
}
const totalChips = (room) => Object.values(room.chips).reduce((a, b) => a + b, 0);
const totalBuyins = (room) => Object.values(room.buyins).reduce((a, b) => a + b, 0);
function tryCmd(rooms, room, conn, msg) {
  try { rooms.command(room.code, conn, msg); return true; } catch { return false; }
}

console.log('Rooms');
test('rebuy: only when short, fixed amount, tracked in buy-ins', () => {
  const { rooms, room, conns } = setupRoom('holdem', 2, 1);
  const [a, b] = conns;
  const start = room.settings.startingChips;
  // A full stack can't rebuy, and a client can't pick its own amount.
  assert.throws(() => rooms.command(room.code, a, { t: 'rebuy', amount: 999999 }), /only rebuy/i);
  assert.strictEqual(room.chips.p0, start);
  assert.strictEqual(room.buyins.p0, start);
  // Once short, one rebuy goes through; a duplicate (double click) does not.
  room.chips.p0 = 0;
  rooms.command(room.code, a, { t: 'rebuy', amount: 999999 });
  assert.strictEqual(room.chips.p0, start);
  assert.strictEqual(room.buyins.p0, start * 2);
  assert.throws(() => rooms.command(room.code, a, { t: 'rebuy' }), /only rebuy/i);
  assert.strictEqual(room.buyins.p0, start * 2);
  // Net stays honest: chips minus buy-ins.
  const me = rooms.viewFor(room, 'p0').members.find((m) => m.id === 'p0');
  assert.strictEqual(me.net, -start);
  // Bot top-ups: host only, bots only, and only when the bot is short.
  const bot = [...room.members.values()].find((m) => m.isBot);
  assert.throws(() => rooms.command(room.code, b, { t: 'botRebuy', id: bot.id }), /host/i);
  assert.throws(() => rooms.command(room.code, a, { t: 'botRebuy', id: bot.id }), /only rebuy/i);
  assert.throws(() => rooms.command(room.code, a, { t: 'botRebuy', id: 'p1' }), /no such bot/i);
  room.chips[bot.id] = 5;
  rooms.command(room.code, a, { t: 'botRebuy', id: bot.id });
  assert.strictEqual(room.chips[bot.id], start + 5);
  assert.throws(() => rooms.command(room.code, a, { t: 'botRebuy', id: bot.id }), /only rebuy/i);
  // Someone who was removed from the room can't touch the bank.
  room.chips.p1 = 0;
  rooms.command(room.code, a, { t: 'kick', id: 'p1' });
  assert.throws(() => rooms.command(room.code, b, { t: 'rebuy' }), /not in this room/i);
  assert.strictEqual(room.chips.p1, 0);
});

test('lobby commands: host-only actions are rejected for guests', () => {
  const { rooms, room, conns } = setupRoom('spades', 2, 2);
  const guest = conns[1];
  for (const msg of [
    { t: 'selectGame', game: 'hearts' }, { t: 'setOption', key: 'target', value: 100 },
    { t: 'setStartingChips', value: 1000000 }, { t: 'addBot' }, { t: 'kick', id: 'p0' },
    { t: 'resetScores' }, { t: 'start' }, { t: 'shuffleSeats' }, { t: 'togglePlaying', id: 'p0' },
  ]) {
    const before = JSON.stringify(rooms.viewFor(room, 'p0'));
    assert.throws(() => rooms.command(room.code, guest, msg), /host/i, msg.t);
    // Chat aside, nothing visible changed.
    assert.strictEqual(JSON.stringify(rooms.viewFor(room, 'p0')).replace(/"chat":\[.*?\],"history"/, ''), before.replace(/"chat":\[.*?\],"history"/, ''), msg.t);
  }
});

// Throw junk, out-of-turn and duplicate actions at every game while bots play it
// out. Nothing may crash the room, chips must be conserved, and the game must end.
const JUNK_TYPES = ['bet', 'call', 'check', 'fold', 'raise', 'allin', 'hit', 'stand', 'double', 'split', 'skip', 'unbet', 'deal', 'next',
  'draw', 'discard', 'knock', 'gin', 'undercut', 'layoff', 'play', 'pass', 'bid', 'move', 'auto', 'finish', 'undo', 'roll', 'hold', 'score', 'flip', 'ready', 'leave', 'nope', 42, null];
const JUNK_VALUES = [undefined, null, -1, 0, 1, 2.5, 13, 1e15, NaN, Infinity, '', 'AS', '2C', 'QH', 'TS', 'ZZ', 'stock', 'discard', 'waste',
  [], {}, ['2C', '3C', '4C'], ['AS', 'AS', 'AS'], { type: 'tableau', index: 3 }, { type: 'foundation' }, 'yahtzee', 'chance', [true, false, true], '__proto__'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function junkAction() {
  const a = { type: pick(JUNK_TYPES) };
  for (const k of ['amount', 'value', 'card', 'cards', 'bid', 'from', 'to', 'category', 'held', 'index']) if (Math.random() < 0.3) a[k] = pick(JUNK_VALUES);
  return a;
}
const FUZZ = [['holdem', 3, 2], ['blackjack', 2, 2], ['spades', 2, 2], ['hearts', 2, 2], ['ginrummy', 2, 0], ['war', 2, 0], ['yahtzee', 2, 1], ['solitaire', 1, 0]];
for (const [gameId, humans, bots] of FUZZ) {
  test(`fuzz ${GAMES[gameId].meta.name}: junk and out-of-turn actions never corrupt the room`, () => {
    for (let run = 0; run < 6; run++) {
      const { rooms, room, conns } = setupRoom(gameId, humans, bots);
      if (GAMES[gameId].meta.options.some((o) => o.key === 'stake')) rooms.command(room.code, conns[0], { t: 'setOption', key: 'stake', value: 50 });
      const chipsBefore = totalChips(room) - totalBuyins(room);
      rooms.command(room.code, conns[0], { t: 'start' });
      const g = room.game;
      let steps = 0;
      while (!g.over && steps++ < 6000) {
        // Junk from anyone, including spectators and players whose turn it isn't.
        if (Math.random() < 0.4) {
          tryCmd(rooms, room, pick(conns), { t: 'act', action: junkAction() });
          if (Math.random() < 0.05) tryCmd(rooms, room, pick(conns), { t: pick(['act', 'start', 'sitIn', 'rebuy', 'bogus']), action: 'x' });
        }
        if (room.game !== g) break;
        // Every view must still render without leaking an error.
        for (const id of g.playerIds) assert(!(rooms.viewFor(room, id).game.view || {}).error, `${gameId} view broke`);
        const waiting = g.module.waitingOn(g.state);
        if (!waiting.length) {
          // Continuous games idle between rounds; let a player move them along.
          const next = gameId === 'holdem' ? null : { type: 'next' };
          if (next) tryCmd(rooms, room, conns[0], { t: 'act', action: next });
          if (gameId === 'holdem' && g.state.hand.phase !== 'betting') { const { act } = g.module; try { act(g.state, conns[0].player.id, { type: 'next' }, rooms.ctx(room)); } catch {} }
          if (!g.module.waitingOn(g.state).length && g.module.meta.continuous && steps > 300) break;
          if (!g.module.waitingOn(g.state).length && !g.module.meta.continuous) assert.fail(`${gameId} stuck waiting on nobody`);
          if (g.module.meta.continuous && !g.module.waitingOn(g.state).length) { rooms.endGame(room); break; }
          continue;
        }
        const id = waiting[0];
        const isBot = !id.startsWith('p');
        const action = g.module.autoAction(g.state, id, true, rooms.ctx(room)) || g.module.autoAction(g.state, id, false, rooms.ctx(room));
        if (action) rooms.applyAction(room, id, action);
        else if (gameId === 'solitaire' && steps > 200) rooms.applyAction(room, id, { type: 'resign' }); // no auto-play; the player gives up
        // Duplicate delivery of the same move must be rejected or harmless.
        if (action && !isBot && Math.random() < 0.2) tryCmd(rooms, room, conns.find((c) => c.player.id === id), { t: 'act', action });
        if (g.module.meta.continuous && steps > 1500) break;
      }
      if (room.game) {
        if (!g.module.meta.continuous) assert(g.over, `${gameId} did not finish`);
        rooms.endGame(room);
      }
      assert.strictEqual(room.game, null);
      // Blackjack plays against the house, so only the other games must conserve chips (rebuys aside).
      if (gameId !== 'blackjack') assert.strictEqual(totalChips(room) - totalBuyins(room), chipsBefore, `${gameId} chips not conserved`);
      for (const v of Object.values(room.chips)) assert(Number.isInteger(v) && v >= 0, `${gameId} bad chip value ${v}`);
      // The room can start another game straight away.
      rooms.command(room.code, conns[0], { t: 'start' });
      assert(room.game && !room.game.over);
      rooms.endGame(room);
    }
  });
}

test('hidden cards: nobody sees another seated player\'s hand', () => {
  const handOf = { spades: (s, i) => s.round.hands[i], hearts: (s, i) => s.round.hands[i], ginrummy: (s, i) => s.round.hands[i] };
  for (const [gameId, humans, bots] of [['spades', 2, 2], ['hearts', 2, 2], ['ginrummy', 2, 0], ['holdem', 3, 0]]) {
    const { rooms, room, conns } = setupRoom(gameId, humans, bots);
    rooms.command(room.code, conns[0], { t: 'start' });
    const g = room.game;
    for (let step = 0; step < 30 && !g.over; step++) {
      for (const viewer of g.playerIds) {
        const json = JSON.stringify(rooms.viewFor(room, viewer).game.view);
        g.playerIds.forEach((other, i) => {
          if (other === viewer) return;
          const cards = gameId === 'holdem'
            ? (g.state.hand.players.find((p) => p.id === other) || { hole: [] }).hole
            : handOf[gameId](g.state, i);
          const resultsShown = gameId === 'holdem' && g.state.hand.results && g.state.hand.results.showdown;
          const roundOver = g.state.round && g.state.round.phase === 'roundover';
          if (resultsShown || roundOver) return;
          // Cards already played face-up to the table are public.
          const visible = new Set([...(g.state.round ? [...(g.state.round.trick || []).map((t) => t.card || t), ...((g.state.round.discard || []).slice(-1))] : []), ...(g.state.hand ? g.state.hand.board : []),
            // Cards you passed in Hearts are yours to remember.
            // A card picked up from the face-up discard pile is public.
            ...(gameId === 'ginrummy' && g.state.round.lastDraw && g.state.round.lastDraw.from === 'discard' ? [g.state.round.lastDraw.card] : []),
            ...(gameId === 'hearts' ? (g.state.round.passes[g.playerIds.indexOf(viewer)] || []) : [])]);
          for (const c of cards) if (!visible.has(c)) assert(!json.includes(`"${c}"`), `${gameId}: ${viewer} can see ${other}'s ${c}`);
        });
        // Spectators see no hands at all.
      }
      const waiting = g.module.waitingOn(g.state);
      if (!waiting.length) break;
      const action = g.module.autoAction(g.state, waiting[0], true, rooms.ctx(room));
      if (action) rooms.applyAction(room, waiting[0], action);
    }
  }
});

test('leaving a poker or blackjack table lets you sit back in later', () => {
  for (const gameId of ['holdem', 'blackjack']) {
    const { rooms, room, conns } = setupRoom(gameId, 3, 0);
    rooms.command(room.code, conns[0], { t: 'start' });
    rooms.command(room.code, conns[2], { t: 'act', action: { type: 'leave' } });
    // Finish whatever round is going so the seat is released.
    for (let i = 0; i < 50; i++) {
      const w = room.game.module.waitingOn(room.game.state);
      if (!w.length) break;
      rooms.applyAction(room, w[0], room.game.module.autoAction(room.game.state, w[0], true, rooms.ctx(room)));
    }
    assert(!room.game.playerIds.includes('p2'), `${gameId}: still listed as playing after leaving`);
    assert(rooms.viewFor(room, 'p2').game.canSitIn, `${gameId}: no way back to the table`);
    rooms.command(room.code, conns[2], { t: 'sitIn' });
    assert(room.game.playerIds.includes('p2'));
  }
});
test('broken saved data is ignored instead of crashing the server', () => {
  for (const bad of [{ rooms: 'nope' }, { rooms: [null, 5, { code: 'ABCD', members: 'x', chips: 'y' }] }, 'garbage']) {
    const r = new Rooms({ storage: { load: () => bad, save() {} } });
    assert(r.rooms instanceof Map);
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
