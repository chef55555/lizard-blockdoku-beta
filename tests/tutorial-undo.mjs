// Tutorial dead-end regression: tapping Undo during the "undo-a" step BEFORE
// placing the star used to rewind a stale snapshot from an earlier step and
// skip to "undo-b" with an empty tray and nothing to undo, dead-ending the
// tutorial. This drives the real tutorial to that step and checks the premature
// Undo is a no-op, then that the intended undo-b rewind still works.
//
// Needs the local server up.  Run:  node tests/tutorial-undo.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:8080';
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

// Fresh player (no save) so the tutorial auto-starts on splash dismiss.
await page.goto(BASE + '/tools/icon-maker.html');
await page.evaluate(() => localStorage.clear());
await page.goto(BASE);
await page.waitForSelector('.cell');
await page.waitForSelector('#splash:not([hidden])');
await page.tap('#splash');
await page.waitForSelector('#splash', { state: 'hidden' }); // splash fades over ~400ms; wait it out
await page.waitForSelector('#coach:not([hidden])');

const coach = () => page.locator('#coachText').textContent();
async function waitCoach(sub) {
  try {
    await page.waitForFunction((s) => (document.getElementById('coachText').textContent || '').includes(s), sub, { timeout: 15000 });
  } catch (e) {
    const cur = await page.locator('#coachText').textContent().catch(() => '(none)');
    const tray = await page.locator('.slot .piece').count().catch(() => -1);
    console.error('waitCoach(\'' + sub + '\') TIMEOUT. current coach="' + cur + '" trayPieces=' + tray);
    throw e;
  }
}
async function drag(row, col) {
  const g = await page.evaluate(() => { const r = document.getElementById('board').getBoundingClientRect(); return { left: r.left, top: r.top, cell: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell')) }; });
  const box = await page.locator('.slot').nth(0).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForSelector('#ghost .piece');
  await page.waitForTimeout(350); // let the pick-up pop-out reach full size before measuring
  const gb = await page.locator('#ghost .piece').boundingBox();
  await page.mouse.move(g.left + col * g.cell + gb.width / 2, g.top + row * g.cell + gb.height + 70, { steps: 10 });
  await page.waitForTimeout(120);
  await page.mouse.up();
}

// Drive steps 0..6 to reach undo-a. Markers are UNIQUE substrings of each
// step's coach text (some steps mention "3x3 box" etc., so avoid those).
console.log('Driving the tutorial to the undo step');
const plan = [
  ['Drag any piece', () => drag(0, 0)],
  ['Finish this row', () => drag(4, 7)],
  ['the very center', () => drag(4, 4)],
  ['flowery row', () => drag(4, 7)],
  ['purple glow', () => drag(2, 8)],
  ['earned a Rotate', async () => { await page.locator('.rot-btn').first().click(); await drag(4, 6); }],
  ['backwards', async () => { await page.locator('.flip-btn').first().click(); await drag(4, 7); }],
];
for (const [marker, act] of plan) {
  await waitCoach(marker);
  await page.waitForFunction(() => document.querySelectorAll('.cell.clearing').length === 0);
  console.log('  step "' + marker + '" tray=' + (await page.locator('.slot .piece').count()));
  await act();
  await page.waitForTimeout(120);
}
await waitCoach('spoils a flower');
check('reached the undo step with the star in the tray', (await page.locator('.slot .piece').count()) === 1);

// THE BUG: tap Undo before placing the star.
await page.locator('#itemUndo').click();
await page.waitForTimeout(400);
check('premature Undo does not empty the tray', (await page.locator('.slot .piece').count()) === 1);
check('premature Undo keeps the tutorial on the undo step', (await coach()).includes('spoils a flower'),
  'coach=' + JSON.stringify((await coach()).slice(0, 40)));

// Now play it as intended: place the star, then undo it.
await drag(4, 8);
await waitCoach('Regrets');
check('undo-b reached with an empty tray', (await page.locator('.slot .piece').count()) === 0);
await page.locator('#itemUndo').click();
await waitCoach('Freeze'); // reaching the freeze step proves the intended undo advanced the tutorial
check('the intended Undo rewinds and advances the tutorial', true);

check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
await browser.close();
console.log(failures ? ('\nFAILURES: ' + failures) : '\nAll tutorial-undo checks passed');
process.exit(failures ? 1 : 0);
