'use strict';

/* Node test suite for the pure game logic in src/logic. Run: node tests/logic.test.js */

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as G from '../src/logic/index.js';

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

test('47 shapes in 16 classes, weights sum to 106', () => {
  assert.strictEqual(G.SHAPES.length, 47);
  const total = G.SHAPES.reduce((a, s) => a + s.weight, 0);
  assert.ok(Math.abs(total - 106) < 1e-9, 'total weight ' + total);
});

test('expected piece size is 392/106 cells, derived from the weighted set', () => {
  const totalWeight = G.SHAPES.reduce((a, s) => a + s.weight, 0);
  const weightedCells = G.SHAPES.reduce((a, s) => a + s.weight * s.cells.length, 0);
  assert.ok(Math.abs(totalWeight - 106) < 1e-9, 'weights sum to 106');
  assert.ok(Math.abs(weightedCells - 392) < 1e-9, 'weighted cell total is 392 (incl. the U class)');
  const avg = weightedCells / totalWeight;
  assert.ok(Math.abs(avg - 392 / 106) < 1e-9, 'avg ' + avg);
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

test('tutorial box step: a center single clears only the box, no icon bonus', () => {
  /* Mirrors the hands-on box lesson: the middle 3x3 box (rows 3-5, cols 3-5)
     is filled point-symmetrically save the center; a butterfly single at
     (4,4) completes it. Icon counts are 2/2/2/2/1 so no icon bonus fires, and
     row 4 and col 4 hold only 3 cells each so nothing but the box clears. */
  const b = G.emptyBoard();
  const box = [[3, 3], [3, 4], [3, 5], [4, 3], [4, 5], [5, 3], [5, 4], [5, 5]];
  [1, 2, 3, 4, 4, 3, 2, 1].forEach((icon, i) => { b[idx(box[i][0], box[i][1])] = icon; });
  G.placePiece(b, G.SHAPES[0], 4, 4, 5); /* butterfly single */
  const units = G.scanUnits(b);
  assert.strictEqual(units.length, 1, 'only the middle box completes');
  assert.strictEqual(units[0].type, 'box');
  assert.strictEqual(units[0].index, 4);
  assert.strictEqual(G.iconBonuses(b, units).length, 0, 'counts 2/2/2/2/1, no bonus');
});

/* ---- Generation ---- */

test('pickShapeId and pickIcon stay in range across seeds', () => {
  const rng = mulberry32(42);
  for (let i = 0; i < 5000; i++) {
    const s = G.pickShapeId(rng);
    const ic = G.pickIcon(rng);
    assert.ok(s >= 0 && s < 47);
    assert.ok(ic >= 0 && ic < 6);
  }
});

test('icon weights: lizard is rare (about 6.5%)', () => {
  const rng = mulberry32(7);
  let lizards = 0;
  const trials = 20000;
  for (let i = 0; i < trials; i++) if (G.pickIcon(rng) === G.LIZARD_ICON) lizards++;
  const rate = lizards / trials;
  assert.ok(rate > 0.05 && rate < 0.08, 'lizard rate ' + rate);
});

test('genTray: 3 valid pieces, never 3 identical shapes', () => {
  const rng = mulberry32(1234);
  const b = G.emptyBoard();
  for (let i = 0; i < 500; i++) {
    const tray = G.genTray(b, rng);
    assert.strictEqual(tray.length, 3);
    for (const p of tray) {
      assert.ok(p.shapeId >= 0 && p.shapeId < 47);
      assert.ok(p.icon >= 0 && p.icon < 6);
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

/* Board full except three vertical cells at column 0, rows 0-2. Only a
   vertical 3-line fits; the horizontal Line3 (shapeId 5) must be rotated. */
function gapBoard() {
  const b = new Int8Array(81).fill(1);
  b[idx(0, 0)] = -1; b[idx(1, 0)] = -1; b[idx(2, 0)] = -1;
  return b;
}

test('isGameOverWithRotate: a Rotate in stock rescues a piece that fits only rotated', () => {
  const b = gapBoard();
  const tray = [{ shapeId: 5, icon: 1 }, null, null]; /* horizontal Line3 */
  assert.strictEqual(G.isGameOver(b, tray), true, 'no current orientation fits');
  assert.strictEqual(G.isGameOverWithRotate(b, tray, 1), false, 'a Rotate saves it');
  assert.strictEqual(G.isGameOverWithRotate(b, tray, 0), true, 'no Rotate, truly over');
});

test('isGameOverWithRotate: an open free-spin session rescues with no Rotate in stock', () => {
  const b = gapBoard();
  const tray = [{ shapeId: 5, icon: 1, rotFree: true, rotOrig: 6 }, null, null];
  assert.strictEqual(G.isGameOverWithRotate(b, tray, 0), false, 'the session unlocks its orbit');
});

test('isGameOverWithRotate: a symmetric piece cannot be rotated to fit', () => {
  const b = new Int8Array(81).fill(1);
  b[idx(0, 0)] = -1; /* one empty cell, only a single fits */
  const tray = [{ shapeId: 13, icon: 1 }, null, null]; /* 2x2 square, rotation fixed point */
  assert.strictEqual(G.isGameOverWithRotate(b, tray, 3), true, 'spinning a square does nothing');
});

test('isGameOverWithRotate: walks the whole orbit (U pentomino needs two spins)', () => {
  const b = new Int8Array(81).fill(1);
  for (const [r, c] of G.SHAPES[45].cells) b[idx(r, c)] = -1; /* hole is exactly SHAPES[45] */
  const tray = [{ shapeId: 43, icon: 1 }, null, null]; /* 43 -> 46 -> 45 reaches the fit */
  assert.strictEqual(G.isGameOverWithRotate(b, tray, 1), false, 'the orbit reaches shape 45');
  assert.strictEqual(G.isGameOverWithRotate(b, tray, 0), true, 'as-is it fits nowhere');
});

test('isGameOverWithRotate: one piece\'s session does not unlock another piece', () => {
  const b = gapBoard();
  const tray = [
    { shapeId: 43, icon: 1, rotFree: true, rotOrig: 44 }, /* pentomino, no orbit member fits */
    { shapeId: 5, icon: 1 },                              /* Line3, fits only when rotated */
    null,
  ];
  assert.strictEqual(G.isGameOverWithRotate(b, tray, 0), true, 'the session does not carry to Line3');
  assert.strictEqual(G.isGameOverWithRotate(b, tray, 1), false, 'a stocked Rotate rescues Line3');
});

test('isGameOverWithRotate: empty tray is never game over', () => {
  const full = new Int8Array(81).fill(1);
  assert.strictEqual(G.isGameOverWithRotate(full, [null, null, null], 3), false);
});

test('isGameOverWithItems: a Reroll in stock always keeps a stuck tray alive', () => {
  const b = gapBoard();
  const tray = [{ shapeId: 13, icon: 1 }, null, null]; /* square, fits nowhere, no orbit */
  assert.strictEqual(G.isGameOverWithItems(b, tray, 0, 1), false, 'the swap might fit');
  assert.strictEqual(G.isGameOverWithItems(b, tray, 0, 0), true, 'no items, truly over');
  assert.strictEqual(G.isGameOverWithItems(b, tray, 3, 0), true, 'rotating a square does nothing');
});

test('isGameOverWithItems: defers to the rotate orbit when no Reroll is held', () => {
  const b = gapBoard();
  const tray = [{ shapeId: 5, icon: 1 }, null, null]; /* Line3, fits only rotated */
  assert.strictEqual(G.isGameOverWithItems(b, tray, 1, 0), false, 'the Rotate rescues');
  assert.strictEqual(G.isGameOverWithItems(b, tray, 0, 0), true, 'nothing left');
});

test('isGameOverWithItems: empty tray is never game over', () => {
  const full = new Int8Array(81).fill(1);
  assert.strictEqual(G.isGameOverWithItems(full, [null, null, null], 0, 0), false);
});

test('rotationRescues: true only when a reachable orientation fits', () => {
  const b = gapBoard();
  const line3 = { shapeId: 5, icon: 1 }; /* horizontal Line3, fits only rotated */
  assert.strictEqual(G.rotationRescues(b, line3, 1), true, 'a stocked Rotate reaches the fit');
  assert.strictEqual(G.rotationRescues(b, line3, 0), false, 'no Rotate, orbit locked');
  assert.strictEqual(G.rotationRescues(b, { ...line3, rotFree: true, rotOrig: 6 }, 0), true,
    'an open session spins for free');
  assert.strictEqual(G.rotationRescues(b, { shapeId: 13, icon: 1 }, 3), false,
    'a symmetric square has no orbit to walk');
  assert.strictEqual(G.rotationRescues(b, { shapeId: 43, icon: 1 }, 1), false,
    'no U pentomino orientation fits the 3-gap');
});

/* ---- Persistence ---- */

test('save v2 round-trip preserves everything', () => {
  const rng = mulberry32(2024);
  const b = G.emptyBoard();
  G.placePiece(b, G.SHAPES[13], 3, 3, 2);
  const frozen = new Uint8Array(81);
  frozen[3 * 9 + 3] = 1;
  const tray = [{ ...G.makePiece(rng), frozen: true }, { shapeId: 16, icon: 2, flipFree: true, flipOrig: G.FLIP_MAP[16] }, { shapeId: 1, icon: 3, rotFree: true, rotOrig: 2 }];
  const scoreLog = [
    G.makeScoreLogEntry(1, 2, [{ icon: 3, count: 3, points: 10, perfect: false }], [], 0, 0, 30),
    G.makeScoreLogEntry(2, 4, [{ icon: 1, count: 4, points: 10, perfect: false }], [{ icon: 1, unitCount: 2, points: 50 }], 2, 10, 128,
      '111111111' + '.'.repeat(72), [0, 1, 2, 3, 4, 5, 6, 7, 8], [8]),
  ];
  const streakLog = [{ n: 1, gained: 30 }, { n: 2, gained: 128 }];
  const game = G.encodeGame({
    board: b, tray, score: 123,
    inv: { rotate: 2, flip: 1, undo: 1, freeze: 3, reroll: 2 },
    progress: { pts: 150, flipPts: 250, combos: 1, fcombos: 1 },
    frozen, freezeHold: true, streak: 2, scoreLog, streakLog,
  });
  const decoded = G.validateSave(JSON.parse(JSON.stringify({
    v: 2, best: 777, muted: true, volume: 30, theme: 'dark', nickname: 'Lizard 🦎',
    seenTutorial: true, tutorialOffered: true,
    itemHelp: { rotate: true, flip: false, undo: false, freeze: true, reroll: true },
    game,
  })));
  assert.strictEqual(decoded.best, 777);
  assert.strictEqual(decoded.muted, true);
  assert.strictEqual(decoded.volume, 30);
  assert.strictEqual(decoded.theme, 'dark');
  assert.strictEqual(decoded.nickname, 'Lizard 🦎');
  assert.strictEqual(decoded.seenTutorial, true);
  assert.strictEqual(decoded.tutorialOffered, true);
  assert.deepStrictEqual(decoded.itemHelp, { rotate: true, flip: false, undo: false, freeze: true, reroll: true });
  assert.ok(decoded.game);
  assert.deepStrictEqual(Array.from(decoded.game.board), Array.from(b));
  assert.deepStrictEqual(decoded.game.tray, tray);
  assert.strictEqual(decoded.game.score, 123);
  assert.deepStrictEqual(decoded.game.inv, { rotate: 2, flip: 1, undo: 1, freeze: 3, reroll: 2 });
  assert.deepStrictEqual(decoded.game.progress, { pts: 150, flipPts: 250, combos: 1, fcombos: 1 });
  assert.deepStrictEqual(Array.from(decoded.game.frozen), Array.from(frozen));
  assert.strictEqual(decoded.game.freezeHold, true);
  assert.strictEqual(decoded.game.streak, 2);
  assert.deepStrictEqual(decoded.game.scoreLog, scoreLog);
  assert.deepStrictEqual(decoded.game.streakLog, streakLog);
});

test('validateSave: v1 saves migrate to v2 defaults', () => {
  const goodBoard = new Array(81).fill(-1);
  goodBoard[0] = 1;
  const v1 = { v: 1, best: 42, muted: true, game: { board: goodBoard, tray: [{ shapeId: 0, icon: 1 }, null, null], score: 9 } };
  const out = G.validateSave(v1);
  assert.strictEqual(out.best, 42);
  assert.strictEqual(out.muted, true);
  assert.strictEqual(out.volume, 50, 'default volume');
  assert.strictEqual(out.theme, 'auto', 'default theme');
  assert.strictEqual(out.nickname, '');
  assert.strictEqual(out.seenTutorial, false);
  assert.ok(out.game, 'v1 game survives migration');
  assert.deepStrictEqual(out.game.inv, { rotate: 0, flip: 0, undo: 0, freeze: 0, reroll: 0 });
  assert.deepStrictEqual(out.game.progress, { pts: 0, flipPts: 0, combos: 0, fcombos: 0 });
  assert.strictEqual(out.game.freezeHold, false);
  assert.strictEqual(Array.from(out.game.frozen).reduce((a, x) => a + x, 0), 0);
  assert.deepStrictEqual(out.game.scoreLog, [], 'v1 has no score history');
  assert.deepStrictEqual(out.game.streakLog, [], 'v1 has no streak history');
});

test('validateSave: corrupt payloads keep meta, drop game', () => {
  assert.strictEqual(G.validateSave(null).game, null);
  assert.strictEqual(G.validateSave('junk').best, 0);
  assert.strictEqual(G.validateSave({ v: 1, best: 42 }).best, 42);

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

  /* Butterfly is icon 5: a board value of 5 and a tray icon of 5 are now valid. */
  const board5 = new Array(81).fill(-1);
  board5[0] = 5;
  const okButterfly = G.validateSave({ v: 2, best: 10, game: { board: board5, tray: [{ shapeId: 0, icon: 5 }, null, null], score: 5 } });
  assert.ok(okButterfly.game, 'butterfly board value and tray icon accepted');
  assert.strictEqual(okButterfly.game.board[0], 5);
  assert.strictEqual(okButterfly.game.tray[0].icon, 5);
});

test('validateSave: hostile v2 fields', () => {
  const filled = new Array(81).fill(1);
  const base = { v: 2, best: 10, game: { board: filled.slice(), tray: [{ shapeId: 0, icon: 1 }, null, null], score: 5 } };

  const overCap = G.validateSave({ ...base, game: { ...base.game, inv: { rotate: 99, undo: -3, freeze: 2, reroll: 99 } } });
  assert.ok(overCap.game);
  assert.deepStrictEqual(overCap.game.inv, { rotate: G.ITEM_CAPS.rotate, flip: 0, undo: 0, freeze: 2, reroll: G.ITEM_CAPS.reroll }, 'inv clamped to caps');

  const negReroll = G.validateSave({ ...base, game: { ...base.game, inv: { reroll: -1 } } });
  assert.strictEqual(negReroll.game.inv.reroll, 0, 'negative reroll floored to 0');
  const fracReroll = G.validateSave({ ...base, game: { ...base.game, inv: { reroll: 1.5 } } });
  assert.strictEqual(fracReroll.game, null, 'fractional reroll discards the game');

  const bigFcombos = G.validateSave({ ...base, game: { ...base.game, progress: { pts: 0, combos: 0, fcombos: 9 } } });
  assert.ok(bigFcombos.game, 'out-of-range fcombos keeps the game');
  assert.strictEqual(bigFcombos.game.progress.fcombos, 0, 'fcombos 9 clamped to 0');
  const strFcombos = G.validateSave({ ...base, game: { ...base.game, progress: { pts: 0, combos: 0, fcombos: '7' } } });
  assert.ok(strFcombos.game, 'string fcombos keeps the game');
  assert.strictEqual(strFcombos.game.progress.fcombos, 0, "fcombos '7' falls back to 0");

  const badFrozenIdx = G.validateSave({ ...base, game: { ...base.game, frozen: [81] } });
  assert.strictEqual(badFrozenIdx.game, null, 'frozen index out of range rejected');

  const empty = new Array(81).fill(-1);
  const frozenOnEmpty = G.validateSave({ v: 2, best: 1, game: { board: empty, tray: [{ shapeId: 0, icon: 1 }, null, null], score: 5, frozen: [4] } });
  assert.strictEqual(frozenOnEmpty.game, null, 'frozen cell must be filled');

  const holdNoFrozen = G.validateSave({ ...base, game: { ...base.game, freezeHold: true } });
  assert.strictEqual(holdNoFrozen.game, null, 'freezeHold without frozen cells rejected');

  /* The converse: ice without a hold is orphaned (unreachable in play) and
     would never melt, so the mask is scrubbed while the game survives. */
  const iceNoHold = G.validateSave({ ...base, game: { ...base.game, frozen: [4, 5] } });
  assert.ok(iceNoHold.game, 'orphan ice keeps the game');
  assert.strictEqual(Array.from(iceNoHold.game.frozen).reduce((a, x) => a + x, 0), 0, 'orphan ice scrubbed');

  const badTheme = G.validateSave({ v: 2, best: 1, theme: 'neon', volume: 400, game: null });
  assert.strictEqual(badTheme.theme, 'auto');
  assert.strictEqual(badTheme.volume, 50);

  const evilName = G.validateSave({ v: 2, best: 1, nickname: '  <b>Liz</b>​  zard  ', game: null });
  assert.strictEqual(evilName.nickname, 'bLiz/b zard');

  const badRotFree = G.validateSave({
    ...base,
    game: { ...base.game, tray: [{ shapeId: 0, icon: 1, rotFree: 'yes' }, null, null] },
  });
  assert.strictEqual(badRotFree.game, null, 'non-boolean rotFree rejected');
});

test('validateSave: rotOrig acceptance, hostile values, and symmetric scrub', () => {
  const empty = new Array(81).fill(-1);
  const mk = (piece) => G.validateSave({
    v: 2, best: 1,
    game: { board: empty.slice(), tray: [piece, null, null], score: 5 },
  });

  /* Happy path: rotFree Line3-V (shape 6) that started as Line3-H (shape 5). */
  const good = mk({ shapeId: 6, icon: 3, rotFree: true, rotOrig: 5 });
  assert.ok(good.game, 'valid rotOrig accepted');
  assert.deepStrictEqual(good.game.tray[0], { shapeId: 6, icon: 3, rotFree: true, rotOrig: 5 });

  /* Non-integer rotOrig discards the game. */
  assert.strictEqual(mk({ shapeId: 6, icon: 3, rotFree: true, rotOrig: '5' }).game, null, 'string rotOrig rejected');
  /* Out-of-range rotOrig discards the game. */
  assert.strictEqual(mk({ shapeId: 6, icon: 3, rotFree: true, rotOrig: 99 }).game, null, 'out-of-range rotOrig rejected');
  /* rotOrig equal to the current shape discards the game. */
  assert.strictEqual(mk({ shapeId: 6, icon: 3, rotFree: true, rotOrig: 6 }).game, null, 'self rotOrig rejected');
  /* rotOrig outside this piece's rotation orbit discards the game (shape 6's
     orbit is {5,6}; shape 0 is not in it). */
  assert.strictEqual(mk({ shapeId: 6, icon: 3, rotFree: true, rotOrig: 0 }).game, null, 'out-of-orbit rotOrig rejected');

  /* rotOrig without an active session is silently dropped, game survives. */
  const noSession = mk({ shapeId: 6, icon: 3, rotOrig: 5 });
  assert.ok(noSession.game, 'rotOrig without rotFree keeps the game');
  assert.strictEqual(noSession.game.tray[0].rotOrig, undefined, 'orphan rotOrig dropped');
  assert.strictEqual(noSession.game.tray[0].rotFree, undefined);

  /* rotFree on a symmetric shape is silently scrubbed (live-save migration). */
  const scrub = mk({ shapeId: 13, icon: 2, rotFree: true });
  assert.ok(scrub.game, 'symmetric rotFree keeps the game');
  assert.strictEqual(scrub.game.tray[0].rotFree, undefined, 'rotFree scrubbed off a symmetric shape');
  assert.deepStrictEqual(scrub.game.tray[0], { shapeId: 13, icon: 2 });
});

test('sanitizeNickname: strips markup, collapses whitespace, caps length', () => {
  assert.strictEqual(G.sanitizeNickname('  Liz<z>ard!  '), 'Lizzard!');
  assert.strictEqual(G.sanitizeNickname('a'.repeat(40)), 'a'.repeat(16));
  assert.strictEqual(G.sanitizeNickname('Liz   za  rd'), 'Liz za rd', 'runs of spaces collapse');
  assert.strictEqual(G.sanitizeNickname('Liz\tza\n rd'), 'Lizza rd', 'control chars strip, not collapse');
  assert.strictEqual(G.sanitizeNickname(12), '');
  assert.strictEqual(G.sanitizeNickname('Lizard 🦎'), 'Lizard 🦎');
});

/* ---- Matching Sets bonus ---- */

test('matchingSetsTier: 0/50/100/200 ladder', () => {
  assert.strictEqual(G.matchingSetsTier(0), 0);
  assert.strictEqual(G.matchingSetsTier(1), 0);
  assert.strictEqual(G.matchingSetsTier(2), 50);
  assert.strictEqual(G.matchingSetsTier(3), 100);
  assert.strictEqual(G.matchingSetsTier(4), 200);
  assert.strictEqual(G.matchingSetsTier(9), 200);
});

function msFromBoard(b) {
  const units = G.scanUnits(b);
  return G.matchingSetBonuses(G.iconBonuses(b, units));
}

test('matchingSetBonuses: two rows with 3+ of the same icon pay 50', () => {
  const cells = [];
  for (let c = 0; c < 9; c++) { cells.push([0, c]); cells.push([4, c]); }
  const b = G.emptyBoard();
  /* rows 0 and 4: three flowers (icon 1) each, rest mixed */
  [1, 1, 1, 2, 3, 4, 2, 3, 4].forEach((icon, c) => { b[c] = icon; });
  [1, 1, 1, 3, 2, 4, 3, 2, 4].forEach((icon, c) => { b[4 * 9 + c] = icon; });
  const ms = msFromBoard(b);
  assert.strictEqual(ms.length, 1);
  assert.strictEqual(ms[0].icon, 1);
  assert.strictEqual(ms[0].unitCount, 2);
  assert.strictEqual(ms[0].points, 50);
});

test('matchingSetBonuses: lizard doubling and higher tiers', () => {
  const b = G.emptyBoard();
  [0, 0, 0, 2, 3, 4, 2, 3, 4].forEach((icon, c) => { b[c] = icon; });
  [0, 0, 0, 3, 2, 4, 3, 2, 4].forEach((icon, c) => { b[4 * 9 + c] = icon; });
  const ms = msFromBoard(b);
  assert.strictEqual(ms[0].points, 100, 'lizard k=2 doubles 50 to 100');

  const b3 = G.emptyBoard();
  for (const row of [0, 4, 8]) {
    [2, 2, 2, 1, 3, 4, 1, 3, 4].forEach((icon, c) => { b3[row * 9 + c] = icon; });
  }
  const ms3 = msFromBoard(b3);
  assert.strictEqual(ms3[0].unitCount, 3);
  assert.strictEqual(ms3[0].points, 100);
});

test('matchingSetBonuses: no bonus for different icons or a single unit', () => {
  const b = G.emptyBoard();
  [1, 1, 1, 2, 3, 4, 2, 3, 4].forEach((icon, c) => { b[c] = icon; });          /* flowers */
  [2, 2, 2, 3, 1, 4, 3, 1, 4].forEach((icon, c) => { b[4 * 9 + c] = icon; });  /* hearts */
  assert.deepStrictEqual(msFromBoard(b), [], 'different icons never pair');

  const single = G.emptyBoard();
  [1, 1, 1, 2, 2, 2, 3, 3, 4].forEach((icon, c) => { single[c] = icon; });
  assert.deepStrictEqual(msFromBoard(single), [], 'two icons inside ONE unit is not a matching set');
});

test('matchingSetBonuses: two icons each spanning two units pay separately', () => {
  const b = G.emptyBoard();
  [1, 1, 1, 2, 2, 2, 3, 3, 4].forEach((icon, c) => { b[c] = icon; });
  [1, 1, 1, 2, 2, 2, 4, 4, 3].forEach((icon, c) => { b[4 * 9 + c] = icon; });
  const ms = msFromBoard(b).sort((a, z) => a.icon - z.icon);
  assert.strictEqual(ms.length, 2);
  assert.strictEqual(ms[0].points + ms[1].points, 100);
});

test('matchingSetBonuses: row+col cross of one icon counts both units', () => {
  const cells = [];
  for (let c = 0; c < 9; c++) cells.push([4, c]);
  for (let r = 0; r < 9; r++) cells.push([r, 4]);
  const b = boardWith(cells, 2);
  const ms = msFromBoard(b);
  assert.strictEqual(ms.length, 1);
  assert.strictEqual(ms[0].unitCount, 2);
  assert.strictEqual(ms[0].points, 50);
  assert.strictEqual(ms[0].cells.length, 17, 'shared cell listed once');
});

/* ---- Rotation ---- */

test('ROTATION_MAP: total, bijective, period 4', () => {
  assert.strictEqual(G.ROTATION_MAP.length, 47);
  for (const t of G.ROTATION_MAP) assert.ok(Number.isInteger(t) && t >= 0 && t < 47);
  assert.strictEqual(new Set(G.ROTATION_MAP).size, 47, 'bijection');
  for (let id = 0; id < 47; id++) {
    let x = id;
    for (let k = 0; k < 4; k++) x = G.ROTATION_MAP[x];
    assert.strictEqual(x, id, 'rotating 4 times returns shape ' + id);
  }
});

test('ROTATION_MAP: known mappings', () => {
  assert.strictEqual(G.ROTATION_MAP[0], 0, 'single is a fixed point');
  assert.strictEqual(G.ROTATION_MAP[1], 2, 'Line2 H rotates to V');
  assert.strictEqual(G.ROTATION_MAP[13], 13, 'square is a fixed point');
  assert.strictEqual(G.ROTATION_MAP[38], 38, 'plus5 is a fixed point');
  /* The U pentomino (indices 43-46) is a clockwise 4-cycle. */
  assert.strictEqual(G.ROTATION_MAP[43], 46, 'U 43 -> 46');
  assert.strictEqual(G.ROTATION_MAP[46], 45, 'U 46 -> 45');
  assert.strictEqual(G.ROTATION_MAP[45], 44, 'U 45 -> 44');
  assert.strictEqual(G.ROTATION_MAP[44], 43, 'U 44 -> 43');
});

test('rotateShapeCells matches geometry', () => {
  assert.deepStrictEqual(G.rotateShapeCells([[0, 0], [0, 1]], 1), [[0, 0], [1, 0]]);
  assert.deepStrictEqual(
    G.rotateShapeCells([[0, 0], [1, 0], [1, 1]], 2).map(([r, c]) => r + ',' + c).sort(),
    ['0,0', '0,1', '1,0'].sort()
  );
});

/* ---- applyRotation: charge / free / cancel / symmetric / null ---- */

test('applyRotation: symmetric shape never charges and leaves the piece alone', () => {
  const piece = { shapeId: 13, icon: 2 }; /* square is a fixed point */
  const res = G.applyRotation(piece, 3);
  assert.strictEqual(res.kind, 'symmetric');
  assert.strictEqual(res.rotateCount, 3, 'no item spent');
  assert.strictEqual(res.piece, piece, 'piece unchanged');
});

test('applyRotation: first spin charges one and remembers the origin', () => {
  const piece = { shapeId: 5, icon: 3 }; /* Line3-H, ROTATION_MAP[5] = 6 */
  const res = G.applyRotation(piece, 2);
  assert.strictEqual(res.kind, 'charged');
  assert.strictEqual(res.rotateCount, 1, 'one rotate spent');
  assert.deepStrictEqual(res.piece, { shapeId: 6, icon: 3, rotFree: true, rotOrig: 5 });
});

test('applyRotation: charging preserves a dipped (frozen) flag', () => {
  const res = G.applyRotation({ shapeId: 5, icon: 3, frozen: true }, 1);
  assert.strictEqual(res.kind, 'charged');
  assert.strictEqual(res.piece.frozen, true);
  assert.strictEqual(res.piece.rotOrig, 5);
});

test('applyRotation: null when there is no session and no item', () => {
  assert.strictEqual(G.applyRotation({ shapeId: 5, icon: 3 }, 0), null);
});

test('applyRotation: mid-session spin is free and keeps the flags', () => {
  /* L4 orbit has period 4: a spin that is not back to the origin stays free. */
  const start = 16;
  const next = G.ROTATION_MAP[start];
  const piece = { shapeId: next, icon: 1, rotFree: true, rotOrig: start };
  const res = G.applyRotation(piece, 1);
  assert.strictEqual(res.kind, 'free');
  assert.strictEqual(res.rotateCount, 1, 'free spin costs nothing');
  assert.strictEqual(res.piece.shapeId, G.ROTATION_MAP[next]);
  assert.strictEqual(res.piece.rotFree, true);
  assert.strictEqual(res.piece.rotOrig, start, 'origin remembered across spins');
});

test('applyRotation: spinning back to the origin cancels and refunds', () => {
  /* Line3-H period 2: one spin then a spin back to shapeId 5 (the origin). */
  const piece = { shapeId: 6, icon: 3, rotFree: true, rotOrig: 5 };
  const res = G.applyRotation(piece, 1);
  assert.strictEqual(res.kind, 'canceled');
  assert.strictEqual(res.rotateCount, 2, 'the rotate comes back');
  assert.strictEqual(res.refunded, true);
  assert.deepStrictEqual(res.piece, { shapeId: 5, icon: 3 }, 'flags stripped');
});

test('applyRotation: cancel refund clamps at the cap (refunded flag false)', () => {
  const piece = { shapeId: 6, icon: 3, rotFree: true, rotOrig: 5 };
  const res = G.applyRotation(piece, G.ITEM_CAPS.rotate);
  assert.strictEqual(res.kind, 'canceled');
  assert.strictEqual(res.rotateCount, G.ITEM_CAPS.rotate, 'stays at cap');
  assert.strictEqual(res.refunded, false, 'nothing actually returned');
});

test('applyRotation: cancel preserves a frozen flag on the rebuilt piece', () => {
  const piece = { shapeId: 6, icon: 3, rotFree: true, rotOrig: 5, frozen: true };
  const res = G.applyRotation(piece, 0);
  assert.strictEqual(res.kind, 'canceled');
  assert.strictEqual(res.piece.frozen, true);
  assert.strictEqual(res.piece.rotFree, undefined);
  assert.strictEqual(res.piece.rotOrig, undefined);
});

test('applyRotation: legacy piece (rotFree, no rotOrig) never cancels', () => {
  /* A Line3 spun on an old save: it stays free forever, matching what was paid. */
  let piece = { shapeId: 5, icon: 3, rotFree: true };
  for (let i = 0; i < 4; i++) {
    const res = G.applyRotation(piece, 1);
    assert.strictEqual(res.kind, 'free', 'never reaches cancel without rotOrig');
    piece = res.piece;
  }
  assert.strictEqual(piece.shapeId, 5, 'back to the start shape but still free');
});

/* ---- Streak bonus ---- */

test('streakBonus: 10 * (k-1) ladder, zero below 2', () => {
  assert.strictEqual(G.streakBonus(0), 0);
  assert.strictEqual(G.streakBonus(1), 0);
  assert.strictEqual(G.streakBonus(2), 10);
  assert.strictEqual(G.streakBonus(3), 20);
  assert.strictEqual(G.streakBonus(4), 30);
  assert.strictEqual(G.streakBonus(10), 90);
});

test('save round-trip preserves a streak of 4', () => {
  const empty = new Array(81).fill(-1);
  const game = G.encodeGame({
    board: G.emptyBoard(),
    tray: [{ shapeId: 0, icon: 1 }, null, null],
    score: 80, inv: { rotate: 0, undo: 0, freeze: 0 },
    progress: { pts: 0, combos: 0 },
    frozen: new Uint8Array(81), freezeHold: false, streak: 4,
  });
  const decoded = G.validateSave({ v: 2, best: 1, game });
  assert.strictEqual(decoded.game.streak, 4);
});

test('validateSave: v1 game defaults streak to 0', () => {
  const goodBoard = new Array(81).fill(-1);
  goodBoard[0] = 1;
  const out = G.validateSave({ v: 1, best: 1, game: { board: goodBoard, tray: [{ shapeId: 0, icon: 1 }, null, null], score: 9 } });
  assert.strictEqual(out.game.streak, 0, 'absent streak defaults to 0');
});

test('validateSave: hostile streak values fall back to 0, big ones saturate', () => {
  const filled = new Array(81).fill(1);
  const mk = (streak) => G.validateSave({
    v: 2, best: 1,
    game: { board: filled.slice(), tray: [{ shapeId: 0, icon: 1 }, null, null], score: 5, streak },
  }).game.streak;
  assert.strictEqual(mk(-1), 0, 'negative rejected');
  assert.strictEqual(mk(3.5), 0, 'fractional rejected');
  assert.strictEqual(mk('7'), 0, 'string rejected');
  assert.strictEqual(mk(1e9), 999, 'a huge integer streak saturates at the cap, never resets');
  assert.strictEqual(mk(1000), 999, 'just over the cap saturates too');
  assert.strictEqual(mk(4), 4, 'a sane streak survives');
});

test('takeSnapshot deep-copies the streak', () => {
  const state = {
    board: G.emptyBoard(), tray: [null, null, null], score: 0,
    inv: { rotate: 0, undo: 0, freeze: 0 }, progress: { pts: 0, combos: 0 },
    frozen: new Uint8Array(81), freezeHold: false, streak: 3,
  };
  const snap = G.takeSnapshot(state);
  state.streak = 0;
  assert.strictEqual(snap.streak, 3);
});

/* ---- Item economy ---- */

test('computeEarned: rotate every 200 points with carry', () => {
  let r = G.computeEarned({ pts: 190, combos: 0 }, { gained: 30, comboN: 0, perfectCount: 0 });
  assert.strictEqual(r.earned.rotate, 1);
  assert.strictEqual(r.progress.pts, 20);
  r = G.computeEarned({ pts: 0, combos: 0 }, { gained: 401, comboN: 0, perfectCount: 0 });
  assert.strictEqual(r.earned.rotate, 2);
  assert.strictEqual(r.progress.pts, 1);
});

test('computeEarned: undo every 2nd multi-set combo, fcombos runs in parallel', () => {
  let r = G.computeEarned({ pts: 0, combos: 0, fcombos: 0 }, { gained: 0, comboN: 2, perfectCount: 0 });
  assert.strictEqual(r.earned.undo, 0);
  assert.strictEqual(r.progress.combos, 1);
  assert.strictEqual(r.progress.fcombos, 1, 'the freeze counter advances alongside undo');
  assert.strictEqual(r.earned.freeze, 0);
  r = G.computeEarned(r.progress, { gained: 0, comboN: 2, perfectCount: 0 });
  assert.strictEqual(r.earned.undo, 1);
  assert.strictEqual(r.progress.combos, 0);
  assert.strictEqual(r.earned.freeze, 1, 'every 2nd combo pays both an undo and a freeze');
  assert.strictEqual(r.progress.fcombos, 0);
  r = G.computeEarned({ pts: 0, combos: 0, fcombos: 0 }, { gained: 0, comboN: 1, perfectCount: 0 });
  assert.strictEqual(r.progress.combos, 0, 'single clear is not a combo');
  assert.strictEqual(r.progress.fcombos, 0);
});

test('computeEarned: freeze economy rewrite (perfects, parallel combos, streaks)', () => {
  /* Perfects still each pay a freeze; nothing else here does. */
  let r = G.computeEarned({ pts: 0, combos: 0, fcombos: 0 }, { gained: 0, comboN: 0, perfectCount: 2 });
  assert.strictEqual(r.earned.freeze, 2, 'two perfects, two freezes');
  assert.strictEqual(r.earned.reroll, 0);

  /* An x3 combo pays a reroll, NOT a freeze. */
  r = G.computeEarned({ pts: 0, combos: 0, fcombos: 0 }, { gained: 0, comboN: 3, perfectCount: 0 });
  assert.strictEqual(r.earned.reroll, 1, 'x3 combo pays a reroll');
  assert.strictEqual(r.earned.freeze, 0, 'x3 combo alone pays no freeze');
  assert.strictEqual(r.progress.combos, 1, 'x3 still counts toward undo');
  assert.strictEqual(r.progress.fcombos, 1, 'and toward the freeze counter');

  /* Two x2 combos: the parallel fcombos counter pays exactly one freeze. */
  let acc = G.computeEarned({ pts: 0, combos: 0, fcombos: 0 }, { gained: 0, comboN: 2, perfectCount: 0 });
  acc = G.computeEarned(acc.progress, { gained: 0, comboN: 2, perfectCount: 0 });
  assert.strictEqual(acc.earned.freeze, 1, 'every 2nd combo pays a freeze');

  /* Streak milestones only fire on a clearing turn (comboN >= 1). */
  r = G.computeEarned({ pts: 0, combos: 0, fcombos: 0 }, { gained: 0, comboN: 1, perfectCount: 0, streak: 3 });
  assert.strictEqual(r.earned.freeze, 1, 'a streak of 3 pays a freeze');
  assert.strictEqual(r.earned.reroll, 0);

  r = G.computeEarned({ pts: 0, combos: 0, fcombos: 0 }, { gained: 0, comboN: 1, perfectCount: 0, streak: 4 });
  assert.strictEqual(r.earned.reroll, 1, 'a streak of 4 pays a reroll');
  assert.strictEqual(r.earned.freeze, 0);

  r = G.computeEarned({ pts: 0, combos: 0, fcombos: 0 }, { gained: 0, comboN: 1, perfectCount: 0, streak: 12 });
  assert.strictEqual(r.earned.freeze, 1, 'streak 12 is a multiple of 3');
  assert.strictEqual(r.earned.reroll, 1, 'and a multiple of 4');

  /* A milestone streak with no clear never pays. */
  r = G.computeEarned({ pts: 0, combos: 0, fcombos: 0 }, { gained: 0, comboN: 0, perfectCount: 0, streak: 3 });
  assert.strictEqual(r.earned.freeze, 0, 'no clear, no streak milestone');
  assert.strictEqual(r.earned.reroll, 0);
});

test('computeEarned: msCombo pays a reroll and stacks with combo and streak', () => {
  let r = G.computeEarned({ pts: 0, combos: 0, fcombos: 0 }, { gained: 0, comboN: 2, perfectCount: 0, msCombo: true });
  assert.strictEqual(r.earned.reroll, 1, 'a Matching Sets combo pays a reroll');

  /* x3 combo (+1), Matching Sets combo (+1), and a streak of 12 (+1) all stack. */
  r = G.computeEarned({ pts: 0, combos: 0, fcombos: 0 }, { gained: 0, comboN: 3, perfectCount: 0, msCombo: true, streak: 12 });
  assert.strictEqual(r.earned.reroll, 3, 'x3 + matching sets + x4 streak stack to three rerolls');
  assert.strictEqual(r.earned.freeze, 1, 'the x3-multiple streak also pays one freeze');
});

test('grantItems clamps to caps, grants rerolls, and never NaNs a legacy inv', () => {
  const inv = { rotate: 2, undo: 3, freeze: 0, reroll: 1 };
  const granted = G.grantItems(inv, { rotate: 3, undo: 1, freeze: 1, reroll: 5 });
  assert.deepStrictEqual(granted, { rotate: 1, flip: 0, undo: 0, freeze: 1, reroll: 2 });
  assert.deepStrictEqual(inv, { rotate: 3, flip: 0, undo: 3, freeze: 1, reroll: 3 });

  /* A legacy inventory with no reroll key must not NaN: the defensive || 0
     treats the missing key as zero and grants up to the cap. */
  const legacy = { rotate: 0, undo: 0, freeze: 0 };
  const g2 = G.grantItems(legacy, { rotate: 0, undo: 0, freeze: 0, reroll: 2 });
  assert.strictEqual(g2.reroll, 2);
  assert.strictEqual(legacy.reroll, 2, 'reroll key created cleanly');
  assert.ok(Number.isInteger(legacy.reroll), 'no NaN in a migrated inventory');
});

/* ---- Undo snapshot ---- */

test('takeSnapshot: deep copy survives mutation of the original', () => {
  const state = {
    board: G.emptyBoard(),
    tray: [{ shapeId: 1, icon: 2, frozen: true }, null, { shapeId: 3, icon: 4 }],
    score: 55,
    inv: { rotate: 1, undo: 2, freeze: 0 },
    progress: { pts: 120, combos: 1 },
    frozen: new Uint8Array(81),
    freezeHold: true,
  };
  state.board[7] = 3;
  state.frozen[7] = 1;
  const snap = G.takeSnapshot(state);
  state.board[7] = -1;
  state.frozen[7] = 0;
  state.tray[0].icon = 0;
  state.inv.rotate = 3;
  state.progress.pts = 0;
  assert.strictEqual(snap.board[7], 3);
  assert.strictEqual(snap.frozen[7], 1);
  assert.strictEqual(snap.tray[0].icon, 2);
  assert.strictEqual(snap.tray[0].frozen, true);
  assert.strictEqual(snap.inv.rotate, 1);
  assert.strictEqual(snap.progress.pts, 120);
  assert.strictEqual(snap.freezeHold, true);
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

/* ---- Freeze stacking ---- */

test('freezeOutcome: not dipped does nothing', () => {
  const frozen = new Uint8Array(81);
  const r = G.freezeOutcome(false, false, new Set([1, 2, 3]), frozen);
  assert.deepStrictEqual(r, { didFreeze: false, frozeNothingNew: false, freezeRefund: false });
});

test('freezeOutcome: a dip that completes nothing is refunded', () => {
  const frozen = new Uint8Array(81);
  const r = G.freezeOutcome(true, false, new Set(), frozen);
  assert.strictEqual(r.didFreeze, false);
  assert.strictEqual(r.frozeNothingNew, false);
  assert.strictEqual(r.freezeRefund, true);
});

test('freezeOutcome: a dip that completes a unit freezes it, no refund', () => {
  const frozen = new Uint8Array(81);
  const r = G.freezeOutcome(true, false, new Set([10, 11]), frozen);
  assert.strictEqual(r.didFreeze, true);
  assert.strictEqual(r.frozeNothingNew, false);
  assert.strictEqual(r.freezeRefund, false);
});

test('freezeOutcome: stacking a dip that adds a fresh cell keeps the item', () => {
  const frozen = new Uint8Array(81);
  frozen[10] = 1;
  const r = G.freezeOutcome(true, true, new Set([10, 11]), frozen); /* 11 is new */
  assert.strictEqual(r.didFreeze, true);
  assert.strictEqual(r.frozeNothingNew, false);
  assert.strictEqual(r.freezeRefund, false);
});

test('freezeOutcome: a dip re-finding only frozen cells is refunded and no longer freezes', () => {
  /* v2.4 exploit fix: this dip used to report didFreeze true, which kept the
     hold alive while the Freeze was refunded. It now resolves as undipped. */
  const frozen = new Uint8Array(81);
  frozen[10] = 1; frozen[11] = 1;
  const r = G.freezeOutcome(true, true, new Set([10, 11]), frozen);
  assert.strictEqual(r.didFreeze, false, 'the melt branch runs instead');
  assert.strictEqual(r.frozeNothingNew, true);
  assert.strictEqual(r.freezeRefund, true);
});

test('simulated freeze stacking: a dip stacks onto a held freeze, then one clear melts all', () => {
  /* Row 4 is already frozen and waiting to melt (freezeHold true). */
  const b = G.emptyBoard();
  for (let c = 0; c < 9; c++) b[idx(4, c)] = 1;
  const frozen = new Uint8Array(81);
  for (let c = 0; c < 9; c++) frozen[idx(4, c)] = 1;
  let freezeHold = true;

  /* Fill column 2 except (0,2); (4,2) is already full from the frozen row. */
  for (const r of [1, 2, 3, 5, 6, 7, 8]) b[idx(r, 2)] = 1;

  /* Dip a single onto (0,2): column 2 completes and crosses the frozen row,
     so the pre-clear scan re-finds both the still full row 4 and column 2. */
  G.placePiece(b, G.SHAPES[0], 0, 2, 1);
  let units = G.scanUnits(b);
  assert.strictEqual(units.length, 2, 'frozen row 4 and new column 2 both full');
  let union = G.unionCells(units);
  assert.strictEqual(union.size, 17, 'two crossing lines share (4,2)');

  let out = G.freezeOutcome(true, freezeHold, union, frozen);
  assert.strictEqual(out.didFreeze, true, 'the dip freezes the new column');
  assert.strictEqual(out.frozeNothingNew, false, 'column 2 adds fresh cells (overlap still stacks)');
  assert.strictEqual(out.freezeRefund, false, 'a real stack keeps the item');

  /* Apply the freeze: mark the whole union, keep the hold. */
  for (const i of union) frozen[i] = 1;
  freezeHold = true;

  /* A plain (non-dipped) placement now melts the whole stack as one combo:
     the frozen cells are still full, so the next scan re-finds both units. */
  G.placePiece(b, G.SHAPES[0], 8, 8, 1);
  units = G.scanUnits(b);
  assert.strictEqual(units.length, 2, 'both frozen lines re-found on the melt turn');
  out = G.freezeOutcome(false, freezeHold, G.unionCells(units), frozen);
  assert.strictEqual(out.didFreeze, false, 'a non-dipped placement never freezes');
  assert.strictEqual(G.clearScore(units.length), 54, 'comboN 2 melt scores as one x2');
});

test('simulated freeze stacking: a wasted dip is refunded AND the stack melts', () => {
  const b = G.emptyBoard();
  for (let c = 0; c < 9; c++) b[idx(4, c)] = 1;
  const frozen = new Uint8Array(81);
  for (let c = 0; c < 9; c++) frozen[idx(4, c)] = 1;

  /* Dip a single at (0,0): it completes nothing new, but the still full row 4
     is re-found, so the union is entirely inside the frozen mask. The dip
     achieved nothing: the Freeze comes back and the placement resolves as if
     the piece was never dipped, melting the held row (v2.4 exploit fix:
     refund plus intact stack used to keep the hold alive for free). */
  G.placePiece(b, G.SHAPES[0], 0, 0, 1);
  const units = G.scanUnits(b);
  assert.strictEqual(units.length, 1, 'only the frozen row is full');
  const union = G.unionCells(units);
  const out = G.freezeOutcome(true, true, union, frozen);
  assert.strictEqual(out.didFreeze, false, 'a wasted dip no longer counts as a freeze');
  assert.strictEqual(out.frozeNothingNew, true, 'no fresh cells frozen');
  assert.strictEqual(out.freezeRefund, true, 'the Freeze is handed back');

  /* didFreeze false and n > 0 routes the resolve pipeline into the clear
     branch, which melts the union and resets the mask and the hold. */
  for (const i of union) b[i] = -1;
  assert.ok(Array.from(b).every((v, i) => (i === 0 ? v === 1 : v === -1)),
    'the held row cleared; the freshly placed single stays');
  assert.strictEqual(G.clearScore(units.length), 18, 'the melt scores as a normal clear');
});

/* ---- U pentomino geometry ---- */

test('U pentomino: four orientations, weight 1.5, 5 cells, 2x3 boxes', () => {
  const us = [43, 44, 45, 46].map((i) => G.SHAPES[i]);
  for (const s of us) {
    assert.ok(Math.abs(s.weight - 1.5) < 1e-9, 'U weight is 6/4 = 1.5');
    assert.strictEqual(s.cells.length, 5, 'U is a pentomino');
    assert.strictEqual([s.h, s.w].sort().join('x'), '2x3', 'each U fits a 2x3 box either way');
  }
  const keys = new Set(us.map((s) => s.cells.map(([r, c]) => r + ',' + c).sort().join('|')));
  assert.strictEqual(keys.size, 4, 'four distinct orientations');
});

/* ---- Reroll ---- */

test('rerollPiece: always changes the shape and stays in range', () => {
  const rng = mulberry32(2718);
  for (let i = 0; i < 500; i++) {
    const piece = { shapeId: i % G.SHAPES.length, icon: 2 };
    const next = G.rerollPiece(piece, rng);
    assert.ok(next.shapeId >= 0 && next.shapeId < G.SHAPES.length, 'shapeId in range');
    assert.ok(next.icon >= 0 && next.icon < G.ICONS.length, 'icon in range');
    assert.notStrictEqual(next.shapeId, piece.shapeId, 'shape always differs');
  }
});

test('rerollPiece: a stuck rng still nudges off the same shape', () => {
  /* An rng pinned to 0 always picks shape 0; from shape 0 the guard must fall
     through to the (shapeId + 1) nudge instead of returning the same shape. */
  const stuck = () => 0;
  const next = G.rerollPiece({ shapeId: 0, icon: 0 }, stuck);
  assert.notStrictEqual(next.shapeId, 0, 'nudged off the stuck shape');
  assert.strictEqual(next.shapeId, 1, 'nudge is (shapeId + 1) % SHAPES.length');
});

test('applyReroll: null when there is nothing to spend', () => {
  const rng = mulberry32(1);
  assert.strictEqual(G.applyReroll(null, { reroll: 3 }, rng), null, 'no piece');
  assert.strictEqual(G.applyReroll({ shapeId: 0, icon: 1 }, { reroll: 0 }, rng), null, 'no stock');
});

test('applyReroll: consumes one reroll, swaps the piece, mutates no input', () => {
  const rng = mulberry32(11);
  const piece = { shapeId: 5, icon: 2 };
  const inv = { rotate: 1, undo: 1, freeze: 1, reroll: 2 };
  const res = G.applyReroll(piece, inv, rng);
  assert.strictEqual(res.inv.reroll, 1, 'one reroll spent');
  assert.notStrictEqual(res.piece.shapeId, 5, 'the shape changed');
  assert.strictEqual(res.refundedRotate, false);
  assert.strictEqual(res.refundedFreeze, false);
  assert.strictEqual(inv.reroll, 2, 'the input inv is untouched');
  assert.deepStrictEqual(piece, { shapeId: 5, icon: 2 }, 'the input piece is untouched');
});

test('applyReroll: refunds an open rotate session and a frozen coat, no flag leak', () => {
  const rng = mulberry32(22);
  const piece = { shapeId: 6, icon: 2, rotFree: true, rotOrig: 5, frozen: true };
  const inv = { rotate: 0, undo: 0, freeze: 0, reroll: 1 };
  const res = G.applyReroll(piece, inv, rng);
  assert.strictEqual(res.refundedRotate, true);
  assert.strictEqual(res.refundedFreeze, true);
  assert.strictEqual(res.inv.rotate, 1, 'rotate returned');
  assert.strictEqual(res.inv.freeze, 1, 'freeze returned');
  assert.strictEqual(res.inv.reroll, 0);
  assert.strictEqual(res.piece.rotFree, undefined, 'fresh piece carries no rotate session');
  assert.strictEqual(res.piece.rotOrig, undefined);
  assert.strictEqual(res.piece.frozen, undefined, 'fresh piece is not iced');
});

test('applyReroll: refunds clamp at the caps and report false when full', () => {
  const rng = mulberry32(33);
  const piece = { shapeId: 6, icon: 2, rotFree: true, rotOrig: 5, frozen: true };
  const inv = { rotate: G.ITEM_CAPS.rotate, undo: 0, freeze: G.ITEM_CAPS.freeze, reroll: 1 };
  const res = G.applyReroll(piece, inv, rng);
  assert.strictEqual(res.inv.rotate, G.ITEM_CAPS.rotate, 'rotate stays at cap');
  assert.strictEqual(res.inv.freeze, G.ITEM_CAPS.freeze, 'freeze stays at cap');
  assert.strictEqual(res.refundedRotate, false, 'nothing actually returned');
  assert.strictEqual(res.refundedFreeze, false);
});

/* ---- Score / streak history ---- */

test('validateSave: history is lenient and never discards the game', () => {
  const filled = new Array(81).fill(1);
  const mkGame = (extra) => ({ board: filled.slice(), tray: [{ shapeId: 0, icon: 1 }, null, null], score: 5, streak: 3, ...extra });

  /* Junk in either log becomes an empty array; the game survives. */
  const junk = G.validateSave({ v: 2, best: 1, game: mkGame({ scoreLog: 'nope', streakLog: 42 }) });
  assert.ok(junk.game, 'junk history keeps the game');
  assert.deepStrictEqual(junk.game.scoreLog, []);
  assert.deepStrictEqual(junk.game.streakLog, []);

  /* Over-long logs are capped to their most recent entries. */
  const many = [];
  for (let i = 0; i < 10; i++) many.push(G.makeScoreLogEntry(1, 2, [], [], 0, 0, 20 + i));
  const manyStreak = [];
  for (let i = 0; i < 20; i++) manyStreak.push({ n: 1, gained: 20 + i });
  const capped = G.validateSave({ v: 2, best: 1, game: mkGame({ scoreLog: many, streakLog: manyStreak }) });
  assert.strictEqual(capped.game.scoreLog.length, G.SCORE_LOG_MAX, 'score log capped');
  assert.strictEqual(capped.game.scoreLog[capped.game.scoreLog.length - 1].total, 29, 'newest score kept');
  assert.strictEqual(capped.game.streakLog.length, G.STREAK_LOG_MAX, 'streak log capped');

  /* A single bad entry is dropped; its good siblings survive in order. */
  const mixed = [
    G.makeScoreLogEntry(2, 4, [], [], 2, 10, 100),
    { n: 999, placement: 0, streakK: 0, streakPts: 0, total: 5, icons: [], ms: [] },
    G.makeScoreLogEntry(1, 3, [], [], 0, 0, 21),
  ];
  const dropped = G.validateSave({ v: 2, best: 1, game: mkGame({ scoreLog: mixed }) });
  assert.strictEqual(dropped.game.scoreLog.length, 2, 'bad entry dropped, siblings kept');
  assert.deepStrictEqual(dropped.game.scoreLog.map((e) => e.total), [100, 21]);

  /* clear is always recomputed from n, never trusted from disk. */
  const tampered = G.validateSave({ v: 2, best: 1, game: mkGame({
    scoreLog: [{ n: 2, placement: 4, clear: 99999, streakK: 0, streakPts: 0, total: 100, icons: [], ms: [] }],
  }) });
  assert.strictEqual(tampered.game.scoreLog[0].clear, G.clearScore(2), 'clear recomputed from n');

  /* No live streak forces the streak log empty regardless of what is on disk. */
  const cold = G.validateSave({ v: 2, best: 1, game: mkGame({ streak: 0, streakLog: [{ n: 1, gained: 5 }] }) });
  assert.deepStrictEqual(cold.game.streakLog, [], 'a cold streak keeps no rows');
});

test('validateSave: board diagram round-trips and strips leniently', () => {
  const filled = new Array(81).fill(1);
  const mkGame = (scoreLog) => ({ board: filled.slice(), tray: [{ shapeId: 0, icon: 1 }, null, null], score: 5, scoreLog });
  const boardStr = '012345012' + '.'.repeat(72);

  /* A valid trio round-trips byte for byte through encode + validate. */
  const good = G.makeScoreLogEntry(2, 4, [], [], 0, 0, 60, boardStr, [0, 1, 2], [8]);
  const okOut = G.validateSave({ v: 2, best: 1, game: mkGame([good]) });
  assert.deepStrictEqual(okOut.game.scoreLog[0], good, 'valid diagram preserved');
  assert.strictEqual(okOut.game.scoreLog[0].board, boardStr);

  /* Each malformed field strips ALL THREE diagram fields but KEEPS the entry so
     it still renders (without a board). Base is a valid combo record. */
  const base = { n: 2, placement: 4, clear: G.clearScore(2), icons: [], ms: [], streakK: 0, streakPts: 0, total: 60 };
  const kept = (extra) => {
    const out = G.validateSave({ v: 2, best: 1, game: mkGame([{ ...base, ...extra }]) });
    assert.strictEqual(out.game.scoreLog.length, 1, 'entry kept');
    const e = out.game.scoreLog[0];
    assert.ok(!('board' in e) && !('cleared' in e) && !('placed' in e), 'diagram stripped');
    return e;
  };
  kept({ board: boardStr.slice(1), cleared: [0], placed: [1] });         /* wrong length */
  kept({ board: 'abc' + boardStr.slice(3), cleared: [0], placed: [1] }); /* letters */
  kept({ board: boardStr, cleared: [99], placed: [1] });                 /* cleared out of range */
  kept({ board: boardStr, cleared: [0], placed: 'nope' });               /* placed non-array */
  kept({ board: boardStr, cleared: [0.5], placed: [1] });                /* non-int cell */

  /* An older v2.2 entry with no diagram at all still renders as before. */
  const legacy = kept({});
  assert.strictEqual(legacy.total, 60, 'legacy entry intact');

  /* A garbage entry (bad n) is still dropped whole; a good sibling survives. */
  const withGarbage = G.validateSave({ v: 2, best: 1, game: mkGame([
    { n: 999, placement: 0, streakK: 0, streakPts: 0, total: 5, icons: [], ms: [], board: boardStr, cleared: [0], placed: [1] },
    good,
  ]) });
  assert.strictEqual(withGarbage.game.scoreLog.length, 1, 'garbage entry dropped, sibling kept');
  assert.deepStrictEqual(withGarbage.game.scoreLog[0], good);
});

test('takeSnapshot deep-copies the score and streak logs', () => {
  const boardStr = '222.....' + '.'.repeat(73);
  const entry = G.makeScoreLogEntry(2, 4,
    [{ icon: 1, count: 3, points: 10, perfect: false }],
    [{ icon: 1, unitCount: 2, points: 50 }], 2, 10, 128,
    boardStr, [0, 1, 2], [2]);
  const state = {
    board: G.emptyBoard(), tray: [null, null, null], score: 0,
    inv: { rotate: 0, undo: 0, freeze: 0, reroll: 0 }, progress: { pts: 0, combos: 0, fcombos: 0 },
    frozen: new Uint8Array(81), freezeHold: false, streak: 2,
    scoreLog: [entry], streakLog: [{ n: 2, gained: 128 }],
  };
  const snap = G.takeSnapshot(state);
  state.scoreLog.push(entry);
  state.scoreLog[0].total = -1;
  state.scoreLog[0].icons[0].count = 9;
  state.scoreLog[0].cleared[0] = 40;
  state.scoreLog[0].placed.push(77);
  state.streakLog[0].gained = -1;
  assert.strictEqual(snap.scoreLog.length, 1, 'array copied');
  assert.strictEqual(snap.scoreLog[0].total, 128, 'entry copied');
  assert.strictEqual(snap.scoreLog[0].icons[0].count, 3, 'nested icon objects copied');
  assert.strictEqual(snap.scoreLog[0].board, boardStr, 'board string copied');
  assert.deepStrictEqual(snap.scoreLog[0].cleared, [0, 1, 2], 'cleared array copied, not aliased');
  assert.deepStrictEqual(snap.scoreLog[0].placed, [2], 'placed array copied, not aliased');
  assert.strictEqual(snap.streakLog[0].gained, 128, 'streak row copied');
});

/* ---- FLIP_MAP + applyFlip ---- */

test('FLIP_MAP: total, bijective, involution', () => {
  assert.strictEqual(G.FLIP_MAP.length, 47);
  for (const t of G.FLIP_MAP) assert.ok(Number.isInteger(t) && t >= 0 && t < 47);
  assert.strictEqual(new Set(G.FLIP_MAP).size, 47, 'bijection');
  for (let id = 0; id < 47; id++) {
    assert.strictEqual(G.FLIP_MAP[G.FLIP_MAP[id]], id, 'flipping twice returns shape ' + id);
  }
});

test('FLIP_MAP: known mappings', () => {
  assert.strictEqual(G.FLIP_MAP[0], 0, 'single is a fixed point');
  assert.strictEqual(G.FLIP_MAP[1], 1, 'a horizontal line mirrors to itself');
  assert.strictEqual(G.FLIP_MAP[13], 13, 'square is a fixed point');
  assert.strictEqual(G.FLIP_MAP[38], 38, 'plus5 is a fixed point');
  assert.strictEqual(G.FLIP_MAP[3], 4, 'diagonals swap chirality');
  assert.strictEqual(G.FLIP_MAP[7], 8, 'long diagonals too');
  assert.strictEqual(G.FLIP_MAP[16], 20, 'L mirrors to J');
  assert.strictEqual(G.FLIP_MAP[24], 26, 'S mirrors to Z');
  assert.strictEqual(G.FLIP_MAP[28], 28, 'the down-pointing T is mirror-symmetric');
  assert.strictEqual(G.FLIP_MAP[30], 31, 'the sideways Ts mirror to each other');
});

test('flipShapeCells matches geometry', () => {
  assert.deepStrictEqual(
    G.flipShapeCells([[0, 0], [1, 0], [1, 1]], 2).map(([r, c]) => r + ',' + c).sort(),
    ['0,1', '1,0', '1,1'].sort()
  );
  assert.deepStrictEqual(
    G.flipShapeCells([[0, 0], [0, 1], [0, 2]], 3).map(([r, c]) => r + ',' + c).sort(),
    ['0,0', '0,1', '0,2'].sort(),
    'a horizontal line is its own mirror'
  );
});

test('applyFlip: mirror-symmetric shape never charges and leaves the piece alone', () => {
  const piece = { shapeId: 5, icon: 3 }; /* Line3-H mirrors to itself */
  const res = G.applyFlip(piece, 3);
  assert.strictEqual(res.kind, 'symmetric');
  assert.strictEqual(res.flipCount, 3, 'no item spent');
  assert.strictEqual(res.piece, piece, 'piece unchanged');
});

test('applyFlip: first mirror charges one and remembers the origin', () => {
  const piece = { shapeId: 16, icon: 3 };
  const res = G.applyFlip(piece, 2);
  assert.strictEqual(res.kind, 'charged');
  assert.strictEqual(res.flipCount, 1, 'one flip spent');
  assert.deepStrictEqual(res.piece, { shapeId: 20, icon: 3, flipFree: true, flipOrig: 16 });
});

test('applyFlip: charging preserves a frozen flag and an open rotate session', () => {
  const res = G.applyFlip({ shapeId: 16, icon: 3, frozen: true, rotFree: true, rotOrig: 17 }, 1);
  assert.strictEqual(res.kind, 'charged');
  assert.strictEqual(res.piece.frozen, true);
  assert.strictEqual(res.piece.rotFree, true, 'paid free spins survive the mirror');
  assert.strictEqual(res.piece.rotOrig, undefined, 'the spin cancel anchor is gone: the mirror left its orbit');
});

test('applyFlip: null when there is no session and no item', () => {
  assert.strictEqual(G.applyFlip({ shapeId: 16, icon: 3 }, 0), null);
});

test('applyFlip: flipping back to the origin cancels and refunds', () => {
  const piece = { shapeId: 20, icon: 3, flipFree: true, flipOrig: 16 };
  const res = G.applyFlip(piece, 1);
  assert.strictEqual(res.kind, 'canceled');
  assert.strictEqual(res.flipCount, 2, 'the flip comes back');
  assert.strictEqual(res.refunded, true);
  assert.deepStrictEqual(res.piece, { shapeId: 16, icon: 3 }, 'flags stripped');
});

test('applyFlip: cancel refund clamps at the cap and keeps the other flags', () => {
  const piece = { shapeId: 20, icon: 3, flipFree: true, flipOrig: 16, rotFree: true, frozen: true };
  const res = G.applyFlip(piece, G.ITEM_CAPS.flip);
  assert.strictEqual(res.kind, 'canceled');
  assert.strictEqual(res.flipCount, G.ITEM_CAPS.flip, 'stays at cap');
  assert.strictEqual(res.refunded, false, 'nothing actually returned');
  assert.strictEqual(res.piece.frozen, true);
  assert.strictEqual(res.piece.rotFree, true);
  assert.strictEqual(res.piece.flipFree, undefined);
  assert.strictEqual(res.piece.flipOrig, undefined);
});

test('applyFlip: a session without an anchor mirrors free forever, never cancels', () => {
  let piece = { shapeId: 16, icon: 3, flipFree: true };
  for (let i = 0; i < 4; i++) {
    const res = G.applyFlip(piece, 0);
    assert.strictEqual(res.kind, 'free', 'never reaches cancel without flipOrig');
    piece = res.piece;
  }
  assert.strictEqual(piece.shapeId, 16, 'back to the start shape but still free');
});

test('applyRotation: a spin drops the flip cancel anchor but keeps the free mirrors', () => {
  const charged = G.applyRotation({ shapeId: 20, icon: 1, flipFree: true, flipOrig: 16 }, 1);
  assert.strictEqual(charged.kind, 'charged');
  assert.strictEqual(charged.piece.flipFree, true);
  assert.strictEqual(charged.piece.flipOrig, undefined);

  const free = G.applyRotation({ shapeId: 20, icon: 1, rotFree: true, flipFree: true, flipOrig: 16 }, 0);
  assert.strictEqual(free.kind, 'free');
  assert.strictEqual(free.piece.flipFree, true);
  assert.strictEqual(free.piece.flipOrig, undefined);
});

test('applyRotation: cancel keeps the free mirrors riding on the piece', () => {
  /* L orbit is a 4-cycle, so shape 19 spins back to its origin 16. */
  const res = G.applyRotation({ shapeId: 19, icon: 3, rotFree: true, rotOrig: 16, flipFree: true }, 0);
  assert.strictEqual(res.kind, 'canceled');
  assert.strictEqual(res.piece.shapeId, 16);
  assert.strictEqual(res.piece.flipFree, true);
});

test('computeEarned: flip every 300 points with its own carry', () => {
  let r = G.computeEarned({ pts: 0, flipPts: 290, combos: 0 }, { gained: 30, comboN: 0, perfectCount: 0 });
  assert.strictEqual(r.earned.flip, 1);
  assert.strictEqual(r.progress.flipPts, 20);
  r = G.computeEarned({ pts: 0, combos: 0 }, { gained: 601, comboN: 0, perfectCount: 0 });
  assert.strictEqual(r.earned.rotate, 3, '601 points pay three rotates');
  assert.strictEqual(r.earned.flip, 2, 'and two flips from the same gains');
  assert.strictEqual(r.progress.pts, 1);
  assert.strictEqual(r.progress.flipPts, 1);
  const legacy = G.computeEarned({ pts: 10, combos: 0 }, { gained: 20, comboN: 0, perfectCount: 0 });
  assert.strictEqual(legacy.progress.flipPts, 20, 'a legacy progress without flipPts starts from zero');
});

test('applyReroll: refunds an open flip session, clamped at the cap', () => {
  const rng = mulberry32(44);
  const piece = { shapeId: 20, icon: 2, flipFree: true, flipOrig: 16 };
  const res = G.applyReroll(piece, { rotate: 0, flip: 0, undo: 0, freeze: 0, reroll: 1 }, rng);
  assert.strictEqual(res.refundedFlip, true);
  assert.strictEqual(res.inv.flip, 1, 'flip returned');
  assert.strictEqual(res.piece.flipFree, undefined, 'fresh piece carries no flip session');
  const capped = G.applyReroll(piece, { rotate: 0, flip: G.ITEM_CAPS.flip, undo: 0, freeze: 0, reroll: 1 }, rng);
  assert.strictEqual(capped.refundedFlip, false, 'nothing actually returned at cap');
  assert.strictEqual(capped.inv.flip, G.ITEM_CAPS.flip);
  const legacy = G.applyReroll(piece, { rotate: 0, undo: 0, freeze: 0, reroll: 1 }, rng);
  assert.strictEqual(legacy.inv.flip, 1, 'a legacy inv without a flip key refunds cleanly');
});

test('validateSave: flip session flags accepted, hostile values rejected, symmetric scrub', () => {
  const empty = new Array(81).fill(-1);
  const mk = (piece) => G.validateSave({
    v: 2, best: 1,
    game: { board: empty.slice(), tray: [piece, null, null], score: 5 },
  });

  const good = mk({ shapeId: 20, icon: 3, flipFree: true, flipOrig: 16 });
  assert.ok(good.game, 'valid flipOrig accepted');
  assert.deepStrictEqual(good.game.tray[0], { shapeId: 20, icon: 3, flipFree: true, flipOrig: 16 });

  assert.strictEqual(mk({ shapeId: 20, icon: 3, flipFree: 'yes' }).game, null, 'non-boolean flipFree rejected');
  assert.strictEqual(mk({ shapeId: 20, icon: 3, flipFree: true, flipOrig: '16' }).game, null, 'string flipOrig rejected');
  assert.strictEqual(mk({ shapeId: 20, icon: 3, flipFree: true, flipOrig: 99 }).game, null, 'out-of-range flipOrig rejected');
  assert.strictEqual(mk({ shapeId: 20, icon: 3, flipFree: true, flipOrig: 17 }).game, null, 'a non-mirror flipOrig rejected');

  const noSession = mk({ shapeId: 20, icon: 3, flipOrig: 16 });
  assert.ok(noSession.game, 'flipOrig without flipFree keeps the game');
  assert.strictEqual(noSession.game.tray[0].flipOrig, undefined, 'orphan flipOrig dropped');

  const scrub = mk({ shapeId: 5, icon: 2, flipFree: true });
  assert.ok(scrub.game, 'mirror-symmetric flipFree keeps the game');
  assert.deepStrictEqual(scrub.game.tray[0], { shapeId: 5, icon: 2 }, 'flipFree scrubbed off a fully symmetric orbit');

  /* A rotation can park an open flip session on a mirror-symmetric
     orientation (T4 28 is FLIP-fixed but its orbit holds chiral 30/31).
     The session must survive the round-trip: scrubbing it would delete a
     paid Flip on reload. */
  const parked = mk({ shapeId: 28, icon: 3, rotFree: true, rotOrig: 31, flipFree: true });
  assert.ok(parked.game, 'parked flip session keeps the game');
  assert.deepStrictEqual(parked.game.tray[0],
    { shapeId: 28, icon: 3, rotFree: true, rotOrig: 31, flipFree: true },
    'flipFree survives on a flip-fixed shape whose spin orbit is chiral');

  const mkProgress = (flipPts) => G.validateSave({
    v: 2, best: 1,
    game: { board: empty.slice(), tray: [{ shapeId: 0, icon: 1 }, null, null], score: 5, progress: { pts: 0, flipPts, combos: 0, fcombos: 0 } },
  }).game.progress.flipPts;
  assert.strictEqual(mkProgress(299), 299, 'a sane flipPts survives');
  assert.strictEqual(mkProgress(900), 0, 'out-of-range flipPts clamped');
});

/* ---- Flip-aware game over ---- */

function boardWithHoles(holes) {
  const b = new Int8Array(81).fill(1);
  for (const [r, c] of holes) b[idx(r, c)] = -1;
  return b;
}

test('flipRescues and orientationRescues: the mirror is reachable, the spin orbit is not', () => {
  /* Holes shaped exactly like the J at shape 20: the L at 16 and its whole
     spin orbit (17, 18, 19) cannot fit, only the mirror can. */
  const b = boardWithHoles([[0, 1], [1, 1], [2, 0], [2, 1]]);
  const L = { shapeId: 16, icon: 1 };
  assert.strictEqual(G.fitsSomewhere(b, G.SHAPES[16]), false, 'the L itself does not fit');
  assert.strictEqual(G.rotationRescues(b, L, 3), false, 'no rotation fits');
  assert.strictEqual(G.flipRescues(b, L, 0), false, 'no flip in stock, no rescue');
  assert.strictEqual(G.flipRescues(b, L, 1), true, 'one Flip buys the mirror');
  assert.strictEqual(G.flipRescues(b, { ...L, flipFree: true }, 0), true, 'an open session mirrors free');
  assert.strictEqual(G.flipRescues(b, { shapeId: 5, icon: 1 }, 3), false, 'a symmetric shape never flip-rescues');
  assert.strictEqual(G.orientationRescues(b, L, 3, 0), false, 'rotate-only walk misses the mirror');
  assert.strictEqual(G.orientationRescues(b, L, 0, 1), true, 'flip-only walk finds it');
});

test('orientationRescues: rotate and flip together reach the full dihedral orbit', () => {
  /* Holes shaped like shape 21 (the mirror rotated once): neither the spin
     orbit alone nor the bare mirror fits; the combination does. */
  const b = boardWithHoles([[0, 0], [1, 0], [1, 1], [1, 2]]);
  const L = { shapeId: 16, icon: 1 };
  assert.strictEqual(G.orientationRescues(b, L, 3, 0), false, 'rotations alone never fit');
  assert.strictEqual(G.orientationRescues(b, L, 0, 3), false, 'the bare mirror does not fit');
  assert.strictEqual(G.orientationRescues(b, L, 1, 1), true, 'mirror plus spin fits');
});

test('isGameOverWithRotate/WithItems: a held Flip counts as a rescue', () => {
  const b = boardWithHoles([[0, 1], [1, 1], [2, 0], [2, 1]]);
  const tray = [{ shapeId: 16, icon: 1 }, null, null];
  assert.strictEqual(G.isGameOverWithRotate(b, tray, 3), true, 'the rotate-only check keeps its historic meaning');
  assert.strictEqual(G.isGameOverWithRotate(b, tray, 0, 1), false, 'a Flip in stock rescues');
  assert.strictEqual(G.isGameOverWithItems(b, tray, 0, 0), true, 'no items, no way out');
  assert.strictEqual(G.isGameOverWithItems(b, tray, 0, 0, 1), false, 'a held Flip keeps the game alive');
});

/* ---- Generation overrides (beta test tools) ---- */

test('generation overrides: class filter restricts pickShapeId, genTray, and reroll', () => {
  const rng = mulberry32(77);
  try {
    G.setShapeClassFilter([0]); /* Single only */
    for (let i = 0; i < 200; i++) assert.strictEqual(G.pickShapeId(rng), 0);
    const tray = G.genTray(G.emptyBoard(), rng);
    assert.deepStrictEqual(tray.map((p) => p.shapeId), [0, 0, 0], 'the variety guard exhausts harmlessly');
    const rerolled = G.rerollPiece({ shapeId: 0, icon: 1 }, rng);
    assert.strictEqual(rerolled.shapeId, 0, 'the nudge stays inside a one-shape subset');

    G.setShapeClassFilter([2, 4]); /* the two diagonal classes: shapes 3, 4, 7, 8 */
    const allowed = new Set([3, 4, 7, 8]);
    for (let i = 0; i < 200; i++) assert.ok(allowed.has(G.pickShapeId(rng)), 'draws stay in the union');
    const r2 = G.rerollPiece({ shapeId: 3, icon: 1 }, rng);
    assert.ok(allowed.has(r2.shapeId), 'reroll stays in the union');
    assert.notStrictEqual(r2.shapeId, 3, 'and still changes the shape');
    const stuck = G.rerollPiece({ shapeId: 3, icon: 1 }, () => 0);
    assert.ok(allowed.has(stuck.shapeId), 'a stuck rng nudges inside the subset, never out');
  } finally {
    G.setShapeClassFilter(null);
  }
});

test('generation overrides: icon filter restricts pickIcon and both piece factories', () => {
  const rng = mulberry32(88);
  try {
    G.setIconFilter([3]);
    for (let i = 0; i < 200; i++) assert.strictEqual(G.pickIcon(rng), 3);
    assert.strictEqual(G.makePiece(rng).icon, 3);
    assert.strictEqual(G.rerollPiece({ shapeId: 5, icon: 1 }, rng).icon, 3);
    G.setIconFilter([0, 5]);
    for (let i = 0; i < 200; i++) assert.ok([0, 5].includes(G.pickIcon(rng)));
  } finally {
    G.setIconFilter(null);
  }
});

test('generation overrides: force-1x1 reroll wins over filters and identical shapes', () => {
  const rng = mulberry32(99);
  try {
    G.setRerollForce1x1(true);
    assert.strictEqual(G.rerollPiece({ shapeId: 32, icon: 1 }, rng).shapeId, 0);
    assert.strictEqual(G.rerollPiece({ shapeId: 0, icon: 1 }, rng).shapeId, 0, 'rerolling a Single keeps a Single');
    G.setShapeClassFilter([11]); /* Line 5 only, deliberately excluding the Single */
    assert.strictEqual(G.rerollPiece({ shapeId: 32, icon: 1 }, rng).shapeId, 0, 'the switch beats the class filter');
    const tray = G.genTray(G.emptyBoard(), rng);
    for (const p of tray) assert.ok([32, 33].includes(p.shapeId), 'tray generation still obeys the filter');
  } finally {
    G.setRerollForce1x1(false);
    G.setShapeClassFilter(null);
  }
});

test('generation overrides: empty, full, and junk selections clear the filters', () => {
  const rng = mulberry32(111);
  try {
    for (const clearing of [[], [...Array(16).keys()], 'junk', null]) {
      G.setShapeClassFilter(clearing);
      const drawn = new Set();
      for (let i = 0; i < 300; i++) drawn.add(G.pickShapeId(rng));
      assert.ok(drawn.size > 16, 'draws span the whole pool after clearing with ' + JSON.stringify(clearing));
    }
    G.setIconFilter([0, 1, 2, 3, 4, 5]);
    const icons = new Set();
    for (let i = 0; i < 300; i++) icons.add(G.pickIcon(rng));
    assert.ok(icons.size >= 4, 'a full icon selection means no filter');
  } finally {
    G.setShapeClassFilter(null);
    G.setIconFilter(null);
  }
});

test('SHAPE_CLASS_META: 16 named classes exactly covering the 47 shapes', () => {
  assert.strictEqual(G.SHAPE_CLASS_META.length, 16);
  assert.strictEqual(G.SHAPE_CLASS_NAMES.length, 16);
  const all = G.SHAPE_CLASS_META.flatMap((m) => m.shapeIds);
  assert.strictEqual(all.length, 47, 'every shape belongs to a class');
  assert.strictEqual(new Set(all).size, 47, 'no shape in two classes');
  assert.deepStrictEqual(G.SHAPE_CLASS_META[0].shapeIds, [0], 'the Single is class 0');
  for (const m of G.SHAPE_CLASS_META) {
    assert.strictEqual(m.name, G.SHAPE_CLASS_NAMES[m.classIdx]);
    for (const id of m.shapeIds) assert.strictEqual(G.SHAPE_CLASS_OF[id], m.classIdx);
  }
});

test('validateSave: journal keeps clean strings, drops garbage, caps length', () => {
  const lines = ['12:00:00 place s0 #0i3 @r4c8 +119 clear x1', '12:00:05 dip s1 #1'];
  const out = G.validateSave({ v: 2, best: 1, journal: [...lines, 42, null, { evil: true }, 'x'.repeat(200), ''], game: null });
  assert.deepStrictEqual(out.journal, lines, 'strings kept in order, non-strings and oversized lines dropped');

  const many = Array.from({ length: 50 }, (_, i) => 'line ' + i);
  const capped = G.validateSave({ v: 2, best: 1, journal: many, game: null });
  assert.strictEqual(capped.journal.length, G.JOURNAL_MAX, 'journal capped');
  assert.strictEqual(capped.journal[capped.journal.length - 1], 'line 49', 'newest entries kept');

  assert.deepStrictEqual(G.validateSave({ v: 2, best: 1, journal: 'junk', game: null }).journal, [], 'junk journal becomes empty');
  assert.deepStrictEqual(G.defaultMeta().journal, [], 'fresh meta starts with an empty journal');
});

test('validateSave: testTools switches are lenient and range-checked', () => {
  const out = G.validateSave({ v: 2, best: 1, testTools: { reroll1x1: true, classes: [3, 3, 99, -1, 2], icons: [5, 5, 0, 9] }, game: null });
  assert.deepStrictEqual(out.testTools, { reroll1x1: true, classes: [2, 3], icons: [0, 5] });

  const junk = G.validateSave({ v: 2, best: 1, testTools: 'nope', game: null });
  assert.deepStrictEqual(junk.testTools, { reroll1x1: false, classes: null, icons: null });

  const collapse = G.validateSave({ v: 2, best: 1, testTools: { reroll1x1: 1, classes: [...Array(16).keys()], icons: [] }, game: null });
  assert.deepStrictEqual(collapse.testTools, { reroll1x1: false, classes: null, icons: null },
    'a full class list, an empty icon list, and a truthy non-bool all collapse to defaults');
});

/* ---- Beta test scenarios ---- */

test('scenarios: every preset builds a valid, clear-free state that round-trips', () => {
  const rng = mulberry32(555);
  for (const s of G.SCENARIOS) {
    const st = s.build(rng);
    assert.strictEqual(st.board.length, 81, s.id + ': board size');
    for (const v of st.board) assert.ok(v >= -1 && v < G.ICONS.length, s.id + ': cell values in range');
    assert.strictEqual(G.scanUnits(st.board).length, 0, s.id + ': no unit starts complete');
    assert.strictEqual(st.tray.length, 3, s.id + ': three tray slots');
    for (const p of st.tray) {
      assert.ok(p && Number.isInteger(p.shapeId) && p.shapeId >= 0 && p.shapeId < G.SHAPES.length, s.id + ': valid piece');
      assert.ok(Number.isInteger(p.icon) && p.icon >= 0 && p.icon < G.ICONS.length, s.id + ': valid icon');
    }
    assert.strictEqual(st.score, 0, s.id + ': fresh score');
    for (const k of Object.keys(G.ITEM_CAPS)) {
      assert.ok(st.inv[k] >= 0 && st.inv[k] <= G.ITEM_CAPS[k], s.id + ': inv within caps');
    }
    const game = G.encodeGame({
      ...st,
      progress: { pts: 0, flipPts: 0, combos: 0, fcombos: 0 },
      frozen: new Uint8Array(81), freezeHold: false, streak: 0, scoreLog: [], streakLog: [],
    });
    assert.ok(G.validateSave({ v: 2, best: 0, game }).game, s.id + ': save round-trips');
  }
  assert.strictEqual(G.buildScenario('nope', rng), null, 'unknown id returns null');
});

test('scenarios: each target move produces exactly the declared outcome', () => {
  const rng = mulberry32(556);
  for (const s of G.SCENARIOS) {
    if (!s.target) continue;
    const st = s.build(rng);
    const piece = st.tray[s.target.slot];
    const shape = G.SHAPES[piece.shapeId];
    assert.ok(G.canPlace(st.board, shape, s.target.row, s.target.col), s.id + ': target placement legal');
    G.placePiece(st.board, shape, s.target.row, s.target.col, piece.icon);
    const units = G.scanUnits(st.board);
    assert.strictEqual(units.length, s.expect.units, s.id + ': unit count');
    const bonuses = G.iconBonuses(st.board, units);
    assert.strictEqual(bonuses.filter((b) => b.perfect).length, s.expect.perfectCount, s.id + ': perfect count');
    const ms = G.matchingSetBonuses(bonuses);
    if (s.expect.msUnits > 0) {
      assert.strictEqual(ms.length, 1, s.id + ': one matching-sets bonus');
      assert.strictEqual(ms[0].unitCount, s.expect.msUnits, s.id + ': matching-sets unit count');
    } else {
      assert.deepStrictEqual(ms, [], s.id + ': no matching-sets bonus');
    }
  }
});

test('scenarios: combo3 completes a row, a column, and a box', () => {
  const st = G.buildScenario('combo3', mulberry32(1));
  const piece = st.tray[0];
  G.placePiece(st.board, G.SHAPES[piece.shapeId], 7, 7, piece.icon);
  const types = G.scanUnits(st.board).map((u) => u.type).sort();
  assert.deepStrictEqual(types, ['box', 'col', 'row']);
});

test('scenarios: freezeRescue is a forced icy move that force-melts and rescues', () => {
  const st = G.buildScenario('freezeRescue', mulberry32(3));
  assert.strictEqual(G.scanUnits(st.board).length, 0, 'no set starts complete');

  const icy = st.tray[0];
  const partner = st.tray[1];
  assert.strictEqual(icy.frozen, true, 'slot 0 is pre-dipped (icy)');
  assert.strictEqual(st.inv.reroll, 0, 'no Reroll, or the dead end would be rescued not melted');

  /* The Line2 partner fits nowhere on the scattered gaps, so the icy Single is
     the only legal move, and it lands a row + column + box wherever it goes. */
  assert.strictEqual(G.fitsSomewhere(st.board, G.SHAPES[partner.shapeId]), false, 'the partner fits nowhere yet');
  assert.strictEqual(G.fitsSomewhere(st.board, G.SHAPES[icy.shapeId]), true, 'the icy Single fits');

  G.placePiece(st.board, G.SHAPES[icy.shapeId], 0, 0, icy.icon);
  const units = G.scanUnits(st.board);
  assert.strictEqual(units.length, 3, 'a row, a column, and a box complete');
  const { didFreeze } = G.freezeOutcome(true, false, G.unionCells(units), new Uint8Array(81));
  assert.strictEqual(didFreeze, true, 'the dipped placement freezes the crossed sets');

  /* The partner still fits nowhere and no item can save it, so the held freeze
     force-melts (paying every crossed set as one combo) to rescue the game. */
  const after = [null, st.tray[1], st.tray[2]];
  assert.strictEqual(G.isGameOver(st.board, after), true, 'the partners fit nowhere');
  assert.strictEqual(
    G.isGameOverWithItems(st.board, after, st.inv.rotate, st.inv.reroll, st.inv.flip), true, 'no item rescues it');
  const bonuses = G.iconBonuses(st.board, units);
  const gained = G.clearScore(units.length) + bonuses.reduce((a, b) => a + b.points, 0);
  assert.ok(gained > 0, 'the force-melt pays a combo');
});

test('scenarios honor the beta icon and class filters', () => {
  const rng = mulberry32(777);
  try {
    G.setIconFilter([5]); /* butterflies only */
    G.setShapeClassFilter([0]); /* Singles only */
    for (const s of G.SCENARIOS) {
      const st = s.build(rng);
      for (const v of st.board) {
        if (v !== -1) assert.strictEqual(v, 5, s.id + ': board cells use the allowed icon');
      }
      for (const p of st.tray) {
        if (p) assert.strictEqual(p.icon, 5, s.id + ': tray icons stay in the allowed set');
      }
    }
    const p1 = G.buildScenario('perfect1', rng);
    assert.deepStrictEqual(p1.tray.map((p) => p.shapeId), [0, 0, 0], 'perfect1 fillers restricted to Singles');
    const ngo = G.buildScenario('nearGameOver', rng);
    assert.deepStrictEqual(ngo.tray.map((p) => p.shapeId), [0, 32, 33], 'nearGameOver keeps its essential shapes');

    /* The re-themed icon still lands the promised perfect sets. */
    const p2 = G.buildScenario('perfect2', rng);
    G.placePiece(p2.board, G.SHAPES[0], 4, 4, p2.tray[0].icon);
    const units = G.scanUnits(p2.board);
    assert.strictEqual(units.length, 2, 'both units still complete');
    const bonuses = G.iconBonuses(p2.board, units);
    assert.strictEqual(bonuses.filter((b) => b.perfect && b.icon === 5).length, 2, 'two perfect butterfly sets');
  } finally {
    G.setIconFilter(null);
    G.setShapeClassFilter(null);
  }
});

test('scenarios: nearGameOver is alive before the move, dead after, items rescue', () => {
  const st = G.buildScenario('nearGameOver', mulberry32(2));
  assert.strictEqual(G.isGameOver(st.board, st.tray), false, 'the Single still fits');

  /* No hole completes a unit: every row, column, and box keeps a second one. */
  const single = st.tray[0];
  for (let i = 0; i < 81; i++) {
    if (st.board[i] !== -1) continue;
    const copy = new Int8Array(st.board);
    copy[i] = single.icon;
    assert.strictEqual(G.scanUnits(copy).length, 0, 'no single placement completes a unit (cell ' + i + ')');
  }

  G.placePiece(st.board, G.SHAPES[single.shapeId], 0, 0, single.icon);
  const after = [null, st.tray[1], st.tray[2]];
  assert.strictEqual(G.isGameOver(st.board, after), true, 'the Line5s fit nowhere');
  assert.strictEqual(G.isGameOverWithRotate(st.board, after, 3, 3), true, 'no spin or mirror rescues a Line5');
  assert.strictEqual(G.isGameOverWithItems(st.board, after, st.inv.rotate, st.inv.reroll, st.inv.flip), false,
    'a held Reroll keeps the game alive');
});

/* ---- Deploy invariants. No bundler: an update only reaches installed
   phones if the service worker precaches every module and its cache name
   was bumped in lockstep with the build number. Forgetting either breaks
   the PWA silently, so the suite enforces both. ---- */

test('deploy: every src module is in sw.js ASSETS and the cache matches the build', () => {
  const root = new URL('..', import.meta.url);
  const sw = readFileSync(new URL('sw.js', root), 'utf8');
  const srcDir = fileURLToPath(new URL('src/', root));
  const modules = readdirSync(srcDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.js'))
    .map((f) => './src/' + f.replace(/\\/g, '/'));
  assert.ok(modules.length >= 10, 'src module sweep found the expected modules');
  for (const m of modules) {
    assert.ok(sw.includes("'" + m + "'"), m + ' must be listed in sw.js ASSETS');
  }
  const cacheVer = Number((sw.match(/-v(\d+)'/) || [])[1]);
  assert.strictEqual(cacheVer, G.APP_BUILD, 'sw.js CACHE version must equal APP_BUILD');
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
