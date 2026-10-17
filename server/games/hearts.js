// Hearts for 4 players. Pass three cards (left, right, across, then a hold hand),
// 2 of clubs leads, no points on the first trick, hearts must be broken before they
// can be led. Each heart is 1 point and the queen of spades 13; take all 26 and you
// shoot the moon (everyone else gets 26). Lowest score when someone reaches the target wins.
const { newDeck, shuffle, rankOf, suitOf, removeCard } = require('../cards');

const meta = {
  id: 'hearts',
  name: 'Hearts',
  blurb: '4 players. Dodge every heart and the queen of spades, or shoot the moon.',
  rules: [
    "4 players, 13 cards each. Before each hand, pass 3 cards: left, right, across, then no pass, repeating.",
    "Whoever has the 2 of clubs leads it. Follow suit if you can. The highest card of the led suit takes the trick.",
    "Each heart you take is 1 point. The queen of spades is 13. Points are bad.",
    "No points can be played on the first trick (unless you have nothing else). Hearts can't be led until one has been played.",
    "Shoot the moon: take all 13 hearts and the queen, and everyone else gets 26 instead.",
    "When someone reaches the target, the lowest score wins.",
  ],
  minPlayers: 4,
  maxPlayers: 4,
  usesChips: false,
  continuous: false,
  options: [
    { key: 'target', label: 'Game ends at (points)', min: 25, max: 500, step: 25, default: 100 },
    { key: 'stake', label: 'Chip stake per player (winner takes the pot)', min: 0, max: 100000, step: 10, default: 0 },
  ],
};

const QS = 'QS';
const PASS_DIRS = ['left', 'right', 'across', 'hold'];
const PASS_OFFSET = { left: 1, right: 3, across: 2, hold: 0 };
const SUIT_ORDER = { C: 0, D: 1, S: 2, H: 3 };
const sortHand = (hand) => hand.sort((a, b) => SUIT_ORDER[suitOf(a)] - SUIT_ORDER[suitOf(b)] || rankOf(a) - rankOf(b));
const points = (c) => (c === QS ? 13 : suitOf(c) === 'H' ? 1 : 0);

function create(players, options) {
  const s = {
    options: { target: options.target },
    players: players.map((p) => ({ id: p.id, name: p.name })),
    scores: [0, 0, 0, 0],
    handNo: 0,
    history: [],
    round: null,
    over: null,
  };
  deal(s);
  return s;
}

function deal(s) {
  const deck = shuffle(newDeck());
  const dir = PASS_DIRS[s.handNo % 4];
  s.handNo++;
  s.round = {
    phase: dir === 'hold' ? 'playing' : 'passing',
    passDir: dir,
    hands: [0, 1, 2, 3].map((i) => sortHand(deck.slice(i * 13, i * 13 + 13))),
    passes: [null, null, null, null],
    received: [[], [], [], []],
    taken: [0, 0, 0, 0], // points taken this hand
    trick: [],
    trickWinner: null,
    trickNo: 0,
    heartsBroken: false,
    played: [],
    voids: [[], [], [], []],
    turn: null,
    summary: null,
  };
  if (s.round.phase === 'playing') startPlay(s);
}

function startPlay(s) {
  const r = s.round;
  r.phase = 'playing';
  r.turn = r.hands.findIndex((h) => h.includes('2C'));
}

const seatOf = (s, id) => s.players.findIndex((p) => p.id === id);

function legalCards(s, seat) {
  const r = s.round;
  const hand = r.hands[seat];
  const trick = r.trick.length === 4 ? [] : r.trick;
  if (r.trickNo === 0 && trick.length === 0) return hand.includes('2C') ? ['2C'] : hand.slice();
  if (trick.length === 0) {
    if (r.heartsBroken) return hand.slice();
    const nonHearts = hand.filter((c) => suitOf(c) !== 'H');
    return nonHearts.length ? nonHearts : hand.slice();
  }
  const led = suitOf(trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === led);
  if (follow.length) return follow;
  // No points on the first trick, unless that's all you have.
  if (r.trickNo === 0) {
    const clean = hand.filter((c) => !points(c));
    if (clean.length) return clean;
  }
  return hand.slice();
}

function trickWinner(trick) {
  const led = suitOf(trick[0].card);
  let best = trick[0];
  for (const t of trick) if (suitOf(t.card) === led && rankOf(t.card) > rankOf(best.card)) best = t;
  return best.seat;
}

function act(s, playerId, action, ctx) {
  if (s.over) throw new Error('Game over');
  const r = s.round;
  const seat = seatOf(s, playerId);
  if (seat === -1) throw new Error("You're not in this game");

  if (action.type === 'next') {
    if (r.phase !== 'handover') throw new Error('Hand still in progress');
    deal(s);
    return;
  }

  if (action.type === 'pass') {
    if (r.phase !== 'passing') throw new Error('Not passing now');
    if (r.passes[seat]) throw new Error('You already passed');
    const cards = Array.isArray(action.cards) ? [...new Set(action.cards)] : [];
    if (cards.length !== 3 || !cards.every((c) => r.hands[seat].includes(c))) throw new Error('Pick 3 cards to pass');
    r.passes[seat] = cards;
    if (r.passes.every(Boolean)) {
      const off = PASS_OFFSET[r.passDir];
      for (let i = 0; i < 4; i++) for (const c of r.passes[i]) removeCard(r.hands[i], c);
      for (let i = 0; i < 4; i++) {
        const to = (i + off) % 4;
        r.hands[to].push(...r.passes[i]);
        r.received[to] = r.passes[i].slice();
        sortHand(r.hands[to]);
      }
      startPlay(s);
    }
    return;
  }

  if (action.type === 'play') {
    if (r.phase !== 'playing') throw new Error('Not playing yet');
    if (r.turn !== seat) throw new Error("It's not your turn");
    const card = action.card;
    if (!legalCards(s, seat).includes(card)) throw new Error("You can't play that card");
    if (r.trick.length === 4) { r.trick = []; r.trickWinner = null; }
    if (r.trick.length && suitOf(card) !== suitOf(r.trick[0].card)) {
      const led = suitOf(r.trick[0].card);
      if (!r.voids[seat].includes(led)) r.voids[seat].push(led);
    }
    removeCard(r.hands[seat], card);
    r.played.push(card);
    if (suitOf(card) === 'H') r.heartsBroken = true;
    r.trick.push({ seat, card });
    if (r.trick.length < 4) { r.turn = (seat + 1) % 4; return; }

    const w = trickWinner(r.trick);
    r.taken[w] += r.trick.reduce((a, t) => a + points(t.card), 0);
    r.trickWinner = w;
    r.trickNo++;
    r.turn = w;
    if (r.trickNo === 13) scoreHand(s, ctx);
    return;
  }
  throw new Error('Unknown action');
}

function scoreHand(s, ctx) {
  const r = s.round;
  const shooter = r.taken.findIndex((p) => p === 26);
  const delta = shooter >= 0 ? r.taken.map((_, i) => (i === shooter ? 0 : 26)) : r.taken.slice();
  delta.forEach((d, i) => { s.scores[i] += d; });
  r.summary = { taken: r.taken.slice(), delta, shooter, scores: s.scores.slice() };
  s.history.push(r.summary);
  r.phase = 'handover';
  r.turn = null;
  if (shooter >= 0) ctx.log(`Hearts: ${s.players[shooter].name} shot the moon! Everyone else takes 26`);
  else ctx.log(`Hearts hand ${s.handNo}: ${s.players.map((p, i) => `${p.name} +${delta[i]}`).join(', ')}`);

  if (s.scores.some((x) => x >= s.options.target)) {
    const low = Math.min(...s.scores);
    const winners = s.players.filter((_, i) => s.scores[i] === low);
    s.over = {
      winners: winners.map((w) => w.id),
      summary: `${winners.map((w) => w.name).join(' & ')} win${winners.length > 1 ? '' : 's'} with ${low} (${s.players.map((p, i) => `${p.name} ${s.scores[i]}`).join(', ')})`,
    };
  }
}

function waitingOn(s) {
  if (s.over) return [];
  const r = s.round;
  if (r.phase === 'passing') return s.players.filter((_, i) => !r.passes[i]).map((p) => p.id);
  if (r.phase === 'playing') return [s.players[r.turn].id];
  return [];
}

// --- Bot -----------------------------------------------------------------------
// Passes the queen of spades and high spades (unless it has enough low spades to
// hide behind), high hearts, and high cards from short suits. Plays to duck under
// the trick, dumps the queen and high hearts when void, and slips the queen under
// the ace or king of spades when it can.

function choosePass(hand) {
  const spades = hand.filter((c) => suitOf(c) === 'S');
  const lowSpades = spades.filter((c) => rankOf(c) < 12).length;
  const len = (st) => hand.filter((c) => suitOf(c) === st).length;
  const danger = (c) => {
    const r = rankOf(c);
    const st = suitOf(c);
    if (c === QS) return lowSpades >= 4 ? 20 : 100;
    if (st === 'S' && r > 12) return lowSpades >= 4 ? 5 : 80 + r;
    if (st === 'H') return 30 + r * 2;
    if (st === 'S') return r;
    return r + (6 - len(st)) * 3; // help empty a short suit
  };
  return hand.slice().sort((a, b) => danger(b) - danger(a)).slice(0, 3);
}

function autoAction(s, id) {
  if (s.over) return null;
  const r = s.round;
  const seat = seatOf(s, id);
  if (seat === -1) return null;
  if (r.phase === 'passing') return r.passes[seat] ? null : { type: 'pass', cards: choosePass(r.hands[seat]) };
  if (r.phase !== 'playing' || r.turn !== seat) return null;

  const hand = r.hands[seat];
  const legal = legalCards(s, seat);
  const play = (card) => ({ type: 'play', card });
  const low = (cs) => cs.reduce((a, c) => (rankOf(c) < rankOf(a) ? c : a));
  const high = (cs) => cs.reduce((a, c) => (rankOf(c) > rankOf(a) ? c : a));
  const trick = r.trick.length === 4 ? [] : r.trick;
  const qsOut = !r.played.includes(QS) && !hand.includes(QS);

  if (trick.length === 0) {
    // Lead low; draw out the queen with low spades when someone else holds it.
    const lowSpades = legal.filter((c) => suitOf(c) === 'S' && rankOf(c) < 12);
    if (qsOut && lowSpades.length) return play(high(lowSpades));
    const safe = legal.filter((c) => suitOf(c) !== 'S' || rankOf(c) < 12);
    return play(low(safe.length ? safe : legal));
  }

  const led = suitOf(trick[0].card);
  const following = legal.some((c) => suitOf(c) === led);
  const winning = trick.reduce((a, t) => (suitOf(t.card) === led && rankOf(t.card) > rankOf(a.card) ? t : a), trick[0]);
  const trickPoints = trick.reduce((a, t) => a + points(t.card), 0);
  const last = trick.length === 3;

  if (!following) {
    // Void: unload the queen, then the danger cards.
    if (legal.includes(QS)) return play(QS);
    const bigSpades = legal.filter((c) => suitOf(c) === 'S' && rankOf(c) > 12);
    if (qsOut && bigSpades.length) return play(high(bigSpades));
    const hearts = legal.filter((c) => suitOf(c) === 'H');
    if (hearts.length) return play(high(hearts));
    return play(high(legal));
  }

  // Slip the queen under a higher spade.
  if (led === 'S' && legal.includes(QS) && rankOf(winning.card) > 12) return play(QS);
  const ducks = legal.filter((c) => rankOf(c) < rankOf(winning.card));
  if (ducks.length) {
    const nonQueen = ducks.filter((c) => c !== QS);
    return play(high(nonQueen.length ? nonQueen : ducks));
  }
  // We're going to win it: if it's clean and we're last, win with our highest card.
  if (last && trickPoints === 0) {
    const nonQueen = legal.filter((c) => c !== QS);
    return play(high(nonQueen.length ? nonQueen : legal));
  }
  const nonQueen = legal.filter((c) => c !== QS);
  return play(last ? high(nonQueen.length ? nonQueen : legal) : low(nonQueen.length ? nonQueen : legal));
}

// --- View ------------------------------------------------------------------------

function view(s, viewerId) {
  const r = s.round;
  const seat = seatOf(s, viewerId);
  return {
    options: s.options,
    handNo: s.handNo,
    mySeat: seat,
    passDir: r.passDir,
    phase: r.phase,
    players: s.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      score: s.scores[i],
      taken: r.taken[i],
      cardCount: r.hands[i].length,
      passed: !!r.passes[i],
    })),
    turn: r.turn,
    trick: r.trick,
    trickWinner: r.trick.length === 4 ? r.trickWinner : null,
    heartsBroken: r.heartsBroken,
    hand: seat >= 0 ? r.hands[seat] : null,
    myPass: seat >= 0 ? r.passes[seat] : null,
    received: seat >= 0 && r.phase === 'playing' && r.trickNo === 0 ? r.received[seat] : [],
    legal: seat >= 0 && r.phase === 'playing' && r.turn === seat ? legalCards(s, seat) : [],
    summary: r.summary,
    history: s.history,
    over: s.over,
  };
}

module.exports = { meta, create, act, view, waitingOn, autoAction, legalCards, trickWinner, choosePass };
