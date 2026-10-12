// Roulette against the house. Everyone bets on the same spin; the wheel spins once
// every seated player is ready (or someone hits "Spin now"). Single-zero wheel by
// default, optional double zero.
const crypto = require('crypto');

const meta = {
  id: 'roulette',
  name: 'Roulette',
  blurb: 'Everyone bets on the same spin. Numbers, colors, dozens and more.',
  minPlayers: 1,
  maxPlayers: 8,
  usesChips: true,
  continuous: true,
  allowJoinMidGame: true,
  options: [
    { key: 'minBet', label: 'Minimum bet', min: 1, max: 1000, default: 5 },
    { key: 'maxBet', label: 'Maximum bet per spot', min: 10, max: 100000, default: 500 },
    { key: 'doubleZero', label: 'American wheel with 00 (0 = no, 1 = yes)', min: 0, max: 1, default: 0 },
  ],
};

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = (n) => (n === 0 || n === '00' ? 'green' : RED.has(n) ? 'red' : 'black');

// kind -> { pays, wins(number) }; `value` picks which number/dozen/column.
const BETS = {
  straight: { pays: 35, label: (v) => `${v}`, wins: (n, v) => n === v },
  red: { pays: 1, label: () => 'Red', wins: (n) => colorOf(n) === 'red' },
  black: { pays: 1, label: () => 'Black', wins: (n) => colorOf(n) === 'black' },
  odd: { pays: 1, label: () => 'Odd', wins: (n) => typeof n === 'number' && n > 0 && n % 2 === 1 },
  even: { pays: 1, label: () => 'Even', wins: (n) => typeof n === 'number' && n > 0 && n % 2 === 0 },
  low: { pays: 1, label: () => '1-18', wins: (n) => typeof n === 'number' && n >= 1 && n <= 18 },
  high: { pays: 1, label: () => '19-36', wins: (n) => typeof n === 'number' && n >= 19 },
  dozen: { pays: 2, label: (v) => `${['1st', '2nd', '3rd'][v - 1]} 12`, wins: (n, v) => typeof n === 'number' && n >= 1 && Math.ceil(n / 12) === v },
  column: { pays: 2, label: (v) => `Column ${v}`, wins: (n, v) => typeof n === 'number' && n >= 1 && ((n - 1) % 3) + 1 === v },
};

const spotKey = (kind, value) => `${kind}:${value === undefined ? '' : value}`;

function validSpot(s, kind, value) {
  if (!BETS[kind]) return false;
  if (kind === 'straight') return (Number.isInteger(value) && value >= 0 && value <= 36) || (value === '00' && s.options.doubleZero);
  if (kind === 'dozen' || kind === 'column') return [1, 2, 3].includes(value);
  return value === undefined || value === null || value === '';
}

function create(players, options) {
  const s = {
    options: {
      minBet: options.minBet,
      maxBet: Math.max(options.minBet, options.maxBet),
      doubleZero: options.doubleZero ? 1 : 0,
    },
    seats: players.map((p) => ({ id: p.id, name: p.name })),
    history: [],
    spinNo: 0,
  };
  newRound(s);
  return s;
}

function newRound(s) {
  s.phase = 'betting';
  s.lastBets = s.bets || {};
  s.bets = {}; // id -> [{ kind, value, amount }]
  s.ready = {};
  s.result = null;
  s.payouts = null;
}

function addPlayer(s, p) {
  if (s.seats.some((x) => x.id === p.id)) return;
  if (s.seats.length >= meta.maxPlayers) throw new Error('Table is full');
  s.seats.push({ id: p.id, name: p.name });
}

function totalOn(bets) {
  return (bets || []).reduce((a, b) => a + b.amount, 0);
}

function placeBet(s, id, kind, value, amount, ctx) {
  amount = Math.floor(Number(amount));
  if (!validSpot(s, kind, value)) throw new Error("That's not a spot on the table");
  if (!(amount > 0)) throw new Error('Pick a chip');
  const mine = s.bets[id] || (s.bets[id] = []);
  const onSpot = mine.filter((b) => spotKey(b.kind, b.value) === spotKey(kind, value)).reduce((a, b) => a + b.amount, 0);
  if (onSpot + amount < s.options.minBet) throw new Error(`Minimum bet is ${s.options.minBet}`);
  if (onSpot + amount > s.options.maxBet) throw new Error(`Maximum on one spot is ${s.options.maxBet}`);
  if (amount > ctx.getChips(id)) throw new Error("You don't have enough chips");
  ctx.addChips(id, -amount);
  mine.push({ kind, value: value === null || value === '' ? undefined : value, amount });
  delete s.ready[id];
}

function act(s, id, action, ctx) {
  const seat = s.seats.find((x) => x.id === id);
  if (!seat) throw new Error("You're not at the table");

  if (action.type === 'leave') {
    if (s.phase === 'betting') refund(s, id, ctx);
    s.seats = s.seats.filter((x) => x.id !== id);
    delete s.ready[id];
    maybeSpin(s, ctx);
    return;
  }
  if (s.phase === 'spun') {
    if (action.type === 'next') { newRound(s); return; }
    throw new Error('Wait for the next round');
  }

  switch (action.type) {
    case 'bet':
      placeBet(s, id, action.kind, action.value, action.amount, ctx);
      return;
    case 'undo': {
      const mine = s.bets[id] || [];
      const last = mine.pop();
      if (last) ctx.addChips(id, last.amount);
      delete s.ready[id];
      return;
    }
    case 'clear':
      refund(s, id, ctx);
      delete s.ready[id];
      return;
    case 'repeat': {
      const prev = s.lastBets[id] || [];
      if (!prev.length) throw new Error('No bets from last spin');
      if (totalOn(prev) > ctx.getChips(id)) throw new Error("You don't have enough chips to repeat that");
      for (const b of prev) placeBet(s, id, b.kind, b.value, b.amount, ctx);
      return;
    }
    case 'ready':
      s.ready[id] = true;
      maybeSpin(s, ctx);
      return;
    case 'spin':
      if (!Object.values(s.bets).some((b) => b.length)) throw new Error('Nobody has bet yet');
      spin(s, ctx);
      return;
    default:
      throw new Error('Unknown action');
  }
}

function refund(s, id, ctx) {
  const mine = s.bets[id] || [];
  ctx.addChips(id, totalOn(mine));
  s.bets[id] = [];
}

function maybeSpin(s, ctx) {
  if (s.phase !== 'betting' || !s.seats.length) return;
  const allReady = s.seats.every((x) => s.ready[x.id]);
  if (allReady && Object.values(s.bets).some((b) => b.length)) spin(s, ctx);
}

function spin(s, ctx) {
  const slots = s.options.doubleZero ? 38 : 37;
  const r = crypto.randomInt(slots);
  const number = r === 37 ? '00' : r;
  s.result = { number, color: colorOf(number) };
  s.spinNo++;
  s.history.unshift(s.result);
  s.history = s.history.slice(0, 16);
  s.payouts = {};
  for (const [id, mine] of Object.entries(s.bets)) {
    if (!mine.length) continue;
    let back = 0;
    const wins = [];
    for (const b of mine) {
      if (BETS[b.kind].wins(number, b.value)) {
        const win = b.amount * (BETS[b.kind].pays + 1);
        back += win;
        wins.push({ label: BETS[b.kind].label(b.value), amount: win - b.amount });
      }
    }
    ctx.addChips(id, back);
    const net = back - totalOn(mine);
    s.payouts[id] = { net, wins };
    const seat = s.seats.find((x) => x.id === id);
    if (seat && net) ctx.log(`Roulette: ${seat.name} ${net > 0 ? 'wins' : 'loses'} ${Math.abs(net)}`);
  }
  s.phase = 'spun';
}

function abort(s, ctx) {
  if (s.phase === 'betting') for (const id of Object.keys(s.bets)) refund(s, id, ctx);
}

function waitingOn(s) {
  return s.phase === 'betting' ? s.seats.filter((x) => !s.ready[x.id]).map((x) => x.id) : [];
}

function autoAction(s, id, isBot, ctx) {
  if (s.phase !== 'betting' || s.ready[id] || !s.seats.some((x) => x.id === id)) return null;
  if (!isBot) return { type: 'ready' }; // someone who's away just sits this spin out
  const mine = s.bets[id] || [];
  const chips = ctx.getChips(id);
  const amount = s.options.minBet * (1 + Math.floor(Math.random() * 3));
  if (mine.length < 1 + Math.floor(Math.random() * 3) && chips >= amount) {
    const pick = Math.random();
    if (pick < 0.4) return { type: 'bet', kind: ['red', 'black', 'odd', 'even', 'low', 'high'][Math.floor(Math.random() * 6)], amount };
    if (pick < 0.7) return { type: 'bet', kind: Math.random() < 0.5 ? 'dozen' : 'column', value: 1 + Math.floor(Math.random() * 3), amount };
    return { type: 'bet', kind: 'straight', value: Math.floor(Math.random() * 37), amount: s.options.minBet };
  }
  return { type: 'ready' };
}

function view(s, viewerId, ctx) {
  return {
    options: s.options,
    phase: s.phase,
    spinNo: s.spinNo,
    result: s.result,
    history: s.history,
    seats: s.seats.map((x) => ({
      id: x.id,
      name: x.name,
      chips: ctx.getChips(x.id),
      bets: s.bets[x.id] || [],
      onTable: totalOn(s.bets[x.id]),
      ready: !!s.ready[x.id],
      payout: s.payouts ? s.payouts[x.id] || null : null,
    })),
    canRepeat: !!(s.lastBets[viewerId] && s.lastBets[viewerId].length),
    red: [...RED],
  };
}

module.exports = { meta, create, act, view, waitingOn, autoAction, abort, addPlayer, BETS, colorOf };
