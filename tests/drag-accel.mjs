// Vertical drag-acceleration behavior check.
//
// With acceleration on (default), the further the finger rises from pickup the
// further the piece leads above it, so the SAME finger position places the
// piece HIGHER (smaller row) than with acceleration off. Horizontal is
// untouched. This asserts the direction of the effect (robust to tuning the
// gain/cap), not exact pixels. Toggling window.__NO_DRAG_ACCEL__ at runtime
// flips the behavior on one page since ghostTargetPos reads it live.
//
// Needs the local server up.  Run:  node tests/drag-accel.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:8080';
const N = 9;
let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  ok: ' + name);
  else { failures++; console.error('  FAIL: ' + name + (extra ? ' (' + extra + ')' : '')); }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

async function inject() {
  await page.goto(BASE + '/tools/icon-maker.html');
  await page.evaluate(() => localStorage.setItem('lizard-blockdoku-v1', JSON.stringify({
    v: 2, best: 0, game: {
      board: new Array(81).fill(-1),
      tray: [{ shapeId: 0, icon: 3 }, { shapeId: 0, icon: 4 }, { shapeId: 0, icon: 5 }],
      score: 0, inv: { rotate: 0, flip: 0, undo: 0, freeze: 0, reroll: 0 },
      progress: { pts: 0, flipPts: 0, combos: 0, fcombos: 0 },
    },
  })));
  await page.goto(BASE); await page.waitForSelector('.cell');
  await page.waitForSelector('#splash:not([hidden])'); await page.tap('#splash'); await page.waitForSelector('#splash', { state: 'hidden' });
}

// Pick up slot-0 Single, move the finger to an absolute (fx, fy), drop. Returns
// the single filled cell index (or the array if not exactly one).
async function dragToFinger(fx, fy) {
  const box = await page.locator('.slot').nth(0).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForSelector('#ghost .piece');
  await page.waitForTimeout(120);
  await page.mouse.move(fx, fy, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(80);
  return page.evaluate(() => { const f = []; document.querySelectorAll('.cell').forEach((c, i) => { if (c.classList.contains('filled')) f.push(i); }); return f; });
}

async function place(accelOn, fx, fy) {
  await inject();
  await page.evaluate((on) => { window.__NO_DRAG_ACCEL__ = !on; }, accelOn);
  const filled = await dragToFinger(fx, fy);
  return filled.length === 1 ? { row: Math.floor(filled[0] / N), col: filled[0] % N, idx: filled[0] } : { bad: filled };
}

await inject();
const geom = await page.evaluate(() => { const r = document.getElementById('board').getBoundingClientRect(); return { left: r.left, top: r.top, cell: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell')) }; });
// A finger target low on the board (so the finger has risen far from the tray),
// centered on column 4.
const fx = geom.left + 4 * geom.cell + geom.cell / 2;
const fy = geom.top + 8 * geom.cell;

console.log('Vertical drag acceleration');
const on = await place(true, fx, fy);
const off = await place(false, fx, fy);
console.log('  accel ON  -> ' + JSON.stringify(on));
console.log('  accel OFF -> ' + JSON.stringify(off));

check('both drops land a single cell', !on.bad && !off.bad, 'on=' + JSON.stringify(on) + ' off=' + JSON.stringify(off));
check('acceleration places the piece higher (smaller row)', on.row < off.row, 'onRow=' + on.row + ' offRow=' + off.row);
check('horizontal is unaffected (same column)', on.col === off.col, 'onCol=' + on.col + ' offCol=' + off.col);
check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();
console.log(failures ? ('\nFAILURES: ' + failures) : '\nAll drag-accel checks passed');
process.exit(failures ? 1 : 0);
