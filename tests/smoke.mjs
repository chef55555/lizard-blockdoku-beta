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
  await page.waitForTimeout(160); // let the pick-up scale animation settle
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
await page.tap('#scoreHelpClose');
await page.tap('#settingsDone');
await page.waitForTimeout(100);

console.log('7d. Items: rotate from the tray');
// Line2-H (shape 1) must rotate to Line2-V (shape 2); two rotates held.
{
  const board = new Array(81).fill(-1);
  await injectSave({
    v: 2, best: 5,
    game: {
      board, tray: [{ shapeId: 1, icon: 2 }, { shapeId: 0, icon: 3 }, { shapeId: 0, icon: 4 }],
      score: 0, inv: { rotate: 2, undo: 0, freeze: 0 }, progress: { pts: 0, combos: 0 },
    },
  });
}
check('rotate count badge shows 2', (await page.locator('#itemRotate .cnt').textContent()) === '2');
check('every filled slot offers a rotate button', (await page.locator('.slot .rot-btn').count()) === 3);
const beforeRot = await page.locator('.slot').nth(0).locator('.piece').boundingBox();
await page.locator('.slot').nth(0).locator('.rot-btn').tap();
await page.waitForTimeout(300);
const afterRot = await page.locator('.slot').nth(0).locator('.piece').boundingBox();
check('piece turned from wide to tall', beforeRot.width > beforeRot.height && afterRot.height > afterRot.width,
  JSON.stringify({ beforeRot, afterRot }));
check('rotate did not place anything', (await filledCount()) === 0);
check('one rotate consumed', (await page.locator('#itemRotate .cnt').textContent()) === '1');
const savedShape = await page.evaluate(() => JSON.parse(localStorage.getItem('lizard-blockdoku-v1')).game.tray[0].shapeId);
check('rotation persisted to the save', savedShape === 2, 'shapeId=' + savedShape);
await page.locator('.slot').nth(0).locator('.rot-btn').tap();
await page.waitForTimeout(300);
check('items bar disables at 0 rotates', (await page.locator('#itemRotate[disabled]').count()) === 1);
check('slot rotate buttons vanish at 0', (await page.locator('.slot .rot-btn').count()) === 0);

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
