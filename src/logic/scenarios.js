/* Beta test scenarios: hand-built board states one move away from a specific
   outcome, so end-state scoring and item flows can be exercised on demand.
   Pure builders (fresh structures every call) so the Node tests can assert
   each scenario's promise. Each entry's target names the tray slot and board
   cell of the intended move; expect declares what that move must produce
   (unfiltered; active filters can change icon-dependent bonuses).

   The builders honor the beta generation filters where they can: theme and
   filler icons stay inside the allowed icon set, and filler tray pieces are
   drawn through the filtered pickers. Scenario-ESSENTIAL pieces keep their
   shapes regardless of the class filter (the promise depends on them): the
   Single that lands the target move, and nearGameOver's two Line5s. */

import { emptyBoard } from './scoring.js';
import { ITEM_CAPS } from './items.js';
import { genTray, makePiece } from './generate.js';
import { pickIcon, iconFilterList } from './pieces.js';

const idx = (r, c) => r * 9 + c;

/* Perfect-match scenarios prefer star: every icon works, but the lizard
   would double the bonus and muddy an A/B comparison against the plain
   tiers. An icon filter that excludes it picks the lowest allowed icon. */
const STAR = 3;

function themeIcon(preferred) {
  const allowed = iconFilterList();
  if (!allowed || allowed.includes(preferred)) return preferred;
  return allowed[0];
}

/* Board fillers cycle a mixed, non-lizard pool, restricted to the icon
   filter when one is active (a one-icon filter makes them uniform). */
function fillerPool() {
  return iconFilterList() || [1, 2, 3, 4, 5];
}

function cappedInv() {
  const inv = {};
  for (const k of Object.keys(ITEM_CAPS)) inv[k] = ITEM_CAPS[k];
  return inv;
}

/* Row 4 all one icon except (4,8); the tray's Single finishes one perfect
   set. Col 8 and box 5 stay far from full, so exactly one unit clears. */
function buildPerfect1(rng) {
  const icon = themeIcon(STAR);
  const board = emptyBoard();
  for (let c = 0; c < 8; c++) board[idx(4, c)] = icon;
  return {
    board,
    tray: [{ shapeId: 0, icon }, makePiece(rng), makePiece(rng)],
    inv: cappedInv(),
    score: 0,
  };
}

/* Row 4 and col 4 all one icon except their shared cell (4,4): the Single
   lands two perfect sets at once, which is also the smallest Matching Sets
   combo. The center box holds only 5 cells, so no accidental third unit. */
function buildPerfect2(rng) {
  const icon = themeIcon(STAR);
  const board = emptyBoard();
  for (let c = 0; c < 9; c++) if (c !== 4) board[idx(4, c)] = icon;
  for (let r = 0; r < 9; r++) if (r !== 4) board[idx(r, 4)] = icon;
  return {
    board,
    tray: [{ shapeId: 0, icon }, makePiece(rng), makePiece(rng)],
    inv: cappedInv(),
    score: 0,
  };
}

/* Row 4 + col 4 + the center box all one icon except (4,4): one Single,
   three perfect sets. Neighboring rows/cols hold only 3 cells each, so
   exactly three units clear. */
function buildPerfect3(rng) {
  const icon = themeIcon(STAR);
  const board = emptyBoard();
  for (let c = 0; c < 9; c++) if (c !== 4) board[idx(4, c)] = icon;
  for (let r = 0; r < 9; r++) if (r !== 4) board[idx(r, 4)] = icon;
  for (const [r, c] of [[3, 3], [3, 5], [5, 3], [5, 5]]) board[idx(r, c)] = icon;
  return {
    board,
    tray: [{ shapeId: 0, icon }, makePiece(rng), makePiece(rng)],
    inv: cappedInv(),
    score: 0,
  };
}

/* 18 holes, exactly two per row, per column, and per box, none horizontally
   or vertically adjacent. The Single fits anywhere but can never complete a
   unit (every unit keeps a hole), and once it lands the two Line5s fit
   nowhere: plain game over, with a full pocket of items as the only way out.
   The diagonal run (5,5)-(6,6)-(7,7) is deliberate: a rerolled diagonal can
   genuinely rescue. */
const GAME_OVER_HOLES = [
  [0, 0], [0, 4], [1, 2], [1, 7], [2, 5], [2, 8],
  [3, 1], [3, 6], [4, 3], [4, 8], [5, 0], [5, 5],
  [6, 2], [6, 6], [7, 4], [7, 7], [8, 1], [8, 3],
];
function buildNearGameOver(rng) {
  const pool = fillerPool();
  const board = emptyBoard();
  const holes = new Set(GAME_OVER_HOLES.map(([r, c]) => idx(r, c)));
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (!holes.has(idx(r, c))) board[idx(r, c)] = pool[(r + c) % pool.length];
    }
  }
  /* All three pieces are essential to the promise; only their icons follow
     the filter. */
  return {
    board,
    tray: [{ shapeId: 0, icon: pickIcon(rng) }, { shapeId: 32, icon: pickIcon(rng) }, { shapeId: 33, icon: pickIcon(rng) }],
    inv: cappedInv(),
    score: 0,
  };
}

/* A fresh board with every item at its cap. The tray is the only rng consumer
   here, and it honors any active generation filters, which is exactly what a
   tester restricting the pool wants. */
function buildEmptyFull(rng) {
  const board = emptyBoard();
  return {
    board,
    tray: genTray(board, rng),
    inv: cappedInv(),
    score: 0,
  };
}

/* Row 7, col 7, and the bottom-right box all filled except their shared cell
   (7,7). One Single completes a box + column + row x3 combo. Icons are
   deliberately mixed, and the Single is a heart, so NO icon bonus fires and
   the x3 combo reads clean (a narrow icon filter can force bonuses back in;
   that is what the tester asked for). */
function buildCombo3(rng) {
  const pool = fillerPool();
  const board = emptyBoard();
  const paint = (r, c) => { board[idx(r, c)] = pool[(r * 2 + c) % pool.length]; };
  for (let c = 0; c < 9; c++) if (c !== 7) paint(7, c);
  for (let r = 0; r < 9; r++) if (r !== 7) paint(r, 7);
  for (const [r, c] of [[6, 6], [6, 8], [8, 6], [8, 8]]) paint(r, c);
  return {
    board,
    tray: [{ shapeId: 0, icon: themeIcon(2) }, makePiece(rng), makePiece(rng)],
    inv: cappedInv(),
    score: 0,
  };
}

const SCENARIOS = [
  {
    id: 'perfect1',
    label: '1 move from a perfect set',
    target: { slot: 0, row: 4, col: 8 },
    expect: { units: 1, perfectCount: 1, msUnits: 0, gameOverAfter: false },
    build: buildPerfect1,
  },
  {
    id: 'perfect2',
    label: '1 move from 2 perfect sets',
    target: { slot: 0, row: 4, col: 4 },
    expect: { units: 2, perfectCount: 2, msUnits: 2, gameOverAfter: false },
    build: buildPerfect2,
  },
  {
    id: 'perfect3',
    label: '1 move from 3 perfect sets',
    target: { slot: 0, row: 4, col: 4 },
    expect: { units: 3, perfectCount: 3, msUnits: 3, gameOverAfter: false },
    build: buildPerfect3,
  },
  {
    id: 'nearGameOver',
    label: '1 move from game over, all items',
    target: { slot: 0, row: 0, col: 0 },
    expect: { units: 0, perfectCount: 0, msUnits: 0, gameOverAfter: true },
    build: buildNearGameOver,
  },
  {
    id: 'emptyFull',
    label: 'Fresh board, all items',
    build: buildEmptyFull,
  },
  {
    id: 'combo3',
    label: '1 move from a box+col+row combo',
    target: { slot: 0, row: 7, col: 7 },
    expect: { units: 3, perfectCount: 0, msUnits: 0, gameOverAfter: false },
    build: buildCombo3,
  },
];

function buildScenario(id, rng) {
  const s = SCENARIOS.find((x) => x.id === id);
  return s ? s.build(rng) : null;
}

export { SCENARIOS, buildScenario };
