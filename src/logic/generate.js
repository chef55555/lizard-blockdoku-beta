/* Piece generation and game-over detection (plain/rotate/item aware). */

import { SHAPES, pickShapeId, pickIcon } from './pieces.js';
import { fitsSomewhere } from './scoring.js';
import { ROTATION_MAP, FLIP_MAP } from './items.js';

function makePiece(rng) {
  return { shapeId: pickShapeId(rng), icon: pickIcon(rng) };
}

/* Fresh tray of 3. Variety rule: never 3 identical shapes in one tray.
   Mercy rule: if none of the 3 fits, regenerate the whole tray (up to 20
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

/* True when this piece could fit in some rotated orientation it can reach:
   free spins cost nothing, otherwise one Rotate in stock unlocks the whole
   orbit. Symmetric shapes have an empty orbit, so they never rescue. */
function rotationRescues(board, piece, rotateCount) {
  if (!piece.rotFree && rotateCount <= 0) return false;
  for (let id = ROTATION_MAP[piece.shapeId]; id !== piece.shapeId; id = ROTATION_MAP[id]) {
    if (fitsSomewhere(board, SHAPES[id])) return true;
  }
  return false;
}

/* True when this piece's mirror would fit and a flip is reachable: an open
   flip session costs nothing, otherwise one Flip in stock buys the mirror.
   Mirror-symmetric shapes never rescue. */
function flipRescues(board, piece, flipCount) {
  if (!piece.flipFree && flipCount <= 0) return false;
  const mirrored = FLIP_MAP[piece.shapeId];
  if (mirrored === piece.shapeId) return false;
  return fitsSomewhere(board, SHAPES[mirrored]);
}

/* True when this piece could fit in ANY orientation its available items can
   reach. One Rotate opens the whole spin orbit, one Flip opens the mirror,
   and together they open the full dihedral orbit (both are session items:
   once charged, further spins/mirrors on that piece are free, so the walk
   may apply each map any number of times). The current orientation is the
   caller's job to fit-test. */
function orientationRescues(board, piece, rotateCount, flipCount) {
  const canRotate = !!piece.rotFree || rotateCount > 0;
  const canFlip = !!piece.flipFree || flipCount > 0;
  if (!canRotate && !canFlip) return false;
  const seen = new Set([piece.shapeId]);
  const queue = [piece.shapeId];
  while (queue.length) {
    const id = queue.pop();
    if (canRotate) {
      const next = ROTATION_MAP[id];
      if (!seen.has(next)) {
        if (fitsSomewhere(board, SHAPES[next])) return true;
        seen.add(next);
        queue.push(next);
      }
    }
    if (canFlip) {
      const next = FLIP_MAP[id];
      if (!seen.has(next)) {
        if (fitsSomewhere(board, SHAPES[next])) return true;
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/* Orientation-aware game over. Not over if any piece fits as-is, if a piece
   with an open session fits in any orientation it can reach, or if a Rotate
   or Flip in stock could open such a session on any one piece. One item
   unlocks a piece's whole reachable orbit, and game over only needs a single
   legal move to be false, so one rescue anywhere is enough. An empty tray is
   never game over. flipCount defaults to 0, which keeps the historic
   rotate-only behavior for old callers. */
function isGameOverWithRotate(board, tray, rotateCount, flipCount = 0) {
  const remaining = tray.filter(Boolean);
  if (remaining.length === 0) return false;
  for (const p of remaining) {
    if (fitsSomewhere(board, SHAPES[p.shapeId])) return false;
    if (orientationRescues(board, p, rotateCount, flipCount)) return false;
  }
  return true;
}

/* Item-aware game over, the full escape-hatch check. A Reroll in stock is
   always a possible way out (the swapped piece might fit, and she deserves
   the chance to try), so a stuck tray only truly ends the game once no
   Reroll is held and no rotation or flip can rescue any piece. */
function isGameOverWithItems(board, tray, rotateCount, rerollCount, flipCount = 0) {
  const remaining = tray.filter(Boolean);
  if (remaining.length === 0) return false;
  if (rerollCount > 0) return false;
  return isGameOverWithRotate(board, tray, rotateCount, flipCount);
}

export { makePiece, genTray, isGameOver, rotationRescues, flipRescues, orientationRescues, isGameOverWithRotate, isGameOverWithItems };
