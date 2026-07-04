/* Item economy, rotation map, rotate/reroll/freeze logic. */

import { SHAPES, pickShapeId, pickIcon } from './pieces.js';

/* ---- Items ---- */

const ITEM_CAPS = { rotate: 3, undo: 3, freeze: 3, reroll: 3 };

/* History panels: how many recent score/streak entries a game keeps. */
const SCORE_LOG_MAX = 6;
const STREAK_LOG_MAX = 12;

/* Economy (per game): rotate 1 per 200 cumulative points; undo 1 per 2 combos;
   freeze 1 per Perfect Match, 1 per every 2nd combo, and 1 each time the streak
   hits a multiple of 3; reroll 1 per x3+ combo, 1 per Matching Sets combo, and
   1 each time the streak hits a multiple of 4. fcombos mirrors combos as the
   freeze counter's own tally so undo and freeze pace independently. */
function computeEarned(progress, turn) {
  const p = { pts: progress.pts + turn.gained, combos: progress.combos, fcombos: progress.fcombos || 0 };
  const earned = { rotate: 0, undo: 0, freeze: 0, reroll: 0 };
  while (p.pts >= 200) { p.pts -= 200; earned.rotate++; }
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
  const granted = { rotate: 0, undo: 0, freeze: 0, reroll: 0 };
  for (const k of Object.keys(granted)) {
    const have = inv[k] || 0;
    const room = Math.max(0, ITEM_CAPS[k] - have);
    granted[k] = Math.min(room, earned[k]);
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

/* Rotating a tray piece. Pure decision function: given the piece and the
   current Rotate stock, it returns what tapping the arrow does, or null when
   the tap can do nothing (no session and no item). One Rotate opens a free
   spin session (rotFree) and remembers the pre-spin orientation (rotOrig);
   spinning all the way back to that start cancels the session and refunds the
   Rotate. Symmetric shapes never charge. Legacy pieces (rotFree without a
   remembered rotOrig) keep spinning for free but can never cancel: that
   matches what was already paid, so her live save keeps working. */
function applyRotation(piece, rotateCount) {
  const next = ROTATION_MAP[piece.shapeId];
  /* A shape that maps to itself has no distinct orientation: spin visual only. */
  if (next === piece.shapeId) {
    return { kind: 'symmetric', rotateCount, piece };
  }
  if (piece.rotFree) {
    /* Landing back on the remembered start cancels the session for a refund. */
    if (piece.rotOrig !== undefined && next === piece.rotOrig) {
      const rebuilt = { shapeId: next, icon: piece.icon };
      if (piece.frozen) rebuilt.frozen = true;
      const refunded = rotateCount < ITEM_CAPS.rotate;
      return {
        kind: 'canceled',
        rotateCount: Math.min(ITEM_CAPS.rotate, rotateCount + 1),
        piece: rebuilt,
        refunded,
      };
    }
    /* A plain mid-session spin: keep rotFree (and rotOrig, if present). */
    return { kind: 'free', rotateCount, piece: { ...piece, shapeId: next } };
  }
  /* The first spin of this piece needs a Rotate in stock. */
  if (rotateCount <= 0) return null;
  const charged = { shapeId: next, icon: piece.icon, rotFree: true, rotOrig: piece.shapeId };
  if (piece.frozen) charged.frozen = true;
  return { kind: 'charged', rotateCount: rotateCount - 1, piece: charged };
}

/* Reroll: swap a tray piece for a fresh one of a DIFFERENT shape (icon from the
   same pool). The guard avoids handing back the identical shape; if the rng is
   pathologically stuck it nudges to the next shape id, so a reroll always
   changes something. */
function rerollPiece(piece, rng) {
  let shapeId = pickShapeId(rng);
  let guard = 0;
  while (shapeId === piece.shapeId && guard++ < 50) shapeId = pickShapeId(rng);
  if (shapeId === piece.shapeId) shapeId = (shapeId + 1) % SHAPES.length;
  return { shapeId, icon: pickIcon(rng) };
}

/* Rerolling a piece spends one Reroll and refunds any item still riding on the
   old piece: an open rotate session gives the Rotate back, an iced piece gives
   the Freeze back (both clamped to caps). Returns null when there is nothing to
   spend (no piece or no stock); leaves the inputs untouched otherwise. */
function applyReroll(piece, inv, rng) {
  if (!piece || (inv.reroll || 0) <= 0) return null;
  const next = { ...inv, reroll: inv.reroll - 1 };
  const refundedRotate = !!piece.rotFree && next.rotate < ITEM_CAPS.rotate;
  if (piece.rotFree) next.rotate = Math.min(ITEM_CAPS.rotate, next.rotate + 1);
  const refundedFreeze = !!piece.frozen && next.freeze < ITEM_CAPS.freeze;
  if (piece.frozen) next.freeze = Math.min(ITEM_CAPS.freeze, next.freeze + 1);
  return { piece: rerollPiece(piece, rng), inv: next, refundedRotate, refundedFreeze };
}

/* Decide what a placement does to the freeze system. union is the Set of
   cells in every completed unit (scanUnits runs on the post-placement,
   pre-clear board, so units frozen on earlier turns are re-found); frozen
   is the current frozen mask. A dipped placement that completes units
   freezes them, stacking onto any units already waiting. A dip that
   completes nothing, or only re-finds cells that were already frozen,
   achieved nothing new and hands the Freeze back. */
function freezeOutcome(dipped, freezeHold, union, frozen) {
  const didFreeze = dipped && union.size > 0;
  let addsNew = false;
  if (didFreeze) {
    for (const idx of union) { if (!frozen[idx]) { addsNew = true; break; } }
  }
  const frozeNothingNew = didFreeze && freezeHold && !addsNew;
  return { didFreeze, frozeNothingNew, freezeRefund: dipped && (!didFreeze || frozeNothingNew) };
}

export { ITEM_CAPS, SCORE_LOG_MAX, STREAK_LOG_MAX, computeEarned, grantItems, rotateShapeCells, shapeKeyOf, ROTATION_MAP, applyRotation, rerollPiece, applyReroll, freezeOutcome };
