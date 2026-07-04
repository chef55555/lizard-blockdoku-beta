/* Score/streak history log entries and undo snapshots. */

import { CELL_COUNT } from './config.js';
import { clearScore } from './scoring.js';

/* Compact 81-char snapshot of a board for a score-log entry: one char per cell
   row-major, '.' for empty and the icon-index digit (0-5) for filled. Built at
   the moment of scoring so the Recent-scores panel can redraw the board exactly
   as it looked when the combo landed. */
function boardToLogString(board) {
  let s = '';
  for (let i = 0; i < CELL_COUNT; i++) s += board[i] < 0 ? '.' : String(board[i]);
  return s;
}

/* One score-toast's worth of breakdown, frozen into a plain record for the
   Recent-scores panel and (later) the toast itself. clear is derived, never a
   free parameter, so a record can never disagree with clearScore(n). The
   optional board/cleared/placed capture the grid at the moment of scoring (board
   AFTER the piece landed, BEFORE the cleared cells were removed) so the panel can
   redraw it; they are added only when a board string is supplied, so older
   callers stay unchanged. Pure: input arrays are copied, never aliased. */
function makeScoreLogEntry(n, placement, bonuses, msBonuses, streakK, streakPts, total, board, cleared, placed) {
  const entry = { n, placement, clear: clearScore(n),
    icons: bonuses.map((b) => ({ icon: b.icon, count: b.count, points: b.points, perfect: b.perfect })),
    ms: msBonuses.map((m) => ({ icon: m.icon, unitCount: m.unitCount, points: m.points })),
    streakK, streakPts, total };
  if (typeof board === 'string') {
    entry.board = board;
    entry.cleared = Array.isArray(cleared) ? cleared.slice() : [];
    entry.placed = Array.isArray(placed) ? placed.slice() : [];
  }
  return entry;
}

/* Append to a capped history list without mutating the input. */
function pushLog(list, entry, cap) {
  const out = list.concat([entry]);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/* Deep copy of a score/streak history pair, tolerant of absent fields. board is
   an immutable string (copied by the spread); cleared/placed are int arrays that
   must be sliced so a snapshot can never alias the live entry's arrays. */
function cloneScoreLog(list) {
  return (list || []).map((e) => {
    const c = {
      ...e,
      icons: (e.icons || []).map((x) => ({ ...x })),
      ms: (e.ms || []).map((x) => ({ ...x })),
    };
    if (Array.isArray(e.cleared)) c.cleared = e.cleared.slice();
    if (Array.isArray(e.placed)) c.placed = e.placed.slice();
    return c;
  });
}
function cloneStreakLog(list) {
  return (list || []).map((e) => ({ ...e }));
}

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
    streak: state.streak,
    scoreLog: cloneScoreLog(state.scoreLog),
    streakLog: cloneStreakLog(state.streakLog),
  };
}

export { boardToLogString, makeScoreLogEntry, pushLog, cloneScoreLog, cloneStreakLog, takeSnapshot };
