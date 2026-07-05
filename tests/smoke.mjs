// End-to-end smoke test: drives the real game in Chrome with a phone-sized
// viewport. Run with the local server up: node tests/smoke.mjs
import { chromium, webkit } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8080';
const ART = new URL('./artifacts/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(ART, { recursive: true });

let failures = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log('  ok: ' + name);
  } else {
    failures++;
    console.error('  FAIL: ' + name + (extra ? ' (' + extra + ')' : ''));
  }
}

/* Default drives real Chrome; BROWSER=webkit drives Safari's engine (WebKit),
   the only way to catch the Safari-only drag/placement issues Chrome hides. */
const ENGINE = process.env.BROWSER || 'chrome';
console.log('engine: ' + ENGINE);
const browser = ENGINE === 'webkit'
  ? await webkit.launch({ headless: true })
  : await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

const consoleErrors = [];
const page = await context.newPage();
await page.addInitScript(() => { window.__NO_DRAG_ACCEL__ = true; }); // test the plain finger->cell mapping
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

async function dismissSplash() {
  await page.waitForSelector('#splash:not([hidden])');
  await page.tap('#splash');
  await page.waitForSelector('#splash', { state: 'hidden' });
}

/* Write a crafted save from a neutral same-origin page, because the game
   itself autosaves on visibilitychange and would clobber a direct write. */
async function injectSave(save) {
  await page.goto(BASE + '/tools/icon-maker.html');
  await page.evaluate((s) => localStorage.setItem('lizard-blockdoku-v1', JSON.stringify(s)), save);
  await page.goto(BASE);
  await page.waitForSelector('.cell');
  await dismissSplash();
}

async function getGeometry() {
  return page.evaluate(() => {
    const r = document.getElementById('board').getBoundingClientRect();
    const cell = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell'));
    return { boardLeft: r.left, boardTop: r.top, cell };
  });
}

/* Drag the piece in a tray slot so its shape lands with its top-left at
   board cell (row, col). Accounts for the 70px ghost lift. */
async function dragPiece(slotIndex, row, col) {
  const { boardLeft, boardTop, cell } = await getGeometry();
  const slot = page.locator('.slot').nth(slotIndex);
  const box = await slot.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(350); // let the pick-up pop-out settle before measuring the ghost
  const ghostBox = await page.locator('#ghost .piece').boundingBox();
  const px = boardLeft + col * cell + ghostBox.width / 2;
  const py = boardTop + row * cell + ghostBox.height + 70;
  await page.mouse.move(px, py, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.up();
}

const filledCount = () => page.locator('.cell.filled').count();
const score = () => page.locator('#scoreVal').textContent().then(Number);

console.log('1. Cold load, fresh game');
await page.goto(BASE);
await page.waitForSelector('.cell');
check('81 board cells', (await page.locator('.cell').count()) === 81);
await dismissSplash();
check('new player auto-starts the tutorial', (await page.locator('#coach:not([hidden])').count()) === 1);
check('tutorial never touches the save', (await page.evaluate(() => localStorage.getItem('lizard-blockdoku-v1'))) === null);
await page.tap('#tutSkip');
await page.waitForTimeout(200);
check('skip ends the tutorial', (await page.locator('#coach:not([hidden])').count()) === 0);
check('3 tray pieces', (await page.locator('.slot .piece').count()) === 3);
check('score starts at 0', (await score()) === 0);
await page.screenshot({ path: ART + 'mobile-fresh.png' });

console.log('2. Drag-and-drop placement');
// Regression (v2.3 immediate tracking): a picked-up piece tracks the finger
// exactly, after a brief 90ms ease-out that lets it flow out of its tray slot.
// With the finger held still on the slot, the ghost settles centered on the
// slot horizontally and lifted GHOST_LIFT (70px) above the finger, so its box
// sits above the slot by the lift plus half the piece height. We measure the
// #ghost CONTAINER, whose box is stable (the scale pop lives on the .piece
// child and transforms do not change layout), so tall pieces no longer read as
// a huge stray the way the old #ghost .piece sample did. Horizontal stray stays
// tiny; vertically the ghost never drops below the slot. A bare down/up places
// nothing, so the piece snaps back and the placement checks below run on it.
{
  const slotBox = await page.locator('.slot').nth(0).boundingBox();
  const slotCx = slotBox.x + slotBox.width / 2;
  const slotCy = slotBox.y + slotBox.height / 2;
  await page.mouse.move(slotCx, slotCy);
  await page.mouse.down();
  await page.waitForTimeout(350); // let the pickup blend finish before measuring
  const gb = await page.locator('#ghost').boundingBox();
  const ghostCx = gb.x + gb.width / 2;
  const ghostCy = gb.y + gb.height / 2;
  const ghostH = gb.height;
  await page.mouse.up(); // no movement: the piece snaps back to its slot
  await page.waitForTimeout(300);
  check('pickup stays horizontally over the slot', Math.abs(ghostCx - slotCx) < 50,
    'ghost dx = ' + (ghostCx - slotCx).toFixed(0) + 'px');
  check('pickup lifts up out of the slot, never sits below it',
    ghostCy > slotCy - (70 + ghostH / 2) - 40 && ghostCy < slotCy + 40,
    'ghostCy=' + ghostCy.toFixed(0) + ' slotCy=' + slotCy.toFixed(0) + ' ghostH=' + ghostH.toFixed(0));
  check('bare pickup left the piece in slot 0',
    (await page.locator('.slot').nth(0).locator('.piece').count()) === 1);
}
const cellsInPiece = await page.locator('.slot').nth(0).locator('.pcell').count();
await dragPiece(0, 3, 3);
await page.waitForTimeout(600);
check('piece placed on board', (await filledCount()) === cellsInPiece, 'filled=' + (await filledCount()) + ' expected=' + cellsInPiece);
check('slot 0 now empty', (await page.locator('.slot').nth(0).locator('.piece').count()) === 0);
check('score = piece size', (await score()) === cellsInPiece, 'score=' + (await score()));
await page.screenshot({ path: ART + 'mobile-placed.png' });

console.log('3. Save and resume across reload');
const scoreBefore = await score();
const filledBefore = await filledCount();
await page.reload();
await page.waitForSelector('.cell');
await dismissSplash();
check('score persisted', (await score()) === scoreBefore, 'score=' + (await score()));
check('board persisted', (await filledCount()) === filledBefore);

console.log('4. Crafted row: invalid drop, then clear with icon bonuses');
// Row 0: icons [1,1,1,2,2,2,3,3] in cols 0..7, col 8 empty.
// Tray: Single(icon 4), Line2-H(icon 2), Line2-V(icon 3).
{
  const board = new Array(81).fill(-1);
  [1, 1, 1, 2, 2, 2, 3, 3].forEach((icon, c) => { board[c] = icon; });
  await injectSave({
    v: 1, best: 5,
    game: { board, tray: [{ shapeId: 0, icon: 4 }, { shapeId: 1, icon: 2 }, { shapeId: 2, icon: 3 }], score: 100 },
  });
}
check('crafted board restored', (await filledCount()) === 8, 'filled=' + (await filledCount()));
check('crafted score restored', (await score()) === 100);

// Line2-H onto occupied (0,0)+(0,1): must snap back.
await dragPiece(1, 0, 0);
await page.waitForTimeout(400);
check('invalid drop leaves board unchanged', (await filledCount()) === 8);
check('invalid drop returns piece to tray', (await page.locator('.slot').nth(1).locator('.piece').count()) === 1);

// A bare tap on a tray piece must never place it (no movement threshold met).
{
  const slotBox = await page.locator('.slot').nth(1).boundingBox();
  await page.mouse.move(slotBox.x + slotBox.width / 2, slotBox.y + slotBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);
  check('bare tap does not place a piece', (await filledCount()) === 8);
  check('bare tap keeps the piece in the tray', (await page.locator('.slot').nth(1).locator('.piece').count()) === 1);
}

// Single at (0,8) completes the row: +1 place, +18 clear, +10 flowers, +10 hearts.
await dragPiece(0, 0, 8);
await page.waitForTimeout(150);
const toastText = await page.locator('.toast.score-toast').textContent();
check('score toast shows the breakdown', toastText.includes('Placement+1') && toastText.includes('Clear x1+18'), toastText);
check('score toast lists both icon bonuses', (toastText.match(/\+10/g) || []).length === 2, toastText);
check('score toast shows the total', toastText.includes('Total+39'), toastText);
await page.tap('.toast.score-toast');
await page.waitForTimeout(400);
check('tapping dismisses the toast', (await page.locator('.toast').count()) === 0);
check('tapping the toast opens the scoring sheet', (await page.locator('#scoreHelp:not([hidden])').count()) === 1);
await page.tap('#scoreHelpClose');
check('scoring sheet closes', (await page.locator('#scoreHelp:not([hidden])').count()) === 0);
await page.waitForTimeout(500);
check('row cleared', (await filledCount()) === 0, 'filled=' + (await filledCount()));
check('score 139 after clear with two icon bonuses', (await score()) === 139, 'score=' + (await score()));

console.log('5. Game over with new best');
// Holes at (r, r) and (r, (r+4) % 9): every row, column AND box keeps at
// least one hole, so nothing is pre-completed and placing one single
// completes nothing. A plus5 needs 3 consecutive empties in a row and rows
// only have 2 holes, so after the single is placed the game is over.
{
  const board = new Array(81).fill(1);
  for (let r = 0; r < 9; r++) { board[r * 9 + r] = -1; board[r * 9 + ((r + 4) % 9)] = -1; }
  await injectSave({
    v: 1, best: 5,
    game: { board, tray: [{ shapeId: 0, icon: 4 }, { shapeId: 38, icon: 1 }, { shapeId: 38, icon: 2 }], score: 100 },
  });
}
check('game-over board restored', (await filledCount()) === 63, 'filled=' + (await filledCount()));
await dragPiece(0, 0, 0);
await page.waitForSelector('#gameOver.show', { timeout: 5000 });
check('game over shown', true);
check('final score 101', (await page.locator('#finalScore').textContent()) === '101');
const headline = await page.locator('#gameOverTitle').textContent();
check('new best headline', headline.includes('New Best'), headline);
check('no nickname prompt without a leaderboard URL', (await page.locator('#nickPrompt:not([hidden])').count()) === 0);
await page.screenshot({ path: ART + 'mobile-gameover.png' });
await page.tap('#playAgain');
await page.waitForTimeout(300);
check('play again resets', (await score()) === 0 && (await filledCount()) === 0);
check('best kept after reset', (await page.locator('#bestVal').textContent()) === '101');

console.log('6. Service worker: offline reload');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForTimeout(800); // let precache finish
if (ENGINE === 'webkit') {
  /* Playwright's WebKit errors on offline navigation, so reload online (keeps
     the flow: splash reappears) and skip the offline-specific assertion. */
  await page.reload();
  console.log('  (offline reload assertion skipped under webkit)');
} else {
  await context.setOffline(true);
  await page.reload();
  const offlineCells = await page.locator('.cell').count().catch(() => 0);
  check('offline reload renders the game', offlineCells === 81, 'cells=' + offlineCells);
  await context.setOffline(false);
}

console.log('7. Restart flow');
await dismissSplash();
await page.tap('#restartBtn');
await page.waitForSelector('#confirmRestart:not([hidden])');
await page.tap('#confirmYes');
await page.waitForTimeout(200);
check('restart resets score', (await score()) === 0);
check('restart clears board', (await filledCount()) === 0);
check('restart deals a fresh tray', (await page.locator('.slot .piece').count()) === 3);

console.log('7b. Mute toggle persists');
const MUTED = '\u{1F507}', UNMUTED = '\u{1F50A}';
check('sound starts unmuted', (await page.locator('#muteBtn').textContent()).includes(UNMUTED));
await page.tap('#muteBtn');
check('mute button toggles', (await page.locator('#muteBtn').textContent()).includes(MUTED));
await page.reload();
await page.waitForSelector('.cell');
await dismissSplash();
check('mute persisted across reload', (await page.locator('#muteBtn').textContent()).includes(MUTED));
await page.tap('#muteBtn');
check('unmute works', (await page.locator('#muteBtn').textContent()).includes(UNMUTED));

console.log('7c. Settings: volume, dark mode, nickname');
await page.tap('#muteBtn'); // mute, then verify the volume slider unmutes
await page.tap('#settingsBtn');
await page.waitForSelector('#settings:not([hidden])');
{
  const vl = page.locator('#versionLine');
  const vText = await vl.textContent();
  // localhost is the production (non-beta) channel: no ', beta' suffix.
  check('settings shows the build version', (await vl.count()) === 1 && /^v\d+\.\d+ \(build \d+\)$/.test(vText), vText);
}
await page.locator('#volSlider').fill('80');
check('volume slider unmutes', (await page.locator('#muteBtn').textContent()).includes(UNMUTED));
await page.tap('#themeSeg button[data-theme-choice="dark"]');
check('dark theme stamped on root', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
await page.fill('#nickInput', '  Liz<z>ard!  ');
await page.locator('#nickInput').blur();
check('nickname sanitized on entry', (await page.locator('#nickInput').inputValue()) === 'Lizzard!');
await page.tap('#settingsDone');
await page.reload();
await page.waitForSelector('.cell');
await dismissSplash();
check('dark theme persists across reload', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
await page.tap('#settingsBtn');
await page.waitForSelector('#settings:not([hidden])');
check('volume persisted', (await page.locator('#volSlider').inputValue()) === '80');
check('nickname persisted', (await page.locator('#nickInput').inputValue()) === 'Lizzard!');
check('dark button shows pressed', (await page.locator('#themeSeg button[data-theme-choice="dark"]').getAttribute('aria-pressed')) === 'true');
await page.tap('#themeSeg button[data-theme-choice="light"]');
check('light theme stamped on root', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
await page.tap('#themeSeg button[data-theme-choice="auto"]');
await page.tap('#scoreHelpBtn');
check('scoring sheet opens from settings', (await page.locator('#scoreHelp:not([hidden])').count()) === 1);
{
  const sheetText = await page.locator('#scoreHelp .help-body').textContent();
  check('sheet explains item earning', sheetText.includes('Rotate') && sheetText.includes('every 200 points')
    && sheetText.includes('Undo') && sheetText.includes('Freeze') && sheetText.includes('Reroll'));
  check('sheet gives scoring examples', (await page.locator('#scoreHelp .ex').count()) >= 10);
  check('sheet draws seven mini board diagrams', (await page.locator('#scoreHelp .mini').count()) === 7);
}
await page.tap('#scoreHelpClose');
await page.tap('#settingsDone');
await page.waitForTimeout(100);

console.log('7d. Items: rotate charges, cancels with a refund, and spins full circle');
// Slot 0 L4 (shape 16, period 4), slot 1 Line3-H (shape 5, period 2),
// slot 2 Square (shape 13, symmetric). Two rotates held.
{
  const board = new Array(81).fill(-1);
  await injectSave({
    v: 2, best: 5,
    game: {
      board, tray: [{ shapeId: 16, icon: 2 }, { shapeId: 5, icon: 3 }, { shapeId: 13, icon: 4 }],
      score: 0, inv: { rotate: 2, undo: 0, freeze: 0 }, progress: { pts: 0, combos: 0 },
    },
  });
}
const rotCnt = () => page.locator('#itemRotate .cnt').textContent();
const savedPiece = (slot) => page.evaluate((s) =>
  JSON.parse(localStorage.getItem('lizard-blockdoku-v1')).game.tray[s], slot);

check('rotate count badge shows 2', (await rotCnt()) === '2');
check('symmetric square shows no rotate button', (await page.locator('.slot .rot-btn').count()) === 2);

// Slot 1 Line3-H: first tap charges one Rotate and opens a free spin session.
await page.locator('.slot').nth(1).locator('.rot-btn').tap();
await page.waitForTimeout(300);
check('charge spends one rotate', (await rotCnt()) === '1');
check('charged piece shows the free-spin style', (await page.locator('.slot').nth(1).locator('.rot-btn.free').count()) === 1);
check('bar icon spins during a free session', (await page.locator('#itemRotate.spinning').count()) === 1);
{
  const p = await savedPiece(1);
  check('charge remembers the original orientation', p.rotFree === true && p.rotOrig === 5, JSON.stringify(p));
}
// Second tap on the period-2 piece spins back to the start: cancel + refund.
await page.locator('.slot').nth(1).locator('.rot-btn').tap();
await page.waitForTimeout(300);
check('cancel refunds the rotate back to 2', (await rotCnt()) === '2');
{
  const p = await savedPiece(1);
  check('cancel strips the spin flags', p.shapeId === 5 && p.rotFree === undefined && p.rotOrig === undefined, JSON.stringify(p));
}
check('spinner stops after cancel', (await page.locator('#itemRotate.spinning').count()) === 0);
{
  const t = await page.locator('.toast.item-toast').last().textContent();
  check('cancel toast says the rotate came back', t.includes('Rotate returned'), t);
}

// Slot 0 L4 (period 4): spin a full circle back to the start, without
// hardcoding the intermediate orientation ids (walk until it returns).
const startShape = (await savedPiece(0)).shapeId;
let orbitTaps = 0;
do {
  await page.locator('.slot').nth(0).locator('.rot-btn').tap();
  await page.waitForTimeout(250);
  orbitTaps++;
} while ((await savedPiece(0)).shapeId !== startShape && orbitTaps < 8);
check('L4 returned to its starting orientation', (await savedPiece(0)).shapeId === startShape, 'taps=' + orbitTaps);
check('a full orbit ends back at 2 rotates', (await rotCnt()) === '2');
// One more tap re-charges the session from the start.
await page.locator('.slot').nth(0).locator('.rot-btn').tap();
await page.waitForTimeout(250);
check('re-charging after a full circle costs a rotate', (await rotCnt()) === '1');

console.log('7e. Items: first-earn help card');
// progress.pts 199: placing the single (+1 point) crosses 200 = 1 rotate.
{
  const board = new Array(81).fill(-1);
  await injectSave({
    v: 2, best: 5,
    game: {
      board, tray: [{ shapeId: 0, icon: 3 }, { shapeId: 0, icon: 4 }, { shapeId: 1, icon: 1 }],
      score: 199, inv: { rotate: 0, undo: 0, freeze: 0 }, progress: { pts: 199, combos: 0 },
    },
  });
}
await dragPiece(0, 4, 4);
await page.waitForSelector('#itemHelp:not([hidden])', { timeout: 4000 });
check('first-earn help card appears', true);
check('help card explains Rotate', (await page.locator('#itemHelpTitle').textContent()).includes('Rotate'));
await page.tap('#itemHelpOk');
await page.waitForTimeout(100);
check('help card dismisses', (await page.locator('#itemHelp:not([hidden])').count()) === 0);
check('earned rotate shows in the bar', (await page.locator('#itemRotate .cnt').textContent()) === '1');

console.log('7f. Items: undo a placement');
{
  const board = new Array(81).fill(-1);
  await injectSave({
    v: 2, best: 500,
    game: {
      board, tray: [{ shapeId: 13, icon: 2 }, { shapeId: 0, icon: 3 }, { shapeId: 1, icon: 4 }],
      score: 50, inv: { rotate: 0, undo: 1, freeze: 0 }, progress: { pts: 0, combos: 0 },
    },
  });
}
await dragPiece(0, 2, 2); // 2x2 square
await page.waitForTimeout(600);
check('square placed before undo', (await filledCount()) === 4);
check('score counted the square', (await score()) === 54);
await page.tap('#itemUndo');
await page.waitForTimeout(300);
check('undo restores the board', (await filledCount()) === 0);
check('undo rewinds the score', (await score()) === 50);
check('undo returns the piece to its slot', (await page.locator('.slot').nth(0).locator('.piece').count()) === 1);
check('undo consumed', (await page.locator('#itemUndo[disabled]').count()) === 1);

console.log('7g. Undo from game over');
{
  const board = new Array(81).fill(1);
  for (let r = 0; r < 9; r++) { board[r * 9 + r] = -1; board[r * 9 + ((r + 4) % 9)] = -1; }
  await injectSave({
    v: 2, best: 500,
    game: {
      board, tray: [{ shapeId: 0, icon: 4 }, { shapeId: 38, icon: 1 }, { shapeId: 38, icon: 2 }],
      score: 100, inv: { rotate: 0, undo: 1, freeze: 0 }, progress: { pts: 0, combos: 0 },
    },
  });
}
await dragPiece(0, 0, 0);
await page.waitForSelector('#gameOver.show', { timeout: 5000 });
check('undo offered on the game-over card', (await page.locator('#undoGameOver:not([hidden])').count()) === 1);
await page.tap('#undoGameOver');
await page.waitForTimeout(300);
check('undo dismisses game over', (await page.locator('#gameOver.show').count()) === 0);
check('board rewound to before the fatal move', (await filledCount()) === 63);
check('score rewound on game-over undo', (await score()) === 100);

console.log('7h. Items: freeze basics (arm, cancel, dip, melt alone)');
{
  const board = new Array(81).fill(-1);
  [1, 1, 1, 2, 2, 2, 3, 3].forEach((icon, c) => { board[c] = icon; });
  await injectSave({
    v: 2, best: 500,
    game: {
      board, tray: [{ shapeId: 0, icon: 4 }, { shapeId: 0, icon: 2 }, { shapeId: 1, icon: 3 }],
      score: 100, inv: { rotate: 0, undo: 0, freeze: 1 }, progress: { pts: 0, combos: 0 },
    },
  });
}
await page.tap('#itemFreeze');
check('freeze arms', (await page.locator('#itemFreeze.armed').count()) === 1);
await page.tap('#itemFreeze');
check('re-tap cancels arming without consuming', (await page.locator('#itemFreeze.armed').count()) === 0
  && (await page.locator('#itemFreeze .cnt').textContent()) === '1');
await page.tap('#itemFreeze');
await page.locator('.slot').nth(0).tap();
check('tapping a piece dips it', (await page.locator('.slot .piece.dipped').count()) === 1);
check('dip consumes the freeze', (await page.locator('#itemFreeze[disabled]').count()) === 1);
check('dip does not place anything', (await filledCount()) === 8);
await dragPiece(0, 0, 8); // dipped single completes row 0
await page.waitForTimeout(500);
check('completed row froze instead of clearing', (await page.locator('.cell.frozen').count()) === 9);
check('freeze turn pays placement only', (await score()) === 101);
await dragPiece(1, 4, 4); // completes nothing new: frozen row melts alone
await page.waitForTimeout(900);
check('frozen row melted on the next turn', (await page.locator('.cell.frozen').count()) === 0);
check('melt cleared the row', (await filledCount()) === 1);
check('melt paid clear plus icon bonuses', (await score()) === 140, 'score=' + (await score()));

console.log('7i. Freeze: merged combo, refund, game-over rescue');
{
  const board = new Array(81).fill(-1);
  [1, 1, 1, 2, 2, 2, 3, 3].forEach((icon, c) => { board[c] = icon; });
  for (let r = 1; r <= 7; r++) board[r * 9 + 8] = 2;
  await injectSave({
    v: 2, best: 500,
    game: {
      board, tray: [{ shapeId: 0, icon: 4 }, { shapeId: 0, icon: 2 }, { shapeId: 1, icon: 3 }],
      score: 0, inv: { rotate: 0, undo: 0, freeze: 1 }, progress: { pts: 0, combos: 0 },
    },
  });
}
await page.tap('#itemFreeze');
await page.locator('.slot').nth(0).tap();
await dragPiece(0, 0, 8); // freeze row 0
await page.waitForTimeout(500);
await dragPiece(1, 8, 8); // completes col 8: melts as a x2 combo
await page.waitForTimeout(400);
check('big clear spawns celebration clones', (await page.locator('.fx-cell').count()) > 0);
const meltToast = await page.locator('.toast.score-toast').textContent();
check('melt scores as a merged combo', meltToast.includes('Combo x2') && meltToast.includes('Clear x2'), meltToast);
check('melt pays the matching sets bonus', meltToast.includes('Matching Sets'), meltToast);
check('melt total is placement + clear + bonuses', meltToast.includes('Total+175'), meltToast);
await page.waitForTimeout(1400);
check('merged melt cleared everything', (await filledCount()) === 0);
check('score after merged melt', (await score()) === 176, 'score=' + (await score()));

// Refund: a dipped piece that completes nothing returns the item
{
  const board = new Array(81).fill(-1);
  await injectSave({
    v: 2, best: 500,
    game: {
      board, tray: [{ shapeId: 0, icon: 1 }, { shapeId: 0, icon: 2 }, { shapeId: 1, icon: 3 }],
      score: 0, inv: { rotate: 0, undo: 0, freeze: 1 }, progress: { pts: 0, combos: 0 },
    },
  });
}
await page.tap('#itemFreeze');
await page.locator('.slot').nth(0).tap();
await dragPiece(0, 4, 4); // completes nothing
await page.waitForTimeout(500);
check('useless dip is refunded', (await page.locator('#itemFreeze .cnt').textContent()) === '1');

// Game-over force-melt: freezing box 0 leaves no room for the plus5s;
// the forced melt clears the box and rescues the game.
{
  const board = new Array(81).fill(1);
  for (let r = 0; r < 9; r++) { board[r * 9 + r] = -1; board[r * 9 + ((r + 4) % 9)] = -1; }
  await injectSave({
    v: 2, best: 900,
    game: {
      board, tray: [{ shapeId: 7, icon: 1 }, { shapeId: 38, icon: 1 }, { shapeId: 38, icon: 1 }],
      score: 100, inv: { rotate: 0, undo: 0, freeze: 1 }, progress: { pts: 0, combos: 0 },
    },
  });
}
await page.tap('#itemFreeze');
await page.locator('.slot').nth(0).tap();
await dragPiece(0, 0, 0); // dipped Diag3 completes box 0 exactly
await page.waitForSelector('#itemHelp:not([hidden])', { timeout: 6000 });
check('force-melt shows a rescue toast', (await page.locator('.toast.melt-toast').count()) >= 1);
check('force-melt earns a freeze (first-earn card)', (await page.locator('#itemHelpTitle').textContent()).includes('Freeze'));
await page.tap('#itemHelpOk');
await page.waitForTimeout(100);
// The perfect box also fires an icon bonus, so the melt earns a Reroll too: clear that card.
if (await page.locator('#itemHelp:not([hidden])').count()) {
  check('force-melt also first-earns Reroll', (await page.locator('#itemHelpTitle').textContent()).includes('Reroll'));
  await page.tap('#itemHelpOk');
  await page.waitForTimeout(100);
}
check('force-melt rescued the game (no game over)', (await page.locator('#gameOver.show').count()) === 0);
check('force-melt cleared the frozen box', (await page.locator('.cell.frozen').count()) === 0
  && (await filledCount()) === 57, 'filled=' + (await filledCount()));
check('force-melt paid full scoring', (await score()) === 221, 'score=' + (await score()));

console.log('7j. Tier-4 celebration: triple perfect flourish');
// Rows 0 and 1 (cols 0-7) and col 8 (rows 3-8) all flowers; Line3-V at
// (0,8) completes 3 perfect flower sets at once: 3+90+300+100 = +493.
// Since v2.3 perfect cells fly as per-symbol flourishes in #perfectLayer
// instead of the generic tier-4 march, which only carries non-perfect cells.
{
  const board = new Array(81).fill(-1);
  for (let c = 0; c < 8; c++) { board[c] = 1; board[9 + c] = 1; }
  for (let r = 3; r < 9; r++) board[r * 9 + 8] = 1;
  await injectSave({
    v: 2, best: 900,
    game: {
      board, tray: [{ shapeId: 6, icon: 1 }, { shapeId: 0, icon: 2 }, { shapeId: 0, icon: 3 }],
      score: 0, inv: { rotate: 0, undo: 0, freeze: 0 }, progress: { pts: 0, combos: 0 },
    },
  });
}
await dragPiece(0, 0, 8);
await page.waitForTimeout(350);
check('triple perfect flies as flower flourishes', (await page.locator('#perfectLayer .pfx-flower').count()) > 0);
check('perfect cells skip the generic march', (await page.locator('.fx-march').count()) === 0);
await page.waitForSelector('#itemHelp:not([hidden])', { timeout: 6000 });
check('x3 haul first-earns Rotate', (await page.locator('#itemHelpTitle').textContent()).includes('Rotate'));
await page.tap('#itemHelpOk');
await page.waitForTimeout(200);
check('then first-earns Flip (493 >= 300)', (await page.locator('#itemHelpTitle').textContent()).includes('Flip'));
await page.tap('#itemHelpOk');
await page.waitForTimeout(200);
check('then first-earns Freeze', (await page.locator('#itemHelpTitle').textContent()).includes('Freeze'));
await page.tap('#itemHelpOk');
await page.waitForTimeout(200);
check('then first-earns Reroll', (await page.locator('#itemHelpTitle').textContent()).includes('Reroll'));
await page.tap('#itemHelpOk');
await page.waitForTimeout(100);
check('triple perfect scored 493', (await score()) === 493, 'score=' + (await score()));
check('rotate stock from 493 points', (await page.locator('#itemRotate .cnt').textContent()) === '2');
check('flip stock from 493 points', (await page.locator('#itemFlip .cnt').textContent()) === '1');
check('freeze stock capped at 3', (await page.locator('#itemFreeze .cnt').textContent()) === '3');
// The x3 combo pays one Reroll, and 3 flower units firing Matching Sets pays another.
check('reroll stock from the x3 combo and Matching Sets', (await page.locator('#itemReroll .cnt').textContent()) === '2');

console.log('7j2. Streak: back-to-back clears pay a rising bonus');
// Rows 0 and 1 (cols 0-7) with mixed icons so no single icon reaches 3 in a
// row (zero icon bonuses). Tray: three Single lizards. Each single completes
// one row; two in a row builds a x2 streak worth +25.
{
  const board = new Array(81).fill(-1);
  [1, 2, 3, 4, 1, 2, 3, 4].forEach((icon, c) => { board[c] = icon; });      // row 0
  [2, 3, 4, 1, 2, 3, 4, 1].forEach((icon, c) => { board[9 + c] = icon; });   // row 1
  await injectSave({
    v: 2, best: 5,
    game: {
      board, tray: [{ shapeId: 0, icon: 0 }, { shapeId: 0, icon: 0 }, { shapeId: 0, icon: 0 }],
      score: 0, inv: { rotate: 0, undo: 0, freeze: 0 }, progress: { pts: 0, combos: 0 },
    },
  });
}
const savedStreak = () => page.evaluate(() => JSON.parse(localStorage.getItem('lizard-blockdoku-v1')).game.streak);
// First clear: the streak starts at 1, so no bonus and no pill yet.
await dragPiece(0, 0, 8);
await page.waitForTimeout(600);
{
  const t = await page.locator('.toast.score-toast').last().textContent();
  check('first clear shows no streak row', !t.includes('Streak'), t);
}
check('streak pill hidden at x1', (await page.locator('#streakPill.show').count()) === 0);
check('score 19 after the first clear', (await score()) === 19, 'score=' + (await score()));
// Second back-to-back clear: streak x2 pays +10 (Total +29).
await dragPiece(1, 1, 8);
await page.waitForTimeout(600);
{
  const t = await page.locator('.toast.score-toast').last().textContent();
  check('second clear shows the streak bonus', t.includes('Streak x2') && t.includes('Total+29'), t);
}
check('streak pill shows x2', (await page.locator('#streakPill.show').count()) === 1
  && (await page.locator('#streakPill').textContent()).includes('x2'));
check('streak persisted to the save', (await savedStreak()) === 2);
check('score 48 after the streak clear', (await score()) === 48, 'score=' + (await score()));
// The lit streak pill opens the streak panel: the footer promises the next
// clear's bonus (10 * streak = +20 at x2) and each clear's payout is listed.
await page.tap('#streakPill');
await page.waitForTimeout(200);
check('streak pill opens the streak panel', (await page.locator('#streakPanel:not([hidden])').count()) === 1);
{
  const panelText = await page.locator('#streakPanelBody').textContent();
  check('streak panel shows the live rows and next-clear footer',
    panelText.includes('+29') && panelText.includes('Next clear pays +20 extra'), panelText);
}
await page.tap('#streakPanelClose');
await page.waitForTimeout(100);
check('streak panel closes', (await page.locator('#streakPanel:not([hidden])').count()) === 0);
// A placement that clears nothing cools the streak back to 0.
await dragPiece(2, 4, 4);
await page.waitForTimeout(400);
check('streak pill hidden after a cold placement', (await page.locator('#streakPill.show').count()) === 0);
check('hidden streak pill is untappable',
  (await page.locator('#streakPill').evaluate((el) => getComputedStyle(el).pointerEvents)) === 'none');
check('streak reset in the save', (await savedStreak()) === 0);
check('score 49 after the cold placement', (await score()) === 49, 'score=' + (await score()));

console.log('7j3. Score panel: the score pill opens recent breakdowns');
{
  const board = new Array(81).fill(-1);
  [1, 1, 1, 2, 2, 2, 3, 3].forEach((icon, c) => { board[c] = icon; });
  await injectSave({
    v: 2, best: 5,
    game: {
      board, tray: [{ shapeId: 0, icon: 4 }, { shapeId: 0, icon: 2 }, { shapeId: 1, icon: 3 }],
      score: 0, inv: { rotate: 0, undo: 0, freeze: 0 }, progress: { pts: 0, combos: 0 },
    },
  });
}
await dragPiece(0, 0, 8); // completes row 0, logging one breakdown
await page.waitForTimeout(1000); // let the clear finish so the turn returns to IDLE
await page.tap('.score-pill');
await page.waitForTimeout(200);
check('score pill opens the recent-scores panel', (await page.locator('#scorePanel:not([hidden])').count()) === 1);
check('score panel lists a breakdown ending in a total', (await page.locator('#scorePanel .bd-entry').count()) >= 1
  && (await page.locator('#scorePanel .bd-entry').first().textContent()).includes('Total'));
{
  const entry = page.locator('#scorePanel .bd-entry').first();
  check('bd-entry renders a mini board of exactly 81 cells',
    (await entry.locator('.mini.mini-9').count()) === 1
    && (await entry.locator('.mini.mini-9 .mc').count()) === 81);
  check('mini board rings at least one cleared cell', (await entry.locator('.mini.mini-9 .mc.ring').count()) >= 1);
  check('mini board marks at least one landing cell', (await entry.locator('.mini.mini-9 .mc.land').count()) >= 1);
  // Tap the mini board: it should blow up into the full-screen zoom overlay.
  await entry.locator('.bd-mini').first().tap();
  await page.waitForTimeout(150);
  check('tapping a mini board opens the zoom overlay',
    (await page.locator('#miniZoom:not([hidden])').count()) === 1);
  check('zoom overlay renders the full 81-cell board',
    (await page.locator('#miniZoom .mc').count()) === 81);
  const zoomCellW = await page.locator('#miniZoom .mc').first().evaluate((el) => el.getBoundingClientRect().width);
  check('zoom cells are enlarged (>=30px)', zoomCellW >= 30, zoomCellW.toFixed(1) + 'px');
  check('zoom overlay shows a + total headline',
    (await page.locator('#miniZoomHead').textContent()).includes('+'));
  await page.tap('#miniZoom');
  await page.waitForTimeout(150);
  check('tapping the zoom overlay closes it',
    (await page.locator('#miniZoom:not([hidden])').count()) === 0);
}
await page.tap('#scorePanelClose');
await page.waitForTimeout(100);
check('score panel closes', (await page.locator('#scorePanel:not([hidden])').count()) === 0);

console.log('7j4. Reroll: arm, cancel, then swap a tray piece');
{
  const board = new Array(81).fill(-1);
  await injectSave({
    v: 2, best: 5,
    game: {
      board, tray: [{ shapeId: 0, icon: 3 }, { shapeId: 1, icon: 2 }, { shapeId: 13, icon: 4 }],
      score: 0, inv: { rotate: 0, undo: 0, freeze: 0, reroll: 1 }, progress: { pts: 0, combos: 0 },
    },
  });
}
const rerollCnt = () => page.locator('#itemReroll .cnt').textContent();
const savedInv = () => page.evaluate(() => JSON.parse(localStorage.getItem('lizard-blockdoku-v1')).game.inv);
check('reroll badge shows 1', (await rerollCnt()) === '1');
// Arm then cancel: no reroll spent.
await page.tap('#itemReroll');
check('reroll arms', (await page.locator('#itemReroll.armed').count()) === 1);
await page.tap('#itemReroll');
check('re-tap cancels arming without consuming', (await page.locator('#itemReroll.armed').count()) === 0
  && (await rerollCnt()) === '1');
// Arm then tap slot 0: one reroll consumed, the piece swapped, nothing placed.
const filledBeforeReroll = await filledCount();
await page.tap('#itemReroll');
await page.locator('.slot').nth(0).tap();
await page.waitForTimeout(300);
check('reroll consumed to 0 in the save', (await savedInv()).reroll === 0);
check('reroll badge disabled at 0', (await page.locator('#itemReroll[disabled]').count()) === 1);
check('reroll placed nothing on the board', (await filledCount()) === filledBeforeReroll);

console.log('7k. Tutorial: full walkthrough via settings replay');
const scoreBeforeTut = await score();
await page.tap('#settingsBtn');
await page.waitForSelector('#settings:not([hidden])');
await page.tap('#replayTutorial');
await page.waitForTimeout(200);
check('replay starts the tutorial', (await page.locator('#coach:not([hidden])').count()) === 1);
check('step 1 welcomes her by name', (await page.locator('#coachText').textContent()).includes('Lizard'));
check('interactive steps hide the Next button', (await page.locator('#coachNext').isVisible()) === false);
await dragPiece(0, 0, 0); // step 1: place any piece
await page.waitForTimeout(700);
check('step 2 teaches clearing', (await page.locator('#coachText').textContent()).includes('Finish this row'));
await dragPiece(0, 0, 0); // gated: wrong spot must snap back
await page.waitForTimeout(400);
check('gated drop snaps back', (await page.locator('.slot').nth(0).locator('.piece').count()) === 1);
await dragPiece(0, 4, 7); // the required spot
await page.waitForTimeout(1000);
check('step 3 teaches the 3x3 box', (await page.locator('#coachText').textContent()).includes('3x3 box'));
await dragPiece(0, 4, 4); // the butterfly single into the very center
await page.waitForTimeout(1000);
check('step 4 teaches icon bonuses', (await page.locator('#coachText').textContent()).includes('Match 3'));
await dragPiece(0, 4, 7);
await page.waitForTimeout(1000);
check('step 5 teaches the previews', (await page.locator('#coachText').textContent()).includes('gold ring'));
await dragPiece(0, 2, 8);
await page.waitForTimeout(1000);
check('step 6 grants a rotate', (await page.locator('#coachText').textContent()).includes('Rotate'));
{
  // pickup is gated until the piece is rotated
  const slotBox = await page.locator('.slot').nth(0).boundingBox();
  await page.mouse.move(slotBox.x + slotBox.width / 2, slotBox.y + slotBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(slotBox.x + slotBox.width / 2, slotBox.y - 120, { steps: 5 });
  await page.mouse.up();
  check('unrotated piece cannot be picked up', (await page.locator('#ghost[hidden]').count()) === 1);
}
await page.locator('.slot').nth(0).locator('.rot-btn').tap();
await page.waitForTimeout(300);
await dragPiece(0, 4, 6);
await page.waitForTimeout(1000);
// Flip lesson: the corner piece is backwards; mirror it, then finish the row.
check('step 7 teaches flip', (await page.locator('#coachText').textContent()).includes('Flip'));
{
  // pickup is gated until the piece is mirrored
  const slotBox = await page.locator('.slot').nth(0).boundingBox();
  await page.mouse.move(slotBox.x + slotBox.width / 2, slotBox.y + slotBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(slotBox.x + slotBox.width / 2, slotBox.y - 120, { steps: 5 });
  await page.mouse.up();
  check('unmirrored piece cannot be picked up', (await page.locator('#ghost[hidden]').count()) === 1);
}
await page.locator('.slot').nth(0).locator('.flip-btn').tap();
await page.waitForTimeout(300);
await dragPiece(0, 4, 7);
await page.waitForTimeout(1000);
// Undo lesson: a forced trap drop, then rewind it.
check('step 8 baits the undo trap', (await page.locator('#coachText').textContent()).includes('spoils'));
await dragPiece(0, 4, 8); // drop the star: it clears the flower row (an 8-flower bonus = tier-2 party)
await page.waitForTimeout(1400);
check('step 9 teaches undo', (await page.locator('#coachText').textContent()).includes('Undo'));
await page.tap('#itemUndo');
await page.waitForTimeout(600);
// Freeze lesson: arm the button, ice the piece, then place it.
check('step 10 teaches freeze', (await page.locator('#coachText').textContent()).includes('Freeze'));
await page.tap('#itemFreeze');
await page.locator('.slot').nth(0).tap();
await page.waitForTimeout(600);
check('step 11 places the iced piece', (await page.locator('#coachText').textContent()).includes('freezes solid'));
await dragPiece(0, 4, 8); // the iced piece freezes the row solid
await page.waitForTimeout(900);
check('the finished row froze instead of clearing', (await page.locator('.cell.frozen').count()) === 9);
check('step 12 teaches the melt', (await page.locator('#coachText').textContent()).includes('melts together'));
await dragPiece(0, 8, 2); // finish the heart column: everything melts as one combo
await page.waitForTimeout(1600);
// Reroll lesson: arm the button, swap the piece.
check('step 13 teaches reroll', (await page.locator('#coachText').textContent()).includes('Reroll'));
await page.tap('#itemReroll');
await page.locator('.slot').nth(0).tap();
await page.waitForTimeout(600);
check('final step points at the score pill', (await page.locator('#coachText').textContent()).includes('have fun'));
check('last step offers Finish', (await page.locator('#coachNext').textContent()) === 'Finish');
await page.tap('#coachNext');
await page.waitForTimeout(200);
check('finish ends the tutorial', (await page.locator('#coach:not([hidden])').count()) === 0);
check('the real game came back intact', (await score()) === scoreBeforeTut, 'score=' + (await score()));

console.log('7l. Tutorial: one-time offer for existing players');
{
  const board = new Array(81).fill(-1);
  board[40] = 1;
  await injectSave({
    v: 2, best: 50,
    game: {
      board, tray: [{ shapeId: 0, icon: 1 }, { shapeId: 0, icon: 2 }, { shapeId: 1, icon: 3 }],
      score: 10, inv: { rotate: 0, undo: 0, freeze: 0 }, progress: { pts: 0, combos: 0 },
    },
  });
}
await page.tap('#restartBtn');
await page.waitForSelector('#confirmRestart:not([hidden])');
await page.tap('#confirmYes');
await page.waitForTimeout(200);
check('existing player gets the offer once', (await page.locator('#tutOffer:not([hidden])').count()) === 1);
await page.tap('#tutOfferNo');
await page.waitForTimeout(100);
check('declining is remembered', (await page.evaluate(() => JSON.parse(localStorage.getItem('lizard-blockdoku-v1')).tutorialOffered)) === true);
await page.tap('#restartBtn');
await page.waitForSelector('#confirmRestart:not([hidden])');
await page.tap('#confirmYes');
await page.waitForTimeout(200);
check('the offer never repeats', (await page.locator('#tutOffer:not([hidden])').count()) === 0);

console.log('7m. Leaderboard: submit and panel against a mocked API');
let submitBody = null;
let submitCount = 0;
await page.route('https://lb.test/**', async (route) => {
  const req = route.request();
  // Fulfilled cross-origin responses still face CORS checks in the browser.
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST',
    'access-control-allow-headers': 'content-type',
  };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  if (req.url().endsWith('/submit') && req.method() === 'POST') {
    submitBody = req.postDataJSON();
    submitCount++;
    return route.fulfill({ headers: cors, json: { accepted: true, best: submitBody.score } });
  }
  if (req.url().endsWith('/top')) {
    return route.fulfill({ headers: cors, json: { scores: [
      { id: 'friend-1', name: 'Tom<script>alert(1)</script>', score: 5000, when: 1 },
      { id: (submitBody && submitBody.playerId) || 'nobody', name: 'Lizard', score: 101, when: 2 },
    ] } });
  }
  return route.fulfill({ status: 404, headers: cors, json: { error: 'not found' } });
});
await page.addInitScript(() => { window.__LB_URL__ = 'https://lb.test'; });
{
  const board = new Array(81).fill(1);
  for (let r = 0; r < 9; r++) { board[r * 9 + r] = -1; board[r * 9 + ((r + 4) % 9)] = -1; }
  await injectSave({
    v: 1, best: 5,
    game: { board, tray: [{ shapeId: 0, icon: 4 }, { shapeId: 38, icon: 1 }, { shapeId: 38, icon: 2 }], score: 100 },
  });
}
// The crown pill opens the leaderboard whenever the feature is live
await page.tap('.best-pill');
await page.waitForTimeout(400);
check('tapping the best pill opens the leaderboard', (await page.locator('#lbPanel:not([hidden])').count()) === 1);
await page.tap('#lbClose');
await page.waitForTimeout(100);

// Opening the leaderboard above already submitted the current best (5); clear
// that so the next check isolates whether GAME OVER itself submits.
submitBody = null;
await dragPiece(0, 0, 0);
await page.waitForSelector('#gameOver.show', { timeout: 5000 });
await page.waitForTimeout(600);
// First New Best with a live leaderboard: the submit waits for a nickname.
check('new best defers the submit for a nickname', submitBody === null, JSON.stringify(submitBody));
check('first new best shows the nickname prompt', (await page.locator('#nickPrompt:not([hidden])').count()) === 1);
check('nick prompt is recorded as shown', (await page.evaluate(() =>
  JSON.parse(localStorage.getItem('lizard-blockdoku-v1')).nickPrompted)) === true);
// Save with an empty name: it falls back to her default name.
await page.fill('#nickPromptInput', '');
await page.tap('#nickPromptSave');
await page.waitForTimeout(600);
check('resolving the prompt submits the new best', submitBody !== null && submitBody.score === 101,
  JSON.stringify(submitBody));
check('submit carries a UUID identity and hex secret',
  submitBody !== null
  && /^[0-9a-f-]{36}$/.test(submitBody.playerId)
  && /^[0-9a-f]{32}$/.test(submitBody.secret));
check('empty name falls back to Lizard', submitBody !== null && submitBody.name === 'Lizard');
check('acceptance advances bestSubmitted',
  (await page.evaluate(() => JSON.parse(localStorage.getItem('lizard-blockdoku-lb')).bestSubmitted)) === 101);
await page.tap('#lbGameOver');
await page.waitForTimeout(500);
check('leaderboard panel opens with rows', (await page.locator('.lb-row').count()) === 2);
check('own row is highlighted', (await page.locator('.lb-row.me .lb-name').textContent()) === 'Lizard');
check('hostile names render inert', (await page.locator('#lbBody script').count()) === 0
  && (await page.locator('#lbBody').textContent()).includes('Tom<script>'));
await page.tap('#lbClose');
const countBefore = submitCount;
await page.tap('#playAgain');
await page.waitForTimeout(400);
check('no resubmit when best is unchanged', submitCount === countBefore);

console.log('8. Landscape browser tab still fits');
await page.setViewportSize({ width: 844, height: 390 });
await page.reload();
await page.waitForSelector('.cell');
await dismissSplash();
const fit = await page.evaluate(() => {
  const tray = document.getElementById('tray').getBoundingClientRect();
  const board = document.getElementById('board').getBoundingClientRect();
  return { trayBottom: tray.bottom, boardTop: board.top, vh: window.innerHeight };
});
check('tray fully visible in landscape', fit.trayBottom <= fit.vh + 1, JSON.stringify(fit));
check('board not clipped at top in landscape', fit.boardTop >= -1, JSON.stringify(fit));
check('items bar (with reroll) hidden in landscape', (await page.locator('#itemsBar').isVisible()) === false);
check('reroll button still exists in the DOM', (await page.locator('#itemReroll').count()) === 1);
await page.setViewportSize({ width: 390, height: 844 });
await page.reload();
await page.waitForSelector('.cell');
await dismissSplash();

console.log('9. Console errors');
check('no console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 5)));

await page.screenshot({ path: ART + 'mobile-final.png' });
await browser.close();

if (failures) {
  console.error('\n' + failures + ' smoke check(s) failed');
  process.exit(1);
}
console.log('\nAll smoke checks passed');
