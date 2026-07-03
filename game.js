'use strict';

/* ================================================================
   Lizard Block Mania
   A gift for Lizard, made with love.
   Pure game logic first (Node-testable), then the browser UI.
   (Internal identifiers keep the historical lizard-blockdoku name:
   renaming the repo/URL or storage keys would break her install.)
   ================================================================ */

const PLAYER_NAME = 'Lizard';

/* Beta channel: the same code deployed under .../lizard-blockdoku-beta/ gets
   its own save (github.io shares one localStorage origin across repos) and
   never submits to the real leaderboard. */
const IS_BETA = typeof location !== 'undefined' && location.pathname.includes('-beta');
const SAVE_KEY = IS_BETA ? 'lizard-blockdoku-beta' : 'lizard-blockdoku-v1';

const ICONS = ['\u{1F98E}', '\u{1F338}', '\u{1F49C}', '⭐', '\u{1F353}']; /* lizard flower heart star berry */
const ICON_WEIGHTS = [8, 23, 23, 23, 23];
const ICON_LABELS = ['Lizard Power!', 'Flower Match!', 'Heart Match!', 'Star Match!', 'Berry Match!'];
const LIZARD_ICON = 0;

const N = 9;
const CELL_COUNT = 81;

/* ---- Piece set: 43 shapes in 15 weighted classes (weights sum 100).
   A class's weight is split evenly among its orientations. Never rotated. ---- */
const SHAPE_CLASSES = [
  { w: 4,  shapes: [[[0,0]]] },                                                     /* Single */
  { w: 6,  shapes: [[[0,0],[0,1]], [[0,0],[1,0]]] },                                /* Line2 */
  { w: 4,  shapes: [[[0,0],[1,1]], [[0,1],[1,0]]] },                                /* Diag2 */
  { w: 10, shapes: [[[0,0],[0,1],[0,2]], [[0,0],[1,0],[2,0]]] },                    /* Line3 */
  { w: 4,  shapes: [[[0,0],[1,1],[2,2]], [[0,2],[1,1],[2,0]]] },                    /* Diag3 */
  { w: 10, shapes: [                                                                 /* Corner3 */
      [[0,0],[1,0],[1,1]], [[0,0],[0,1],[1,0]], [[0,0],[0,1],[1,1]], [[0,1],[1,0],[1,1]] ] },
  { w: 8,  shapes: [[[0,0],[0,1],[1,0],[1,1]]] },                                   /* Square2x2 */
  { w: 8,  shapes: [[[0,0],[0,1],[0,2],[0,3]], [[0,0],[1,0],[2,0],[3,0]]] },        /* Line4 */
  { w: 12, shapes: [                                                                 /* L/J4, 8 orientations */
      [[0,0],[1,0],[2,0],[2,1]], [[0,0],[0,1],[0,2],[1,0]],
      [[0,0],[0,1],[1,1],[2,1]], [[0,2],[1,0],[1,1],[1,2]],
      [[0,1],[1,1],[2,0],[2,1]], [[0,0],[1,0],[1,1],[1,2]],
      [[0,0],[0,1],[1,0],[2,0]], [[0,0],[0,1],[0,2],[1,2]] ] },
  { w: 8,  shapes: [                                                                 /* S/Z4 */
      [[0,1],[0,2],[1,0],[1,1]], [[0,0],[1,0],[1,1],[2,1]],
      [[0,0],[0,1],[1,1],[1,2]], [[0,1],[1,0],[1,1],[2,0]] ] },
  { w: 8,  shapes: [                                                                 /* T4 */
      [[0,0],[0,1],[0,2],[1,1]], [[0,1],[1,0],[1,1],[1,2]],
      [[0,1],[1,0],[1,1],[2,1]], [[0,0],[1,0],[1,1],[2,0]] ] },
  { w: 6,  shapes: [[[0,0],[0,1],[0,2],[0,3],[0,4]], [[0,0],[1,0],[2,0],[3,0],[4,0]]] }, /* Line5 */
  { w: 6,  shapes: [                                                                 /* Corner5 */
      [[0,0],[1,0],[2,0],[2,1],[2,2]], [[0,0],[0,1],[0,2],[1,0],[2,0]],
      [[0,0],[0,1],[0,2],[1,2],[2,2]], [[0,2],[1,2],[2,0],[2,1],[2,2]] ] },
  { w: 3,  shapes: [[[0,1],[1,0],[1,1],[1,2],[2,1]]] },                              /* Plus5 */
  { w: 3,  shapes: [                                                                 /* T5 */
      [[0,0],[0,1],[0,2],[1,1],[2,1]], [[0,1],[1,1],[2,0],[2,1],[2,2]],
      [[0,0],[1,0],[1,1],[1,2],[2,0]], [[0,2],[1,0],[1,1],[1,2],[2,2]] ] },
];

const SHAPES = [];
for (const cls of SHAPE_CLASSES) {
  const per = cls.w / cls.shapes.length;
  for (const cells of cls.shapes) {
    let h = 0, w = 0;
    for (const [r, c] of cells) { h = Math.max(h, r + 1); w = Math.max(w, c + 1); }
    SHAPES.push({ cells, w, h, weight: per });
  }
}
const TOTAL_SHAPE_WEIGHT = SHAPES.reduce((a, s) => a + s.weight, 0);
const TOTAL_ICON_WEIGHT = ICON_WEIGHTS.reduce((a, b) => a + b, 0);

/* ---- Board helpers. board = Int8Array(81), -1 empty, 0..4 icon index ---- */

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
    const counts = [0, 0, 0, 0, 0];
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

/* ---- Items ---- */

const ITEM_CAPS = { rotate: 3, undo: 3, freeze: 3 };

/* Economy: rotate 1 per 200 cumulative points, undo 1 per 2 multi-set combos,
   freeze 1 per Perfect Match and 1 per x3+ combo. Progress is per game. */
function computeEarned(progress, turn) {
  const p = { pts: progress.pts + turn.gained, combos: progress.combos };
  const earned = { rotate: 0, undo: 0, freeze: 0 };
  while (p.pts >= 200) { p.pts -= 200; earned.rotate++; }
  if (turn.comboN >= 2) p.combos += 1;
  while (p.combos >= 2) { p.combos -= 2; earned.undo++; }
  earned.freeze += turn.perfectCount || 0;
  if (turn.comboN >= 3) earned.freeze++;
  return { earned, progress: p };
}

function grantItems(inv, earned) {
  const granted = { rotate: 0, undo: 0, freeze: 0 };
  for (const k of Object.keys(granted)) {
    const room = Math.max(0, ITEM_CAPS[k] - inv[k]);
    granted[k] = Math.min(room, earned[k]);
    inv[k] += granted[k];
  }
  return granted;
}

/* Rotation: 90 degrees clockwise, (r,c) -> (c, h-1-r), re-anchored to (0,0).
   The 43-shape set is closed under rotation; ROTATION_MAP proves it at load. */
function rotateShapeCells(cells, h) {
  const rot = cells.map(([r, c]) => [c, h - 1 - r]);
  let minR = Infinity, minC = Infinity;
  for (const [r, c] of rot) { minR = Math.min(minR, r); minC = Math.min(minC, c); }
  return rot.map(([r, c]) => [r - minR, c - minC]);
}

const shapeKeyOf = (cells) => cells.map(([r, c]) => r + ',' + c).sort().join('|');
const ROTATION_MAP = (() => {
  const byKey = new Map(SHAPES.map((s, id) => [shapeKeyOf(s.cells), id]));
  return SHAPES.map((s, id) => {
    const target = byKey.get(shapeKeyOf(rotateShapeCells(s.cells, s.h)));
    if (target === undefined) throw new Error('shape ' + id + ' has no rotation in the set');
    return target;
  });
})();

/* One-level undo: deep snapshot of everything a turn can change. */
function takeSnapshot(state) {
  return {
    board: new Int8Array(state.board),
    tray: state.tray.map((p) => (p ? { ...p } : null)),
    score: state.score,
    inv: { ...state.inv },
    progress: { ...state.progress },
    frozen: new Uint8Array(state.frozen),
    freezeHold: !!state.freezeHold,
  };
}

/* ---- Piece generation ---- */

function pickShapeId(rng) {
  let t = rng() * TOTAL_SHAPE_WEIGHT;
  for (let i = 0; i < SHAPES.length; i++) {
    t -= SHAPES[i].weight;
    if (t < 0) return i;
  }
  return SHAPES.length - 1;
}

function pickIcon(rng) {
  let t = rng() * TOTAL_ICON_WEIGHT;
  for (let i = 0; i < ICON_WEIGHTS.length; i++) {
    t -= ICON_WEIGHTS[i];
    if (t < 0) return i;
  }
  return ICON_WEIGHTS.length - 1;
}

function makePiece(rng) {
  return { shapeId: pickShapeId(rng), icon: pickIcon(rng) };
}

/* Fresh tray of 3. Variety rule: never 3 identical shapes in one tray.
   Mercy rule: if none of the 3 fits, reroll the whole tray (up to 20
   attempts) then accept the last roll; the fit test ends the game honestly.
   No mid-tray mercy by design. */
function genTray(board, rng) {
  let tray = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    tray = [];
    for (let slot = 0; slot < 3; slot++) {
      let piece = makePiece(rng);
      let guard = 0;
      while (
        guard++ < 50 &&
        tray.length === 2 &&
        tray[0].shapeId === tray[1].shapeId &&
        piece.shapeId === tray[0].shapeId
      ) {
        piece = makePiece(rng);
      }
      tray.push(piece);
    }
    if (tray.some((p) => fitsSomewhere(board, SHAPES[p.shapeId]))) return tray;
  }
  return tray;
}

/* Game over iff the tray still holds pieces and none of them fits.
   An empty tray is never game over (it is about to refill). */
function isGameOver(board, tray) {
  const remaining = tray.filter(Boolean);
  return remaining.length > 0 && remaining.every((p) => !fitsSomewhere(board, SHAPES[p.shapeId]));
}

/* ---- Persistence (schema v2; v1 saves migrate) ---- */

function defaultMeta() {
  return {
    best: 0,
    muted: false,
    volume: 50,
    theme: 'auto',
    nickname: '',
    seenTutorial: false,
    tutorialOffered: false,
    itemHelp: { rotate: false, undo: false, freeze: false },
  };
}

function frozenMaskToList(mask) {
  const list = [];
  for (let i = 0; i < CELL_COUNT; i++) if (mask[i]) list.push(i);
  return list;
}

function encodeGame(state) {
  return {
    board: Array.from(state.board),
    tray: state.tray.map((p) => (p
      ? { shapeId: p.shapeId, icon: p.icon, ...(p.frozen ? { frozen: true } : {}) }
      : null)),
    score: state.score,
    inv: { ...state.inv },
    progress: { ...state.progress },
    frozen: frozenMaskToList(state.frozen),
    freezeHold: !!state.freezeHold,
  };
}

const clampInt = (v, lo, hi, fallback) =>
  (Number.isInteger(v) && v >= lo && v <= hi) ? v : fallback;

/* Returns full meta + game|null. On any surprise inside game, discard the
   game but keep the meta. v1 payloads (no v2 fields) migrate to defaults. */
function validateSave(raw) {
  const out = { ...defaultMeta(), game: null };
  if (!raw || typeof raw !== 'object') return out;

  if (typeof raw.best === 'number' && isFinite(raw.best) && raw.best >= 0) {
    out.best = Math.floor(raw.best);
  }
  out.muted = raw.muted === true;
  out.volume = clampInt(raw.volume, 0, 100, 50);
  out.theme = ['auto', 'light', 'dark'].includes(raw.theme) ? raw.theme : 'auto';
  out.nickname = typeof raw.nickname === 'string'
    ? raw.nickname.replace(/[<>\u0000-\u001F\u007F-\u009F\u200B-\u200F\uFEFF]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16)
    : '';
  out.seenTutorial = raw.seenTutorial === true;
  out.tutorialOffered = raw.tutorialOffered === true;
  const ih = raw.itemHelp;
  if (ih && typeof ih === 'object') {
    out.itemHelp = { rotate: ih.rotate === true, undo: ih.undo === true, freeze: ih.freeze === true };
  }

  const g = raw.game;
  try {
    if (!g || typeof g !== 'object') return out;
    if (!Array.isArray(g.board) || g.board.length !== CELL_COUNT) return out;
    const board = new Int8Array(CELL_COUNT);
    for (let i = 0; i < CELL_COUNT; i++) {
      const v = g.board[i];
      if (!Number.isInteger(v) || v < -1 || v >= ICONS.length) return out;
      board[i] = v;
    }
    if (!Array.isArray(g.tray) || g.tray.length !== 3) return out;
    const tray = g.tray.map((p) => {
      if (p === null) return null;
      if (!p || typeof p !== 'object') throw new Error('bad piece');
      if (!Number.isInteger(p.shapeId) || p.shapeId < 0 || p.shapeId >= SHAPES.length) throw new Error('bad shape');
      if (!Number.isInteger(p.icon) || p.icon < 0 || p.icon >= ICONS.length) throw new Error('bad icon');
      const piece = { shapeId: p.shapeId, icon: p.icon };
      if (p.frozen === true) piece.frozen = true;
      else if (p.frozen !== undefined && p.frozen !== false) throw new Error('bad frozen flag');
      return piece;
    });
    if (typeof g.score !== 'number' || !isFinite(g.score) || g.score < 0) return out;

    /* v2 fields; absent (v1 game) means defaults */
    const inv = { rotate: 0, undo: 0, freeze: 0 };
    if (g.inv !== undefined) {
      if (!g.inv || typeof g.inv !== 'object') return out;
      for (const k of Object.keys(inv)) {
        if (g.inv[k] !== undefined && !Number.isInteger(g.inv[k])) return out;
        inv[k] = Math.max(0, Math.min(ITEM_CAPS[k], g.inv[k] || 0));
      }
    }
    const progress = { pts: 0, combos: 0 };
    if (g.progress !== undefined) {
      if (!g.progress || typeof g.progress !== 'object') return out;
      progress.pts = clampInt(g.progress.pts, 0, 199, 0);
      progress.combos = clampInt(g.progress.combos, 0, 1, 0);
    }
    const frozen = new Uint8Array(CELL_COUNT);
    if (g.frozen !== undefined) {
      if (!Array.isArray(g.frozen)) return out;
      for (const idx of g.frozen) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= CELL_COUNT) return out;
        if (board[idx] === -1) return out; /* frozen cell must be filled */
        frozen[idx] = 1;
      }
    }
    const freezeHold = g.freezeHold === true;
    if (freezeHold && frozenMaskToList(frozen).length === 0) return out;

    out.game = { board, tray, score: Math.floor(g.score), inv, progress, frozen, freezeHold };
    return out;
  } catch (e) {
    return out;
  }
}

/* ---- Node test export ---- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ICONS, ICON_WEIGHTS, ICON_LABELS, LIZARD_ICON, SHAPES, SHAPE_CLASSES,
    N, CELL_COUNT,
    emptyBoard, canPlace, fitsSomewhere, placePiece,
    scanUnits, unionCells, clearScore, iconBonusTier, iconBonuses,
    matchingSetsTier, matchingSetBonuses,
    ITEM_CAPS, computeEarned, grantItems,
    rotateShapeCells, ROTATION_MAP, takeSnapshot,
    pickShapeId, pickIcon, makePiece, genTray, isGameOver,
    defaultMeta, frozenMaskToList, encodeGame, validateSave,
  };
}

/* ================================================================
   Browser UI
   ================================================================ */

if (typeof document !== 'undefined') {
  initUI();
}

function initUI() {

  /* ---- Timing and tuning ---- */
  const POP_MS = 180, POP_STAGGER = 22;
  const FLASH_MS = 260;
  const CLEAR_STAGGER = 18;
  const CLEAR_WAIT = 450;
  const SNAPBACK_MS = 150;
  const GAMEOVER_DELAY = 600;
  const GHOST_LIFT = 70;          /* px the ghost floats above the finger */
  const GHOST_TAU = 50;           /* ms time constant of the ghost's easing */
  const BADGE_STAGGER = 120;
  const MAX_PARTICLES = 24;

  const COMBO_PHRASES = { 2: 'So cute!', 3: 'Gorgeous!', 4: 'Queen Lizard!' };
  const COMBO_LEGENDARY = 'LEGENDARY LIZARD!!';
  const SWEET_LINES = [
    'You’re amazing, ' + PLAYER_NAME + ' \u{1F49C}',
    'The prettiest blocks for the prettiest girl \u{1F338}',
    'Every line you clear makes me smile ⭐',
    'My favorite player, forever \u{1F98E}',
    'Berry good, my love! \u{1F353}',
    'Queen of the board \u{1F451}',
  ];

  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- State ---- */
  let board = emptyBoard();
  let tray = [null, null, null];
  let score = 0;
  let best = 0;
  let inv = { rotate: 0, undo: 0, freeze: 0 };
  let progress = { pts: 0, combos: 0 };
  let frozen = new Uint8Array(CELL_COUNT);
  let freezeHold = false;
  let meta = defaultMeta();       /* volume, theme, nickname, tutorial + item-help flags */
  let hadSave = false;
  let state = 'SPLASH';           /* SPLASH | IDLE | DRAGGING | RESOLVING | GAME_OVER | TUTORIAL */
  const rng = Math.random;

  let cellPx = 40;
  let trayScale = 0.6;
  let liveParticles = 0;
  let displayedScore = 0;
  let scoreAnim = null;

  /* ---- DOM handles ---- */
  const $ = (id) => document.getElementById(id);
  const boardEl = $('board');
  const boardWrap = $('boardWrap');
  const headerEl = document.querySelector('header');
  const scoreRowEl = $('scoreRow');
  const trayEl = $('tray');
  const ghostEl = $('ghost');
  const toastLayer = $('toastLayer');
  const scoreVal = $('scoreVal');
  const bestVal = $('bestVal');
  const comboPill = $('comboPill');
  const splashEl = $('splash');
  const gameOverEl = $('gameOver');
  const confirmEl = $('confirmRestart');
  const glowEl = $('glowPulse');
  const confettiLayer = $('confettiLayer');

  const cellEls = [];
  const slotEls = Array.from(document.querySelectorAll('.slot'));

  /* ---- Sounds: tiny Web Audio chimes, zero assets.
     The context is created lazily inside a user gesture (autoplay policy). ---- */
  const sound = (() => {
    let ctx = null;
    let master = null;
    let muted = false;

    function ensure() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!ctx) {
        try {
          ctx = new AC();
          master = ctx.createGain();
          master.gain.value = 0.22;
          master.connect(ctx.destination);
        } catch (err) { ctx = null; return null; }
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    function note(freq, at, dur, type, vol, slideTo) {
      if (muted) return;
      const c = ensure();
      if (!c) return;
      const t = c.currentTime + at;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type || 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol || 0.5, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(master);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }

    return {
      unlock: () => { ensure(); },
      isMuted: () => muted,
      setMuted: (m) => { muted = m; },
      toggle: () => { muted = !muted; },
      pickup: () => note(520, 0, 0.09, 'triangle', 0.5, 760),
      place: () => { note(300, 0, 0.1, 'triangle', 0.6, 190); note(900, 0, 0.035, 'sine', 0.2); },
      invalid: () => { note(220, 0, 0.09, 'square', 0.16, 180); note(170, 0.09, 0.13, 'square', 0.16, 140); },
      clear: (n) => {
        const run = [523, 659, 784, 1047, 1319];
        const count = Math.min(run.length, 2 + n);
        for (let i = 0; i < count; i++) note(run[i], i * 0.06, 0.22, 'triangle', 0.5);
      },
      bonus: (lizard) => {
        const notes = lizard ? [587, 740, 880, 1175, 1480] : [880, 1109, 1319];
        notes.forEach((f, i) => note(f, i * 0.055, 0.18, 'sine', lizard ? 0.5 : 0.4));
      },
      gameOver: () => { [523, 440, 349, 262].forEach((f, i) => note(f, i * 0.16, 0.34, 'sine', 0.4)); },
      newBest: () => {
        [523, 659, 784, 1047].forEach((f, i) => note(f, i * 0.09, 0.24, 'triangle', 0.55));
        note(1319, 0.36, 0.5, 'triangle', 0.6);
      },
      tap: () => note(660, 0, 0.05, 'sine', 0.25),
    };
  })();

  /* ---- Build the 81 cells once ---- */
  (function buildBoard() {
    const frag = document.createDocumentFragment();
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        const boxParity = (Math.floor(r / 3) + Math.floor(c / 3)) % 2;
        cell.classList.add(boxParity === 0 ? 'tint-a' : 'tint-b');
        if (c === 2 || c === 5) cell.classList.add('b-right');
        if (r === 2 || r === 5) cell.classList.add('b-bottom');
        const ic = document.createElement('span');
        ic.className = 'ic';
        cell.appendChild(ic);
        frag.appendChild(cell);
        cellEls.push(cell);
      }
    }
    boardEl.appendChild(frag);
  })();

  /* ---- Background floaters ---- */
  (function buildFloaters() {
    if (reducedMotion) return;
    const host = $('floaters');
    const chars = ['\u{1F338}', '\u{1F49C}', '✨', '\u{1F338}', '\u{1F49C}', '✨'];
    chars.forEach((ch, i) => {
      const s = document.createElement('span');
      s.textContent = ch;
      s.style.left = (8 + i * 15 + (i % 2) * 4) + '%';
      s.style.top = (10 + ((i * 37) % 70)) + '%';
      s.style.fontSize = (22 + ((i * 5) % 13)) + 'px';
      s.style.animationDuration = (16 + i * 1.7) + 's';
      s.style.animationDelay = (-i * 3.1) + 's';
      host.appendChild(s);
    });
  })();

  /* ---- Layout ---- */
  function relayout() {
    const vw = document.documentElement.clientWidth;
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    /* Size the board to the space the fixed chrome actually leaves, so
       short viewports (landscape browser tab) never clip the tray. */
    const chromeH = headerEl.offsetHeight + scoreRowEl.offsetHeight + trayEl.offsetHeight + 44;
    cellPx = Math.max(24, Math.min(56, Math.floor(Math.min(vw - 16, vh - chromeH) / 9)));
    document.documentElement.style.setProperty('--cell', cellPx + 'px');
    const slotH = slotEls[0] ? slotEls[0].clientHeight : 110;
    trayScale = Math.min(0.6, Math.max(0.3, (slotH - 12) / (5 * cellPx)));
    document.documentElement.style.setProperty('--tray-cell', Math.floor(cellPx * trayScale) + 'px');
  }

  let relayoutTimer = 0;
  function queueRelayout() {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => { relayout(); renderTray(); }, 100);
  }
  window.addEventListener('resize', queueRelayout);
  window.addEventListener('orientationchange', queueRelayout);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', queueRelayout);

  /* ---- Rendering ---- */
  function renderBoard() {
    for (let i = 0; i < CELL_COUNT; i++) paintCell(i, board[i]);
  }

  function paintCell(idx, icon) {
    const cell = cellEls[idx];
    const ic = cell.firstChild;
    cell.classList.remove('preview', 'will-clear', 'clearing', 'flash', 'pop');
    cell.style.animationDelay = '';
    if (icon >= 0) {
      cell.classList.add('filled');
      ic.textContent = ICONS[icon];
    } else {
      cell.classList.remove('filled');
      ic.textContent = '';
    }
  }

  function buildPieceEl(piece, cellSizeVar) {
    const shape = SHAPES[piece.shapeId];
    const el = document.createElement('div');
    el.className = 'piece';
    el.style.gridTemplateColumns = 'repeat(' + shape.w + ', var(' + cellSizeVar + '))';
    el.style.gridTemplateRows = 'repeat(' + shape.h + ', var(' + cellSizeVar + '))';
    const occupied = new Set(shape.cells.map(([r, c]) => r * shape.w + c));
    for (let r = 0; r < shape.h; r++) {
      for (let c = 0; c < shape.w; c++) {
        const d = document.createElement('div');
        if (occupied.has(r * shape.w + c)) {
          d.className = 'pcell';
          const ic = document.createElement('span');
          ic.className = 'ic';
          ic.textContent = ICONS[piece.icon];
          d.appendChild(ic);
        }
        el.appendChild(d);
      }
    }
    return el;
  }

  function renderTray() {
    slotEls.forEach((slot, i) => {
      slot.textContent = '';
      slot.classList.remove('dead');
      const piece = tray[i];
      if (!piece) return;
      slot.appendChild(buildPieceEl(piece, '--tray-cell'));
      if (!fitsSomewhere(board, SHAPES[piece.shapeId])) slot.classList.add('dead');
    });
  }

  function updateScoreDisplay(instant) {
    if (instant) {
      displayedScore = score;
      scoreVal.textContent = String(score);
      bestVal.textContent = String(Math.max(best, score));
      return;
    }
    if (scoreAnim) cancelAnimationFrame(scoreAnim);
    const from = displayedScore;
    const to = score;
    if (from === to) return;
    const t0 = performance.now();
    const dur = 400;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      displayedScore = Math.round(from + (to - from) * k);
      scoreVal.textContent = String(displayedScore);
      if (k < 1) scoreAnim = requestAnimationFrame(step);
    };
    scoreAnim = requestAnimationFrame(step);
    bestVal.textContent = String(Math.max(best, score));
  }

  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  /* ---- Drag and drop ---- */
  const drag = {
    active: false,
    pointerId: -1,
    slot: -1,
    piece: null,
    shape: null,
    boardRect: null,
    ghostW: 0,
    ghostH: 0,
    px: 0,
    py: 0,
    gx: 0,               /* eased ghost position; trails the finger target */
    gy: 0,
    lastT: 0,
    startX: 0,
    startY: 0,
    moved: false,        /* a bare tap must never place a piece */
    anchor: null,        /* {row, col} of last computed anchor */
    valid: false,
    raf: 0,
    previewCells: [],
    willClearCells: [],
  };
  let snapTimer = 0;

  /* Where the ghost WANTS to be: centered on the finger, lifted above it.
     All drop targeting derives from this, never from the lagging ghost. */
  function ghostTargetPos() {
    return {
      x: drag.px - drag.ghostW / 2,
      y: drag.py - drag.ghostH - GHOST_LIFT,
    };
  }

  function onPointerDown(e) {
    if (state !== 'IDLE') return;
    if (e.isPrimary === false) return;
    const slot = slotEls.indexOf(e.currentTarget);
    if (slot === -1) return;
    const piece = tray[slot];
    if (!piece) return;
    e.preventDefault();
    sound.unlock();
    sound.pickup();

    drag.active = true;
    drag.pointerId = e.pointerId;
    drag.slot = slot;
    drag.piece = piece;
    drag.shape = SHAPES[piece.shapeId];
    drag.boardRect = boardEl.getBoundingClientRect();
    drag.px = e.clientX;
    drag.py = e.clientY;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.moved = false;
    drag.anchor = null;
    drag.valid = false;
    state = 'DRAGGING';

    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

    /* A snap-back may still be animating; take the ghost over cleanly. */
    clearTimeout(snapTimer);
    ghostEl.style.transition = '';
    ghostEl.style.opacity = '';
    ghostEl.textContent = '';
    ghostEl.appendChild(buildPieceEl(piece, '--cell'));
    drag.ghostW = drag.shape.w * cellPx;
    drag.ghostH = drag.shape.h * cellPx;
    ghostEl.hidden = false;
    ghostEl.classList.remove('invalid');
    ghostEl.classList.add('picked');
    slotEls[slot].classList.add('lifted');

    /* Seed the follower at the tray slot so the piece flies OUT of it */
    const pieceEl = slotEls[slot].querySelector('.piece');
    const seedRect = (pieceEl || slotEls[slot]).getBoundingClientRect();
    drag.gx = seedRect.left + seedRect.width / 2 - drag.ghostW / 2;
    drag.gy = seedRect.top + seedRect.height / 2 - drag.ghostH / 2;
    drag.lastT = performance.now();
    ghostEl.style.transform = 'translate3d(' + drag.gx + 'px,' + drag.gy + 'px,0)';
    updateTarget();
    drag.raf = requestAnimationFrame(dragLoop);
  }

  /* Exponential follower: the ghost grows out of its tray slot and trails
     the finger with a little weight (settles in ~150ms, never overshoots). */
  function dragLoop(now) {
    if (!drag.active) return;
    const dt = Math.min(32, now - (drag.lastT || now));
    drag.lastT = now;
    const { x, y } = ghostTargetPos();
    const k = 1 - Math.exp(-dt / GHOST_TAU);
    drag.gx += (x - drag.gx) * k;
    drag.gy += (y - drag.gy) * k;
    ghostEl.style.transform = 'translate3d(' + drag.gx + 'px,' + drag.gy + 'px,0)';
    updateTarget();
    drag.raf = requestAnimationFrame(dragLoop);
  }

  /* Snapping math derives from the ghost's TARGET (finger-derived), never
     from the eased ghost itself, so fast flicks land where the finger said. */
  function updateTarget() {
    const { x, y } = ghostTargetPos();
    const col = Math.floor((x + cellPx / 2 - drag.boardRect.left) / cellPx);
    const row = Math.floor((y + cellPx / 2 - drag.boardRect.top) / cellPx);
    if (drag.anchor && drag.anchor.row === row && drag.anchor.col === col) return;
    drag.anchor = { row, col };
    clearTargetHighlights();
    drag.valid = canPlace(board, drag.shape, row, col);
    ghostEl.classList.toggle('invalid', !drag.valid);
    if (!drag.valid) return;

    for (const [dr, dc] of drag.shape.cells) {
      const idx = (row + dr) * N + col + dc;
      const cell = cellEls[idx];
      cell.classList.add('preview');
      cell.firstChild.textContent = ICONS[drag.piece.icon];
      drag.previewCells.push(idx);
    }
    /* Will-clear glow: simulate the placement and reuse the unit scan. */
    const sim = new Int8Array(board);
    for (const [dr, dc] of drag.shape.cells) sim[(row + dr) * N + col + dc] = drag.piece.icon;
    const units = scanUnits(sim);
    for (const u of units) {
      for (const idx of u.cells) {
        cellEls[idx].classList.add('will-clear');
        drag.willClearCells.push(idx);
      }
    }
  }

  function clearTargetHighlights() {
    for (const idx of drag.previewCells) {
      const cell = cellEls[idx];
      cell.classList.remove('preview');
      if (board[idx] === -1) cell.firstChild.textContent = '';
    }
    for (const idx of drag.willClearCells) cellEls[idx].classList.remove('will-clear');
    drag.previewCells = [];
    drag.willClearCells = [];
  }

  function endDrag() {
    drag.active = false;
    cancelAnimationFrame(drag.raf);
    clearTargetHighlights();
    if (drag.slot >= 0 && slotEls[drag.slot]) slotEls[drag.slot].classList.remove('lifted');
  }

  function snapBack() {
    endDrag();
    sound.invalid();
    const slotRect = slotEls[drag.slot].getBoundingClientRect();
    ghostEl.style.transition = 'transform ' + SNAPBACK_MS + 'ms ease, opacity ' + SNAPBACK_MS + 'ms ease';
    ghostEl.style.opacity = '0.3';
    ghostEl.style.transform = 'translate3d(' + (slotRect.left + slotRect.width / 2 - drag.ghostW / 2) + 'px,' +
      (slotRect.top + slotRect.height / 2 - drag.ghostH / 2) + 'px,0) scale(0.6)';
    snapTimer = setTimeout(() => {
      ghostEl.hidden = true;
      ghostEl.style.transition = '';
      ghostEl.style.opacity = '';
      ghostEl.classList.remove('picked');
    }, SNAPBACK_MS);
    state = 'IDLE';
  }

  function onPointerMove(e) {
    if (!drag.active || e.pointerId !== drag.pointerId) return;
    drag.px = e.clientX;
    drag.py = e.clientY;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 10) {
      drag.moved = true;
    }
  }

  function onPointerUp(e) {
    if (!drag.active || e.pointerId !== drag.pointerId) return;
    if (drag.moved && drag.valid && drag.anchor) {
      const { row, col } = drag.anchor;
      endDrag();
      ghostEl.hidden = true;
      ghostEl.classList.remove('picked');
      resolveTurn(drag.slot, row, col);
    } else {
      snapBack();
    }
  }

  function onPointerCancel(e) {
    if (!drag.active || e.pointerId !== drag.pointerId) return;
    snapBack();
  }

  slotEls.forEach((slot) => slot.addEventListener('pointerdown', onPointerDown));
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ---- Turn resolution.
     All game state mutates synchronously up front so autosave is always
     consistent; the DOM catches up during the animation phase. ---- */
  async function resolveTurn(slotIdx, row, col) {
    state = 'RESOLVING';
    const piece = tray[slotIdx];
    const shape = SHAPES[piece.shapeId];

    /* 1. Commit placement */
    const placedIdx = placePiece(board, shape, row, col, piece.icon);
    tray[slotIdx] = null;

    /* 2. Detect ALL full units on the pre-clear snapshot */
    const units = scanUnits(board);
    const n = units.length;
    const bonuses = n ? iconBonuses(board, units) : [];
    const msBonuses = n ? matchingSetBonuses(bonuses) : [];
    const union = unionCells(units);

    /* Capture visuals before mutating further */
    const placedRender = placedIdx.map((idx) => ({ idx, icon: piece.icon }));
    const clearDelays = computeClearDelays(units);
    const bonusCells = new Set();
    for (const b of bonuses) for (const idx of b.cells) bonusCells.add(idx);

    /* 3. Clear the union and apply all scoring */
    for (const idx of union) board[idx] = -1;
    const gained = shape.cells.length + clearScore(n)
      + bonuses.reduce((a, b) => a + b.points, 0)
      + msBonuses.reduce((a, b) => a + b.points, 0);
    score += gained;
    /* Bank the record immediately so a mid-game restart can never lose it. */
    const newBest = score > best;
    if (newBest) best = score;

    /* Item earning (economy in computeEarned; grants clamp at ITEM_CAPS) */
    const perfectCount = bonuses.filter((b) => b.perfect).length;
    const earnResult = computeEarned(progress, { gained, comboN: n, perfectCount });
    progress = earnResult.progress;
    const granted = grantItems(inv, earnResult.earned);

    /* 4. Refill when all three slots are used */
    const refilled = tray.every((p) => p === null);
    if (refilled) tray = genTray(board, rng);

    /* 5. Fit test on the post-clear board */
    const over = isGameOver(board, tray);

    /* ---- DOM phase ---- */
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) { /* ignore */ } }
    sound.place();
    slotEls[slotIdx].textContent = '';
    for (let k = 0; k < placedRender.length; k++) {
      const { idx, icon } = placedRender[k];
      const cell = cellEls[idx];
      cell.classList.add('filled', 'pop');
      cell.firstChild.textContent = ICONS[icon];
      cell.style.animationDelay = (reducedMotion ? 0 : k * POP_STAGGER) + 'ms';
    }
    updateScoreDisplay();

    void granted; /* consumed by the items bar UI in a later milestone */
    if (n > 0) {
      showScoreToast(n, shape.cells.length, bonuses, msBonuses, gained);
      if (bonuses.length) {
        sound.bonus(bonuses.some((b) => b.icon === LIZARD_ICON));
        if (!reducedMotion) {
          for (const idx of bonusCells) cellEls[idx].classList.add('flash');
          await wait(FLASH_MS);
        }
      }
      sound.clear(n);
      for (const idx of union) {
        const cell = cellEls[idx];
        cell.classList.remove('flash', 'pop');
        cell.classList.add('clearing');
        cell.style.animationDelay = (reducedMotion ? 0 : clearDelays.get(idx)) + 'ms';
      }
      spawnParticles(union);
      await wait(reducedMotion ? 160 : CLEAR_WAIT);
      renderBoard();
    } else {
      await wait(POP_MS + placedRender.length * POP_STAGGER);
      for (const idx of placedIdx) {
        cellEls[idx].classList.remove('pop');
        cellEls[idx].style.animationDelay = '';
      }
    }

    renderTray();
    persist();

    if (over) {
      persist();
      await wait(GAMEOVER_DELAY);
      showGameOver(newBest);
    } else {
      state = 'IDLE';
    }
  }

  /* Clear sweep: rows left to right, columns top to bottom, boxes center out.
     Shared cells take the smallest delay of their units. */
  function computeClearDelays(units) {
    const delays = new Map();
    const boxOrder = [4, 1, 3, 5, 7, 0, 2, 6, 8];
    for (const u of units) {
      u.cells.forEach((idx, k) => {
        let rank = k;
        if (u.type === 'box') rank = boxOrder.indexOf(k);
        const d = rank * CLEAR_STAGGER;
        if (!delays.has(idx) || delays.get(idx) > d) delays.set(idx, d);
      });
    }
    return delays;
  }

  function cellCenter(idx) {
    const r = Math.floor(idx / N), c = idx % N;
    return { x: (c + 0.5) * cellPx, y: (r + 0.5) * cellPx };
  }

  function spawnParticles(union) {
    if (reducedMotion) return;
    for (const idx of union) {
      for (let i = 0; i < 2; i++) {
        if (liveParticles >= MAX_PARTICLES) return;
        liveParticles++;
        const p = document.createElement('span');
        p.className = 'particle';
        p.textContent = '✨';
        const { x, y } = cellCenter(idx);
        p.style.left = x + 'px';
        p.style.top = y + 'px';
        p.style.setProperty('--dx', ((rng() * 32 - 16) | 0) + 'px');
        p.style.setProperty('--dy', (-(28 + rng() * 16) | 0) + 'px');
        p.style.animationDelay = (rng() * 120 | 0) + 'ms';
        p.addEventListener('animationend', () => { p.remove(); liveParticles--; });
        $('fxLayer').appendChild(p);
      }
    }
  }

  /* ---- Toasts: slow notifications that float off the top; tap to dismiss ---- */
  const MAX_TOASTS = 3;
  const TOAST_HOLD = 1800;

  function dismissToast(t, fast) {
    if (t.dataset.leaving) return;
    t.dataset.leaving = '1';
    clearTimeout(t._ttl);
    t.classList.add(fast ? 'out-fast' : 'out');
    const done = () => t.remove();
    t.addEventListener('animationend', done, { once: true });
    setTimeout(done, 700); /* safety if animations are disabled */
  }

  function showToast(cls, content, opts) {
    const t = document.createElement('div');
    t.className = 'toast ' + cls;
    if (typeof content === 'string') t.textContent = content;
    else t.appendChild(content);
    t.addEventListener('pointerup', () => {
      if (opts && opts.onTap) opts.onTap();
      dismissToast(t, true);
    });
    const live = Array.from(toastLayer.children).filter((x) => !x.dataset.leaving);
    if (live.length >= MAX_TOASTS) dismissToast(live[0], true);
    toastLayer.appendChild(t);
    t._ttl = setTimeout(() => dismissToast(t, false), (opts && opts.ttl) || TOAST_HOLD);
    return t;
  }

  /* The per-clear score breakdown. Tapping it will open the scoring sheet. */
  function showScoreToast(n, placementPts, bonuses, msBonuses, total) {
    const box = document.createElement('div');
    const row = (label, pts, cls) => {
      const r = document.createElement('div');
      r.className = 't-row' + (cls ? ' ' + cls : '');
      const l = document.createElement('span');
      l.textContent = label;
      const p = document.createElement('span');
      p.className = 'pts';
      p.textContent = '+' + pts;
      r.append(l, p);
      box.appendChild(r);
    };
    if (n >= 2) {
      const head = document.createElement('div');
      head.className = 't-head';
      head.textContent = 'Combo x' + n + '! ' + (n >= 5 ? COMBO_LEGENDARY : COMBO_PHRASES[n]);
      box.appendChild(head);
      comboPill.textContent = 'x' + n + '!';
      comboPill.classList.add('show');
      setTimeout(() => comboPill.classList.remove('show'), 1100);
    }
    row('Placement', placementPts);
    row('Clear x' + n, clearScore(n));
    let lizardHit = false;
    for (const b of bonuses) {
      const label = b.perfect ? 'Perfect Match!' : ICON_LABELS[b.icon].replace('!', '');
      row(ICONS[b.icon] + ' ' + label + ' x' + b.count, b.points);
      if (b.icon === LIZARD_ICON) lizardHit = true;
    }
    for (const ms of msBonuses) {
      row(ICONS[ms.icon] + ' Matching Sets x' + ms.unitCount, ms.points);
      if (ms.icon === LIZARD_ICON) lizardHit = true;
    }
    row('Total', total, 'total');
    if (lizardHit && !reducedMotion) {
      glowEl.hidden = false;
      glowEl.classList.add('pulse');
      setTimeout(() => { glowEl.classList.remove('pulse'); glowEl.hidden = true; }, 520);
    }
    showToast('score-toast', box, { ttl: 2400, onTap: openScoreHelp });
  }

  /* Placeholder until the settings milestone ships the real sheet. */
  let openScoreHelp = () => {};

  /* ---- Overlays ---- */
  function showGameOver(newBest) {
    state = 'GAME_OVER';
    if (newBest) sound.newBest(); else sound.gameOver();
    $('finalScore').textContent = String(score);
    $('finalBest').textContent = String(best);
    $('sweetLine').textContent = SWEET_LINES[(rng() * SWEET_LINES.length) | 0];
    const headline = $('gameOverTitle');
    if (newBest) {
      headline.textContent = 'New Best, ' + PLAYER_NAME + '! \u{1F451}';
      headline.classList.add('gold');
      if (!reducedMotion) confetti();
    } else {
      headline.textContent = 'Game Over';
      headline.classList.remove('gold');
    }
    gameOverEl.hidden = false;
    void gameOverEl.offsetWidth; /* flush styles so the card entrance transition plays */
    gameOverEl.classList.add('show');
  }

  function confetti() {
    const chars = ['\u{1F49C}', '\u{1F338}', '⭐', '\u{1F98E}', '✨'];
    for (let i = 0; i < 30; i++) {
      const s = document.createElement('span');
      s.textContent = chars[(rng() * chars.length) | 0];
      s.style.left = (rng() * 100) + '%';
      s.style.animationDuration = (1.8 + rng() * 0.8) + 's';
      s.style.animationDelay = (rng() * 0.6) + 's';
      s.style.setProperty('--spin', ((rng() * 720 - 360) | 0) + 'deg');
      s.addEventListener('animationend', () => s.remove());
      confettiLayer.appendChild(s);
    }
  }

  function resetGame() {
    freshGameState();
    renderBoard();
    renderTray();
    updateScoreDisplay(true);
    persist();
    gameOverEl.classList.remove('show');
    gameOverEl.hidden = true;
    confirmEl.hidden = true;
    state = 'IDLE';
  }

  $('playAgain').addEventListener('click', () => { sound.tap(); resetGame(); });
  $('restartBtn').addEventListener('click', () => {
    if (state !== 'IDLE') return;
    sound.tap();
    confirmEl.hidden = false;
  });
  $('confirmYes').addEventListener('click', () => { sound.tap(); resetGame(); });
  $('confirmNo').addEventListener('click', () => { sound.tap(); confirmEl.hidden = true; });

  const muteBtn = $('muteBtn');
  function updateMuteBtn() {
    muteBtn.textContent = sound.isMuted() ? '\u{1F507}' : '\u{1F50A}';
    muteBtn.setAttribute('aria-label', sound.isMuted() ? 'Unmute sounds' : 'Mute sounds');
  }
  muteBtn.addEventListener('click', () => {
    sound.toggle();
    updateMuteBtn();
    sound.tap();
    persist();
  });

  splashEl.addEventListener('pointerup', () => {
    if (state !== 'SPLASH') return;
    sound.unlock();
    splashEl.classList.add('gone');
    setTimeout(() => { splashEl.hidden = true; }, 400);
    state = 'IDLE';
  });

  /* ---- Persistence ---- */
  function persist() {
    try {
      if (state === 'TUTORIAL') return; /* tutorial state never touches the save */
      meta.best = best;
      meta.muted = sound.isMuted();
      const over = state === 'GAME_OVER' || isGameOver(board, tray);
      const game = over ? null : encodeGame({ board, tray, score, inv, progress, frozen, freezeHold });
      localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 2, ...meta, game }));
    } catch (err) { /* storage may be unavailable; play on */ }
  }

  function freshGameState() {
    board = emptyBoard();
    score = 0;
    inv = { rotate: 0, undo: 0, freeze: 0 };
    progress = { pts: 0, combos: 0 };
    frozen = new Uint8Array(CELL_COUNT);
    freezeHold = false;
    tray = genTray(board, rng);
  }

  function restore() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (err) { raw = null; }
    hadSave = raw !== null;
    const save = validateSave(raw);
    const { game, ...savedMeta } = save;
    meta = savedMeta;
    best = save.best;
    sound.setMuted(save.muted);
    if (game && !isGameOver(game.board, game.tray)) {
      board = game.board;
      tray = game.tray;
      score = game.score;
      inv = game.inv;
      progress = game.progress;
      frozen = game.frozen;
      freezeHold = game.freezeHold;
      if (tray.every((p) => p === null)) tray = genTray(board, rng);
    } else {
      freshGameState();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (state === 'IDLE' || state === 'RESOLVING') persist();
    } else if (swReg) {
      swReg.update().catch(() => {});
    }
  });

  /* ---- Service worker ---- */
  let swReg = null;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => { swReg = reg; })
      .catch(() => {});
    /* Reload once when an UPDATED worker takes over, never on first install. */
    let hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      if (reloaded) return;
      if (state === 'DRAGGING' || state === 'RESOLVING') return;
      reloaded = true;
      persist();
      location.reload();
    });
  }
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  /* ---- Boot ---- */
  if (IS_BETA) {
    const tag = document.createElement('span');
    tag.className = 'beta-tag';
    tag.textContent = 'BETA';
    $('title').appendChild(tag);
  }

  restore();
  relayout();
  renderBoard();
  renderTray();
  updateScoreDisplay(true);
  updateMuteBtn();
}
