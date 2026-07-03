// End-to-end smoke test: drives the real game in Chrome with a phone-sized
// viewport. Run with the local server up: node tests/smoke.mjs
import { chromium } from 'playwright';
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

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

const consoleErrors = [];
const page = await context.newPage();
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
await page.screenshot({ path: ART + 'mobile-gameover.png' });
await page.tap('#playAgain');
await page.waitForTimeout(300);
check('play again resets', (await score()) === 0 && (await filledCount()) === 0);
check('best kept after reset', (await page.locator('#bestVal').textContent()) === '101');

console.log('6. Service worker: offline reload');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForTimeout(800); // let precache finish
await context.setOffline(true);
await page.reload();
const offlineCells = await page.locator('.cell').count().catch(() => 0);
check('offline reload renders the game', offlineCells === 81, 'cells=' + offlineCells);
await context.setOffline(false);

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
    && sheetText.includes('Undo') && sheetText.includes('Freeze'));
  check('sheet gives scoring examples', (await page.locator('#scoreHelp .ex').count()) >= 10);
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
check('force-melt earns a freeze (first-earn card)', (await page.locator('#itemHelpTitle').textContent()).includes('Freeze'));
await page.tap('#itemHelpOk');
check('force-melt rescued the game (no game over)', (await page.locator('#gameOver.show').count()) === 0);
check('force-melt cleared the frozen box', (await page.locator('.cell.frozen').count()) === 0
  && (await filledCount()) === 57, 'filled=' + (await filledCount()));
check('force-melt paid full scoring', (await score()) === 221, 'score=' + (await score()));

console.log('7j. Tier-4 celebration: triple perfect march');
// Rows 0 and 1 (cols 0-7) and col 8 (rows 3-8) all flowers; Line3-V at
// (0,8) completes 3 perfect flower sets at once: 3+90+300+100 = +493.
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
check('tier-4 clear marches off screen', (await page.locator('.fx-march').count()) > 0);
await page.waitForSelector('#itemHelp:not([hidden])', { timeout: 6000 });
check('x3 haul first-earns Rotate', (await page.locator('#itemHelpTitle').textContent()).includes('Rotate'));
await page.tap('#itemHelpOk');
await page.waitForTimeout(200);
check('then first-earns Freeze', (await page.locator('#itemHelpTitle').textContent()).includes('Freeze'));
await page.tap('#itemHelpOk');
check('triple perfect scored 493', (await score()) === 493, 'score=' + (await score()));
check('rotate stock from 493 points', (await page.locator('#itemRotate .cnt').textContent()) === '2');
check('freeze stock capped at 3', (await page.locator('#itemFreeze .cnt').textContent()) === '3');

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
// Second back-to-back clear: streak x2 pays +25 (Total +44).
await dragPiece(1, 1, 8);
await page.waitForTimeout(600);
{
  const t = await page.locator('.toast.score-toast').last().textContent();
  check('second clear shows the streak bonus', t.includes('Streak x2') && t.includes('Total+44'), t);
}
check('streak pill shows x2', (await page.locator('#streakPill.show').count()) === 1
  && (await page.locator('#streakPill').textContent()).includes('x2'));
check('streak persisted to the save', (await savedStreak()) === 2);
check('score 63 after the streak clear', (await score()) === 63, 'score=' + (await score()));
// A placement that clears nothing cools the streak back to 0.
await dragPiece(2, 4, 4);
await page.waitForTimeout(400);
check('streak pill hidden after a cold placement', (await page.locator('#streakPill.show').count()) === 0);
check('streak reset in the save', (await savedStreak()) === 0);
check('score 64 after the cold placement', (await score()) === 64, 'score=' + (await score()));

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
check('step 3 teaches icon bonuses', (await page.locator('#coachText').textContent()).includes('Match 3'));
await dragPiece(0, 4, 7);
await page.waitForTimeout(1000);
check('step 4 teaches the previews', (await page.locator('#coachText').textContent()).includes('gold ring'));
await dragPiece(0, 2, 8);
await page.waitForTimeout(1000);
check('step 5 grants a rotate', (await page.locator('#coachText').textContent()).includes('Rotate'));
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
check('step 6 explains undo and freeze', (await page.locator('#coachText').textContent()).includes('Undo'));
await page.tap('#coachNext');
check('step 7 points at settings', (await page.locator('#coachText').textContent()).includes('have fun'));
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
await dragPiece(0, 0, 0);
await page.waitForSelector('#gameOver.show', { timeout: 5000 });
await page.waitForTimeout(600);
check('game over submits the new best', submitBody !== null && submitBody.score === 101,
  JSON.stringify(submitBody));
check('submit carries a UUID identity and hex secret',
  submitBody !== null
  && /^[0-9a-f-]{36}$/.test(submitBody.playerId)
  && /^[0-9a-f]{32}$/.test(submitBody.secret));
check('submit uses her name', submitBody !== null && submitBody.name === 'Lizard');
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
