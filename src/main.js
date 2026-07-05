/* Browser entry: boot sequence + the full UI (initUI), moved verbatim.
   The logic names below are re-bound from the barrel so initUI's body is
   unchanged. See the refactor plan for the module map. */
import * as L from './logic/index.js';
import { idb, MIRROR_KEYS, preloadFromIdb, mirrorAllToIdb } from './idb.js';
import { RELEASE_NOTES } from './release-notes.js';

const {
  PLAYER_NAME, IS_BETA, SAVE_KEY, APP_VERSION, APP_BUILD, LEADERBOARD_URL,
  LB_KEY, BETA_LB_SUBMITS, BETA_STARTER_ITEMS, ICONS, ICON_LABELS,
  LIZARD_ICON, N, CELL_COUNT, SHAPES, emptyBoard, canPlace, fitsSomewhere,
  placePiece, scanUnits, unionCells, clearScore, streakBonus,
  iconBonuses, matchingSetBonuses, ITEM_CAPS,
  SCORE_LOG_MAX, STREAK_LOG_MAX, computeEarned, grantItems, ROTATION_MAP,
  FLIP_MAP, applyRotation, applyFlip, applyReroll, freezeOutcome, boardToLogString,
  makeScoreLogEntry, pushLog, takeSnapshot, genTray, isGameOver,
  rotationRescues, flipRescues, isGameOverWithRotate, isGameOverWithItems, defaultMeta,
  encodeGame, sanitizeNickname, validateSave,
  SCENARIOS, buildScenario, SHAPE_CLASS_META,
  setShapeClassFilter, setIconFilter, setRerollForce1x1,
  JOURNAL_MAX, zeroInv, fillInv,
} = L;

/* ================================================================
   Browser UI
   ================================================================ */

if (typeof document !== 'undefined') {
  let saveMissing = false;
  try { saveMissing = localStorage.getItem(SAVE_KEY) === null; } catch (err) { /* ignore */ }
  if (saveMissing) {
    /* Nothing local: give the IDB backup a beat to rehydrate localStorage,
       but never let a hung IDB block boot. */
    const grace = new Promise((res) => setTimeout(res, 600));
    Promise.race([preloadFromIdb(), grace]).then(initUI, initUI);
  } else {
    preloadFromIdb(); /* background gap-fill for the lb keys only */
    initUI();
  }
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
  /* Brief ease-out at pickup so the piece flows out of its tray slot instead
     of teleporting; after this the ghost sits exactly on the finger target. */
  const PICKUP_BLEND_MS = 90;
  const BADGE_STAGGER = 120;
  const MAX_PARTICLES = 36;
  /* Celebration wait, fx clone cap, and impact all escalate with the tier. */
  const CELEBRATE_WAIT = { 2: 750, 3: 950, 4: 1400 };
  const FX_CAP = { 2: 30, 3: 42, 4: 54 };
  /* Perfect Match flourish: per-icon duration (only used to time the safety
     sweep) and how many perfect units get their own flourish in one clear. */
  const PERFECT_MS = [2200, 2100, 2200, 1000, 1500, 2200]; /* by icon index */
  const PERFECT_UNIT_CAP = 3;

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
  let inv = zeroInv();
  let progress = { pts: 0, flipPts: 0, combos: 0, fcombos: 0 };
  let frozen = new Uint8Array(CELL_COUNT);
  let freezeHold = false;
  let streak = 0;                 /* consecutive clearing placements */
  let scoreLog = [];              /* recent per-clear breakdowns (newest last) */
  let streakLog = [];             /* per-clear rows for the live streak, reset when it cools */
  let meta = defaultMeta();       /* volume, theme, nickname, tutorial + item-help flags */
  let undoSnapshot = null;        /* one level, in-memory only; gone after reload */
  let tutorial = null;            /* { step, stash } while the tutorial runs */
  let hadSave = false;
  let state = 'SPLASH';           /* SPLASH | IDLE | DRAGGING | RESOLVING | GAME_OVER */
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
  const itemsBarEl = $('itemsBar');
  const ghostEl = $('ghost');
  const toastLayer = $('toastLayer');
  const scoreVal = $('scoreVal');
  const bestVal = $('bestVal');
  const streakPill = $('streakPill');
  const splashEl = $('splash');
  const gameOverEl = $('gameOver');
  const confirmEl = $('confirmRestart');
  const glowEl = $('glowPulse');
  const confettiLayer = $('confettiLayer');
  const perfectLayer = $('perfectLayer');

  const cellEls = [];
  const slotEls = Array.from(document.querySelectorAll('.slot'));

  /* ---- Sounds: tiny Web Audio chimes, zero assets.
     The context is created lazily inside a user gesture (autoplay policy). ---- */
  const sound = (() => {
    let ctx = null;
    let master = null;
    let muted = false;
    let volume = 50;   /* 0..100; 50 = the original fixed gain of 0.22 */

    const masterGain = () => 0.44 * (volume / 100);

    function ensure() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!ctx) {
        try {
          ctx = new AC();
          master = ctx.createGain();
          master.gain.value = masterGain();
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
      setVolume: (v) => {
        volume = Math.max(0, Math.min(100, v));
        if (master) master.gain.value = masterGain();
      },
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
      rotate: () => { note(500, 0, 0.06, 'triangle', 0.4, 900); note(700, 0.05, 0.08, 'triangle', 0.35, 1100); },
      undo: () => { note(720, 0, 0.07, 'triangle', 0.4, 480); note(480, 0.06, 0.09, 'triangle', 0.35, 320); },
      freeze: () => { note(1400, 0, 0.08, 'sine', 0.35); note(1100, 0.06, 0.1, 'sine', 0.3); note(880, 0.13, 0.14, 'sine', 0.25); },
      bubbles: () => { [1250, 980, 760, 610].forEach((f, i) => note(f, i * 0.07, 0.11, 'sine', 0.3, f * 1.4)); },
      perfect: () => { [784, 988, 1319, 1568].forEach((f, i) => note(f, i * 0.06, 0.28, 'sine', 0.35, f * 1.5)); },
      fanfare: () => {
        [523, 659, 784, 1047].forEach((f, i) => note(f, i * 0.09, 0.2, 'triangle', 0.5));
        [659, 784, 1319].forEach((f) => note(f, 0.42, 0.55, 'triangle', 0.35));
      },
      impact: (tier) => {
        note(160, 0, 0.22, 'sine', 0.7, 60);
        note(80, 0.02, 0.35, 'triangle', 0.5, 50);
        if (tier >= 3) note(55, 0.06, 0.5, 'sine', 0.65, 40);
        if (tier >= 4) {
          note(45, 0.12, 0.7, 'sine', 0.7, 34);
          note(1568, 0.15, 0.4, 'sine', 0.22, 2093);
        }
      },
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
    const chromeH = headerEl.offsetHeight + scoreRowEl.offsetHeight + itemsBarEl.offsetHeight + trayEl.offsetHeight + 44;
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
    cell.classList.remove('preview', 'will-clear', 'will-bonus', 'clearing', 'flash', 'pop', 'fade-fast');
    cell.style.animationDelay = '';
    cell.classList.toggle('frozen', icon >= 0 && !!frozen[idx]);
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
    if (piece.frozen) el.classList.add('dipped');
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
    const fits = tray.map((p) => !!p && fitsSomewhere(board, SHAPES[p.shapeId]));
    const plainStuck = tray.some(Boolean) && !fits.some(Boolean);
    slotEls.forEach((slot, i) => {
      slot.textContent = '';
      slot.classList.remove('dead');
      const piece = tray[i];
      if (!piece) return;
      slot.appendChild(buildPieceEl(piece, '--tray-cell'));
      /* Symmetric shapes have nothing to transform, so no arrow. When a
         transform is the only move left, the arrow pulses to point the way. */
      if ((inv.rotate > 0 || piece.rotFree) && ROTATION_MAP[piece.shapeId] !== piece.shapeId) {
        const rescue = plainStuck && rotationRescues(board, piece, inv.rotate);
        slot.appendChild(buildXformBtn(i, 'rotate', piece.rotFree, rescue));
      }
      if ((inv.flip > 0 || piece.flipFree) && FLIP_MAP[piece.shapeId] !== piece.shapeId) {
        const rescue = plainStuck && flipRescues(board, piece, inv.flip);
        slot.appendChild(buildXformBtn(i, 'flip', piece.flipFree, rescue));
      }
      if (!fits[i]) slot.classList.add('dead');
    });
  }

  /* The two transform items share one per-slot button and tap flow; they
     differ only in glyph, animation, and which session they drive. */
  const XFORM = {
    rotate: { btnClass: 'rot-btn', glyph: '⟳', anim: 'spin', invKey: 'rotate', apply: applyRotation, countKey: 'rotateCount', label: 'Rotate' },
    flip: { btnClass: 'flip-btn', glyph: '⇄', anim: 'mirror', invKey: 'flip', apply: applyFlip, countKey: 'flipCount', label: 'Flip' },
  };

  /* Per-slot transform button. Its pointerdown never reaches the slot, so
     tapping it can never begin a drag. */
  function buildXformBtn(i, kind, free, rescue) {
    const cfg = XFORM[kind];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cfg.btnClass + (free ? ' free' : '') + (rescue ? ' rescue' : '');
    b.textContent = cfg.glyph;
    b.setAttribute('aria-label', cfg.label + ' this piece' + (free ? ' (free)' : ''));
    b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
    b.addEventListener('pointerup', (e) => { e.stopPropagation(); transformSlot(i, kind); });
    return b;
  }

  /* One item buys unlimited transforms of that piece until it is placed;
     taking it all the way back to the start cancels the session and refunds
     the item. The flags ride on the piece, so they survive saves and undo. */
  function transformSlot(i, kind) {
    if (state !== 'IDLE') return;
    const cfg = XFORM[kind];
    const piece = tray[i];
    if (!piece) return;
    const res = cfg.apply(piece, inv[cfg.invKey]);
    if (!res) return;
    sound.rotate();
    if (res.kind === 'symmetric') {
      /* Nothing to transform; just a playful little wiggle, no state change. */
      const el = slotEls[i].querySelector('.piece');
      if (el && !reducedMotion) { el.classList.remove(cfg.anim); void el.offsetWidth; el.classList.add(cfg.anim); }
      return;
    }
    inv[cfg.invKey] = res[cfg.countKey];
    tray[i] = res.piece;
    logAction(kind + ' s' + i + ' #' + piece.shapeId + '->' + res.piece.shapeId + ' ' + res.kind);
    if (res.kind === 'canceled') {
      showToast('item-toast', cfg.glyph + ' Back where it started' + (res.refunded ? ', ' + cfg.label + ' returned!' : '!'));
    }
    renderTray();
    updateItemsBar();
    const el = slotEls[i].querySelector('.piece');
    if (el && !reducedMotion) el.classList.add(cfg.anim);
    persist();
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

  /* The streak pill sits in the score row and stays lit while streak >= 2,
     bouncing (punch) each time it climbs. Cleared below 2, it fades out. */
  function updateStreakPill(punch) {
    if (streak >= 2) {
      streakPill.textContent = '';
      const fire = document.createElement('span');
      fire.className = 'fire';
      fire.textContent = '\u{1F525}';
      streakPill.append(fire, document.createTextNode(' x' + streak));
      streakPill.classList.add('show');
      if (punch && !reducedMotion) {
        streakPill.classList.remove('punch');
        void streakPill.offsetWidth;
        streakPill.classList.add('punch');
      }
    } else {
      streakPill.classList.remove('show', 'punch');
      streakPill.textContent = '';
    }
  }

  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  /* Beta action journal: a rolling trace of the last moves, persisted in
     meta (each action site already calls persist) so a bug report written
     even after a reload still shows the fatal sequence. Production never
     appends; the tutorial's sandbox moves are skipped too. */
  function logAction(text) {
    if (!IS_BETA || tutorial) return;
    const t = new Date();
    const stamp = String(t.getHours()).padStart(2, '0') + ':'
      + String(t.getMinutes()).padStart(2, '0') + ':'
      + String(t.getSeconds()).padStart(2, '0');
    meta.journal = pushLog(meta.journal || [], stamp + ' ' + text, JOURNAL_MAX);
  }

  /* Everything a bug report needs in one paste-able JSON blob: the build,
     the environment, the test switches, the recent action trace, the live
     game, and the state as it stood before the last move (the undo
     snapshot). Loadable from the test panel via validateSave. */
  function buildBugReport() {
    return JSON.stringify({
      type: 'lizard-blockdoku-bug-report',
      version: APP_VERSION,
      build: APP_BUILD,
      channel: IS_BETA ? 'beta' : 'prod',
      time: new Date().toISOString(),
      ua: navigator.userAgent,
      uiState: state,
      testTools: meta.testTools,
      journal: (meta.journal || []).slice(),
      game: encodeGame({ board, tray, score, inv, progress, frozen, freezeHold, streak, scoreLog, streakLog }),
      beforeLastMove: undoSnapshot ? encodeGame(undoSnapshot) : null,
    });
  }

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
    gx: 0,               /* ghost position; blends from the slot seed to target */
    gy: 0,
    seedX: 0,            /* tray-slot origin the pickup blend eases out of */
    seedY: 0,
    startT: 0,           /* pickup timestamp; drives the ease-out blend */
    startX: 0,
    startY: 0,
    moved: false,        /* a bare tap must never place a piece */
    anchor: null,        /* {row, col} of last computed anchor */
    valid: false,
    raf: 0,
    previewCells: [],
    willClearCells: [],
    willBonusCells: [],
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
    if (freezeArming) { dipPiece(slot); return; }
    if (rerollArming) { doReroll(slot); return; }
    if (tutorial) {
      const gate = TUT[tutorial.step].allowPickup;
      if (gate && !gate(slot)) return;
    }
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
    /* Retrigger the pop even if a snapback of this ghost is still animating. */
    ghostEl.classList.remove('picked');
    void ghostEl.offsetWidth;
    ghostEl.classList.add('picked');
    slotEls[slot].classList.add('lifted');

    /* Seed the follower at the tray slot so the piece flies OUT of it */
    const pieceEl = slotEls[slot].querySelector('.piece');
    const seedRect = (pieceEl || slotEls[slot]).getBoundingClientRect();
    drag.gx = seedRect.left + seedRect.width / 2 - drag.ghostW / 2;
    drag.gy = seedRect.top + seedRect.height / 2 - drag.ghostH / 2;
    drag.seedX = drag.gx;
    drag.seedY = drag.gy;
    drag.startT = performance.now();
    ghostEl.style.transform = 'translate3d(' + drag.gx + 'px,' + drag.gy + 'px,0)';
    updateTarget();
    drag.raf = requestAnimationFrame(dragLoop);
  }

  /* The ghost tracks the finger exactly. A brief ease-out blend at pickup
     lets the piece flow out of its tray slot instead of teleporting; after
     PICKUP_BLEND_MS it sits precisely on the finger target every frame. */
  function dragLoop(now) {
    if (!drag.active) return;
    const { x, y } = ghostTargetPos();
    const p = reducedMotion ? 1 : Math.min(1, (now - drag.startT) / PICKUP_BLEND_MS);
    const k = 1 - (1 - p) * (1 - p);
    drag.gx = drag.seedX + (x - drag.seedX) * k;
    drag.gy = drag.seedY + (y - drag.seedY) * k;
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
    /* Will-clear glow: simulate the placement and reuse the unit scan. A
       DIPPED piece freezes what it completes instead of clearing it, so its
       preview goes icy and shows no bonus rings (bonuses pay at the melt). */
    const sim = new Int8Array(board);
    for (const [dr, dc] of drag.shape.cells) sim[(row + dr) * N + col + dc] = drag.piece.icon;
    const units = scanUnits(sim);
    const unitClass = drag.piece.frozen ? 'will-freeze' : 'will-clear';
    for (const u of units) {
      for (const idx of u.cells) {
        cellEls[idx].classList.add(unitClass);
        drag.willClearCells.push(idx);
      }
    }
    /* Gold ring on the cells that would pay an icon bonus */
    if (units.length && !drag.piece.frozen) {
      for (const b of iconBonuses(sim, units)) {
        for (const idx of b.cells) {
          cellEls[idx].classList.add('will-bonus');
          drag.willBonusCells.push(idx);
        }
      }
    }
  }

  function clearTargetHighlights() {
    for (const idx of drag.previewCells) {
      const cell = cellEls[idx];
      cell.classList.remove('preview');
      if (board[idx] === -1) cell.firstChild.textContent = '';
    }
    for (const idx of drag.willClearCells) cellEls[idx].classList.remove('will-clear', 'will-freeze');
    for (const idx of drag.willBonusCells) cellEls[idx].classList.remove('will-bonus');
    drag.previewCells = [];
    drag.willClearCells = [];
    drag.willBonusCells = [];
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
    /* Resolve the drop cell HERE, synchronously with the pointer, not only in
       the rAF ghost loop. Safari can throttle requestAnimationFrame, and iOS
       shifts the board mid-drag when the address bar hides, so a rAF-driven
       anchor can be stale at release: pieces land in the wrong cell, or fail
       to place at all. Re-reading the board rect each move also keeps the
       mapping correct while the viewport moves. */
    drag.boardRect = boardEl.getBoundingClientRect();
    updateTarget();
  }

  function onPointerUp(e) {
    if (!drag.active || e.pointerId !== drag.pointerId) return;
    if (drag.moved && drag.valid && drag.anchor) {
      const { row, col } = drag.anchor;
      if (tutorial) {
        const gate = TUT[tutorial.step].allowDrop;
        if (gate && !gate(row, col)) { snapBack(); return; }
      }
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
  /* The shared force-melt for a game that is about to end: score the frozen
     units as one combo, clear them, and reset the freeze system. Mutates the
     live state; the caller re-runs the fit test (the freed space can rescue
     the game) and drives the visuals from the returned melt object. */
  function forceMeltAtGameOver() {
    const mUnits = scanUnits(board);
    const mBonuses = iconBonuses(board, mUnits);
    const mMs = matchingSetBonuses(mBonuses);
    const melt = {
      n: mUnits.length,
      union: unionCells(mUnits),
      delays: computeClearDelays(mUnits),
      gained: clearScore(mUnits.length)
        + mBonuses.reduce((a, b) => a + b.points, 0)
        + mMs.reduce((a, b) => a + b.points, 0),
      newBest: false,
    };
    for (const idx of melt.union) board[idx] = -1;
    frozen = new Uint8Array(CELL_COUNT);
    freezeHold = false;
    score += melt.gained;
    if (score > best) { best = score; melt.newBest = true; }
    const meltEarn = computeEarned(progress, {
      gained: melt.gained,
      comboN: melt.n,
      perfectCount: mBonuses.filter((b) => b.perfect).length,
      streak: 0,
      msCombo: mMs.length > 0,
    });
    progress = meltEarn.progress;
    melt.granted = grantItems(inv, meltEarn.earned);
    return melt;
  }

  async function resolveTurn(slotIdx, row, col) {
    state = 'RESOLVING';
    /* Everything a turn can change, captured before any mutation */
    undoSnapshot = takeSnapshot({ board, tray, score, inv, progress, frozen, freezeHold, streak, scoreLog, streakLog });
    const piece = tray[slotIdx];
    const shape = SHAPES[piece.shapeId];
    const dipped = !!piece.frozen;

    /* 1. Commit placement */
    const placedIdx = placePiece(board, shape, row, col, piece.icon);
    tray[slotIdx] = null;

    /* 2. Detect ALL full units on the pre-clear snapshot */
    const units = scanUnits(board);
    const n = units.length;
    const union = unionCells(units);

    /* A dipped piece that completes something FREEZES the scan instead of
       clearing it: placement points only, and the units wait (still full,
       so the next scan re-finds them) to melt into one bigger combo. Freezes
       stack: dipping again while a freeze already waits adds the new units on
       top, so the eventual melt is one bigger combo. A dip that achieved
       nothing (no units, or only cells already frozen) is returned. */
    const { didFreeze, frozeNothingNew, freezeRefund } = freezeOutcome(dipped, freezeHold, union, frozen);
    if (freezeRefund) inv.freeze = Math.min(ITEM_CAPS.freeze, inv.freeze + 1);
    /* Capture before freezeHold mutates: a dip that piled new frozen cells
       onto an existing hold deserves the "frozen deeper" toast. */
    const stacked = didFreeze && freezeHold && !frozeNothingNew;

    const bonuses = !didFreeze && n ? iconBonuses(board, units) : [];
    const msBonuses = !didFreeze && n ? matchingSetBonuses(bonuses) : [];

    /* Capture visuals before mutating further */
    const placedRender = placedIdx.map((idx) => ({ idx, icon: piece.icon }));
    const unionRender = [...union].map((idx) => ({ idx, icon: board[idx] }));
    const clearDelays = computeClearDelays(units);
    const bonusCells = new Set();
    for (const b of bonuses) for (const idx of b.cells) bonusCells.add(idx);
    /* A perfect bonus (count === 9) is a whole unit of one symbol: those get a
       signature per-symbol flourish instead of the generic celebration clones. */
    const perfects = bonuses.filter((b) => b.perfect);

    /* 3. Freeze, or clear the union and apply all scoring.
       Streak: a frozen set keeps the streak warm (unchanged); a real clear
       extends it and pays the rising bonus; a placement that clears nothing
       cools it back to zero. */
    let gained;
    let streakPts = 0;
    let scoreEntry = null;
    if (didFreeze) {
      for (const idx of union) frozen[idx] = 1;
      freezeHold = true;
      gained = shape.cells.length;
    } else if (n > 0) {
      /* Snapshot the board for the score panel NOW: the piece has landed (its
         cells are written) but the cleared union is still filled, so the entry
         shows exactly what completed the combo. Capture before the clear below. */
      const boardSnapshot = boardToLogString(board);
      for (const idx of union) board[idx] = -1;
      if (freezeHold) { /* the melt rode along with this scan */
        frozen = new Uint8Array(CELL_COUNT);
        freezeHold = false;
      }
      streak++;
      streakPts = streakBonus(streak);
      gained = shape.cells.length + clearScore(n)
        + bonuses.reduce((a, b) => a + b.points, 0)
        + msBonuses.reduce((a, b) => a + b.points, 0)
        + streakPts;
      /* A melt (freezeHold clear) logs like any other clear. */
      scoreEntry = makeScoreLogEntry(n, shape.cells.length, bonuses, msBonuses, streak, streakPts, gained,
        boardSnapshot, [...union], placedIdx);
      scoreLog = pushLog(scoreLog, scoreEntry, SCORE_LOG_MAX);
      streakLog = pushLog(streakLog, { n, gained }, STREAK_LOG_MAX);
    } else {
      streak = 0;
      streakLog = [];
      gained = shape.cells.length;
    }
    score += gained;
    /* Bank the record immediately so a mid-game restart can never lose it. */
    let newBest = score > best;
    if (newBest) best = score;

    /* Item earning (economy in computeEarned; grants clamp at ITEM_CAPS) */
    const perfectCount = bonuses.filter((b) => b.perfect).length;
    const earnResult = computeEarned(progress, {
      gained, comboN: didFreeze ? 0 : n, perfectCount,
      streak: didFreeze ? 0 : streak,
      msCombo: !didFreeze && msBonuses.length > 0,
    });
    progress = earnResult.progress;
    const granted = grantItems(inv, earnResult.earned);

    /* 4. Refill when all three slots are used */
    const refilled = tray.every((p) => p === null);
    if (refilled) tray = genTray(board, rng);

    /* 5. Fit test on the post-clear board. Item-aware: a Rotate or Flip in
       stock (or an open session) can rescue a piece and a held Reroll always
       offers a way out, so the plain test short-circuits the cheap common
       case before the orbit walk. */
    let over = isGameOver(board, tray) && isGameOverWithItems(board, tray, inv.rotate, inv.reroll, inv.flip);

    /* A pending freeze force-melts at game over; the space it frees can
       rescue the game, so the fit test runs again afterwards. */
    let melt = null;
    if (over && freezeHold) {
      melt = forceMeltAtGameOver();
      if (melt.newBest) newBest = true;
      for (const k of Object.keys(granted)) granted[k] += melt.granted[k];
      /* No history append: a force-melt only ever happens at game over, where
         the save is nulled anyway. The DOM phase may still build an ad hoc
         entry for the melt toast, but nothing is logged. */
      over = isGameOverWithItems(board, tray, inv.rotate, inv.reroll, inv.flip);
    }

    logAction('place s' + slotIdx + ' #' + piece.shapeId + 'i' + piece.icon
      + ' @r' + row + 'c' + col + ' +' + gained
      + (didFreeze ? ' freeze' : (n > 0 ? ' clear x' + n : ''))
      + (freezeRefund ? ' freeze-refund' : '')
      + (melt ? ' force-melt' : '')
      + (over ? ' GAME-OVER' : ''));

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

    if (didFreeze) {
      sound.freeze();
      /* A dip that added new frozen cells on top of a waiting freeze stacked
         it deeper; a dip that re-found only already-frozen cells said nothing
         new (its refund toast fires below instead). A freeze that instantly
         force-melted at game over gets no promise it cannot keep. */
      if (melt) {
        /* the force-melt block below owns the messaging */
      } else if (stacked) {
        showToast('item-toast', '❄️ Frozen deeper! Your next clear melts it all');
      } else if (!frozeNothingNew) {
        showToast('item-toast', '❄️ Frozen! Finish another set to melt a big combo');
      }
      await wait(POP_MS + placedRender.length * POP_STAGGER);
      renderBoard(); /* paints the icy cells from the mask */
    } else if (n > 0) {
      showScoreToast(scoreEntry);
      updateStreakPill(true);
      if (bonuses.length) {
        sound.bonus(bonuses.some((b) => b.icon === LIZARD_ICON));
        if (!reducedMotion) {
          for (const idx of bonusCells) cellEls[idx].classList.add('flash');
          await wait(FLASH_MS);
        }
      }
      sound.clear(n);
      const tier = reducedMotion ? 0 : celebrationTier(gained);
      if (tier >= 4) sound.fanfare();
      else if (tier >= 2) sound.bubbles();
      if (tier <= 1) {
        for (const idx of union) {
          const cell = cellEls[idx];
          cell.classList.remove('flash', 'pop');
          cell.classList.add('clearing');
          cell.style.animationDelay = (reducedMotion ? 0 : clearDelays.get(idx)) + 'ms';
        }
        spawnParticles(union);
        await wait(reducedMotion ? 160 : CLEAR_WAIT);
      } else {
        sound.impact(tier);
        /* A perfect always lands here (its min gain clears the tier-2 floor).
           Its 9 cells fly off with their symbol's signature flourish; the rest
           of the clear still marches with the generic celebration clones. */
        let celebrateRender = unionRender;
        if (perfects.length) {
          sound.perfect();
          const claimed = perfectFx(perfects); /* Set of cell idx the flourish owns */
          celebrateRender = unionRender.filter((u) => !claimed.has(u.idx));
        }
        celebrate(tier, celebrateRender);
        spawnParticles(union);
        await wait(CELEBRATE_WAIT[tier]);
      }
      renderBoard();
    } else {
      updateStreakPill(false);
      await wait(POP_MS + placedRender.length * POP_STAGGER);
      for (const idx of placedIdx) {
        cellEls[idx].classList.remove('pop');
        cellEls[idx].style.animationDelay = '';
      }
    }
    if (freezeRefund) showToast('item-toast', '❄️ Freeze unused, returned');

    /* Rare: the freeze ended the game and force-melted. A perfect melting here
       deliberately gets no per-symbol flourish: it plays the plain clear, since
       the game is over and the flourish would fight the game-over card. */
    if (melt) {
      sound.clear(melt.n);
      for (const idx of melt.union) {
        const cell = cellEls[idx];
        cell.classList.add('clearing');
        cell.style.animationDelay = (reducedMotion ? 0 : melt.delays.get(idx)) + 'ms';
      }
      spawnParticles(melt.union);
      await wait(reducedMotion ? 160 : CLEAR_WAIT);
      renderBoard();
      /* A force-melt that RESCUED the game (over fell back to false at the
         re-test) reads as a surprise board-wipe unless we say what happened.
         At a true game over the game-over card speaks for itself, so only the
         rescue is announced. */
      if (!over && !tutorial) {
        /* Pinned + a longer hold: a big melt earns a flurry of item toasts
           right after, and this explainer must ride over them, not get bumped. */
        showToast('melt-toast', '❄️ Board full! Frozen combo melted to save you  +' + melt.gained, { pin: true, ttl: 7000 });
      }
    }

    renderTray();
    updateItemsBar();
    announceEarned(granted);
    persist();

    if (over && !tutorial) {
      persist();
      await wait(GAMEOVER_DELAY);
      showGameOver(newBest);
    } else {
      state = 'IDLE';
      /* All current orientations are stuck, so the only reason the game is
         still alive is an item rescue. Tell her which one. */
      if (!tutorial && isGameOver(board, tray)) {
        let hint = '\u{1F3B2} Stuck? A Reroll can still save you!';
        if (!isGameOverWithRotate(board, tray, inv.rotate)) hint = '⟳ Stuck? Rotating a piece can still save you!';
        else if (!isGameOverWithRotate(board, tray, 0, inv.flip)) hint = '⇄ Stuck? Flipping a piece can still save you!';
        else if (!isGameOverWithRotate(board, tray, inv.rotate, inv.flip)) hint = '⟳⇄ Stuck? Rotate and Flip together can still save you!';
        showToast('item-toast', hint);
      }
      /* The tutorial teaches items hands-on; its crafted melt can earn a
         Rotate/Freeze, so suppress the first-earn help card here (it would
         cover the coach). announceEarned's toast still reinforces the reward. */
      if (!tutorial) maybeShowItemHelp(granted);
      if (tutorial) tutAdvance();
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

  /* Clears escalate with the turn's haul: T1 sparkle, T2 bubbles,
     T3 confetti burst, T4 the whole clear marches off screen. */
  function celebrationTier(gained) {
    if (gained >= 260) return 4;
    if (gained >= 130) return 3;
    if (gained >= 54) return 2;
    return 1;
  }

  /* A single shared glow layer with one owning timer, so a pink lizard pulse
     can never clip a gold celebration glow (or vice versa) mid-flight. */
  let glowTimer = 0;
  function pulseGlow(cls, ms) {
    if (reducedMotion) return;
    clearTimeout(glowTimer);
    glowEl.className = '';
    void glowEl.offsetWidth;
    glowEl.hidden = false;
    glowEl.classList.add(cls);
    glowTimer = setTimeout(() => {
      glowEl.classList.remove(cls);
      glowEl.hidden = true;
    }, ms);
  }

  /* Tier 2+: the real cells fade fast while lightweight clones (transform and
     opacity only) carry the show, and the whole board shakes, the score pill
     punches, and a gold glow pulses. Cleanup on animationend plus a safety
     sweep in case animations never fire. */
  function celebrate(tier, unionRender) {
    const fxHost = $('fxLayer');
    const boardW = cellPx * N;
    for (const { idx } of unionRender) {
      const cell = cellEls[idx];
      cell.classList.remove('flash', 'pop');
      cell.classList.add('fade-fast');
    }
    const cap = Math.min(FX_CAP[tier], unionRender.length);
    const step = unionRender.length / cap;
    for (let i = 0; i < cap; i++) {
      const { idx, icon } = unionRender[Math.floor(i * step)];
      if (icon < 0) continue;
      const s = document.createElement('span');
      s.textContent = ICONS[icon];
      const { x, y } = cellCenter(idx);
      s.style.left = x + 'px';
      s.style.top = y + 'px';
      if (tier === 2) {
        s.className = 'fx-cell fx-bubble';
        s.style.setProperty('--dy', -(70 + rng() * 100 | 0) + 'px');
        s.style.setProperty('--d', (rng() * 200 | 0) + 'ms');
      } else if (tier === 3) {
        s.className = 'fx-cell fx-burst';
        s.style.setProperty('--dx', ((rng() * 240 - 120) | 0) + 'px');
        s.style.setProperty('--dy', ((rng() * 240 - 170) | 0) + 'px');
        s.style.setProperty('--spin', ((rng() * 840 - 420) | 0) + 'deg');
        s.style.setProperty('--d', (rng() * 140 | 0) + 'ms');
      } else {
        s.className = 'fx-cell fx-march fx-big';
        s.style.setProperty('--dx', ((boardW - x + 60) | 0) + 'px');
        s.style.setProperty('--d', ((idx % 9) * 40) + 'ms');
      }
      s.addEventListener('animationend', () => s.remove());
      fxHost.appendChild(s);
    }

    /* Board shake rides inside boardWrap, so the fx clones shake with it while
       the header and toasts stay readable. The animationend guard ignores the
       many child-cell animations that bubble up through boardWrap. */
    boardWrap.classList.remove('shake-2', 'shake-3', 'shake-4');
    void boardWrap.offsetWidth;
    boardWrap.classList.add('shake-' + tier);
    const clearShake = (e) => {
      if (e.target !== boardWrap) return;
      boardWrap.classList.remove('shake-2', 'shake-3', 'shake-4');
      boardWrap.removeEventListener('animationend', clearShake);
    };
    boardWrap.addEventListener('animationend', clearShake);

    const scorePill = document.querySelector('.score-pill');
    if (scorePill) {
      scorePill.classList.remove('punch');
      void scorePill.offsetWidth;
      scorePill.classList.add('punch');
      const clearPunch = () => { scorePill.classList.remove('punch'); scorePill.removeEventListener('animationend', clearPunch); };
      scorePill.addEventListener('animationend', clearPunch);
    }

    if (tier === 3) pulseGlow('pulse-gold', 750);
    if (tier === 4) { pulseGlow('pulse-gold-double', 950); confetti(); }

    setTimeout(() => {
      fxHost.querySelectorAll('.fx-cell').forEach((el) => el.remove());
    }, 2600);
  }

  /* Perfect Match: each perfect unit (a whole row, column, or box of one
     symbol) sends its nine cells off with a signature exit by icon. Builds off
     a single boardEl rect read (so no layout thrash), claims every cell it owns
     so celebrate() leaves them out of the generic march, and self-sweeps.
     reducedMotion never reaches here (tier is forced to 0 upstream), so there
     is no separate reduced path. Returns the Set of claimed cell indices. */
  function perfectFx(perfects) {
    const claimed = new Set();
    const rect = boardEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    /* Board center in viewport space, for the star radial burst (+3 is the
       board's 3px frame, which the rect includes but the cell grid starts after). */
    const cx = rect.left + 3 + (N / 2) * cellPx;
    const cy = rect.top + 3 + (N / 2) * cellPx;
    const frag = document.createDocumentFragment();
    let maxMs = 0;
    perfects.slice(0, PERFECT_UNIT_CAP).forEach((b, ui) => {
      const base = ui * 150;   /* stagger whole units so two symbols do not fire as one */
      const icon = b.icon;
      /* Flowers share one gust per unit so all nine read as a single wind. */
      const gust = (rng() < 0.5 ? -1 : 1) * (vw * 0.6 + rng() * vw * 0.35);
      maxMs = Math.max(maxMs, base + (PERFECT_MS[icon] || 2200));
      let k = 0;
      for (const idx of b.cells) {
        if (claimed.has(idx)) continue;   /* a cell shared by two perfect units is owned once */
        claimed.add(idx);
        const cell = cellEls[idx];
        cell.classList.remove('flash', 'pop');
        cell.classList.add('fade-fast');
        const x = rect.left + 3 + ((idx % N) + 0.5) * cellPx;
        const y = rect.top + 3 + (Math.floor(idx / N) + 0.5) * cellPx;
        frag.appendChild(makePfx(icon, x, y, k, base, vw, vh, cx, cy, gust));
        k++;
      }
    });
    perfectLayer.appendChild(frag);
    /* Safety sweep in case an animationend never fires (backgrounded tab, etc.). */
    setTimeout(() => {
      perfectLayer.querySelectorAll('.pfx').forEach((el) => el.remove());
    }, maxMs + 800);
    return claimed;
  }

  /* Build one .pfx glyph for a perfect cell. icon picks the exit; x/y are the
     cell center in viewport space; k is the cell's place within its unit (for
     waves); base is the unit's stagger; gust is the unit's shared flower wind.
     Icons with a second, composed motion nest a span so the outer element
     carries the travel while the span scurries, chomps, or flaps. Removal is on
     the OUTER animation only (e.target === el), so an infinite inner flap or a
     finite chomp never yanks the glyph early. */
  function makePfx(icon, x, y, k, base, vw, vh, cx, cy, gust) {
    const el = document.createElement('span');
    el.className = 'pfx';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    let inner = null;
    if (icon === 0) {
      /* Lizard: scurry across the whole viewport and off the near edge. */
      const right = rng() < 0.5;
      el.classList.add('pfx-lizard');
      el.style.setProperty('--dx', ((right ? (vw - x + 80) : -(x + 80)) | 0) + 'px');
      el.style.setProperty('--dy', ((rng() * 120 - 60) | 0) + 'px');
      el.style.setProperty('--face', (right ? 90 : -90) + 'deg');
      el.style.setProperty('--dur', ((1400 + rng() * 800) | 0) + 'ms');
      el.style.setProperty('--delay', ((base + rng() * 250) | 0) + 'ms');
      inner = document.createElement('span');
    } else if (icon === 1) {
      /* Flower: the shared gust carries all nine off the same side; those the
         wind reaches first (nearest its source edge) leave first. */
      const fromLeft = gust > 0;
      const along = fromLeft ? x : (vw - x);
      el.classList.add('pfx-flower');
      el.style.setProperty('--dx', (gust | 0) + 'px');
      el.style.setProperty('--dur', ((1500 + rng() * 600) | 0) + 'ms');
      el.style.setProperty('--delay', ((base + (along / vw) * 350) | 0) + 'ms');
    } else if (icon === 2) {
      /* Heart: inflate into a balloon and float off the top. */
      el.classList.add('pfx-heart');
      el.style.setProperty('--dy', (-(y + cellPx * 2 + 60) | 0) + 'px');
      el.style.setProperty('--dur', ((1900 + rng() * 300) | 0) + 'ms');
      el.style.setProperty('--delay', ((base + k * 40) | 0) + 'ms');
    } else if (icon === 3) {
      /* Star: shoot radially out from the board center with a rainbow trail. */
      let ang = Math.atan2(y - cy, x - cx);
      if (Math.abs(x - cx) < 1 && Math.abs(y - cy) < 1) ang = rng() * Math.PI * 2;
      ang += (rng() - 0.5) * 0.5;
      const r = 0.75 * Math.max(vw, vh) + rng() * 120;
      el.classList.add('pfx-star');
      el.style.setProperty('--ang', (ang * 180 / Math.PI).toFixed(1) + 'deg');
      el.style.setProperty('--r', (r | 0) + 'px');
      el.style.setProperty('--dur', ((900 + rng() * 100) | 0) + 'ms');
      el.style.setProperty('--delay', ((base + k * 20) | 0) + 'ms');
    } else if (icon === 4) {
      /* Strawberry: eaten in place, bite by bite, in a wave across the unit. */
      el.classList.add('pfx-berry');
      el.style.setProperty('--delay', ((base + k * 90) | 0) + 'ms');
      inner = document.createElement('span');
    } else {
      /* Butterfly: zigzag up and away off the top, wings flapping. */
      const dir = rng() < 0.5 ? -1 : 1;
      el.classList.add('pfx-butterfly');
      el.style.setProperty('--dx', ((dir * rng() * vw * 0.4) | 0) + 'px');
      el.style.setProperty('--dy', (-(y + cellPx * 2 + 80) | 0) + 'px');
      el.style.setProperty('--sway', (((30 + rng() * 50) * (rng() < 0.5 ? -1 : 1)) | 0) + 'px');
      el.style.setProperty('--dur', ((1900 + rng() * 300) | 0) + 'ms');
      el.style.setProperty('--delay', ((base + k * 50) | 0) + 'ms');
      inner = document.createElement('span');
    }
    if (inner) {
      /* Custom properties inherit, so the inner motion (scurry, chomp, flap)
         reads the same --delay/--face the outer element carries. */
      inner.textContent = ICONS[icon];
      el.appendChild(inner);
    } else {
      el.textContent = ICONS[icon];
    }
    el.addEventListener('animationend', (e) => { if (e.target === el) el.remove(); });
    return el;
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
  const TOAST_HOLD = 3600;

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
    if (opts && opts.pin) t.dataset.pinned = '1';
    if (typeof content === 'string') t.textContent = content;
    else t.appendChild(content);
    t.addEventListener('pointerup', () => {
      if (opts && opts.onTap) opts.onTap();
      dismissToast(t, true);
    });
    const live = Array.from(toastLayer.children).filter((x) => !x.dataset.leaving);
    /* Over the cap, evict the oldest UNPINNED toast, so a pinned notice (the
       freeze force-melt rescue) is not bumped off by the reward toasts that
       immediately follow it. Fall back to the oldest if every toast is pinned. */
    if (live.length >= MAX_TOASTS) dismissToast(live.find((x) => !x.dataset.pinned) || live[0], true);
    toastLayer.appendChild(t);
    t._ttl = setTimeout(() => dismissToast(t, false), (opts && opts.ttl) || TOAST_HOLD);
    return t;
  }

  /* A 9x9 mini board redraw from an entry's captured snapshot, reusing the
     scoring-sheet visual language (.mini/.mc, .filled, .land, .ring). Filled
     cells show their icon; the landing piece's cells get the dashed .land
     treatment (exactly like the help sheet's landing cells); cleared cells get
     the gold .ring. Assumes entry.board is a valid CELL_COUNT-char string. */
  function buildMiniBoard(entry, opts) {
    const placedSet = new Set(entry.placed || []);
    const clearedSet = new Set(entry.cleared || []);
    const grid = document.createElement('div');
    grid.className = 'mini mini-9';
    grid.style.setProperty('--mini-cols', 9);
    for (let i = 0; i < entry.board.length; i++) {
      const ch = entry.board[i];
      const cell = document.createElement('div');
      cell.className = 'mc';
      const icon = (ch >= '0' && ch <= '5') ? ch.charCodeAt(0) - 48 : -1;
      const landed = placedSet.has(i);
      if (icon >= 0) {
        cell.classList.add(landed ? 'land' : 'filled');
        const ic = document.createElement('span');
        ic.className = 'ic';
        ic.textContent = ICONS[icon];
        cell.appendChild(ic);
      } else if (landed) {
        cell.classList.add('land');
      }
      if (clearedSet.has(i)) cell.classList.add('ring');
      grid.appendChild(cell);
    }
    const wrap = document.createElement('div');
    wrap.className = 'bd-mini';
    /* Panel-only: tapping the board pops it open full-screen (12px cells are
       too small to inspect). The zoom copy is built without this flag so it is
       not itself a nested button. */
    if (opts && opts.zoom) {
      wrap.classList.add('bd-mini-zoomable');
      wrap.setAttribute('role', 'button');
      wrap.tabIndex = 0;
      wrap.setAttribute('aria-label', 'Show this board bigger');
      wrap.addEventListener('click', () => { sound.tap(); openMiniZoom(entry); });
    }
    wrap.appendChild(grid);
    return wrap;
  }

  /* The per-clear score breakdown, built from one makeScoreLogEntry record so
     the live toast and the Recent-scores panel can never disagree. Returns the
     box plus whether a lizard bonus showed (the toast pulses pink for it). With
     opts.board, and when the entry carries a valid snapshot, a mini board is
     drawn above the rows: panel-only, so the live toast stays compact. */
  function buildBreakdown(entry, opts) {
    const box = document.createElement('div');
    if (opts && opts.board && typeof entry.board === 'string' && entry.board.length === CELL_COUNT) {
      box.appendChild(buildMiniBoard(entry, { zoom: true }));
    }
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
    const n = entry.n;
    if (n >= 2) {
      const head = document.createElement('div');
      head.className = 't-head';
      head.textContent = 'Combo x' + n + '! ' + (n >= 5 ? COMBO_LEGENDARY : COMBO_PHRASES[n]);
      box.appendChild(head);
    }
    row('Placement', entry.placement);
    row('Clear x' + n, entry.clear);
    let lizardHit = false;
    for (const b of entry.icons) {
      const label = b.perfect ? 'Perfect Match!' : ICON_LABELS[b.icon].replace('!', '');
      row(ICONS[b.icon] + ' ' + label + ' x' + b.count, b.points);
      if (b.icon === LIZARD_ICON) lizardHit = true;
    }
    for (const ms of entry.ms) {
      row(ICONS[ms.icon] + ' Matching Sets x' + ms.unitCount, ms.points);
      if (ms.icon === LIZARD_ICON) lizardHit = true;
    }
    if (entry.streakPts > 0) row('\u{1F525} Streak x' + entry.streakK + '!', entry.streakPts, 'streak');
    row('Total', entry.total, 'total');
    return { box, lizardHit };
  }

  /* Thin wrapper: the live score toast, tap to open the scoring sheet. */
  function showScoreToast(entry) {
    const { box, lizardHit } = buildBreakdown(entry);
    if (lizardHit && !reducedMotion) pulseGlow('pulse', 520);
    showToast('score-toast', box, { ttl: 4800, onTap: openScoreHelp });
  }

  /* ---- Scoring sheet (also opened by tapping any score toast) ---- */
  const scoreHelpEl = $('scoreHelp');
  function openScoreHelp() { scoreHelpEl.hidden = false; }
  $('scoreHelpClose').addEventListener('click', () => { sound.tap(); scoreHelpEl.hidden = true; });

  /* Static mini board diagrams for the scoring sheet, built once from a data
     table. Tokens per cell: '.' empty, '0'-'5' a filled cell showing ICONS[d],
     'A'-'F' a landing (dashed) cell showing ICONS[letter]; ring lists the
     gold-ringed cell indexes ('all' rings every cell); pts is the headline.
     Every headline is verified against the engine scoring functions:
       place  L4 on empty grid            -> placement 4
       clear  2-block piece finishing a row-> placement 2 + clearScore(1) 18 = 20
       combo  single lands a row and a col -> clearScore(2) = 54
       icon   6 stars in a cleared row     -> iconBonusTier(6) = 25
       perfect box of 9 berries            -> iconBonusTier(9) = 100
       msets  flowers matched across 2 sets-> matchingSetsTier(2) = 50
       lizard 3 lizards in a cleared row   -> iconBonusTier(3) * 2 = 20 */
  const HELP_DIAGRAMS = {
    place:   { rows: ['E..', 'E..', 'EE.'], ring: [], pts: '+4' },
    clear:   { rows: ['1234512DE'], ring: [], pts: '+20' },
    combo:   { rows: ['..1..', '..2..', '34B51', '..2..', '..3..'], ring: [], pts: '+54' },
    icon:    { rows: ['333333214'], ring: [0, 1, 2, 3, 4, 5], pts: '+25' },
    perfect: { rows: ['444', '444', '4EE'], ring: 'all', pts: '+100' },
    msets:   { rows: ['..1..', '..1..', '11111', '..1..', '..1..'], ring: [2, 7, 10, 11, 12, 13, 14, 17, 22], pts: '+50' },
    lizard:  { rows: ['000123451'], ring: [0, 1, 2], pts: '+20' },
  };

  function buildHelpDiagram(spec) {
    const wrap = document.createElement('div');
    wrap.className = 'mini-wrap';
    const grid = document.createElement('div');
    grid.className = 'mini';
    grid.style.setProperty('--mini-cols', spec.rows[0].length);
    const ringAll = spec.ring === 'all';
    const ringSet = ringAll ? null : new Set(spec.ring);
    let idx = 0;
    for (const rowStr of spec.rows) {
      for (const ch of rowStr) {
        const cell = document.createElement('div');
        cell.className = 'mc';
        let icon = -1;
        if (ch >= '0' && ch <= '5') { icon = ch.charCodeAt(0) - 48; cell.classList.add('filled'); }
        else if (ch >= 'A' && ch <= 'F') { icon = ch.charCodeAt(0) - 65; cell.classList.add('land'); }
        if (icon >= 0) {
          const ic = document.createElement('span');
          ic.className = 'ic';
          ic.textContent = ICONS[icon];
          cell.appendChild(ic);
        }
        if (ringAll || (ringSet && ringSet.has(idx))) cell.classList.add('ring');
        grid.appendChild(cell);
        idx++;
      }
    }
    const pts = document.createElement('div');
    pts.className = 'mini-pts';
    pts.textContent = spec.pts;
    wrap.append(grid, pts);
    return wrap;
  }

  function initHelpDiagrams() {
    for (const el of document.querySelectorAll('#scoreHelp .help-item[data-ex]')) {
      const spec = HELP_DIAGRAMS[el.dataset.ex];
      if (!spec) continue;
      const diagram = buildHelpDiagram(spec);
      const ex = el.querySelector('.ex');
      if (ex) el.insertBefore(diagram, ex);
      else el.appendChild(diagram);
    }
  }

  /* ---- History panels: the score and streak pills each open a sheet ---- */
  const scorePanelEl = $('scorePanel');
  const streakPanelEl = $('streakPanel');

  /* Zoom overlay for a Recent-scores mini board. Reuses buildMiniBoard (built
     without the zoom flag, so the enlarged copy is not itself a button) and
     swaps in the .mini-zoom size variant, which fills most of the phone width.
     Layers above the score panel; a tap anywhere on the dim backdrop closes it. */
  const miniZoomEl = $('miniZoom');
  function openMiniZoom(entry) {
    const mount = $('miniZoomBoard');
    mount.textContent = '';
    const wrap = buildMiniBoard(entry);
    const grid = wrap.querySelector('.mini');
    if (grid) grid.classList.add('mini-zoom');
    mount.appendChild(wrap);
    $('miniZoomHead').textContent = '+' + entry.total;
    miniZoomEl.hidden = false;
  }
  miniZoomEl.addEventListener('click', () => { sound.tap(); miniZoomEl.hidden = true; });

  function renderScorePanel() {
    const body = $('scorePanelBody');
    body.textContent = '';
    if (scoreLog.length === 0) {
      const p = document.createElement('p');
      p.className = 'panel-empty';
      p.textContent = 'Nothing scored yet. Go clear something!';
      body.appendChild(p);
      return;
    }
    for (let i = scoreLog.length - 1; i >= 0; i--) {
      const { box } = buildBreakdown(scoreLog[i], { board: true });
      box.classList.add('bd-entry');
      body.appendChild(box);
    }
  }

  function renderStreakPanel() {
    const body = $('streakPanelBody');
    body.textContent = '';
    if (streakLog.length === 0) {
      const p = document.createElement('p');
      p.className = 'panel-empty';
      p.textContent = 'No streak burning right now';
      body.appendChild(p);
      return;
    }
    const box = document.createElement('div');
    box.className = 'bd-entry';
    streakLog.forEach((e, i) => {
      const r = document.createElement('div');
      r.className = 't-row';
      const l = document.createElement('span');
      l.textContent = 'Clear ' + (i + 1) + (e.n >= 2 ? ' (combo x' + e.n + ')' : '');
      const p = document.createElement('span');
      p.className = 'pts';
      p.textContent = '+' + e.gained;
      r.append(l, p);
      box.appendChild(r);
    });
    const foot = document.createElement('div');
    foot.className = 't-row total';
    foot.textContent = 'Next clear pays +' + (10 * streak) + ' extra';
    box.appendChild(foot);
    body.appendChild(box);
  }

  /* ---- Items bar ---- */
  const itemBtns = { rotate: $('itemRotate'), flip: $('itemFlip'), undo: $('itemUndo'), freeze: $('itemFreeze'), reroll: $('itemReroll') };
  const ITEM_INFO = {
    rotate: {
      icon: '\u{1F504}', article: 'a', name: 'Rotate',
      text: 'Tap the little ⟳ arrow on a tray piece to spin it. One Rotate covers that piece until you place it, so spin away! You earn one for every 200 points. Spin it back to how it started and the Rotate hops right back into your pocket!',
    },
    flip: {
      icon: '\u{2194}\u{FE0F}', article: 'a', name: 'Flip',
      text: 'Tap the little ⇄ arrow on a tray piece to mirror it left-to-right. One Flip covers that piece until you place it. You earn one for every 300 points. Flip it back to how it started and the Flip hops right back into your pocket!',
    },
    undo: {
      icon: '↩️', article: 'an', name: 'Undo',
      text: 'Takes back your whole last move. You earn one for every 2 combos!',
    },
    freeze: {
      icon: '❄️', article: 'a', name: 'Freeze',
      text: 'Ices a piece: the sets it finishes wait, frozen solid, and melt into your next unfrozen clear as one bigger combo. Keep dipping fresh pieces to stack even more! Earn one from Perfect Matches, every 2nd combo, and a x3 streak!',
    },
    reroll: {
      icon: '\u{1F3B2}', article: 'a', name: 'Reroll',
      text: 'Swaps a tray piece for a brand new one. Tap \u{1F3B2}, then tap the piece you want gone. Earn one from x3 combos, x4 streaks, and Matching Sets combos!',
    },
  };

  function updateItemsBar() {
    for (const k of Object.keys(itemBtns)) {
      const btn = itemBtns[k];
      const cnt = btn.querySelector('.cnt');
      const n = inv[k] || 0; /* tutorial stashes may predate newer item keys */
      cnt.textContent = String(n);
      cnt.hidden = n === 0;
      btn.disabled = n === 0;
    }
    /* The bar icons animate while any piece still has an open session */
    itemBtns.rotate.classList.toggle('spinning', tray.some((p) => p && p.rotFree));
    itemBtns.flip.classList.toggle('mirroring', tray.some((p) => p && p.flipFree));
    /* When the tray is stuck, a held Reroll is a way out: pulse it. */
    itemBtns.reroll.classList.toggle('rescue',
      !tutorial && inv.reroll > 0 && isGameOver(board, tray));
  }

  function announceEarned(granted) {
    for (const k of Object.keys(granted)) {
      if (!granted[k]) continue;
      const info = ITEM_INFO[k];
      showToast('item-toast', info.icon + ' ' + info.name + ' earned!' + (granted[k] > 1 ? ' x' + granted[k] : ''));
      const btn = itemBtns[k];
      btn.classList.remove('bounce');
      void btn.offsetWidth;
      btn.classList.add('bounce');
    }
  }

  /* First-earn mini tutorial, once ever per item. The flag is only set when
     the card is actually SHOWN, so an earn during game over tries again. */
  const itemHelpEl = $('itemHelp');
  const helpQueue = [];
  function maybeShowItemHelp(granted) {
    for (const k of Object.keys(granted)) {
      if (granted[k] && !meta.itemHelp[k] && !helpQueue.includes(k)) helpQueue.push(k);
    }
    showNextItemHelp();
  }
  function showNextItemHelp() {
    if (!itemHelpEl.hidden) return;
    const k = helpQueue.shift();
    if (!k) return;
    const info = ITEM_INFO[k];
    $('itemHelpIcon').textContent = info.icon;
    $('itemHelpTitle').textContent = 'You earned ' + info.article + ' ' + info.name + '!';
    $('itemHelpText').textContent = info.text;
    meta.itemHelp[k] = true;
    persist();
    itemHelpEl.hidden = false;
  }
  $('itemHelpOk').addEventListener('click', () => {
    sound.tap();
    itemHelpEl.hidden = true;
    showNextItemHelp();
  });

  /* The bar's rotate and flip buttons are inventory display; usage lives on
     the tray. */
  itemBtns.rotate.addEventListener('click', () => {
    if (inv.rotate > 0) showToast('item-toast', '⟳ Tap the little arrow on a tray piece to rotate it');
  });
  itemBtns.flip.addEventListener('click', () => {
    if (inv.flip > 0) showToast('item-toast', '⇄ Tap the little arrow on a tray piece to mirror it');
  });

  /* ---- Undo: one level, usable from play or from the game-over card.
     Restoring the snapshot also revokes items earned by the undone turn;
     the undo itself is consumed from the RESTORED inventory. ---- */
  function doUndo() {
    if (!undoSnapshot || inv.undo <= 0) return;
    if (state !== 'IDLE' && state !== 'GAME_OVER') return;
    setArming(false);
    setRerollArming(false);
    const snap = undoSnapshot;
    undoSnapshot = null;
    board = snap.board;
    tray = snap.tray;
    score = snap.score;
    inv = snap.inv;
    progress = snap.progress;
    frozen = snap.frozen;
    freezeHold = snap.freezeHold;
    streak = snap.streak;
    scoreLog = snap.scoreLog;
    streakLog = snap.streakLog;
    inv.undo = Math.max(0, inv.undo - 1);
    logAction('undo' + (state === 'GAME_OVER' ? ' (from game over)' : ''));
    if (state === 'GAME_OVER') {
      resolveNickPrompt();
      gameOverEl.classList.remove('show');
      gameOverEl.hidden = true;
    }
    state = 'IDLE';
    sound.undo();
    renderBoard();
    renderTray();
    updateItemsBar();
    updateScoreDisplay(true);
    updateStreakPill(false);
    persist();
    showToast('item-toast', '↩️ Move undone');
    if (tutorial) tutAdvance();
  }

  itemBtns.undo.addEventListener('click', () => {
    if (inv.undo > 0 && !undoSnapshot) {
      showToast('item-toast', '↩️ Nothing to undo yet');
      return;
    }
    doUndo();
  });
  $('undoGameOver').addEventListener('click', doUndo);

  /* ---- Freeze: arm from the bar, then tap a tray piece to dip it ---- */
  let freezeArming = false;

  function setArming(on) {
    freezeArming = on;
    itemBtns.freeze.classList.toggle('armed', on);
  }

  itemBtns.freeze.addEventListener('click', () => {
    if (state !== 'IDLE') return;
    if (freezeArming) {
      setArming(false);
      showToast('item-toast', '❄️ Freeze canceled');
      return;
    }
    if (inv.freeze <= 0) return;
    if (tray.some((p) => p && p.frozen)) { showToast('item-toast', '❄️ A piece is already dipped'); return; }
    setRerollArming(false);
    setArming(true);
    showToast('item-toast', '❄️ Tap a tray piece to dip it in ice');
  });

  function dipPiece(slot) {
    setArming(false);
    if (state !== 'IDLE' || inv.freeze <= 0 || !tray[slot]) return;
    inv.freeze--;
    tray[slot] = { ...tray[slot], frozen: true };
    logAction('dip s' + slot + ' #' + tray[slot].shapeId);
    sound.freeze();
    renderTray();
    updateItemsBar();
    persist();
    if (tutorial) tutAdvance();
  }

  /* ---- Reroll: arm from the bar, then tap a tray piece to swap it ---- */
  let rerollArming = false;

  function setRerollArming(on) {
    rerollArming = on;
    itemBtns.reroll.classList.toggle('armed', on);
  }

  itemBtns.reroll.addEventListener('click', () => {
    if (state !== 'IDLE') return;
    if (rerollArming) {
      setRerollArming(false);
      showToast('item-toast', '\u{1F3B2} Reroll canceled');
      return;
    }
    if (inv.reroll <= 0) return;
    setArming(false);
    setRerollArming(true);
    showToast('item-toast', '\u{1F3B2} Tap a tray piece to swap it for a new one');
  });

  function doReroll(slot) {
    setRerollArming(false);
    if (state !== 'IDLE') return;
    const fromShape = tray[slot] ? tray[slot].shapeId : -1;
    const res = applyReroll(tray[slot], inv, rng);
    if (!res) return;
    inv = res.inv;
    tray[slot] = res.piece;
    logAction('reroll s' + slot + ' #' + fromShape + '->' + res.piece.shapeId
      + (res.refundedRotate ? ' +rotate' : '') + (res.refundedFlip ? ' +flip' : '') + (res.refundedFreeze ? ' +freeze' : ''));
    showToast('item-toast', '\u{1F3B2} Fresh piece!');
    if (res.refundedRotate) showToast('item-toast', '\u{1F504} Rotate returned!');
    if (res.refundedFlip) showToast('item-toast', '\u{2194}\u{FE0F} Flip returned!');
    if (res.refundedFreeze) showToast('item-toast', '❄️ Freeze returned!');
    sound.tap();
    renderTray();
    updateItemsBar();
    persist();
    if (tutorial) { tutAdvance(); return; }
    /* A last-hope reroll that fails ends the game right here, no placement
       needed: the swap was the escape hatch that kept the fit test alive. */
    if (isGameOver(board, tray) && isGameOverWithItems(board, tray, inv.rotate, inv.reroll, inv.flip)) {
      endGameFromReroll();
    }
  }

  /* Game over reached through a failed reroll instead of a placement.
     Mirrors resolveTurn's ending: a pending freeze force-melts first (the
     space it frees, or an item it earns, can still rescue the game), and
     only then the card shows. */
  async function endGameFromReroll() {
    state = 'RESOLVING';
    logAction('game over (reroll dead end)' + (freezeHold ? ' force-melt' : ''));
    let newBest = false;
    if (freezeHold) {
      const melt = forceMeltAtGameOver();
      newBest = melt.newBest;
      sound.clear(melt.n);
      for (const idx of melt.union) {
        const cell = cellEls[idx];
        cell.classList.add('clearing');
        cell.style.animationDelay = (reducedMotion ? 0 : melt.delays.get(idx)) + 'ms';
      }
      spawnParticles(melt.union);
      await wait(reducedMotion ? 160 : CLEAR_WAIT);
      renderBoard();
      updateScoreDisplay();
      renderTray();
      updateItemsBar();
      announceEarned(melt.granted);
      maybeShowItemHelp(melt.granted);
      if (!isGameOverWithItems(board, tray, inv.rotate, inv.reroll, inv.flip)) {
        state = 'IDLE';
        persist();
        return;
      }
    }
    persist();
    await wait(GAMEOVER_DELAY);
    showGameOver(newBest);
  }

  /* ---- Interactive tutorial. Runs on the real engine against crafted
     boards; the live game (and best) is stashed in memory and restored at
     the end, and persist() is suppressed throughout, so the real save can
     never see tutorial state. ---- */
  const coachEl = $('coach');

  const TUT = [
    {
      text: 'Hi ' + PLAYER_NAME + '! \u{1F49C} Drag any piece from the tray onto the board.',
      setup() {
        board = emptyBoard();
        tray = [{ shapeId: 13, icon: 2 }, { shapeId: 5, icon: 1 }, { shapeId: 0, icon: 3 }];
      },
      anchor: () => trayEl,
    },
    {
      text: 'Fill a whole row, column, or 3x3 box to clear it. Finish this row!',
      setup() {
        board = emptyBoard();
        [1, 2, 3, 4, 1, 2, 3].forEach((icon, c) => { board[4 * N + c] = icon; });
        tray = [{ shapeId: 1, icon: 4 }, null, null];
      },
      anchor: () => cellEls[4 * N + 7],
      allowDrop: (r, c) => r === 4 && c === 7,
    },
    {
      text: 'Boxes clear too! Drop the \u{1F98B} in the very center to finish the middle 3x3 box!',
      setup() {
        board = emptyBoard();
        const box = [[3, 3], [3, 4], [3, 5], [4, 3], [4, 5], [5, 3], [5, 4], [5, 5]];
        [1, 2, 3, 4, 4, 3, 2, 1].forEach((icon, i) => { board[box[i][0] * N + box[i][1]] = icon; });
        tray = [{ shapeId: 0, icon: 5 }, null, null]; /* butterfly single */
      },
      anchor: () => cellEls[4 * N + 4],
      allowDrop: (r, c) => r === 4 && c === 4,
    },
    {
      text: 'Match 3 or more of the same icon in a set you clear and it pays a bonus! Clear this flowery row \u{1F338}',
      setup() {
        board = emptyBoard();
        [1, 1, 1, 1, 2, 3, 2].forEach((icon, c) => { board[4 * N + c] = icon; });
        tray = [{ shapeId: 1, icon: 1 }, null, null];
      },
      anchor: () => cellEls[4 * N + 7],
      allowDrop: (r, c) => r === 4 && c === 7,
    },
    {
      text: 'Hold a piece over its spot before dropping: purple glow means it will clear, a gold ring means an icon bonus!',
      setup() {
        board = emptyBoard();
        [2, 2, 2, 3, 4, 1, 3, 4].forEach((icon, c) => { board[2 * N + c] = icon; });
        tray = [{ shapeId: 0, icon: 2 }, null, null];
      },
      anchor: () => cellEls[2 * N + 8],
      allowDrop: (r, c) => r === 2 && c === 8,
    },
    {
      text: 'Items! You just earned a Rotate. Tap the little ⟳ arrow on the piece, then finish the row!',
      setup() {
        board = emptyBoard();
        [3, 1, 4, 2, 3, 1].forEach((icon, c) => { board[4 * N + c] = icon; });
        board[5 * N + 6] = 2; /* blocks the unrotated drop */
        inv = { ...zeroInv(), rotate: 1 };
        tray = [{ shapeId: 6, icon: 4 }, null, null];
      },
      anchor: () => slotEls[0],
      allowPickup: (slot) => !!tray[slot] && SHAPES[tray[slot].shapeId].h === 1,
      allowDrop: (r, c) => r === 4 && c === 6,
    },
    {
      /* 6 flip: the corner piece is backwards; only its mirror fills the gap.
         allowPickup gates until the piece has actually been mirrored. */
      text: '\u{2194}\u{FE0F} Flip! This piece is backwards. Tap the little ⇄ arrow to mirror it, then finish the row!',
      setup() {
        board = emptyBoard();
        [2, 4, 1, 3, 2, 4, 1].forEach((icon, c) => { board[5 * N + c] = icon; });
        board[4 * N + 7] = 3; /* blocks the unmirrored corner */
        inv = { ...zeroInv(), flip: 1 };
        tray = [{ shapeId: 9, icon: 2 }, null, null]; /* corner; its mirror is shape 12 */
      },
      anchor: () => slotEls[0],
      allowPickup: (slot) => !!tray[slot] && tray[slot].shapeId === 12,
      allowDrop: (r, c) => r === 4 && c === 7,
    },
    {
      /* 7 undo-a: a tempting star that finishes the row but spoils the flower
         Perfect Match. The drop is forced so the lesson lands next step. */
      text: 'This ⭐ finishes the row, but it spoils a flower Perfect Match. Drop it in anyway!',
      setup() {
        board = emptyBoard();
        for (let c = 0; c < 8; c++) board[4 * N + c] = 1; /* flowers cols 0-7 */
        inv = { ...zeroInv(), undo: 1 };
        tray = [{ shapeId: 0, icon: 3 }, null, null]; /* star single */
        /* Nothing to rewind until the star is placed. Without this, a snapshot
           left over from an earlier step lets Undo fire early: it rewinds to
           that stale state and skips to undo-b with nothing left to undo,
           dead-ending the tutorial on an empty tray. The star's own placement
           sets the real snapshot that undo-b then rewinds. */
        undoSnapshot = null;
      },
      anchor: () => cellEls[4 * N + 8],
      allowDrop: (r, c) => r === 4 && c === 8,
    },
    {
      /* 8 undo-b: the placed star already cleared the row; tapping Undo rewinds
         the whole move (the surviving snapshot brings the star back). */
      text: 'Regrets? Tap ↩️ Undo and the whole move rewinds!',
      setup() {
        board = emptyBoard();
        inv = { ...zeroInv(), undo: 1 };
        tray = [null, null, null];
      },
      anchor: () => $('itemUndo'),
    },
    {
      /* 9 freeze-a: arm Freeze, then tap the piece to ice it (dipPiece advances).
         allowPickup false forces the button-first gesture. */
      text: '❄️ Freeze! Tap the ❄️ button, then tap your piece to coat it in ice.',
      setup() {
        board = emptyBoard();
        for (let c = 0; c < 8; c++) board[4 * N + c] = 1; /* flowers cols 0-7 */
        inv = { ...zeroInv(), freeze: 1 };
        tray = [{ shapeId: 0, icon: 1 }, null, null]; /* flower single */
      },
      anchor: () => $('itemFreeze'),
      allowPickup: () => false,
    },
    {
      /* 10 freeze-b: the pre-iced piece finishes the row but freezes it solid. */
      text: 'Now finish the row. Watch: it freezes solid instead of clearing!',
      setup() {
        board = emptyBoard();
        for (let c = 0; c < 8; c++) board[4 * N + c] = 1; /* flowers cols 0-7 */
        tray = [{ shapeId: 0, icon: 1, frozen: true }, null, null]; /* pre-iced flower */
      },
      anchor: () => cellEls[4 * N + 8],
      allowDrop: (r, c) => r === 4 && c === 8,
    },
    {
      /* 11 freeze-c: a real x2 melt. The frozen flower row waits; completing the
         heart column melts both together as one big combo. */
      text: 'Finish another set and everything melts together: one big combo!',
      setup() {
        board = emptyBoard();
        for (let c = 0; c < N; c++) board[4 * N + c] = 1; /* frozen flower row */
        for (let r = 0; r < 8; r++) if (r !== 4) board[r * N + 2] = 2; /* hearts col 2 */
        for (let c = 0; c < N; c++) frozen[4 * N + c] = 1;
        freezeHold = true;
        tray = [{ shapeId: 0, icon: 2 }, null, null]; /* heart single */
      },
      anchor: () => cellEls[8 * N + 2],
      allowDrop: (r, c) => r === 8 && c === 2,
    },
    {
      /* 12 reroll: arm Reroll, then tap the piece to swap it (doReroll advances). */
      text: '\u{1F3B2} A piece you do not like? Tap \u{1F3B2} Reroll, then tap the piece to swap it!',
      setup() {
        board = emptyBoard();
        inv = { ...zeroInv(), reroll: 1 };
        tray = [{ shapeId: 38, icon: 4 }, null, null]; /* Plus5 */
      },
      anchor: () => $('itemReroll'),
      allowPickup: () => false,
    },
    {
      text: 'Tap your score pill anytime to see how a move paid, and ⚙️ has the full guide. That is everything: have fun, ' + PLAYER_NAME + '! \u{1F49C}',
      setup() {
        board = emptyBoard();
        tray = [null, null, null];
      },
      anchor: () => document.querySelector('.score-pill'),
      next: true,
      nextLabel: 'Finish',
    },
  ];

  function startTutorial() {
    if (tutorial || state !== 'IDLE') return;
    tutorial = {
      step: -1,
      stash: { board, tray, score, best, inv, progress, frozen, freezeHold, streak, scoreLog, streakLog, undoSnapshot },
    };
    score = 0;
    undoSnapshot = null;
    setArming(false);
    setRerollArming(false);
    updateScoreDisplay(true);
    $('tutSkip').hidden = false;
    nextTutStep();
  }

  function endTutorial() {
    if (!tutorial) return;
    setArming(false);
    setRerollArming(false);
    const s = tutorial.stash;
    tutorial = null;
    board = s.board;
    tray = s.tray;
    score = s.score;
    best = s.best;
    inv = s.inv;
    progress = s.progress;
    frozen = s.frozen;
    freezeHold = s.freezeHold;
    streak = s.streak;
    scoreLog = s.scoreLog;
    streakLog = s.streakLog;
    undoSnapshot = s.undoSnapshot;
    meta.seenTutorial = true;
    coachEl.hidden = true;
    $('tutSkip').hidden = true;
    renderBoard();
    renderTray();
    updateItemsBar();
    updateScoreDisplay(true);
    updateStreakPill(false);
    state = 'IDLE';
    persist();
  }

  function tutAdvance() {
    if (tutorial) nextTutStep();
  }

  function nextTutStep() {
    tutorial.step++;
    if (tutorial.step >= TUT.length) { endTutorial(); return; }
    const s = TUT[tutorial.step];
    inv = zeroInv();
    progress = { pts: 0, flipPts: 0, combos: 0, fcombos: 0 };
    frozen = new Uint8Array(CELL_COUNT);
    freezeHold = false;
    streak = 0;
    scoreLog = [];
    streakLog = [];
    s.setup();
    renderBoard();
    renderTray();
    updateItemsBar();
    showCoach(s);
  }

  function showCoach(s) {
    $('coachText').textContent = s.text;
    const nextBtn = $('coachNext');
    nextBtn.hidden = !s.next;
    nextBtn.textContent = s.nextLabel || 'Next';
    coachEl.hidden = false;
    positionCoach(s.anchor());
  }

  /* Above the anchor when there is room, below it otherwise */
  function positionCoach(el) {
    const r = el.getBoundingClientRect();
    const cw = coachEl.offsetWidth;
    const ch = coachEl.offsetHeight;
    let x = r.left + r.width / 2 - cw / 2;
    x = Math.max(8, Math.min(document.documentElement.clientWidth - cw - 8, x));
    let y = r.top - ch - 12;
    if (y < 8) y = r.bottom + 12;
    coachEl.style.left = x + 'px';
    coachEl.style.top = y + 'px';
  }

  $('coachNext').addEventListener('click', () => { sound.tap(); tutAdvance(); });
  $('tutSkip').addEventListener('click', () => {
    if (state !== 'IDLE') return;
    sound.tap();
    endTutorial();
  });

  /* Offered exactly once to existing players, at their next new game */
  function maybeOfferTutorial() {
    if (meta.seenTutorial || meta.tutorialOffered || tutorial) return;
    meta.tutorialOffered = true;
    persist();
    $('tutOffer').hidden = false;
  }
  $('tutOfferYes').addEventListener('click', () => {
    sound.tap();
    $('tutOffer').hidden = true;
    startTutorial();
  });
  $('tutOfferNo').addEventListener('click', () => { sound.tap(); $('tutOffer').hidden = true; });
  $('replayTutorial').addEventListener('click', () => {
    sound.tap();
    settingsEl.hidden = true;
    startTutorial();
  });

  /* ---- Global leaderboard. Every call is best effort with a 5s timeout
     and never awaited by gameplay; offline play is completely unaffected.
     Beta deployments may view the board but never submit to it
     (BETA_LB_SUBMITS is the testing escape hatch). ---- */
  const lb = (() => {
    function identity() {
      try {
        const raw = JSON.parse(localStorage.getItem(LB_KEY));
        if (raw && typeof raw.playerId === 'string' && typeof raw.secret === 'string') return raw;
      } catch (err) { /* mint a fresh one */ }
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const fresh = {
        playerId: crypto.randomUUID(),
        secret: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
        bestSubmitted: 0,
      };
      saveIdentity(fresh);
      return fresh;
    }
    function saveIdentity(idn) {
      storeBlob(LB_KEY, JSON.stringify(idn));
    }

    async function call(path, opts) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      try {
        const res = await fetch(LEADERBOARD_URL.replace(/\/+$/, '') + path, { ...opts, signal: ctl.signal });
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    }

    /* bestSubmitted only advances when the server answers, so any failure
       retries at the next game over, panel open, or reconnect. */
    async function submitBest() {
      if (!LEADERBOARD_URL || (IS_BETA && !BETA_LB_SUBMITS)) return;
      const idn = identity();
      if (best <= (idn.bestSubmitted || 0)) return;
      try {
        const out = await call('/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            playerId: idn.playerId,
            secret: idn.secret,
            name: meta.nickname || PLAYER_NAME,
            score: best,
          }),
        });
        if (out && (out.accepted === true || out.accepted === false)) {
          idn.bestSubmitted = Math.max(best, out.best || 0);
          saveIdentity(idn);
        }
      } catch (err) { /* offline or slow; try again later */ }
    }

    async function fetchTop() {
      const out = await call('/top', { method: 'GET' });
      if (!out || !Array.isArray(out.scores)) throw new Error('bad payload');
      const scores = out.scores.slice(0, 50);
      storeBlob(LB_KEY + '-cache', JSON.stringify(scores));
      return scores;
    }

    function cachedTop() {
      try {
        const raw = JSON.parse(localStorage.getItem(LB_KEY + '-cache'));
        return Array.isArray(raw) ? raw : null;
      } catch (err) { return null; }
    }

    return { identity, submitBest, fetchTop, cachedTop };
  })();

  const lbPanelEl = $('lbPanel');
  const lbBodyEl = $('lbBody');

  /* Names come from strangers on the internet: textContent only, always. */
  function renderLb(scores, statusText) {
    lbBodyEl.textContent = '';
    if (statusText) {
      const p = document.createElement('p');
      p.className = 'lb-status';
      p.textContent = statusText;
      lbBodyEl.appendChild(p);
    }
    if (!scores || !scores.length) {
      if (!statusText) {
        const p = document.createElement('p');
        p.className = 'lb-status';
        p.textContent = 'No scores yet. Be the first!';
        lbBodyEl.appendChild(p);
      }
      return;
    }
    const myId = lb.identity().playerId;
    scores.forEach((row, i) => {
      const div = document.createElement('div');
      div.className = 'lb-row' + (row.id === myId ? ' me' : '');
      const rank = document.createElement('span');
      rank.className = 'lb-rank';
      rank.textContent = String(i + 1);
      const name = document.createElement('span');
      name.className = 'lb-name';
      name.textContent = String(row.name == null ? '?' : row.name);
      const pts = document.createElement('span');
      pts.className = 'lb-pts';
      pts.textContent = String(row.score);
      div.append(rank, name, pts);
      lbBodyEl.appendChild(div);
    });
  }

  async function openLeaderboard() {
    lbPanelEl.hidden = false;
    const cached = lb.cachedTop();
    renderLb(cached, cached ? 'Refreshing...' : 'Loading...');
    if (!nickPending) lb.submitBest(); /* natural retry point for an unsent best */
    try {
      renderLb(await lb.fetchTop());
    } catch (err) {
      renderLb(cached, cached ? 'Offline: showing the last scores' : 'Could not reach the leaderboard');
    }
  }

  if (LEADERBOARD_URL) {
    $('lbBtn').hidden = false;
    $('lbGameOver').hidden = false;
  }
  $('lbBtn').addEventListener('click', () => { sound.tap(); openLeaderboard(); });
  $('lbGameOver').addEventListener('click', () => { sound.tap(); resolveNickPrompt(); openLeaderboard(); });
  $('lbClose').addEventListener('click', () => { sound.tap(); lbPanelEl.hidden = true; });
  /* Her crown pill is a door to the leaderboard too */
  const bestPillEl = document.querySelector('.best-pill');
  bestPillEl.setAttribute('role', 'button');
  bestPillEl.setAttribute('aria-label', 'Show the leaderboard');
  bestPillEl.addEventListener('click', () => {
    if (!LEADERBOARD_URL || state !== 'IDLE' || tutorial) return;
    sound.tap();
    openLeaderboard();
  });
  window.addEventListener('online', () => { if (!nickPending) lb.submitBest(); });

  /* The score pill opens a log of recent breakdowns; the streak pill opens the
     live streak (it only takes taps while lit, via pointer-events in CSS). */
  const scorePillEl = document.querySelector('.score-pill');
  scorePillEl.setAttribute('role', 'button');
  scorePillEl.setAttribute('aria-label', 'Show recent scores');
  scorePillEl.addEventListener('click', () => {
    if (state !== 'IDLE' || tutorial) return;
    sound.tap();
    renderScorePanel();
    scorePanelEl.hidden = false;
  });
  streakPill.setAttribute('role', 'button');
  streakPill.setAttribute('aria-label', 'Show this streak');
  streakPill.addEventListener('click', () => {
    if (state !== 'IDLE' || tutorial) return;
    sound.tap();
    renderStreakPanel();
    streakPanelEl.hidden = false;
  });
  $('scorePanelClose').addEventListener('click', () => { sound.tap(); scorePanelEl.hidden = true; });
  $('streakPanelClose').addEventListener('click', () => { sound.tap(); streakPanelEl.hidden = true; });

  /* ---- Nickname prompt: shown once, on the first New Best game over, only
     when a leaderboard exists and no name is set yet. Any path that leaves the
     game-over card resolves it first so the best is submitted with the name. ---- */
  let nickPending = false;

  function resolveNickPrompt() {
    if (!nickPending) return;
    nickPending = false;
    const nm = sanitizeNickname($('nickPromptInput').value);
    if (nm) {
      meta.nickname = nm;
      persist();
    }
    $('nickPrompt').hidden = true;
    lb.submitBest();
  }

  $('nickPromptSave').addEventListener('click', () => { sound.tap(); resolveNickPrompt(); });
  $('nickPromptInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); resolveNickPrompt(); }
  });

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
    $('undoGameOver').hidden = !(inv.undo > 0 && undoSnapshot);
    const wantsNick = newBest && LEADERBOARD_URL && !meta.nickname && !meta.nickPrompted;
    const nickEl = $('nickPrompt');
    if (wantsNick) {
      $('nickPromptInput').value = '';
      nickEl.hidden = false;
      nickPending = true;
      meta.nickPrompted = true;
      persist();
    } else {
      nickEl.hidden = true;
      lb.submitBest();
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
    logAction('new game');
    undoSnapshot = null;
    setArming(false);
    setRerollArming(false);
    renderBoard();
    renderTray();
    updateItemsBar();
    updateScoreDisplay(true);
    updateStreakPill(false);
    persist();
    gameOverEl.classList.remove('show');
    gameOverEl.hidden = true;
    confirmEl.hidden = true;
    state = 'IDLE';
    maybeOfferTutorial();
  }

  /* Beta test panel: swap the live game for a hand-built scenario. Mirrors
     resetGame's render/persist tail. Presets carry no frozen cells, streak,
     or history, and never offer the tutorial. */
  function applyScenario(id) {
    if (state !== 'IDLE' || tutorial) return;
    const s = buildScenario(id, rng);
    if (!s) return;
    logAction('scenario ' + id);
    board = s.board;
    tray = s.tray;
    score = s.score;
    inv = s.inv;
    progress = { pts: 0, flipPts: 0, combos: 0, fcombos: 0 };
    frozen = new Uint8Array(CELL_COUNT);
    freezeHold = false;
    streak = 0;
    scoreLog = [];
    streakLog = [];
    undoSnapshot = null;
    setArming(false);
    setRerollArming(false);
    renderBoard();
    renderTray();
    updateItemsBar();
    updateScoreDisplay(true);
    updateStreakPill(false);
    persist();
  }

  $('playAgain').addEventListener('click', () => { sound.tap(); resolveNickPrompt(); resetGame(); });
  $('restartBtn').addEventListener('click', () => {
    if (state !== 'IDLE' || tutorial) return;
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

  /* ---- Settings ---- */
  const settingsEl = $('settings');
  const volSlider = $('volSlider');
  const nickInput = $('nickInput');
  const themeButtons = Array.from(document.querySelectorAll('#themeSeg button'));
  const themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  /* Build/version line: composed once from the constants (never hardcoded)
     so a stale service worker is easy to spot at the bottom of Settings. */
  const versionLine = $('versionLine');
  if (versionLine) {
    versionLine.textContent = APP_VERSION + ' (build ' + APP_BUILD + (IS_BETA ? ', beta' : '') + ')';
  }

  /* 'auto' follows the system; the resolved value is always stamped on the
     root so the CSS only ever has to know about data-theme="dark". */
  function applyTheme() {
    const dark = meta.theme === 'dark' || (meta.theme === 'auto' && !!(themeMedia && themeMedia.matches));
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.setAttribute('content', dark ? '#2A1436' : '#8A4FBF');
  }
  if (themeMedia) {
    const followSystem = () => { if (meta.theme === 'auto') applyTheme(); };
    if (themeMedia.addEventListener) themeMedia.addEventListener('change', followSystem);
    else if (themeMedia.addListener) themeMedia.addListener(followSystem);
  }

  function syncSettingsUI() {
    volSlider.value = String(meta.volume);
    nickInput.value = meta.nickname;
    for (const b of themeButtons) {
      b.setAttribute('aria-pressed', String(b.dataset.themeChoice === meta.theme));
    }
  }

  $('settingsBtn').addEventListener('click', () => {
    if (state !== 'IDLE' || tutorial) return;
    sound.tap();
    setArming(false);
    setRerollArming(false);
    syncSettingsUI();
    settingsEl.hidden = false;
  });
  $('settingsDone').addEventListener('click', () => {
    sound.tap();
    settingsEl.hidden = true;
    persist();
  });
  $('scoreHelpBtn').addEventListener('click', () => { sound.tap(); openScoreHelp(); });

  /* "What's new": per-release summaries next to the version line, latest
     first. Built fresh on every open; the overlay sits later in the DOM than
     Settings, so it paints on top without hiding it (like the scoring sheet). */
  $('whatsNewBtn').addEventListener('click', () => {
    sound.tap();
    const body = $('releaseNotesBody');
    body.textContent = '';
    for (const rel of RELEASE_NOTES) {
      const h = document.createElement('h3');
      h.textContent = rel.version + ' · ' + rel.date;
      body.appendChild(h);
      const ul = document.createElement('ul');
      ul.className = 'notes-list';
      for (const note of rel.notes) {
        const li = document.createElement('li');
        li.textContent = note;
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }
    $('releaseNotes').hidden = false;
  });
  $('releaseNotesClose').addEventListener('click', () => {
    sound.tap();
    $('releaseNotes').hidden = true;
  });

  /* Reset all data: wipe both stores, then boot as a fresh install.
     Order matters: block re-writes first, then IDB (bounded wait, so a hung
     delete can never trap the user), then localStorage, then reload. Per-key
     idb.del, never deleteDatabase: our open connection would block it, and it
     would nuke the other channel's mirror. NEVER localStorage.clear(): the
     github.io origin is shared across repos. Resetting one channel also forgets
     the shared leaderboard identity for the other, but the server keeps her scores. */
  async function resetAllData() {
    wiping = true;
    settingsEl.hidden = true;
    $('confirmReset').hidden = true;
    const grace = new Promise((res) => setTimeout(res, 800));
    try {
      await Promise.race([Promise.all(MIRROR_KEYS.map((k) => idb.del(k))), grace]);
    } catch (err) { /* still reload */ }
    for (const key of MIRROR_KEYS) {
      try { localStorage.removeItem(key); } catch (err) { /* ignore */ }
    }
    location.reload();
  }
  /* Settings must step aside while the confirm is up: both are .overlay and
     settings comes later in the DOM, so it would paint on top of the card. */
  $('resetData').addEventListener('click', () => {
    sound.tap();
    settingsEl.hidden = true;
    $('confirmReset').hidden = false;
  });
  $('confirmResetNo').addEventListener('click', () => {
    sound.tap();
    $('confirmReset').hidden = true;
    settingsEl.hidden = false;
  });
  $('confirmResetYes').addEventListener('click', () => { sound.tap(); resetAllData(); });

  let volPreviewAt = 0;
  volSlider.addEventListener('input', () => {
    meta.volume = Math.max(0, Math.min(100, Number(volSlider.value) || 0));
    sound.setVolume(meta.volume);
    if (sound.isMuted()) { sound.setMuted(false); updateMuteBtn(); }
    const now = performance.now();
    if (now - volPreviewAt > 160) { volPreviewAt = now; sound.tap(); }
  });
  volSlider.addEventListener('change', () => persist());

  themeButtons.forEach((b) => b.addEventListener('click', () => {
    sound.tap();
    meta.theme = b.dataset.themeChoice;
    applyTheme();
    syncSettingsUI();
    persist();
  }));

  nickInput.addEventListener('change', () => {
    meta.nickname = sanitizeNickname(nickInput.value);
    nickInput.value = meta.nickname;
    persist();
  });

  splashEl.addEventListener('pointerup', () => {
    if (state !== 'SPLASH') return;
    sound.unlock();
    splashEl.classList.add('gone');
    setTimeout(() => { splashEl.hidden = true; }, 400);
    state = 'IDLE';
    /* Brand-new player: walk her through it (skippable) */
    if (!hadSave && !meta.seenTutorial) startTutorial();
  });

  /* ---- Persistence ---- */
  let wiping = false; /* Reset all data: block every re-write until the reload */

  /* localStorage first (synchronous, survives unload), then the IDB mirror.
     Independent try blocks: a quota-dead localStorage must not starve IDB. */
  function storeBlob(key, blob) {
    if (wiping) return;
    try { localStorage.setItem(key, blob); } catch (err) { /* ignore */ }
    idb.put(key, blob);
  }

  function persist() {
    try {
      if (tutorial) return; /* the tutorial never touches the real save */
      meta.best = best;
      meta.muted = sound.isMuted();
      const over = state === 'GAME_OVER' || isGameOverWithItems(board, tray, inv.rotate, inv.reroll, inv.flip);
      const game = over ? null : encodeGame({ board, tray, score, inv, progress, frozen, freezeHold, streak, scoreLog, streakLog });
      storeBlob(SAVE_KEY, JSON.stringify({ v: 2, ...meta, game }));
    } catch (err) { /* storage may be unavailable; play on */ }
  }

  function freshGameState() {
    board = emptyBoard();
    score = 0;
    inv = BETA_STARTER_ITEMS ? fillInv(1) : zeroInv();
    progress = { pts: 0, flipPts: 0, combos: 0, fcombos: 0 };
    frozen = new Uint8Array(CELL_COUNT);
    freezeHold = false;
    streak = 0;
    scoreLog = [];
    streakLog = [];
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
    if (game && !isGameOverWithItems(game.board, game.tray, game.inv.rotate, game.inv.reroll, game.inv.flip)) {
      board = game.board;
      tray = game.tray;
      score = game.score;
      inv = game.inv;
      progress = game.progress;
      frozen = game.frozen;
      freezeHold = game.freezeHold;
      streak = game.streak;
      scoreLog = game.scoreLog;
      streakLog = game.streakLog;
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
  /* iOS often skips visibilitychange on a real close; pagehide is the reliable
     last chance to flush. storeBlob's wiping guard keeps this quiet on reset. */
  window.addEventListener('pagehide', () => {
    if (state === 'IDLE' || state === 'RESOLVING') persist();
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
    /* Re-request at every boot until the browser grants it. */
    const check = navigator.storage.persisted
      ? navigator.storage.persisted().then((ok) => ok || navigator.storage.persist())
      : navigator.storage.persist();
    check.catch(() => {});
  }

  /* ---- Boot ---- */
  if (IS_BETA) {
    const tag = document.createElement('span');
    tag.className = 'beta-tag';
    tag.textContent = 'BETA';
    $('title').appendChild(tag);
  }

  restore();
  mirrorAllToIdb(); /* re-sync the IDB backup with whatever localStorage holds */

  /* ---- Beta test panel: scenario presets + generation overrides. Wired
     after restore() so the persisted switches in meta.testTools can be
     applied immediately. Production never enters this block, so the
     pieces.js overrides stay inert there by construction. ---- */
  if (IS_BETA) {
    const testToolsEl = $('testTools');
    const testToolsBtn = $('testToolsBtn');
    const reroll1x1Toggle = $('reroll1x1Toggle');
    testToolsBtn.hidden = false;

    const scenarioList = $('testScenarioList');
    for (const s of SCENARIOS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-ghost';
      b.textContent = s.label;
      b.addEventListener('click', () => {
        sound.tap();
        testToolsEl.hidden = true;
        applyScenario(s.id);
      });
      scenarioList.appendChild(b);
    }

    const buildChecks = (host, entries, key) => entries.map(({ idxVal, text }) => {
      const label = document.createElement('label');
      label.className = 'check-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset[key] = String(idxVal);
      label.append(box, document.createTextNode(' ' + text));
      host.appendChild(label);
      return box;
    });
    const classBoxes = buildChecks($('classFilterList'),
      SHAPE_CLASS_META.map((m) => ({ idxVal: m.classIdx, text: m.name })), 'classIdx');
    const iconBoxes = buildChecks($('iconFilterList'),
      ICONS.map((icon, i) => ({ idxVal: i, text: icon })), 'iconIdx');

    /* meta.testTools is the single source of truth; the pieces.js setters
       are re-applied from it on every change and once here at boot. */
    const applyGenOverrides = () => {
      setRerollForce1x1(meta.testTools.reroll1x1);
      setShapeClassFilter(meta.testTools.classes);
      setIconFilter(meta.testTools.icons);
    };
    const syncTestToolsUI = () => {
      reroll1x1Toggle.checked = meta.testTools.reroll1x1;
      for (const box of classBoxes) {
        box.checked = !meta.testTools.classes || meta.testTools.classes.includes(Number(box.dataset.classIdx));
      }
      for (const box of iconBoxes) {
        box.checked = !meta.testTools.icons || meta.testTools.icons.includes(Number(box.dataset.iconIdx));
      }
    };
    /* An all-or-none selection means "no filter" (stored as null), and the
       boxes snap back to all checked so the panel never shows a dead state. */
    const readFilter = (boxes, key) => {
      const chosen = [];
      for (const b of boxes) if (b.checked) chosen.push(Number(b.dataset[key]));
      return (chosen.length === 0 || chosen.length === boxes.length) ? null : chosen;
    };
    const onFilterChange = () => {
      meta.testTools.classes = readFilter(classBoxes, 'classIdx');
      meta.testTools.icons = readFilter(iconBoxes, 'iconIdx');
      applyGenOverrides();
      syncTestToolsUI();
      persist();
    };
    classBoxes.forEach((b) => b.addEventListener('change', onFilterChange));
    iconBoxes.forEach((b) => b.addEventListener('change', onFilterChange));
    reroll1x1Toggle.addEventListener('change', () => {
      meta.testTools.reroll1x1 = reroll1x1Toggle.checked;
      applyGenOverrides();
      persist();
    });
    $('classFilterAll').addEventListener('click', () => {
      sound.tap();
      meta.testTools.classes = null;
      meta.testTools.icons = null;
      applyGenOverrides();
      syncTestToolsUI();
      persist();
    });

    /* Settings steps aside while the panel is up (same dance as the reset
       confirm: both are overlays and DOM order decides who paints on top). */
    testToolsBtn.addEventListener('click', () => {
      sound.tap();
      settingsEl.hidden = true;
      syncTestToolsUI();
      testToolsEl.hidden = false;
    });
    $('testToolsDone').addEventListener('click', () => {
      sound.tap();
      testToolsEl.hidden = true;
      settingsEl.hidden = false;
    });

    /* ---- Bug reports: capture to clipboard/share, load from a paste ---- */
    const bugPasteEl = $('bugPaste');

    async function copyBugReport() {
      const text = buildBugReport();
      bugPasteEl.value = text; /* the box doubles as a manual copy source */
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (err) { /* clipboard can be denied; the box still has the text */ }
      showToast('item-toast', copied
        ? '\u{1F41E} Bug report copied! Send it to Thomas \u{1F49C}'
        : '\u{1F41E} Report is in the box in Test scenarios: long-press to copy');
      logAction('bug report captured');
      persist();
    }
    $('bugCopy').addEventListener('click', () => { sound.tap(); copyBugReport(); });
    $('bugGameOver').hidden = false;
    $('bugGameOver').addEventListener('click', () => { sound.tap(); copyBugReport(); });
    if (navigator.share) {
      const shareBtn = $('bugShare');
      shareBtn.hidden = false;
      shareBtn.addEventListener('click', async () => {
        sound.tap();
        try {
          await navigator.share({ title: 'Lizard Blockdoku bug report', text: buildBugReport() });
          logAction('bug report shared');
          persist();
        } catch (err) { /* share sheet dismissed */ }
      });
    }

    /* Load a pasted report (or raw save, or bare game object). Everything
       funnels through validateSave, so a mangled paste can never corrupt the
       live game: it just toasts and changes nothing. */
    function loadFromPaste(which) {
      if (state !== 'IDLE' || tutorial) return;
      let raw = null;
      try { raw = JSON.parse(bugPasteEl.value); } catch (err) {
        showToast('item-toast', '\u{1F41E} That does not parse as a report');
        return;
      }
      let gameObj = raw;
      if (raw && typeof raw === 'object') {
        if (raw.type === 'lizard-blockdoku-bug-report') gameObj = which === 'before' ? raw.beforeLastMove : raw.game;
        else if (raw.game !== undefined) gameObj = raw.game;
      }
      if (which === 'before' && !gameObj) {
        showToast('item-toast', '\u{1F41E} No pre-move state in this report');
        return;
      }
      const validated = validateSave({ v: 2, game: gameObj });
      if (!validated.game) {
        showToast('item-toast', '\u{1F41E} That state did not validate');
        return;
      }
      const g = validated.game;
      logAction('import ' + (which === 'before' ? 'pre-move state' : 'state'));
      board = g.board;
      tray = g.tray;
      if (tray.every((p) => p === null)) tray = genTray(board, rng);
      score = g.score;
      inv = g.inv;
      progress = g.progress;
      frozen = g.frozen;
      freezeHold = g.freezeHold;
      streak = g.streak;
      scoreLog = g.scoreLog;
      streakLog = g.streakLog;
      undoSnapshot = null;
      setArming(false);
      setRerollArming(false);
      renderBoard();
      renderTray();
      updateItemsBar();
      updateScoreDisplay(true);
      updateStreakPill(false);
      persist();
      testToolsEl.hidden = true;
      /* A dead-end import (game over, no rescuing items) renders fine for
         inspection, but persist() nulls finished games, so a reload will
         discard it. Say so up front instead of letting it vanish quietly. */
      if (isGameOver(board, tray) && isGameOverWithItems(board, tray, inv.rotate, inv.reroll, inv.flip)) {
        showToast('item-toast', '\u{1F41E} Loaded a dead-end state: look now, it will not survive a reload');
      } else {
        showToast('item-toast', '\u{1F41E} State loaded');
      }
    }
    $('bugLoad').addEventListener('click', () => { sound.tap(); loadFromPaste('game'); });
    $('bugLoadBefore').addEventListener('click', () => { sound.tap(); loadFromPaste('before'); });

    applyGenOverrides();
    logAction('boot build ' + APP_BUILD);
  }

  sound.setVolume(meta.volume);
  applyTheme();
  relayout();
  initHelpDiagrams();
  renderBoard();
  renderTray();
  updateItemsBar();
  updateScoreDisplay(true);
  updateStreakPill(false);
  updateMuteBtn();
}
