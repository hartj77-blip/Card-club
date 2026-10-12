// Three Card Poker against the dealer. Everyone antes (plus an optional Pair Plus
// side bet), sees three cards, then plays (matching the ante) or folds. The dealer
// needs Queen-high to qualify. Standard paytables.
const { newDeck, shuffle, rankOf, suitOf } = require('../cards');

const meta = {
  id: 'threecard',
  name: 'Three Card Poker',
  blurb: 'Fast poker against the dealer, 1-7 players. Ante, look, play or fold.',
  minPlayers: 1,
  maxPlayers: 7,
  usesChips: true,
  continuous: true,
  allowJoinMidGame: true,
  options: [
    { key: 'minBet', label: 'Minimum ante', min: 1, max: 1000, default: 10 },
    { key: 'maxBet', label: 'Maximum ante / Pair Plus', min: 10, max: 100000, default: 500 },
  ],
};

const CATS = ['High Card', 'Pair', 'Flush', 'Straight', 'Three of a Kind', 'Straight Flush'];
const PAIR_PLUS = { 1: 1, 2: 4, 3: 6, 4: 30, 5: 40 }; // pair, flush, straight, trips, straight flush
const ANTE_BONUS = { 3: 1, 4: 4, 5: 5 }; // straight, trips, straight flush

// Score a 3-card hand as [category, ...tiebreak ranks]; in 3-card poker a straight beats a flush.
function score3(cards) {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  let straightHigh = 0;
  if (ranks[0] - ranks[1] === 1 && ranks[1] - ranks[2] === 1) straightHigh = ranks[0];
  if (ranks[0] === 14 && ranks[1] === 3 && ranks[2] === 2) straightHigh = 3; // A-2-3
  if (straightHigh && flush) return [5, straightHigh];
  if (ranks[0] === ranks[2]) return [4, ranks[0]];
  if (straightHigh) return [3, straightHigh];
  if (flush) return [2, ...ranks];
  if (ranks[0] === ranks[1] || ranks[1] === ranks[2]) {
    const pair = ranks[1];
    const kicker = ranks[0] === ranks[1] ? ranks[2] : ranks[0];
    return [1, pair, kicker];
  }
  return [0, ...ranks];
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

const qualifies = (score) => score[0] > 0 || score[1] >= 12;

function create(players, options) {
  const s = {
    options: { minBet: options.minBet, maxBet: Math.max(options.minBet, options.maxBet) },
    seats: players.map((p) => ({ id: p.id, name: p.name, leaving: false })),
    roundNo: 0,
  };
  newRound(s);
  return s;
}

function addPlayer(s, p) {
  if (s.seats.some((x) => x.id === p.id)) return;
  if (s.seats.length >= meta.maxPlayers) throw new Error('Table is full');
  s.seats.push({ id: p.id, name: p.name, leaving: false });
}

function newRound(s) {
  s.seats = s.seats.filter((x) => !x.leaving);
  s.roundNo++;
  s.phase = 'betting';
  s.bets = {}; // id -> { ante, pairPlus }
  s.skipping = {};
  s.hands = {}; // id -> { cards, decision, play, result }
  s.dealer = [];
}

function act(s, id, action, ctx) {
  const seat = s.seats.find((x) => x.id === id);
  if (!seat) throw new Error("You're not at the table");
  const o = s.options;

  if (action.type === 'leave') {
    seat.leaving = true;
    if (s.phase === 'betting') {
      delete s.bets[id];
      s.seats = s.seats.filter((x) => x.id !== id);
      maybeDeal(s, ctx);
    } else if (s.phase === 'deciding' && s.hands[id] && !s.hands[id].decision) {
      decide(s, id, 'fold', ctx);
    }
    return;
  }

  if (s.phase === 'betting') {
    if (action.type === 'bet') {
      const ante = Math.floor(Number(action.ante));
      const pairPlus = Math.floor(Number(action.pairPlus) || 0);
      if (!(ante >= o.minBet && ante <= o.maxBet)) throw new Error(`Ante between ${o.minBet} and ${o.maxBet}`);
      if (pairPlus && !(pairPlus >= o.minBet && pairPlus <= o.maxBet)) throw new Error(`Pair Plus between ${o.minBet} and ${o.maxBet}`);
      // You need enough to cover the ante, Pair Plus, and a matching Play bet.
      if (ante * 2 + pairPlus > ctx.getChips(id)) throw new Error('You need enough chips to cover the ante, Pair Plus and a Play bet');
      s.bets[id] = { ante, pairPlus };
      delete s.skipping[id];
      maybeDeal(s, ctx);
      return;
    }
    if (action.type === 'unbet') { delete s.bets[id]; delete s.skipping[id]; return; }
    if (action.type === 'skip') { delete s.bets[id]; s.skipping[id] = true; maybeDeal(s, ctx); return; }
    if (action.type === 'deal') {
      if (!Object.keys(s.bets).length) throw new Error('Nobody has bet yet');
      deal(s, ctx);
      return;
    }
    throw new Error('Place your ante');
  }

  if (s.phase === 'deciding') {
    if (action.type !== 'play' && action.type !== 'fold') throw new Error('Play or fold');
    if (!s.hands[id] || s.hands[id].decision) throw new Error("You've already decided");
    decide(s, id, action.type, ctx);
    return;
  }

  if (s.phase === 'settled' && action.type === 'next') { newRound(s); return; }
  throw new Error('Round is over');
}

function maybeDeal(s, ctx) {
  const pending = s.seats.filter((x) => !(x.id in s.bets) && !s.skipping[x.id]);
  if (!pending.length && Object.keys(s.bets).length) deal(s, ctx);
}

function deal(s, ctx) {
  const deck = shuffle(newDeck());
  for (const [id, b] of Object.entries(s.bets)) {
    ctx.addChips(id, -(b.ante + b.pairPlus));
    s.hands[id] = { cards: [deck.pop(), deck.pop(), deck.pop()], decision: null, play: 0 };
  }
  s.dealer = [deck.pop(), deck.pop(), deck.pop()];
  s.phase = 'deciding';
}

function decide(s, id, choice, ctx) {
  const h = s.hands[id];
  if (choice === 'play') {
    const ante = s.bets[id].ante;
    if (ctx.getChips(id) < ante) throw new Error('Not enough chips to play');
    ctx.addChips(id, -ante);
    h.play = ante;
  }
  h.decision = choice;
  if (Object.values(s.hands).every((x) => x.decision)) settle(s, ctx);
}

function settle(s, ctx) {
  const dScore = score3(s.dealer);
  const dQual = qualifies(dScore);
  s.dealerScore = { name: CATS[dScore[0]], qualifies: dQual };
  for (const [id, h] of Object.entries(s.hands)) {
    const { ante, pairPlus } = s.bets[id];
    const ps = score3(h.cards);
    const lines = [];
    let back = 0;
    if (h.decision === 'fold') {
      lines.push('Folded');
    } else {
      const c = compare(ps, dScore);
      if (!dQual) { back += ante * 2 + h.play; lines.push('Dealer doesn\'t qualify: ante wins, play pushes'); }
      else if (c > 0) { back += ante * 2 + h.play * 2; lines.push('Beat the dealer'); }
      else if (c === 0) { back += ante + h.play; lines.push('Push'); }
      else lines.push('Dealer wins');
      if (ANTE_BONUS[ps[0]]) { back += ante * ANTE_BONUS[ps[0]]; lines.push(`Ante bonus ${ANTE_BONUS[ps[0]]}:1`); }
    }
    // Pair Plus pays on your hand alone, but is forfeited if you fold.
    if (pairPlus && h.decision !== 'fold') {
      const m = PAIR_PLUS[ps[0]];
      if (m) { back += pairPlus * (m + 1); lines.push(`Pair Plus ${m}:1`); }
      else lines.push('Pair Plus loses');
    }
    ctx.addChips(id, back);
    h.net = back - ante - pairPlus - h.play;
    h.handName = CATS[ps[0]];
    h.lines = lines;
    const seat = s.seats.find((x) => x.id === id);
    if (seat && h.net) ctx.log(`Three Card Poker: ${seat.name} ${h.net > 0 ? 'wins' : 'loses'} ${Math.abs(h.net)}`);
  }
  s.phase = 'settled';
}

function abort(s, ctx) {
  if (s.phase === 'deciding') {
    for (const [id, h] of Object.entries(s.hands)) ctx.addChips(id, s.bets[id].ante + s.bets[id].pairPlus + h.play);
  }
}

function waitingOn(s) {
  if (s.phase === 'betting') return s.seats.filter((x) => !(x.id in s.bets) && !s.skipping[x.id]).map((x) => x.id);
  if (s.phase === 'deciding') return Object.entries(s.hands).filter(([, h]) => !h.decision).map(([id]) => id);
  return [];
}

function autoAction(s, id, isBot, ctx) {
  if (s.phase === 'betting') {
    if (id in s.bets || s.skipping[id]) return null;
    if (!isBot) return { type: 'skip' };
    const ante = s.options.minBet * (1 + Math.floor(Math.random() * 2));
    if (ctx.getChips(id) < ante * 3) return { type: 'skip' };
    return { type: 'bet', ante, pairPlus: Math.random() < 0.5 ? s.options.minBet : 0 };
  }
  if (s.phase === 'deciding') {
    const h = s.hands[id];
    if (!h || h.decision) return null;
    if (!isBot) return { type: 'fold' };
    // Optimal strategy: play Queen-6-4 or better.
    const sc = score3(h.cards);
    const play = sc[0] > 0 || compare(sc, [0, 12, 6, 4]) >= 0;
    return { type: play && ctx.getChips(id) >= s.bets[id].ante ? 'play' : 'fold' };
  }
  return null;
}

function view(s, viewerId, ctx) {
  const reveal = s.phase === 'settled';
  return {
    options: s.options,
    phase: s.phase,
    roundNo: s.roundNo,
    dealer: s.dealer.length ? (reveal ? s.dealer : [null, null, null]) : [],
    dealerScore: reveal ? s.dealerScore : null,
    seats: s.seats.map((x) => {
      const h = s.hands[x.id];
      const mine = x.id === viewerId;
      return {
        id: x.id,
        name: x.name,
        chips: ctx.getChips(x.id),
        bet: s.bets[x.id] || null,
        skipping: !!s.skipping[x.id],
        hand: h ? {
          cards: mine || reveal ? h.cards : [null, null, null],
          decision: h.decision,
          play: h.play,
          handName: mine || reveal ? CATS[score3(h.cards)[0]] : null,
          net: reveal ? h.net : undefined,
          lines: reveal ? h.lines : undefined,
        } : null,
      };
    }),
    paytable: { pairPlus: PAIR_PLUS, anteBonus: ANTE_BONUS, cats: CATS },
  };
}

module.exports = { meta, create, act, view, waitingOn, autoAction, abort, addPlayer, score3, compare, qualifies };
