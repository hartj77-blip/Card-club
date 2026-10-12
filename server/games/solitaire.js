// Klondike solitaire for one player (others in the room can watch).
// Draw 1 or draw 3, unlimited passes through the stock, undo, and auto-finish
// once every card is face up. Your time and move count go on the scoreboard.
const { newDeck, shuffle, suitOf } = require('../cards');

const meta = {
  id: 'solitaire',
  name: 'Solitaire',
  blurb: 'Classic Klondike for one. Everyone else in the room can watch.',
  minPlayers: 1,
  maxPlayers: 1,
  usesChips: false,
  continuous: false,
  options: [
    { key: 'draw', label: 'Cards per draw (1 or 3)', min: 1, max: 3, step: 2, default: 1 },
  ],
};

const RANKS = 'A23456789TJQK';
const rank = (c) => RANKS.indexOf(c[0]) + 1; // A = 1 ... K = 13
const red = (c) => suitOf(c) === 'H' || suitOf(c) === 'D';
const SUITS = ['S', 'H', 'D', 'C'];
const UNDO_LIMIT = 200;

function create(players, options) {
  const deck = shuffle(newDeck());
  const tableau = [];
  for (let i = 0; i < 7; i++) {
    const cards = deck.splice(0, i + 1);
    tableau.push({ cards, up: i }); // cards[up..] are face up
  }
  return {
    options: { draw: options.draw === 3 ? 3 : 1 },
    player: { id: players[0].id, name: players[0].name },
    stock: deck,
    waste: [],
    foundations: { S: [], H: [], D: [], C: [] },
    tableau,
    moves: 0,
    passes: 0,
    startedAt: Date.now(),
    finishedAt: null,
    undo: [],
    over: null,
  };
}

const snapshot = (s) => JSON.stringify({ stock: s.stock, waste: s.waste, foundations: s.foundations, tableau: s.tableau, moves: s.moves, passes: s.passes });
function restore(s, snap) { Object.assign(s, JSON.parse(snap)); }
function remember(s) {
  s.undo.push(snapshot(s));
  if (s.undo.length > UNDO_LIMIT) s.undo.shift();
}

function canFoundation(s, card) {
  const f = s.foundations[suitOf(card)];
  return rank(card) === f.length + 1;
}

function canTableau(pile, card) {
  if (!pile.cards.length) return rank(card) === 13;
  const top = pile.cards[pile.cards.length - 1];
  return red(top) !== red(card) && rank(top) === rank(card) + 1;
}

function flipTop(pile) {
  if (!pile.cards.length) pile.up = 0; // an empty pile takes a face-up King next
  else if (pile.up >= pile.cards.length) pile.up = pile.cards.length - 1;
}

// Pull the moving cards off their source (without committing) to validate a move.
function source(s, from) {
  if (from.type === 'waste') {
    if (!s.waste.length) throw new Error('The waste pile is empty');
    return { cards: [s.waste[s.waste.length - 1]], take: () => s.waste.pop() };
  }
  if (from.type === 'foundation') {
    const f = s.foundations[from.suit];
    if (!f || !f.length) throw new Error('That foundation is empty');
    return { cards: [f[f.length - 1]], take: () => f.pop() };
  }
  if (from.type === 'tableau') {
    const pile = s.tableau[from.pile];
    if (!pile) throw new Error('No such pile');
    const i = Number(from.index);
    if (!(i >= pile.up && i < pile.cards.length)) throw new Error('You can only move face-up cards');
    return { cards: pile.cards.slice(i), take: () => { pile.cards.splice(i); flipTop(pile); } };
  }
  throw new Error('Unknown pile');
}

function move(s, from, to) {
  const src = source(s, from);
  if (to.type === 'foundation') {
    if (src.cards.length !== 1) throw new Error('Move one card at a time to a foundation');
    const card = src.cards[0];
    if (!canFoundation(s, card)) throw new Error("That card can't go there yet");
    remember(s);
    src.take();
    s.foundations[suitOf(card)].push(card);
  } else if (to.type === 'tableau') {
    const pile = s.tableau[to.pile];
    if (!pile) throw new Error('No such pile');
    if (from.type === 'tableau' && Number(from.pile) === Number(to.pile)) throw new Error('Pick a different pile');
    if (!canTableau(pile, src.cards[0])) throw new Error(pile.cards.length ? 'Needs the opposite color, one rank lower' : 'Only a King can go on an empty pile');
    remember(s);
    src.take();
    pile.cards.push(...src.cards);
  } else throw new Error('Unknown destination');
  s.moves++;
}

// Best single move for a card, used by double-tap: foundation first, then a tableau pile.
function autoDestination(s, from) {
  const src = source(s, from);
  if (src.cards.length === 1 && canFoundation(s, src.cards[0])) return { type: 'foundation' };
  for (let p = 0; p < 7; p++) {
    if (from.type === 'tableau' && Number(from.pile) === p) continue;
    const pile = s.tableau[p];
    // Don't shuffle a King between empty piles for nothing.
    if (!pile.cards.length && from.type === 'tableau' && Number(from.index) === 0) continue;
    if (canTableau(pile, src.cards[0])) return { type: 'tableau', pile: p };
  }
  return null;
}

const allFaceUp = (s) => !s.stock.length && !s.waste.length && s.tableau.every((p) => p.up <= 0 || !p.cards.length);
const won = (s) => SUITS.every((st) => s.foundations[st].length === 13);

function finish(s, didWin) {
  s.finishedAt = Date.now();
  const secs = Math.round((s.finishedAt - s.startedAt) / 1000);
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const placed = SUITS.reduce((a, st) => a + s.foundations[st].length, 0);
  s.result = { won: didWin, time, secs, moves: s.moves, placed };
  s.over = {
    winners: didWin ? [s.player.id] : [],
    summary: didWin
      ? `${s.player.name} solved it in ${time} with ${s.moves} moves (draw ${s.options.draw})`
      : `${s.player.name} got ${placed} of 52 cards home in ${time} (draw ${s.options.draw})`,
  };
}

function act(s, playerId, action) {
  if (s.over) throw new Error('Game over');
  if (playerId !== s.player.id) throw new Error("You're watching this game");

  switch (action.type) {
    case 'draw': {
      remember(s);
      if (!s.stock.length) {
        if (!s.waste.length) { s.undo.pop(); throw new Error('No cards left to draw'); }
        s.stock = s.waste.reverse();
        s.waste = [];
        s.passes++;
      } else {
        for (let i = 0; i < s.options.draw && s.stock.length; i++) s.waste.push(s.stock.pop());
      }
      s.moves++;
      return;
    }
    case 'move':
      move(s, action.from || {}, action.to || {});
      break;
    case 'auto': {
      const to = autoDestination(s, action.from || {});
      if (!to) throw new Error('No move for that card');
      move(s, action.from, to);
      break;
    }
    case 'finish': {
      if (!allFaceUp(s)) throw new Error('Turn every card face up first');
      remember(s);
      let progress = true;
      while (progress) {
        progress = false;
        for (const pile of s.tableau) {
          const top = pile.cards[pile.cards.length - 1];
          if (top && canFoundation(s, top)) { s.foundations[suitOf(top)].push(pile.cards.pop()); s.moves++; progress = true; }
        }
      }
      break;
    }
    case 'undo': {
      const snap = s.undo.pop();
      if (!snap) throw new Error('Nothing to undo');
      restore(s, snap);
      return;
    }
    case 'resign':
      finish(s, false);
      return;
    default:
      throw new Error('Unknown action');
  }
  if (won(s)) finish(s, true);
}

function waitingOn(s) {
  return s.over ? [] : [s.player.id];
}

// Solitaire has no bots; if the player walks away the game just waits for them.
function autoAction() {
  return null;
}

function view(s) {
  return {
    options: s.options,
    player: s.player,
    stockCount: s.stock.length,
    waste: s.waste.slice(-3),
    wasteCount: s.waste.length,
    foundations: s.foundations,
    tableau: s.tableau.map((p) => ({
      down: Math.min(p.up, p.cards.length),
      up: p.cards.slice(p.up),
      count: p.cards.length,
    })),
    moves: s.moves,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    canUndo: s.undo.length > 0,
    canFinish: !s.over && allFaceUp(s) && !won(s),
    result: s.result || null,
    over: s.over,
  };
}

module.exports = { meta, create, act, view, waitingOn, autoAction, canTableau, autoDestination };
