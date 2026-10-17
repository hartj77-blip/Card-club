// War for 2 players. Both flip their top card; the higher card takes both. A tie
// means war: each puts three cards face down and one face up, and the higher
// face-up card takes the whole pile (repeat on another tie). Take every card to
// win, or have the most cards when the round limit runs out.
const { newDeck, shuffle, rankOf } = require('../cards');

const meta = {
  id: 'war',
  name: 'War',
  blurb: '2 players. Flip, compare, go to war on a tie. Has an auto-flip button.',
  rules: [
    "The deck is split evenly. Both players flip their top card at the same time; the higher card takes both.",
    "Aces are high. On a tie it's war: each player puts three cards face down and one face up, and the higher face-up card takes them all.",
    "If you run out of cards, you lose. If the round limit is reached, whoever has the most cards wins.",
    "Tick Auto-flip to let the game flip for you.",
  ],
  minPlayers: 2,
  maxPlayers: 2,
  usesChips: false,
  continuous: false,
  options: [
    { key: 'maxRounds', label: 'Round limit (most cards wins after this)', min: 50, max: 2000, step: 50, default: 300 },
    { key: 'stake', label: 'Chip stake per player (winner takes the pot)', min: 0, max: 100000, step: 10, default: 0 },
  ],
};

function create(players, options) {
  const deck = shuffle(newDeck());
  return {
    options: { maxRounds: options.maxRounds },
    players: players.map((p) => ({ id: p.id, name: p.name })),
    piles: [deck.slice(0, 26), deck.slice(26)], // index 0 is the top of the pile
    ready: [false, false],
    round: 0,
    last: null, // { battles: [[cardA, cardB], ...], faceDown, winner, won }
    wars: 0,
    over: null,
  };
}

const seatOf = (s, id) => s.players.findIndex((p) => p.id === id);

function act(s, playerId, action, ctx) {
  if (s.over) throw new Error('Game over');
  const seat = seatOf(s, playerId);
  if (seat === -1) throw new Error("You're not in this game");
  if (action.type !== 'flip') throw new Error('Unknown action');
  s.ready[seat] = true;
  if (s.ready[0] && s.ready[1]) resolve(s, ctx);
}

function resolve(s, ctx) {
  s.ready = [false, false];
  s.round++;
  const pot = [];
  const battles = [];
  let faceDown = 0;
  let winner = -1;
  for (;;) {
    // A player who can't continue a war plays their last card face up.
    if (!s.piles[0].length || !s.piles[1].length) {
      winner = s.piles[0].length ? 0 : 1;
      break;
    }
    const a = s.piles[0].shift();
    const b = s.piles[1].shift();
    pot.push(a, b);
    battles.push([a, b]);
    if (rankOf(a) !== rankOf(b)) { winner = rankOf(a) > rankOf(b) ? 0 : 1; break; }
    // War: three face down each (fewer if a player is running low, keeping one to flip).
    s.wars++;
    for (const p of [0, 1]) {
      const n = Math.max(0, Math.min(3, s.piles[p].length - 1));
      const down = s.piles[p].splice(0, n);
      pot.push(...down);
      faceDown += down.length;
    }
  }
  // Shuffle the winnings onto the bottom so games can't loop forever.
  s.piles[winner].push(...shuffle(pot));
  s.last = { battles, faceDown, winner, won: pot.length };
  if (battles.length > 1) ctx.log(`War! ${s.players[winner].name} wins ${pot.length} cards`);

  const out = s.piles.findIndex((p) => !p.length);
  if (out >= 0) return end(s, 1 - out, 'took every card');
  if (s.round >= s.options.maxRounds) {
    const [x, y] = s.piles.map((p) => p.length);
    if (x === y) return end(s, -1, `tied at ${x} cards each after ${s.round} rounds`);
    return end(s, x > y ? 0 : 1, `has ${Math.max(x, y)} cards to ${Math.min(x, y)} after ${s.round} rounds`);
  }
}

function end(s, winner, how) {
  s.over = winner < 0
    ? { winners: s.players.map((p) => p.id), summary: `War ends in a draw, ${how}` }
    : { winners: [s.players[winner].id], summary: `${s.players[winner].name} ${how} (${s.wars} war${s.wars === 1 ? '' : 's'})` };
}

function waitingOn(s) {
  if (s.over) return [];
  return s.players.filter((_, i) => !s.ready[i]).map((p) => p.id);
}

// Bots (and anyone who wanders off) just flip.
function autoAction(s, id) {
  if (s.over) return null;
  const seat = seatOf(s, id);
  return seat >= 0 && !s.ready[seat] ? { type: 'flip' } : null;
}

function view(s, viewerId) {
  return {
    options: s.options,
    mySeat: seatOf(s, viewerId),
    players: s.players.map((p, i) => ({ id: p.id, name: p.name, count: s.piles[i].length, ready: s.ready[i] })),
    round: s.round,
    wars: s.wars,
    last: s.last,
    over: s.over,
  };
}

module.exports = { meta, create, act, view, waitingOn, autoAction };
