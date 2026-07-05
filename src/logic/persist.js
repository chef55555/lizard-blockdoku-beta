/* Save encode + lenient validation/migration (schema v2). */

import { CELL_COUNT, ICONS, iconSetIds } from './config.js';
import { SHAPES, SHAPE_CLASSES } from './pieces.js';
import { clearScore } from './scoring.js';
import { ITEM_KEYS, ITEM_CAPS, zeroInv, ROTATION_MAP, FLIP_MAP, SCORE_LOG_MAX, STREAK_LOG_MAX } from './items.js';
import { cloneScoreLog, cloneStreakLog } from './history.js';

/* ---- Persistence (schema v2; v1 saves migrate) ---- */

/* Beta action journal: how many recent action lines a save keeps. */
const JOURNAL_MAX = 30;

function defaultMeta() {
  return {
    best: 0,
    muted: false,
    volume: 50,
    theme: 'auto',
    iconSet: 'classic',
    nickname: '',
    nickPrompted: false,
    seenTutorial: false,
    tutorialOffered: false,
    itemHelp: Object.fromEntries(ITEM_KEYS.map((k) => [k, false])),
    /* Beta test-tool switches. null filters mean "no restriction". Production
       never writes or applies these; they still round-trip harmlessly. */
    testTools: { reroll1x1: false, classes: null, icons: null },
    /* Beta action journal: a rolling trace of the last moves for bug reports.
       Production never appends entries; the empty array round-trips. */
    journal: [],
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
      ? {
        shapeId: p.shapeId,
        icon: p.icon,
        ...(p.frozen ? { frozen: true } : {}),
        ...(p.rotFree ? { rotFree: true } : {}),
        ...(p.rotFree && Number.isInteger(p.rotOrig) ? { rotOrig: p.rotOrig } : {}),
        ...(p.flipFree ? { flipFree: true } : {}),
        ...(p.flipFree && Number.isInteger(p.flipOrig) ? { flipOrig: p.flipOrig } : {}),
      }
      : null)),
    score: state.score,
    inv: { ...state.inv },
    progress: { ...state.progress },
    frozen: frozenMaskToList(state.frozen),
    freezeHold: !!state.freezeHold,
    streak: state.streak || 0,
    scoreLog: cloneScoreLog(state.scoreLog),
    streakLog: cloneStreakLog(state.streakLog),
  };
}

const clampInt = (v, lo, hi, fallback) =>
  (Number.isInteger(v) && v >= lo && v <= hi) ? v : fallback;

/* Strip angle brackets, control, and zero-width characters; collapse
   whitespace; cap at 16 code units. Shared by the save validator and the
   settings nickname input so both always agree. */
function sanitizeNickname(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[<>\u0000-\u001F\u007F-\u009F\u200B-\u200F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

/* An array of cell indexes (ints 0-80), capped at CELL_COUNT entries. Returns
   null on any non-array or any out-of-range/non-integer member so the caller can
   drop the whole (cosmetic) diagram rather than render a broken one. */
function sanitizeCellList(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const v of arr.slice(0, CELL_COUNT)) {
    if (!Number.isInteger(v) || v < 0 || v >= CELL_COUNT) return null;
    out.push(v);
  }
  return out;
}

/* The optional board-diagram trio on a score entry (board/cleared/placed). It is
   validated LENIENTLY and as a unit: board must be exactly CELL_COUNT chars each
   '.' or '0'-'5', cleared/placed valid cell lists. Any fault returns null and the
   caller strips all three while KEEPING the entry, so a v2.2 entry with no board
   still renders (just without a diagram). Never throws. */
function sanitizeBoardDiagram(e) {
  const b = e.board;
  if (typeof b !== 'string' || b.length !== CELL_COUNT) return null;
  for (let i = 0; i < b.length; i++) {
    const ch = b[i];
    if (ch !== '.' && (ch < '0' || ch > '5')) return null;
  }
  const cleared = sanitizeCellList(e.cleared);
  if (cleared === null) return null;
  const placed = sanitizeCellList(e.placed);
  if (placed === null) return null;
  return { board: b, cleared, placed };
}

/* Score/streak history are cosmetic panels only. They are validated LENIENTLY:
   a bad ENTRY is dropped and its siblings kept, garbage becomes [], and no path
   here ever throws or discards the game. clear is always recomputed from n, so a
   tampered disk value can never show a wrong Clear line. */
function sanitizeScoreLog(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const n = clampInt(e.n, 1, 50, null);
    if (n === null) continue;
    const placement = clampInt(e.placement, 0, 25, null);
    if (placement === null) continue;
    const streakK = clampInt(e.streakK, 0, 999, null);
    if (streakK === null) continue;
    const streakPts = clampInt(e.streakPts, 0, 99999, null);
    if (streakPts === null) continue;
    const total = clampInt(e.total, 0, 999999, null);
    if (total === null) continue;
    const icons = [];
    if (Array.isArray(e.icons)) {
      for (const b of e.icons.slice(0, 64)) {
        if (!b || typeof b !== 'object') continue;
        if (!Number.isInteger(b.icon) || b.icon < 0 || b.icon >= ICONS.length) continue;
        const count = clampInt(b.count, 3, 9, null);
        if (count === null) continue;
        const points = clampInt(b.points, 0, 99999, null);
        if (points === null) continue;
        icons.push({ icon: b.icon, count, points, perfect: b.perfect === true });
      }
    }
    const ms = [];
    if (Array.isArray(e.ms)) {
      for (const m of e.ms.slice(0, 64)) {
        if (!m || typeof m !== 'object') continue;
        if (!Number.isInteger(m.icon) || m.icon < 0 || m.icon >= ICONS.length) continue;
        const unitCount = clampInt(m.unitCount, 2, 50, null);
        if (unitCount === null) continue;
        const points = clampInt(m.points, 0, 99999, null);
        if (points === null) continue;
        ms.push({ icon: m.icon, unitCount, points });
      }
    }
    const entry = { n, placement, clear: clearScore(n), icons, ms, streakK, streakPts, total };
    const diagram = sanitizeBoardDiagram(e);
    if (diagram) {
      entry.board = diagram.board;
      entry.cleared = diagram.cleared;
      entry.placed = diagram.placed;
    }
    out.push(entry);
  }
  return out.slice(-SCORE_LOG_MAX);
}

function sanitizeStreakLog(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const n = clampInt(e.n, 1, 50, null);
    if (n === null) continue;
    const gained = clampInt(e.gained, 0, 999999, null);
    if (gained === null) continue;
    out.push({ n, gained });
  }
  return out.slice(-STREAK_LOG_MAX);
}

/* One tray piece from an untrusted save. Throws on any fault (validateSave's
   try discards the whole game); a stale-but-harmless flag is scrubbed
   instead of thrown so a live save keeps working across migrations. This is
   the block that grows with every new per-piece item flag: keep it here. */
function validatePiece(p) {
  if (p === null) return null;
  if (!p || typeof p !== 'object') throw new Error('bad piece');
  if (!Number.isInteger(p.shapeId) || p.shapeId < 0 || p.shapeId >= SHAPES.length) throw new Error('bad shape');
  if (!Number.isInteger(p.icon) || p.icon < 0 || p.icon >= ICONS.length) throw new Error('bad icon');
  const piece = { shapeId: p.shapeId, icon: p.icon };
  if (p.frozen === true) piece.frozen = true;
  else if (p.frozen !== undefined && p.frozen !== false) throw new Error('bad frozen flag');
  if (p.rotFree === true) {
    /* rotFree only means something on a shape that can actually rotate; on
       a symmetric shape it is silently scrubbed (live-save migration). */
    if (ROTATION_MAP[p.shapeId] !== p.shapeId) piece.rotFree = true;
  } else if (p.rotFree !== undefined && p.rotFree !== false) {
    throw new Error('bad rotFree flag');
  }
  /* rotOrig is the pre-session orientation remembered for cancel. Accept it
     only alongside a live rotFree session, only as a real integer in this
     piece's rotation orbit, and only a DIFFERENT orientation than now.
     rotOrig without an active session is silently dropped. */
  if (p.rotOrig !== undefined && piece.rotFree) {
    if (!Number.isInteger(p.rotOrig) || p.rotOrig < 0 || p.rotOrig >= SHAPES.length) throw new Error('bad rotOrig');
    if (p.rotOrig === p.shapeId) throw new Error('rotOrig equals shapeId');
    let x = ROTATION_MAP[p.shapeId];
    let inOrbit = false;
    for (let k = 0; k < 4 && x !== p.shapeId; k++) {
      if (x === p.rotOrig) { inOrbit = true; break; }
      x = ROTATION_MAP[x];
    }
    if (!inOrbit) throw new Error('rotOrig out of orbit');
    piece.rotOrig = p.rotOrig;
  }
  /* Flip session flags mirror the rotate pair. flipFree survives as long
     as the flip is usable ANYWHERE in the piece's spin orbit: a rotation
     legitimately parks an open flip session on a mirror-symmetric
     orientation (T4/T5/U5 orbits mix both kinds), and scrubbing there
     would delete a paid session on reload. Only a fully mirror-symmetric
     orbit (lines, squares...) scrubs. flipOrig is accepted only alongside
     a live session and only as the exact mirror of the current shape
     (flip is period two, so the orbit is just that pair). */
  if (p.flipFree === true) {
    let usable = FLIP_MAP[p.shapeId] !== p.shapeId;
    for (let x = ROTATION_MAP[p.shapeId]; !usable && x !== p.shapeId; x = ROTATION_MAP[x]) {
      if (FLIP_MAP[x] !== x) usable = true;
    }
    if (usable) piece.flipFree = true;
  } else if (p.flipFree !== undefined && p.flipFree !== false) {
    throw new Error('bad flipFree flag');
  }
  if (p.flipOrig !== undefined && piece.flipFree) {
    if (!Number.isInteger(p.flipOrig) || p.flipOrig < 0 || p.flipOrig >= SHAPES.length) throw new Error('bad flipOrig');
    if (p.flipOrig !== FLIP_MAP[p.shapeId]) throw new Error('flipOrig is not the mirror');
    piece.flipOrig = p.flipOrig;
  }
  return piece;
}

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
  out.iconSet = iconSetIds().includes(raw.iconSet) ? raw.iconSet : 'classic';
  out.nickname = sanitizeNickname(raw.nickname);
  out.nickPrompted = raw.nickPrompted === true;
  out.seenTutorial = raw.seenTutorial === true;
  out.tutorialOffered = raw.tutorialOffered === true;
  const ih = raw.itemHelp;
  if (ih && typeof ih === 'object') {
    out.itemHelp = Object.fromEntries(ITEM_KEYS.map((k) => [k, ih[k] === true]));
  }
  /* Beta test tools: reroll1x1 a strict bool; class/icon lists deduped and
     range-checked, with an empty or complete selection collapsing to null
     (no filter) so stale saves can never half-restrict generation. */
  const tt = raw.testTools;
  if (tt && typeof tt === 'object') {
    out.testTools.reroll1x1 = tt.reroll1x1 === true;
    if (Array.isArray(tt.classes)) {
      const cls = [...new Set(tt.classes.filter((v) => Number.isInteger(v) && v >= 0 && v < SHAPE_CLASSES.length))].sort((a, b) => a - b);
      if (cls.length > 0 && cls.length < SHAPE_CLASSES.length) out.testTools.classes = cls;
    }
    if (Array.isArray(tt.icons)) {
      const ics = [...new Set(tt.icons.filter((v) => Number.isInteger(v) && v >= 0 && v < ICONS.length))].sort((a, b) => a - b);
      if (ics.length > 0 && ics.length < ICONS.length) out.testTools.icons = ics;
    }
  }
  /* Journal lines are plain strings for humans; anything else is dropped,
     lengths are capped, and only the newest JOURNAL_MAX entries survive. */
  if (Array.isArray(raw.journal)) {
    for (const e of raw.journal.slice(-JOURNAL_MAX)) {
      if (typeof e === 'string' && e.length > 0 && e.length <= 160) out.journal.push(e);
    }
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
    const tray = g.tray.map(validatePiece);
    if (typeof g.score !== 'number' || !isFinite(g.score) || g.score < 0) return out;

    /* v2 fields; absent (v1 game) means defaults */
    const inv = zeroInv();
    if (g.inv !== undefined) {
      if (!g.inv || typeof g.inv !== 'object') return out;
      for (const k of Object.keys(inv)) {
        if (g.inv[k] !== undefined && !Number.isInteger(g.inv[k])) return out;
        inv[k] = Math.max(0, Math.min(ITEM_CAPS[k], g.inv[k] || 0));
      }
    }
    const progress = { pts: 0, flipPts: 0, combos: 0, fcombos: 0 };
    if (g.progress !== undefined) {
      if (!g.progress || typeof g.progress !== 'object') return out;
      progress.pts = clampInt(g.progress.pts, 0, 199, 0);
      progress.flipPts = clampInt(g.progress.flipPts, 0, 299, 0);
      progress.combos = clampInt(g.progress.combos, 0, 1, 0);
      progress.fcombos = clampInt(g.progress.fcombos, 0, 1, 0);
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
    /* The engine keeps mask and hold in lockstep; orphan ice without a hold
       (tampered save) would never melt and would confuse freezeOutcome, so
       it is scrubbed rather than trusted. */
    if (!freezeHold) frozen.fill(0);

    /* A legit monster streak saturates at the cap instead of resetting. */
    const streak = Math.min(999, clampInt(g.streak, 0, Number.MAX_SAFE_INTEGER, 0));
    const scoreLog = sanitizeScoreLog(g.scoreLog);
    const streakLog = streak > 0 ? sanitizeStreakLog(g.streakLog) : [];

    out.game = { board, tray, score: Math.floor(g.score), inv, progress, frozen, freezeHold, streak, scoreLog, streakLog };
    return out;
  } catch (e) {
    return out;
  }
}


export { JOURNAL_MAX, defaultMeta, frozenMaskToList, encodeGame, clampInt, sanitizeNickname, sanitizeCellList, sanitizeBoardDiagram, sanitizeScoreLog, sanitizeStreakLog, validateSave };
