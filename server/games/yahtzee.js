// Yahtzee for 1-6 players: 13 rounds, up to three rolls a turn, standard scoring
// with the upper-section bonus, Yahtzee bonuses and the forced-joker rule.
const crypto = require('crypto');

const meta = {
  id: 'yahtzee',
  name: 'Yahtzee',
  blurb: '1-6 players. Roll five dice up to three times a turn and fill your scorecard.',
  rules: [
    "On your turn, roll five dice up to three times. Tap dice to hold them between rolls.",
    "After rolling, pick one empty box on your scorecard. The card shows what each box would score.",
    "Upper section: add up the matching dice. Score 63 or more there for a 35-point bonus.",
    "Lower section: 3 and 4 of a kind (sum of all dice), full house 25, small straight 30, large straight 40, Yahtzee 50, chance (sum of all dice).",
    "Extra Yahtzees score a 100 bonus each and can be used as a joker in the lower section.",
    "After 13 rounds, the highest total wins. If a box doesn't fit, you may have to score a 0.",
  ],
  minPlayers: 1,
  maxPlayers: 6,
  usesChips: false,
  continuous: false,
  options: [
    { key: 'stake', label: 'Chip stake per player (winner takes the pot)', min: 0, max: 100000, step: 10, default: 0 },
  ],
};

const UPPER = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
const LOWER = ['threeKind', 'fourKind', 'fullHouse', 'smallStraight', 'largeStraight', 'yahtzee', 'chance'];
const CATEGORIES = UPPER.concat(LOWER);
const LABELS = {
  ones: 'Ones', twos: 'Twos', threes: 'Threes', fours: 'Fours', fives: 'Fives', sixes: 'Sixes',
  threeKind: '3 of a Kind', fourKind: '4 of a Kind', fullHouse: 'Full House',
  smallStraight: 'Sm. Straight', largeStraight: 'Lg. Straight', yahtzee: 'Yahtzee', chance: 'Chance',
};
const UPPER_BONUS_AT = 63;
const UPPER_BONUS = 35;
const YAHTZEE_BONUS = 100;

const rollDie = () => crypto.randomInt(6) + 1;
const sum = (dice) => dice.reduce((a, b) => a + b, 0);
function counts(dice) {
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) c[d]++;
  return c;
}
const isYahtzee = (dice) => dice.every((d) => d === dice[0]);
function hasRun(dice, len) {
  const have = new Set(dice);
  for (let start = 1; start + len - 1 <= 6; start++) {
    let ok = true;
    for (let v = start; v < start + len; v++) if (!have.has(v)) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

// Raw score for a box, ignoring joker rules.
function rawScore(cat, dice) {
  const c = counts(dice);
  const ui = UPPER.indexOf(cat);
  if (ui >= 0) return c[ui + 1] * (ui + 1);
  switch (cat) {
    case 'threeKind': return c.some((n) => n >= 3) ? sum(dice) : 0;
    case 'fourKind': return c.some((n) => n >= 4) ? sum(dice) : 0;
    case 'fullHouse': return c.includes(3) && c.includes(2) ? 25 : 0;
    case 'smallStraight': return hasRun(dice, 4) ? 30 : 0;
    case 'largeStraight': return hasRun(dice, 5) ? 40 : 0;
    case 'yahtzee': return isYahtzee(dice) ? 50 : 0;
    case 'chance': return sum(dice);
    default: return 0;
  }
}

// Which boxes may be used, and what each scores, for these dice on this card.
// Extra Yahtzees follow the forced-joker rule: use the matching upper box if it's
// open; otherwise any lower box scores full value; otherwise zero an upper box.
function options(card, dice) {
  const open = CATEGORIES.filter((c) => card[c] === null);
  const out = {};
  const joker = isYahtzee(dice) && card.yahtzee !== null;
  if (!joker) {
    for (const c of open) out[c] = rawScore(c, dice);
    return out;
  }
  const upperBox = UPPER[dice[0] - 1];
  if (card[upperBox] === null) {
    out[upperBox] = rawScore(upperBox, dice);
    return out;
  }
  const lowerOpen = open.filter((c) => LOWER.includes(c));
  if (lowerOpen.length) {
    const jokerValues = { fullHouse: 25, smallStraight: 30, largeStraight: 40 };
    for (const c of lowerOpen) out[c] = jokerValues[c] !== undefined ? jokerValues[c] : rawScore(c, dice);
    return out;
  }
  for (const c of open) out[c] = 0;
  return out;
}

function totals(card, yBonus) {
  const upper = UPPER.reduce((a, c) => a + (card[c] || 0), 0);
  const bonus = upper >= UPPER_BONUS_AT ? UPPER_BONUS : 0;
  const lower = LOWER.reduce((a, c) => a + (card[c] || 0), 0);
  return { upper, bonus, lower, yahtzeeBonus: yBonus, total: upper + bonus + lower + yBonus };
}

const blankCard = () => Object.fromEntries(CATEGORIES.map((c) => [c, null]));

function create(players) {
  const s = {
    players: players.map((p) => ({ id: p.id, name: p.name })),
    cards: players.map(blankCard),
    yahtzeeBonus: players.map(() => 0),
    turn: 0,
    round: 1,
    dice: [1, 1, 1, 1, 1],
    held: [false, false, false, false, false],
    rollsLeft: 3,
    rollNo: 0, // increases on every roll so the client can animate fresh dice
    last: null, // { seat, category, points }
    over: null,
  };
  return s;
}

const seatOf = (s, id) => s.players.findIndex((p) => p.id === id);

function act(s, playerId, action, ctx) {
  if (s.over) throw new Error('Game over');
  const seat = seatOf(s, playerId);
  if (seat === -1) throw new Error("You're not in this game");
  if (seat !== s.turn) throw new Error("It's not your turn");

  switch (action.type) {
    case 'hold': {
      const i = Number(action.index);
      if (!(i >= 0 && i < 5)) throw new Error('Pick a die');
      if (s.rollsLeft === 3 || s.rollsLeft === 0) throw new Error('Roll first');
      s.held[i] = !s.held[i];
      return;
    }
    case 'roll': {
      if (s.rollsLeft <= 0) throw new Error('No rolls left. Pick a box to score.');
      if (Array.isArray(action.held) && s.rollsLeft < 3) s.held = action.held.slice(0, 5).map(Boolean);
      if (s.rollsLeft === 3) s.held = [false, false, false, false, false];
      s.dice = s.dice.map((d, i) => (s.held[i] ? d : rollDie()));
      s.rollsLeft--;
      s.rollNo++;
      return;
    }
    case 'score': {
      if (s.rollsLeft === 3) throw new Error('Roll first');
      const card = s.cards[seat];
      const opts = options(card, s.dice);
      if (!(action.category in opts)) throw new Error("You can't score there");
      // A Yahtzee bonus applies to any extra Yahtzee once the Yahtzee box holds 50.
      if (isYahtzee(s.dice) && card.yahtzee === 50) {
        s.yahtzeeBonus[seat] += YAHTZEE_BONUS;
        ctx.log(`${s.players[seat].name} rolls another Yahtzee! +${YAHTZEE_BONUS} bonus`);
      }
      card[action.category] = opts[action.category];
      s.last = { seat, category: action.category, points: opts[action.category] };
      if (action.category === 'yahtzee' && opts.yahtzee === 50) ctx.log(`${s.players[seat].name} rolls a YAHTZEE!`);
      nextTurn(s);
      return;
    }
    default:
      throw new Error('Unknown action');
  }
}

function nextTurn(s) {
  s.held = [false, false, false, false, false];
  s.rollsLeft = 3;
  s.turn = (s.turn + 1) % s.players.length;
  if (s.turn === 0) s.round++;
  if (s.round > 13) finish(s);
}

function finish(s) {
  const scores = s.players.map((p, i) => ({ id: p.id, name: p.name, total: totals(s.cards[i], s.yahtzeeBonus[i]).total }));
  const best = Math.max(...scores.map((x) => x.total));
  const winners = scores.filter((x) => x.total === best);
  const ranked = scores.slice().sort((a, b) => b.total - a.total);
  s.over = {
    winners: winners.map((w) => w.id),
    summary: s.players.length === 1
      ? `${ranked[0].name} finishes with ${ranked[0].total}`
      : `${winners.map((w) => w.name).join(' & ')} win${winners.length > 1 ? '' : 's'} with ${best} (${ranked.map((x) => `${x.name} ${x.total}`).join(', ')})`,
  };
}

function waitingOn(s) {
  return s.over ? [] : [s.players[s.turn].id];
}

// --- Bot -----------------------------------------------------------------------
// A bot rates each possible box by its score relative to what that box is usually
// worth (plus upper-bonus progress), and before each reroll tries all 32 ways of
// keeping dice, simulating the rerolls to find the keep with the best expected value.

const TYPICAL = {
  ones: 2.1, twos: 5.3, threes: 8.6, fours: 12.2, fives: 15.7, sixes: 19.2,
  threeKind: 15, fourKind: 9, fullHouse: 16, smallStraight: 21, largeStraight: 14, yahtzee: 12, chance: 22,
};

// Value of the best box for these dice, from this card's point of view.
function bestBoxValue(card, dice, roundsLeft) {
  const opts = options(card, dice);
  const upperNow = UPPER.reduce((a, c) => a + (card[c] || 0), 0);
  let best = -Infinity;
  let bestCat = null;
  for (const [cat, pts] of Object.entries(opts)) {
    let v = pts - TYPICAL[cat];
    const ui = UPPER.indexOf(cat);
    if (ui >= 0 && upperNow < UPPER_BONUS_AT) {
      const par = 3 * (ui + 1); // three of each face reaches the bonus exactly
      v += (pts - par) * 0.6;
      if (upperNow + pts >= UPPER_BONUS_AT) v += 20;
    }
    if (cat === 'chance' && roundsLeft > 3) v -= 3; // keep Chance as a late safety net
    if (cat === 'yahtzee' && pts === 0 && roundsLeft > 4) v -= 6; // don't give up on Yahtzee early
    if (isYahtzee(dice) && card.yahtzee === 50) v += YAHTZEE_BONUS;
    if (v > best) { best = v; bestCat = cat; }
  }
  return { value: best, category: bestCat };
}

// Quick keep rule used inside simulations for the final reroll.
function greedyHold(dice) {
  const c = counts(dice);
  // Four in a row: keep one of each and chase the large straight.
  for (const start of [3, 2, 1]) {
    const run = [start, start + 1, start + 2, start + 3];
    if (run.every((v) => c[v])) {
      const used = new Set();
      return dice.map((d) => (run.includes(d) && !used.has(d) ? (used.add(d), true) : false));
    }
  }
  // Otherwise keep the most common face (highest on ties).
  let face = 6;
  for (let v = 6; v >= 1; v--) if (c[v] > c[face]) face = v;
  return dice.map((d) => d === face);
}

function rerolled(dice, held) {
  return dice.map((d, i) => (held[i] ? d : Math.floor(Math.random() * 6) + 1));
}

function bestHold(card, dice, rollsLeft, roundsLeft) {
  const TRIALS = 60;
  let best = null;
  for (let mask = 0; mask < 32; mask++) {
    const held = [0, 1, 2, 3, 4].map((i) => !!(mask & (1 << i)));
    let total = 0;
    const trials = mask === 31 ? 1 : TRIALS;
    for (let t = 0; t < trials; t++) {
      let d = mask === 31 ? dice : rerolled(dice, held);
      if (rollsLeft > 1 && mask !== 31) d = rerolled(d, greedyHold(d));
      total += bestBoxValue(card, d, roundsLeft).value;
    }
    const ev = total / trials;
    if (!best || ev > best.ev) best = { held, ev, mask };
  }
  return best;
}

function autoAction(s, id) {
  if (s.over) return null;
  const seat = seatOf(s, id);
  if (seat !== s.turn) return null;
  const card = s.cards[seat];
  const roundsLeft = 14 - s.round;
  if (s.rollsLeft === 3) return { type: 'roll' };
  if (s.rollsLeft > 0) {
    const h = bestHold(card, s.dice, s.rollsLeft, roundsLeft);
    if (h.mask !== 31) return { type: 'roll', held: h.held };
  }
  return { type: 'score', category: bestBoxValue(card, s.dice, roundsLeft).category };
}

// --- View ------------------------------------------------------------------------

function view(s, viewerId) {
  const mySeat = seatOf(s, viewerId);
  const current = s.cards[s.turn];
  return {
    mySeat,
    categories: CATEGORIES,
    upper: UPPER,
    lower: LOWER,
    labels: LABELS,
    players: s.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      card: s.cards[i],
      totals: totals(s.cards[i], s.yahtzeeBonus[i]),
    })),
    turn: s.turn,
    round: Math.min(s.round, 13),
    dice: s.dice,
    held: s.held,
    rollsLeft: s.rollsLeft,
    rollNo: s.rollNo,
    last: s.last,
    // What each open box would score for the player whose turn it is.
    preview: s.rollsLeft < 3 && !s.over ? options(current, s.dice) : null,
    bonusAt: UPPER_BONUS_AT,
    over: s.over,
  };
}

module.exports = { meta, create, act, view, waitingOn, autoAction, options, rawScore, totals };
