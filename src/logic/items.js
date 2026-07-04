/* Item economy, rotation/flip maps, rotate/flip/reroll/freeze logic. */

import { SHAPES, pickShapeId, pickIcon, isRerollForce1x1, nextAllowedShapeId } from './pieces.js';

/* ---- Items ---- */

/* The canonical item list, in display order. Every per-item structure
   (inventories, caps, help flags, buttons) derives from this so adding an
   item cannot silently miss a site. */
const ITEM_KEYS = ['rotate', 'flip', 'undo', 'freeze', 'reroll'];
const ITEM_CAPS = { rotate: 3, flip: 3, undo: 3, freeze: 3, reroll: 3 };
const zeroInv = () => Object.fromEntries(ITEM_KEYS.map((k) => [k, 0]));
const fillInv = (n) => Object.fromEntries(ITEM_KEYS.map((k) => [k, n]));

/* History panels: how many recent score/streak entries a game keeps. */
const SCORE_LOG_MAX = 6;
const STREAK_LOG_MAX = 12;

/* Economy (per game): rotate 1 per 200 cumulative points; flip 1 per 300
   cumulative points (its own rolling counter, fed by the same gains); undo 1
   per 2 combos; freeze 1 per Perfect Match, 1 per every 2nd combo, and 1 each
   time the streak hits a multiple of 3; reroll 1 per x3+ combo, 1 per Matching
   Sets combo, and 1 each time the streak hits a multiple of 4. fcombos mirrors
   combos as the freeze counter's own tally so undo and freeze pace
   independently. */
function computeEarned(progress, turn) {
  const p = {
    pts: progress.pts + turn.gained,
    flipPts: (progress.flipPts || 0) + turn.gained,
    combos: progress.combos,
    fcombos: progress.fcombos || 0,
  };
  const earned = zeroInv();
  while (p.pts >= 200) { p.pts -= 200; earned.rotate++; }
  while (p.flipPts >= 300) { p.flipPts -= 300; earned.flip++; }
  if (turn.comboN >= 2) { p.combos += 1; p.fcombos += 1; }
  while (p.combos >= 2) { p.combos -= 2; earned.undo++; }
  while (p.fcombos >= 2) { p.fcombos -= 2; earned.freeze++; }
  earned.freeze += turn.perfectCount || 0;
  if (turn.comboN >= 3) earned.reroll++;
  if (turn.msCombo) earned.reroll++;
  const s = turn.streak || 0;
  if (turn.comboN >= 1 && s > 0) {
    if (s % 3 === 0) earned.freeze++;
    if (s % 4 === 0) earned.reroll++;
  }
  return { earned, progress: p };
}

function grantItems(inv, earned) {
  const granted = zeroInv();
  for (const k of Object.keys(granted)) {
    const have = inv[k] || 0;
    const room = Math.max(0, ITEM_CAPS[k] - have);
    granted[k] = Math.min(room, earned[k] || 0);
    inv[k] = have + granted[k];
  }
  return granted;
}

/* Rotation: 90 degrees clockwise, (r,c) -> (c, h-1-r), re-anchored to (0,0).
   The 47-shape set is closed under rotation; ROTATION_MAP proves it at load. */
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

/* Horizontal flip: mirror the columns, (r,c) -> (r, w-1-c), re-anchored to
   (0,0). The 47-shape set is closed under reflection too (L/J ships both
   chiralities, S/Z all four orientations); FLIP_MAP proves it at load. Flip
   is its own inverse, so the map is an involution. */
function flipShapeCells(cells, w) {
  const flip = cells.map(([r, c]) => [r, w - 1 - c]);
  let minR = Infinity, minC = Infinity;
  for (const [r, c] of flip) { minR = Math.min(minR, r); minC = Math.min(minC, c); }
  return flip.map(([r, c]) => [r - minR, c - minC]);
}

const FLIP_MAP = (() => {
  const byKey = new Map(SHAPES.map((s, id) => [shapeKeyOf(s.cells), id]));
  return SHAPES.map((s, id) => {
    const target = byKey.get(shapeKeyOf(flipShapeCells(s.cells, s.w)));
    if (target === undefined) throw new Error('shape ' + id + ' has no mirror in the set');
    return target;
  });
})();

/* Transforming a tray piece (Rotate and Flip share one mechanism; they
   differ only in the orientation map and their field names). Pure decision
   function: given the piece and the item stock, it returns what tapping the
   arrow does, or null when the tap can do nothing (no session and no item).
   One item opens a free session (the cfg.free flag) and remembers the
   pre-transform orientation (cfg.orig); landing back on that start cancels
   the session and refunds the item. Shapes the map fixes never charge.
   Legacy pieces (a free flag without a remembered anchor) keep transforming
   for free but can never cancel: that matches what was already paid, so her
   live save keeps working.

   The two sessions coexist on a piece, but each shape-changing transform
   breaks the OTHER session's cancel anchor: after a rotation the mirror of
   flipOrig is no longer where the piece stands, and after a flip rotOrig has
   left the piece's spin orbit entirely (an L spins among Ls, never back to a
   J). So the transform drops cfg.otherOrig while keeping cfg.otherFree
   (those free transforms were paid for). Both sessions keep working; only
   the refunds close. */
const ROT_SESSION = { map: ROTATION_MAP, free: 'rotFree', orig: 'rotOrig', otherFree: 'flipFree', otherOrig: 'flipOrig', cap: ITEM_CAPS.rotate };
const FLIP_SESSION = { map: FLIP_MAP, free: 'flipFree', orig: 'flipOrig', otherFree: 'rotFree', otherOrig: 'rotOrig', cap: ITEM_CAPS.flip };

function applyTransform(piece, count, cfg) {
  const next = cfg.map[piece.shapeId];
  /* A shape that maps to itself has no distinct orientation: visual only. */
  if (next === piece.shapeId) {
    return { kind: 'symmetric', count, piece };
  }
  if (piece[cfg.free]) {
    /* Landing back on the remembered start cancels the session for a refund. */
    if (piece[cfg.orig] !== undefined && next === piece[cfg.orig]) {
      const rebuilt = { shapeId: next, icon: piece.icon };
      if (piece.frozen) rebuilt.frozen = true;
      if (piece[cfg.otherFree]) rebuilt[cfg.otherFree] = true;
      const refunded = count < cfg.cap;
      return { kind: 'canceled', count: Math.min(cfg.cap, count + 1), piece: rebuilt, refunded };
    }
    /* A plain mid-session move: keep this session's flags as they are. */
    const moved = { ...piece, shapeId: next };
    delete moved[cfg.otherOrig];
    return { kind: 'free', count, piece: moved };
  }
  /* The first transform of this piece needs the item in stock. */
  if (count <= 0) return null;
  const charged = { shapeId: next, icon: piece.icon, [cfg.free]: true, [cfg.orig]: piece.shapeId };
  if (piece.frozen) charged.frozen = true;
  if (piece[cfg.otherFree]) charged[cfg.otherFree] = true;
  return { kind: 'charged', count: count - 1, piece: charged };
}

/* Public wrappers keep the historic result field names. */
function renameCount(res, key) {
  if (!res) return null;
  const { count, ...rest } = res;
  return { ...rest, [key]: count };
}
const applyRotation = (piece, rotateCount) => renameCount(applyTransform(piece, rotateCount, ROT_SESSION), 'rotateCount');
const applyFlip = (piece, flipCount) => renameCount(applyTransform(piece, flipCount, FLIP_SESSION), 'flipCount');

/* Reroll: swap a tray piece for a fresh one of a DIFFERENT shape (icon from the
   same pool). The guard avoids handing back the identical shape; if the rng is
   pathologically stuck it nudges to the next shape id, so a reroll always
   changes something. The nudge cycles inside any active shape filter, so a
   restricted subset can never leak an out-of-set shape (a one-shape subset
   degrades to an icon-only swap). The beta force-1x1 switch short-circuits
   everything but the icon draw. */
function rerollPiece(piece, rng) {
  if (isRerollForce1x1()) return { shapeId: 0, icon: pickIcon(rng) };
  let shapeId = pickShapeId(rng);
  let guard = 0;
  while (shapeId === piece.shapeId && guard++ < 50) shapeId = pickShapeId(rng);
  if (shapeId === piece.shapeId) shapeId = nextAllowedShapeId(shapeId);
  return { shapeId, icon: pickIcon(rng) };
}

/* Rerolling a piece spends one Reroll and refunds any item still riding on the
   old piece: an open rotate or flip session gives the item back, an iced piece
   gives the Freeze back (all clamped to caps). Returns null when there is
   nothing to spend (no piece or no stock); leaves the inputs untouched
   otherwise. */
function applyReroll(piece, inv, rng) {
  if (!piece || (inv.reroll || 0) <= 0) return null;
  const next = { ...inv, reroll: inv.reroll - 1 };
  const refundedRotate = !!piece.rotFree && next.rotate < ITEM_CAPS.rotate;
  if (piece.rotFree) next.rotate = Math.min(ITEM_CAPS.rotate, next.rotate + 1);
  const refundedFlip = !!piece.flipFree && (next.flip || 0) < ITEM_CAPS.flip;
  if (piece.flipFree) next.flip = Math.min(ITEM_CAPS.flip, (next.flip || 0) + 1);
  const refundedFreeze = !!piece.frozen && next.freeze < ITEM_CAPS.freeze;
  if (piece.frozen) next.freeze = Math.min(ITEM_CAPS.freeze, next.freeze + 1);
  return { piece: rerollPiece(piece, rng), inv: next, refundedRotate, refundedFlip, refundedFreeze };
}

/* Decide what a placement does to the freeze system. union is the Set of
   cells in every completed unit (scanUnits runs on the post-placement,
   pre-clear board, so units frozen on earlier turns are re-found); frozen
   is the current frozen mask. A dipped placement that completes units
   freezes them, stacking onto any units already waiting. A dip that
   completes nothing, or only re-finds cells that were already frozen,
   achieved nothing new: the Freeze is handed back AND the placement resolves
   as if the piece was never dipped, so a waiting hold melts like any other
   clear. (Reporting didFreeze for a re-found hold used to keep the hold
   alive for free: refund plus intact stack, an exploit.) */
function freezeOutcome(dipped, freezeHold, union, frozen) {
  const completed = dipped && union.size > 0;
  let addsNew = false;
  if (completed) {
    for (const idx of union) { if (!frozen[idx]) { addsNew = true; break; } }
  }
  const frozeNothingNew = completed && freezeHold && !addsNew;
  const didFreeze = completed && !frozeNothingNew;
  return { didFreeze, frozeNothingNew, freezeRefund: dipped && !didFreeze };
}

export { ITEM_KEYS, ITEM_CAPS, zeroInv, fillInv, SCORE_LOG_MAX, STREAK_LOG_MAX, computeEarned, grantItems, rotateShapeCells, flipShapeCells, shapeKeyOf, ROTATION_MAP, FLIP_MAP, applyRotation, applyFlip, rerollPiece, applyReroll, freezeOutcome };
