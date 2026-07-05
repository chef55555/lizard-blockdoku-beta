// WebKit (Safari-engine) drag-placement regression guard.
//
// Reproduces the Safari-only "blocks move all over and don't place right" bug:
// the drop anchor used to be resolved inside the rAF ghost loop, so when the
// release landed before the next animation frame (Safari throttles rAF), the
// piece dropped on a stale anchor, or failed to place at all. Driving real
// mouse input under WebKit with a short release delay, this failed ~every drop
// before the fix (anchor now resolves synchronously in onPointerMove) and
// passes every drop after it.
//
// Needs the local server up and Playwright's WebKit build installed
// (npx playwright install webkit).  Run:  node tests/webkit-drag.mjs
import { webkit } from 'playwright';

const BASE = 'http://localhost:8080';
const ITER = Number(process.env.ITER || 12);
const SETTLE = Number(process.env.SETTLE || 20); // ms between the last move and release

let failures = 0;
const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await context.newPage();
await page.addInitScript(() => { window.__NO_DRAG_ACCEL__ = true; }); // test the plain finger->cell mapping

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

// Drag the slot-0 Single so it lands at board cell (row,col); return filled indices.
async function drag(row, col) {
  const g = await page.evaluate(() => { const r = document.getElementById('board').getBoundingClientRect(); return { left: r.left, top: r.top, cell: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell')) }; });
  const box = await page.locator('.slot').nth(0).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForSelector('#ghost .piece');
  const gb = await page.locator('#ghost .piece').boundingBox();
  const px = g.left + col * g.cell + gb.width / 2;
  const py = g.top + row * g.cell + gb.height + 70; // the ghost floats 70px above the finger
  await page.mouse.move(px, py, { steps: 8 });
  await page.waitForTimeout(SETTLE);
  await page.mouse.up();
  await page.waitForTimeout(80);
  return page.evaluate(() => { const f = []; document.querySelectorAll('.cell').forEach((c, i) => { if (c.classList.contains('filled')) f.push(i); }); return f; });
}

const cells = [[0, 0], [8, 8], [0, 8], [8, 0], [4, 4], [2, 6], [7, 3], [5, 1], [3, 7], [6, 4]];
console.log('WebKit drag placement (SETTLE=' + SETTLE + 'ms, ' + ITER + ' drops)');
for (let k = 0; k < ITER; k++) {
  const [r, c] = cells[k % cells.length];
  await inject();
  const filled = await drag(r, c);
  const want = r * 9 + c;
  const ok = filled.length === 1 && filled[0] === want;
  if (!ok) { failures++; console.error('  FAIL r' + r + 'c' + c + ': got ' + JSON.stringify(filled) + ' want ' + want); }
}

await browser.close();
if (failures) { console.error('\n' + failures + '/' + ITER + ' drops misplaced'); process.exit(1); }
console.log('\nAll ' + ITER + ' drops placed exactly');
process.exit(0);
