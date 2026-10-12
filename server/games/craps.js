// Craps against the house. The shooter role rotates; everyone bets on every roll.
// Bets: Pass Line / Don't Pass (with Pass odds at true odds up to 3x), Come,
// Field, Place 6 / Place 8, and one-roll Any 7 / Any Craps.
const crypto = require('crypto');

const meta = {
  id: 'craps',
  name: 'Craps',
  blurb: 'The whole table rides on one shooter. Pass line, odds, field and more.',
  minPlayers: 1,
  maxPlayers: 8,
  usesChips: true,
  continuous: true,
  allowJoinMidGame: true,
  options: [
    { key: 'minBet', label: 'Minimum bet', min: 1, max: 1000, default: 5 },
    { key: 'maxBet', label: 'Maximum bet per spot', min: 10, max: 100000, default: 500 },
  ],
};

const POINTS = [4, 5, 6, 8, 9, 10];
const TRUE_ODDS = { 4: [2, 1], 10: [2, 1], 5: [3, 2], 9: [3, 2], 6: [6, 5], 8: [6, 5] };
const ODDS_MAX = 3; // odds up to 3x the line bet
// Spots a player can bet on directly, and when.
const SPOTS = {
  pass: { label: 'Pass Line', when: 'comeout', removable: false },
  dontPass: { label: "Don't Pass", when: 'comeout', removable: false },
  passOdds: { label: 'Pass Odds', when: 'point', removable: true },
  come: { label: 'Come', when: 'point', removable: false },
  field: { label: 'Field', when: 'any', removable: true },
  place6: { label: 'Place 6', when: 'any', removable: true },
  place8: { label: 'Place 8', when: 'any', removable: true },
  any7: { label: 'Any 7', when: 'any', removable: true },
  anyCraps: { label: 'Any Craps', when: 'any', removable: true },
};

const rollDie = () => crypto.randomInt(6) + 1;
const blankBets = () => ({ pass: 0, dontPass: 0, passOdds: 0, come: 0, field: 0, place6: 0, place8: 0, any7: 0, anyCraps: 0, comePoints: {} });
const tableTotal = (b) => Object.entries(b).reduce((a, [k, v]) => a + (k === 'comePoints' ? Object.values(v).reduce((x, y) => x + y, 0) : v), 0);

function create(players, options) {
  const s = {
    options: { minBet: options.minBet, maxBet: Math.max(options.minBet, options.maxBet) },
    seats: players.map((p) => ({ id: p.id, name: p.name })),
    shooter: 0,
    point: null,
    dice: null,
    rollNo: 0,
    log: [], // recent rolls: { dice, total, text }
    bets: {},
    lastRoll: null, // per-player results of the latest roll
    acted: {}, // bots that have finished betting since the last roll
  };
  for (const p of s.seats) s.bets[p.id] = blankBets();
  return s;
}

function addPlayer(s, p) {
  if (s.seats.some((x) => x.id === p.id)) return;
  if (s.seats.length >= meta.maxPlayers) throw new Error('Table is full');
  s.seats.push({ id: p.id, name: p.name });
  s.bets[p.id] = blankBets();
}

function shooterId(s) {
  return s.seats.length ? s.seats[s.shooter % s.seats.length].id : null;
}

function placeBet(s, id, spot, amount, ctx) {
  amount = Math.floor(Number(amount));
  const def = SPOTS[spot];
  if (!def) throw new Error('Unknown bet');
  if (!(amount > 0)) throw new Error('Pick a chip');
  if (def.when === 'comeout' && s.point) throw new Error(`${def.label} bets go on before the point is set`);
  if (def.when === 'point' && !s.point) throw new Error(`${def.label} is only open once a point is set`);
  const b = s.bets[id];
  const now = b[spot] + amount;
  if (spot === 'passOdds') {
    if (!b.pass) throw new Error('Make a Pass Line bet first');
    if (now > b.pass * ODDS_MAX) throw new Error(`Odds are limited to ${ODDS_MAX}x your Pass Line bet`);
  } else {
    if (now < s.options.minBet) throw new Error(`Minimum bet is ${s.options.minBet}`);
    if (now > s.options.maxBet) throw new Error(`Maximum on one spot is ${s.options.maxBet}`);
  }
  if (amount > ctx.getChips(id)) throw new Error("You don't have enough chips");
  ctx.addChips(id, -amount);
  b[spot] = now;
}

function act(s, id, action, ctx) {
  const seat = s.seats.find((x) => x.id === id);
  if (!seat) throw new Error("You're not at the table");
  const b = s.bets[id];

  switch (action.type) {
    case 'bet':
      placeBet(s, id, action.spot, action.amount, ctx);
      return;
    case 'remove': {
      const def = SPOTS[action.spot];
      if (!def || !def.removable) throw new Error("That bet can't be taken down");
      ctx.addChips(id, b[action.spot]);
      b[action.spot] = 0;
      return;
    }
    case 'done':
      s.acted[id] = true;
      return;
    case 'roll':
      if (id !== shooterId(s)) throw new Error("You're not the shooter");
      roll(s, ctx);
      return;
    case 'leave': {
      // Contract bets (line and come) stay with the house; everything else comes back.
      for (const k of ['passOdds', 'field', 'place6', 'place8', 'any7', 'anyCraps']) ctx.addChips(id, b[k]);
      const idx = s.seats.findIndex((x) => x.id === id);
      const shooterIdx = s.shooter % s.seats.length;
      s.seats.splice(idx, 1);
      delete s.bets[id];
      // Keep the same shooter; if the shooter left, the next player picks up the dice (and the point).
      if (idx < shooterIdx) s.shooter = shooterIdx - 1;
      else s.shooter = s.seats.length ? shooterIdx % s.seats.length : 0;
      return;
    }
    default:
      throw new Error('Unknown action');
  }
}

function roll(s, ctx) {
  const d = [rollDie(), rollDie()];
  const t = d[0] + d[1];
  s.dice = d;
  s.rollNo++;
  s.acted = {};
  const comeout = !s.point;
  const results = {};
  const pay = (id, label, back, net) => {
    if (back) ctx.addChips(id, back);
    (results[id] || (results[id] = [])).push({ label, net });
  };

  for (const [id, b] of Object.entries(s.bets)) {
    // One-roll bets
    if (b.field) {
      const m = t === 2 ? 2 : t === 12 ? 3 : [3, 4, 9, 10, 11].includes(t) ? 1 : 0;
      if (m) pay(id, 'Field', b.field * (m + 1), b.field * m); else pay(id, 'Field', 0, -b.field);
      b.field = 0;
    }
    if (b.any7) { if (t === 7) pay(id, 'Any 7', b.any7 * 5, b.any7 * 4); else pay(id, 'Any 7', 0, -b.any7); b.any7 = 0; }
    if (b.anyCraps) { if ([2, 3, 12].includes(t)) pay(id, 'Any Craps', b.anyCraps * 8, b.anyCraps * 7); else pay(id, 'Any Craps', 0, -b.anyCraps); b.anyCraps = 0; }

    // Place bets are off on the come-out roll; they stay up after a win.
    for (const n of [6, 8]) {
      const k = `place${n}`;
      if (!b[k] || comeout) continue;
      if (t === n) { const win = Math.floor((b[k] * 7) / 6); pay(id, `Place ${n}`, win, win); }
      else if (t === 7) { pay(id, `Place ${n}`, 0, -b[k]); b[k] = 0; }
    }

    // Established come bets
    for (const [nStr, amt] of Object.entries(b.comePoints)) {
      const n = Number(nStr);
      if (t === n) { pay(id, `Come ${n}`, amt * 2, amt); delete b.comePoints[nStr]; }
      else if (t === 7) { pay(id, `Come ${n}`, 0, -amt); delete b.comePoints[nStr]; }
    }
    // A new come bet acts like its own come-out roll
    if (b.come) {
      if (t === 7 || t === 11) pay(id, 'Come', b.come * 2, b.come);
      else if ([2, 3, 12].includes(t)) pay(id, 'Come', 0, -b.come);
      else b.comePoints[t] = (b.comePoints[t] || 0) + b.come;
      b.come = 0;
    }

    // Line bets
    if (comeout) {
      if (b.pass) {
        if (t === 7 || t === 11) pay(id, 'Pass Line', b.pass, b.pass); // paid; the bet rides
        else if ([2, 3, 12].includes(t)) { pay(id, 'Pass Line', 0, -b.pass); b.pass = 0; }
      }
      if (b.dontPass) {
        if (t === 2 || t === 3) pay(id, "Don't Pass", b.dontPass, b.dontPass); // paid; the bet rides
        else if (t === 12) pay(id, "Don't Pass", 0, 0); // bar 12: push
        else if (t === 7 || t === 11) { pay(id, "Don't Pass", 0, -b.dontPass); b.dontPass = 0; }
      }
    } else if (t === s.point || t === 7) {
      const made = t === s.point;
      if (b.pass) {
        if (made) {
          const [num, den] = TRUE_ODDS[s.point];
          const oddsWin = Math.floor((b.passOdds * num) / den);
          pay(id, 'Pass Line', b.pass * 2 + (b.passOdds ? b.passOdds + oddsWin : 0), b.pass + oddsWin);
        } else pay(id, 'Pass Line', 0, -(b.pass + b.passOdds));
        b.pass = 0;
        b.passOdds = 0;
      }
      if (b.dontPass) {
        if (made) pay(id, "Don't Pass", 0, -b.dontPass); else pay(id, "Don't Pass", b.dontPass * 2, b.dontPass);
        b.dontPass = 0;
      }
    }
  }

  let text;
  if (comeout) {
    if (t === 7 || t === 11) text = `${t}: winner! Pass Line wins`;
    else if ([2, 3, 12].includes(t)) text = `${t}: craps. Pass Line loses`;
    else { s.point = t; text = `Point is ${t}`; }
  } else if (t === s.point) { text = `${t}: point made! Pass Line wins`; s.point = null; }
  else if (t === 7) {
    text = '7 out. Dice pass to the next shooter';
    s.point = null;
    s.shooter = (s.shooter + 1) % Math.max(1, s.seats.length);
  } else text = `${t}`;

  s.log.unshift({ dice: d, total: t, text });
  s.log = s.log.slice(0, 12);
  s.lastRoll = results;
  const name = (id) => (s.seats.find((x) => x.id === id) || {}).name;
  for (const [id, rs] of Object.entries(results)) {
    const net = rs.reduce((a, r) => a + r.net, 0);
    if (net) ctx.log(`Craps: ${name(id)} ${net > 0 ? 'wins' : 'loses'} ${Math.abs(net)}`);
  }
}

function abort(s, ctx) {
  // Ending the session returns everything on the felt.
  for (const [id, b] of Object.entries(s.bets)) ctx.addChips(id, tableTotal(b));
}

function waitingOn(s) {
  const sh = shooterId(s);
  return sh ? [sh] : [];
}

// Bots also get a turn to bet before each roll (see rooms.js scheduleAuto).
function optionalActors(s) {
  return s.seats.filter((x) => !s.acted[x.id]).map((x) => x.id);
}

function autoAction(s, id, isBot, ctx) {
  const isShooter = id === shooterId(s);
  if (!isBot) {
    // A shooter who walked away keeps the game moving.
    return isShooter ? { type: 'roll' } : null;
  }
  const b = s.bets[id];
  const chips = ctx.getChips(id);
  const unit = s.options.minBet * 2;
  if (!s.acted[id]) {
    if (!s.point && !b.pass && !b.dontPass && chips >= unit) return { type: 'bet', spot: Math.random() < 0.85 ? 'pass' : 'dontPass', amount: unit };
    if (s.point && b.pass && b.passOdds < b.pass * 2 && chips >= b.pass) return { type: 'bet', spot: 'passOdds', amount: b.pass };
    if (s.point && !b.place6 && !b.place8 && chips >= 12 && Math.random() < 0.3) return { type: 'bet', spot: Math.random() < 0.5 ? 'place6' : 'place8', amount: Math.max(6, Math.ceil(s.options.minBet / 6) * 6) };
    if (s.point && !b.come && chips >= unit && Math.random() < 0.2) return { type: 'bet', spot: 'come', amount: unit };
    if (!b.field && chips >= s.options.minBet && Math.random() < 0.1) return { type: 'bet', spot: 'field', amount: s.options.minBet };
    return { type: 'done' };
  }
  return isShooter ? { type: 'roll' } : null;
}

function view(s, viewerId, ctx) {
  return {
    options: s.options,
    point: s.point,
    dice: s.dice,
    rollNo: s.rollNo,
    log: s.log,
    shooter: shooterId(s),
    spots: SPOTS,
    oddsMax: ODDS_MAX,
    seats: s.seats.map((x) => ({
      id: x.id,
      name: x.name,
      chips: ctx.getChips(x.id),
      bets: s.bets[x.id],
      onTable: tableTotal(s.bets[x.id]),
      last: s.lastRoll && s.lastRoll[x.id] ? s.lastRoll[x.id] : null,
    })),
  };
}

module.exports = { meta, create, act, view, waitingOn, optionalActors, autoAction, abort, addPlayer, TRUE_ODDS };
