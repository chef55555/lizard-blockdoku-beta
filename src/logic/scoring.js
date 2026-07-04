/* Board helpers and scoring (units, clears, icon/matching-set bonuses). */

import { N, CELL_COUNT, ICONS, LIZARD_ICON } from './config.js';

/* ---- Board helpers. board = Int8Array(81), -1 empty, 0..5 icon index ---- */

function emptyBoard() {
  return new Int8Array(CELL_COUNT).fill(-1);
}

function canPlace(board, shape, row, col) {
  if (row < 0 || col < 0 || row + shape.h > N || col + shape.w > N) return false;
  for (const [dr, dc] of shape.cells) {
    if (board[(row + dr) * N + col + dc] !== -1) return false;
  }
  return true;
}

function fitsSomewhere(board, shape) {
  for (let r = 0; r <= N - shape.h; r++) {
    for (let c = 0; c <= N - shape.w; c++) {
      if (canPlace(board, shape, r, c)) return true;
    }
  }
  return false;
}

function placePiece(board, shape, row, col, icon) {
  const placed = [];
  for (const [dr, dc] of shape.cells) {
    const idx = (row + dr) * N + col + dc;
    board[idx] = icon;
    placed.push(idx);
  }
  return placed;
}

/* Scan the FULL board once and return every completed unit.
   Detection always runs on the post-placement, pre-clear snapshot. */
function scanUnits(board) {
  const units = [];
  for (let r = 0; r < N; r++) {
    const cells = [];
    let full = true;
    for (let c = 0; c < N; c++) {
      const idx = r * N + c;
      if (board[idx] === -1) { full = false; break; }
      cells.push(idx);
    }
    if (full) units.push({ type: 'row', index: r, cells });
  }
  for (let c = 0; c < N; c++) {
    const cells = [];
    let full = true;
    for (let r = 0; r < N; r++) {
      const idx = r * N + c;
      if (board[idx] === -1) { full = false; break; }
      cells.push(idx);
    }
    if (full) units.push({ type: 'col', index: c, cells });
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const cells = [];
      let full = true;
      for (let dr = 0; dr < 3 && full; dr++) {
        for (let dc = 0; dc < 3; dc++) {
          const idx = (br * 3 + dr) * N + bc * 3 + dc;
          if (board[idx] === -1) { full = false; break; }
          cells.push(idx);
        }
      }
      if (full) units.push({ type: 'box', index: br * 3 + bc, cells });
    }
  }
  return units;
}

function unionCells(units) {
  const set = new Set();
  for (const u of units) for (const idx of u.cells) set.add(idx);
  return set;
}

/* n simultaneous units: 18, 54, 90, 126, 162... Units counted separately
   even when they share cells; cells are only ever cleared once. */
function clearScore(n) {
  return n > 0 ? 18 * (2 * n - 1) : 0;
}

/* Streak: clearing something on back-to-back placements pays a rising bonus.
   x2 +10, x3 +20, x4 +30... Uncapped. One tunable, chunky on purpose. */
function streakBonus(k) {
  return k >= 2 ? 10 * (k - 1) : 0;
}

/* Icon bonus per (unit, icon) pair, counted on the pre-clear snapshot.
   3-4 same: +10, 5-6: +25, 7-8: +50, 9: +100. Doubled for the lizard. */
function iconBonusTier(count) {
  if (count >= 9) return 100;
  if (count >= 7) return 50;
  if (count >= 5) return 25;
  if (count >= 3) return 10;
  return 0;
}

function iconBonuses(board, units) {
  const bonuses = [];
  for (const unit of units) {
    const counts = new Array(ICONS.length).fill(0);
    for (const idx of unit.cells) {
      const icon = board[idx];
      if (icon >= 0) counts[icon]++;
    }
    for (let icon = 0; icon < ICONS.length; icon++) {
      const count = counts[icon];
      const tier = iconBonusTier(count);
      if (tier === 0) continue;
      bonuses.push({
        unit,
        icon,
        count,
        points: icon === LIZARD_ICON ? tier * 2 : tier,
        perfect: count === 9,
        cells: unit.cells.filter((idx) => board[idx] === icon),
      });
    }
  }
  return bonuses;
}

/* Matching Sets: an icon with a 3+ match in k >= 2 distinct cleared units.
   Tier 50 (k=2), 100 (k=3), 200 (k>=4); doubled for the lizard. */
function matchingSetsTier(k) {
  if (k >= 4) return 200;
  if (k === 3) return 100;
  if (k === 2) return 50;
  return 0;
}

function matchingSetBonuses(bonuses) {
  const byIcon = new Map();
  for (const b of bonuses) {
    if (!byIcon.has(b.icon)) byIcon.set(b.icon, []);
    byIcon.get(b.icon).push(b);
  }
  const out = [];
  for (const [icon, list] of byIcon) {
    const tier = matchingSetsTier(list.length);
    if (tier === 0) continue;
    const cells = new Set();
    for (const b of list) for (const idx of b.cells) cells.add(idx);
    out.push({
      icon,
      unitCount: list.length,
      points: icon === LIZARD_ICON ? tier * 2 : tier,
      cells: [...cells],
    });
  }
  return out;
}

export { emptyBoard, canPlace, fitsSomewhere, placePiece, scanUnits, unionCells, clearScore, streakBonus, iconBonusTier, iconBonuses, matchingSetsTier, matchingSetBonuses };
