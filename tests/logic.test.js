'use strict';

/* Node test suite for the pure game logic in game.js. Run: node tests/logic.test.js */

const assert = require('assert');
const G = require('../game.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, err });
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const idx = (r, c) => r * 9 + c;

function boardWith(cells, icon = 1) {
  const b = G.emptyBoard();
  for (const [r, c] of cells) b[idx(r, c)] = icon;
  return b;
}

/* ---- Shape set integrity ---- */

test('43 shapes, weights sum to 100', () => {
  assert.strictEqual(G.SHAPES.length, 43);
  const total = G.SHAPES.reduce((a, s) => a + s.weight, 0);
  assert.ok(Math.abs(total - 100) < 1e-9, 'total weight ' + total);
});

test('expected piece size is about 3.62 cells', () => {
  const avg = G.SHAPES.reduce((a, s) => a + s.weight * s.cells.length, 0) / 100;
  assert.ok(Math.abs(avg - 3.62) < 0.02, 'avg ' + avg);
});

test('every shape: unique in-bounds cells matching its bounding box', () => {
  const seen = new Set();
  for (const s of G.SHAPES) {
    const key = s.cells.map(([r, c]) => r + ',' + c).sort().join('|');
    assert.ok(!seen.has(key), 'duplicate shape ' + key);
    seen.add(key);
    assert.ok(s.cells.length >= 1 && s.cells.length <= 5);
    let maxR = 0, maxC = 0, minR = 9, minC = 9;
    const cellSet = new Set();
    for (const [r, c] of s.cells) {
      assert.ok(r >= 0 && c >= 0 && r < 5 && c < 5);
      cellSet.add(r + ',' + c);
      maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
      minR = Math.min(minR, r); minC = Math.min(minC, c);
    }
    assert.strictEqual(cellSet.size, s.cells.length, 'repeated cell in shape');
    assert.strictEqual(minR, 0, 'shape not anchored to row 0');
    assert.strictEqual(minC, 0, 'shape not anchored to col 0');
    assert.strictEqual(s.h, maxR + 1);
    assert.strictEqual(s.w, maxC + 1);
  }
});

test('no 2x3, 3x2 or 3x3 rectangles in the set', () => {
  for (const s of G.SHAPES) {
    const full = s.cells.length === s.w * s.h;
    assert.ok(!(full && s.w >= 2 && s.h >= 2 && s.cells.length > 4), 'oversized rect present');
  }
});

/* ---- Placement ---- */

test('canPlace: bounds and overlap', () => {
  const line5h = G.SHAPES.find((s) => s.w === 5 && s.h === 1);
  const b = G.emptyBoard();
  assert.ok(G.canPlace(b, line5h, 0, 0));
  assert.ok(G.canPlace(b, line5h, 8, 4));
  assert.ok(!G.canPlace(b, line5h, 0, 5), 'runs off right edge');
  assert.ok(!G.canPlace(b, line5h, -1, 0));
  b[idx(3, 2)] = 2;
  assert.ok(!G.canPlace(b, line5h, 3, 0), 'overlap');
  assert.ok(G.canPlace(b, line5h, 3, 3));
});

test('fitsSomewhere: every shape fits an empty board, none fits a full board', () => {
  const empty = G.emptyBoard();
  const full = new Int8Array(81).fill(1);
  for (const s of G.SHAPES) {
    assert.ok(G.fitsSomewhere(empty, s));
    assert.ok(!G.fitsSomewhere(full, s));
  }
});

test('placePiece writes the icon and returns indices', () => {
  const b = G.emptyBoard();
  const diag = G.SHAPES.find((s) => s.cells.length === 3 && s.w === 3 && s.h === 3 && s.cells.every(([r, c]) => r === c));
  const placed = G.placePiece(b, diag, 2, 4, 3);
  assert.deepStrictEqual(placed.sort((a, z) => a - z), [idx(2, 4), idx(3, 5), idx(4, 6)]);
  for (const i of placed) assert.strictEqual(b[i], 3);
});

/* ---- Unit scan ---- */

test('scanUnits finds a full row, col and box', () => {
  const row = boardWith(Array.from({ length: 9 }, (_, c) => [4, c]));
  assert.deepStrictEqual(G.scanUnits(row).map((u) => u.type), ['row']);

  const col = boardWith(Array.from({ length: 9 }, (_, r) => [r, 7]));
  assert.deepStrictEqual(G.scanUnits(col).map((u) => u.type), ['col']);

  const box = [];
  for (let r = 3; r < 6; r++) for (let c = 6; c < 9; c++) box.push([r, c]);
  const units = G.scanUnits(boardWith(box));
  assert.strictEqual(units.length, 1);
  assert.strictEqual(units[0].type, 'box');
  assert.strictEqual(units[0].index, 5);
});

test('nearly full units are not detected', () => {
  const cells = Array.from({ length: 8 }, (_, c) => [4, c]);
  assert.strictEqual(G.scanUnits(boardWith(cells)).length, 0);
});

test('triple intersection: row+col+box = 3 units, 21-cell union', () => {
  const cells = [];
  for (let c = 0; c < 9; c++) cells.push([4, c]);
  for (let r = 0; r < 9; r++) cells.push([r, 4]);
  for (let r = 3; r < 6; r++) for (let c = 3; c < 6; c++) cells.push([r, c]);
  const b = boardWith(cells);
  const units = G.scanUnits(b);
  assert.strictEqual(units.length, 3);
  assert.deepStrictEqual(units.map((u) => u.type).sort(), ['box', 'col', 'row']);
  assert.strictEqual(G.unionCells(units).size, 21);
});

/* ---- Scoring ---- */

test('clearScore: 18*(2n-1)', () => {
  assert.strictEqual(G.clearScore(0), 0);
  assert.strictEqual(G.clearScore(1), 18);
  assert.strictEqual(G.clearScore(2), 54);
  assert.strictEqual(G.clearScore(3), 90);
  assert.strictEqual(G.clearScore(4), 126);
  assert.strictEqual(G.clearScore(5), 162);
});

test('icon bonus tiers', () => {
  assert.strictEqual(G.iconBonusTier(0), 0);
  assert.strictEqual(G.iconBonusTier(2), 0);
  assert.strictEqual(G.iconBonusTier(3), 10);
  assert.strictEqual(G.iconBonusTier(4), 10);
  assert.strictEqual(G.iconBonusTier(5), 25);
  assert.strictEqual(G.iconBonusTier(6), 25);
  assert.strictEqual(G.iconBonusTier(7), 50);
  assert.strictEqual(G.iconBonusTier(8), 50);
  assert.strictEqual(G.iconBonusTier(9), 100);
});

function rowBoard(icons) {
  const b = G.emptyBoard();
  icons.forEach((icon, c) => { b[idx(0, c)] = icon; });
  return b;
}

test('iconBonuses: 3 same icons in a cleared row pay 10', () => {
  const b = rowBoard([1, 1, 1, 2, 3, 4, 2, 3, 4]);
  const bonuses = G.iconBonuses(b, G.scanUnits(b));
  assert.strictEqual(bonuses.length, 1);
  assert.strictEqual(bonuses[0].icon, 1);
  assert.strictEqual(bonuses[0].count, 3);
  assert.strictEqual(bonuses[0].points, 10);
  assert.strictEqual(bonuses[0].perfect, false);
});

test('iconBonuses: two qualifying icons in one unit both pay', () => {
  const b = rowBoard([1, 1, 1, 1, 2, 2, 2, 3, 4]);
  const bonuses = G.iconBonuses(b, G.scanUnits(b));
  assert.strictEqual(bonuses.length, 2);
  const byIcon = Object.fromEntries(bonuses.map((x) => [x.icon, x.points]));
  assert.strictEqual(byIcon[1], 10);
  assert.strictEqual(byIcon[2], 10);
});

test('iconBonuses: 5 and 7 counts hit higher tiers', () => {
  let b = rowBoard([2, 2, 2, 2, 2, 1, 1, 3, 4]);
  assert.strictEqual(G.iconBonuses(b, G.scanUnits(b))[0].points, 25);
  b = rowBoard([3, 3, 3, 3, 3, 3, 3, 1, 2]);
  assert.strictEqual(G.iconBonuses(b, G.scanUnits(b))[0].points, 50);
});

test('iconBonuses: perfect 9 pays 100, lizard doubles everything', () => {
  let b = rowBoard([4, 4, 4, 4, 4, 4, 4, 4, 4]);
  let bonus = G.iconBonuses(b, G.scanUnits(b))[0];
  assert.strictEqual(bonus.points, 100);
  assert.strictEqual(bonus.perfect, true);

  b = rowBoard([0, 0, 0, 1, 2, 3, 1, 2, 3]);
  assert.strictEqual(G.iconBonuses(b, G.scanUnits(b))[0].points, 20, 'lizard trio doubles to 20');

  b = rowBoard([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(G.iconBonuses(b, G.scanUnits(b))[0].points, 200, 'full lizard row doubles to 200');
});

test('iconBonuses: shared cell counts toward every containing unit', () => {
  const cells = [];
  for (let c = 0; c < 9; c++) cells.push([4, c]);
  for (let r = 0; r < 9; r++) cells.push([r, 4]);
  const b = boardWith(cells, 2);
  const units = G.scanUnits(b);
  const bonuses = G.iconBonuses(b, units);
  assert.strictEqual(units.length, 2);
  assert.strictEqual(bonuses.length, 2, 'one perfect bonus per unit');
  for (const bo of bonuses) assert.strictEqual(bo.points, 100);
});

/* ---- Generation ---- */

test('pickShapeId and pickIcon stay in range across seeds', () => {
  const rng = mulberry32(42);
  for (let i = 0; i < 5000; i++) {
    const s = G.pickShapeId(rng);
    const ic = G.pickIcon(rng);
    assert.ok(s >= 0 && s < 43);
    assert.ok(ic >= 0 && ic < 5);
  }
});

test('icon weights: lizard is rare (about 8%)', () => {
  const rng = mulberry32(7);
  let lizards = 0;
  const trials = 20000;
  for (let i = 0; i < trials; i++) if (G.pickIcon(rng) === G.LIZARD_ICON) lizards++;
  const rate = lizards / trials;
  assert.ok(rate > 0.06 && rate < 0.10, 'lizard rate ' + rate);
});

test('genTray: 3 valid pieces, never 3 identical shapes', () => {
  const rng = mulberry32(1234);
  const b = G.emptyBoard();
  for (let i = 0; i < 500; i++) {
    const tray = G.genTray(b, rng);
    assert.strictEqual(tray.length, 3);
    for (const p of tray) {
      assert.ok(p.shapeId >= 0 && p.shapeId < 43);
      assert.ok(p.icon >= 0 && p.icon < 5);
    }
    assert.ok(!(tray[0].shapeId === tray[1].shapeId && tray[1].shapeId === tray[2].shapeId));
  }
});

test('genTray mercy: prefers a tray with at least one fitting piece', () => {
  /* Board with only one empty cell: only a Single fits. */
  const b = new Int8Array(81).fill(1);
  b[idx(4, 4)] = -1;
  const rng = mulberry32(99);
  let fittingTrays = 0;
  for (let i = 0; i < 50; i++) {
    const tray = G.genTray(b, rng);
    if (tray.some((p) => G.fitsSomewhere(b, G.SHAPES[p.shapeId]))) fittingTrays++;
  }
  /* Singles are 4% per slot; without mercy about 11% of trays would fit.
     With 20 rerolls nearly every tray should contain a fitting piece. */
  assert.ok(fittingTrays >= 45, 'mercy rerolls: ' + fittingTrays + '/50');
});

test('genTray terminates even when nothing can fit', () => {
  const full = new Int8Array(81).fill(2);
  const rng = mulberry32(5);
  const tray = G.genTray(full, rng);
  assert.strictEqual(tray.length, 3);
});

/* ---- Game over ---- */

test('isGameOver: empty tray is never game over', () => {
  const full = new Int8Array(81).fill(1);
  assert.strictEqual(G.isGameOver(full, [null, null, null]), false);
});

test('isGameOver: false while any piece fits, true when none does', () => {
  const b = new Int8Array(81).fill(1);
  b[idx(0, 0)] = -1;
  const single = { shapeId: 0, icon: 1 };
  const line5 = { shapeId: G.SHAPES.findIndex((s) => s.w === 5), icon: 2 };
  assert.strictEqual(G.isGameOver(b, [single, null, null]), false);
  assert.strictEqual(G.isGameOver(b, [line5, null, null]), true);
  assert.strictEqual(G.isGameOver(b, [line5, single, null]), false);
});

/* ---- Persistence ---- */

test('save round-trip preserves board, tray, score, best', () => {
  const rng = mulberry32(2024);
  const b = G.emptyBoard();
  G.placePiece(b, G.SHAPES[13], 3, 3, 2);
  const tray = [G.makePiece(rng), null, G.makePiece(rng)];
  const encoded = G.encodeSave(777, b, tray, 123);
  const decoded = G.validateSave(JSON.parse(JSON.stringify(encoded)));
  assert.strictEqual(decoded.best, 777);
  assert.ok(decoded.game);
  assert.deepStrictEqual(Array.from(decoded.game.board), Array.from(b));
  assert.deepStrictEqual(decoded.game.tray, tray);
  assert.strictEqual(decoded.game.score, 123);
});

test('validateSave: corrupt payloads keep best, drop game', () => {
  assert.deepStrictEqual(G.validateSave(null), { best: 0, game: null });
  assert.deepStrictEqual(G.validateSave('junk'), { best: 0, game: null });
  assert.deepStrictEqual(G.validateSave({ v: 1, best: 42 }), { best: 42, game: null });

  const bad1 = G.validateSave({ v: 1, best: 10, game: { board: [1, 2, 3], tray: [null, null, null], score: 5 } });
  assert.strictEqual(bad1.best, 10);
  assert.strictEqual(bad1.game, null);

  const goodBoard = new Array(81).fill(-1);
  const bad2 = G.validateSave({ v: 1, best: 10, game: { board: goodBoard, tray: [{ shapeId: 99, icon: 0 }, null, null], score: 5 } });
  assert.strictEqual(bad2.game, null, 'out of range shapeId rejected');

  const bad3 = G.validateSave({ v: 1, best: 10, game: { board: goodBoard, tray: [{ shapeId: 0, icon: 7 }, null, null], score: 5 } });
  assert.strictEqual(bad3.game, null, 'out of range icon rejected');

  const boardWithBadIcon = goodBoard.slice();
  boardWithBadIcon[0] = 6;
  const bad4 = G.validateSave({ v: 1, best: 10, game: { board: boardWithBadIcon, tray: [null, null, null], score: 5 } });
  assert.strictEqual(bad4.game, null, 'out of range board value rejected');

  const bad5 = G.validateSave({ v: 1, best: -5, game: null });
  assert.strictEqual(bad5.best, 0, 'negative best rejected');
});

/* ---- Simulated full turns: the resolve pipeline invariants ---- */

test('simulated turn: place, detect, clear union once, score correctly', () => {
  /* Row 0 has 8 cells filled with icon 1; placing a single at (0,8)
     completes the row: 9 cells of icon 1 except the placed one. */
  const b = rowBoard([1, 1, 1, 1, 1, 1, 1, 1, -1]);
  const single = G.SHAPES[0];
  G.placePiece(b, single, 0, 8, 1);
  const units = G.scanUnits(b);
  assert.strictEqual(units.length, 1);
  const bonuses = G.iconBonuses(b, units);
  assert.strictEqual(bonuses[0].points, 100, 'perfect 9 of icon 1');
  const union = G.unionCells(units);
  for (const i of union) b[i] = -1;
  assert.ok(Array.from(b).every((v) => v === -1), 'board fully cleared');
  const gained = single.cells.length + G.clearScore(units.length) + bonuses.reduce((a, x) => a + x.points, 0);
  assert.strictEqual(gained, 1 + 18 + 100);
});

test('simulated turn: detection reads pre-clear snapshot (cross clear)', () => {
  /* Row 4 and column 4 both missing only (4,4). One single completes both. */
  const cells = [];
  for (let c = 0; c < 9; c++) if (c !== 4) cells.push([4, c]);
  for (let r = 0; r < 9; r++) if (r !== 4) cells.push([r, 4]);
  const b = boardWith(cells, 3);
  G.placePiece(b, G.SHAPES[0], 4, 4, 3);
  const units = G.scanUnits(b);
  assert.strictEqual(units.length, 2, 'row AND column detected together');
  assert.strictEqual(G.clearScore(units.length), 54);
  const union = G.unionCells(units);
  assert.strictEqual(union.size, 17);
  const bonuses = G.iconBonuses(b, units);
  assert.strictEqual(bonuses.length, 2);
  for (const bo of bonuses) assert.strictEqual(bo.points, 100);
});

/* ---- Report ---- */

if (failures.length) {
  for (const f of failures) {
    console.error('FAIL: ' + f.name);
    console.error('  ' + (f.err && f.err.message));
  }
  console.error('\n' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(1);
} else {
  console.log('All ' + passed + ' tests passed');
}
