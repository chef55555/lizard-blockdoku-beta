/* Piece generation and game-over detection (plain/rotate/item aware). */

import { SHAPES, pickShapeId, pickIcon } from './pieces.js';
import { fitsSomewhere } from './scoring.js';
import { ROTATION_MAP } from './items.js';

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

/* Rotate-aware game over. Not over if any piece fits as-is, if a piece with
   an open free-spin session fits in any of its orientations, or if a Rotate
   in stock could open such a session on any one piece. One Rotate unlocks a
   piece's whole orbit, and game over only needs a single legal move to be
   false, so one rescue anywhere is enough. An empty tray is never game over. */
function isGameOverWithRotate(board, tray, rotateCount) {
  const remaining = tray.filter(Boolean);
  if (remaining.length === 0) return false;
  for (const p of remaining) {
    if (fitsSomewhere(board, SHAPES[p.shapeId])) return false;
    if (rotationRescues(board, p, rotateCount)) return false;
  }
  return true;
}

/* Item-aware game over, the full escape-hatch check. A Reroll in stock is
   always a possible way out (the swapped piece might fit, and she deserves
   the chance to try), so a stuck tray only truly ends the game once no
   Reroll is held and no rotation can rescue any piece. */
function isGameOverWithItems(board, tray, rotateCount, rerollCount) {
  const remaining = tray.filter(Boolean);
  if (remaining.length === 0) return false;
  if (rerollCount > 0) return false;
  return isGameOverWithRotate(board, tray, rotateCount);
}

export { makePiece, genTray, isGameOver, rotationRescues, isGameOverWithRotate, isGameOverWithItems };
