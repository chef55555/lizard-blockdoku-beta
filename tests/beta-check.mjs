// Beta-channel end-to-end check: drives the beta build (IS_BETA is path-based,
// so serve the repo under a path containing '-beta') through the v2.4 test
// tooling: scenario presets, generation filters, the force-1x1 reroll switch,
// the Flip item, the freeze refund+melt fix, and the What's-new sheet.
// Run: node tests/beta-check.mjs
//   BETA_BASE (default http://localhost:8081/lizard-blockdoku-beta)
//   PROD_BASE (default http://localhost:8080) for the no-leak check
import { chromium } from 'playwright';

const BETA = process.env.BETA_BASE || 'http://localhost:8081/lizard-blockdoku-beta';
const PROD = process.env.PROD_BASE || 'http://localhost:8080';

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

const filledCount = () => page.locator('.cell.filled').count();
const score = () => page.locator('#scoreVal').textContent().then(Number);
const cnt = (id) => page.locator('#' + id + ' .cnt').textContent();

async function getGeometry() {
  return page.evaluate(() => {
    const r = document.getElementById('board').getBoundingClientRect();
    const cell = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell'));
    return { boardLeft: r.left, boardTop: r.top, cell };
  });
}

/* Same drag helper as smoke.mjs: land the shape's top-left at (row, col). */
async function dragPiece(slotIndex, row, col) {
  const { boardLeft, boardTop, cell } = await getGeometry();
  const slot = page.locator('.slot').nth(slotIndex);
  const box = await slot.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(350);
  const ghostBox = await page.locator('#ghost .piece').boundingBox();
  const px = boardLeft + col * cell + ghostBox.width / 2;
  const py = boardTop + row * cell + ghostBox.height + 70;
  await page.mouse.move(px, py, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.up();
}

async function dismissItemHelpCards() {
  for (let i = 0; i < 6; i++) {
    if (!(await page.locator('#itemHelp:not([hidden])').count())) break;
    await page.tap('#itemHelpOk');
    await page.waitForTimeout(150);
  }
}

async function openTestPanel() {
  await page.tap('#settingsBtn');
  await page.waitForSelector('#settings:not([hidden])');
  await page.tap('#testToolsBtn');
  await page.waitForSelector('#testTools:not([hidden])');
}

async function closeTestPanel() {
  await page.tap('#testToolsDone');
  await page.waitForSelector('#settings:not([hidden])');
  await page.tap('#settingsDone');
  await page.waitForTimeout(100);
}

async function applyScenario(index) {
  await openTestPanel();
  await page.locator('#testScenarioList button').nth(index).tap();
  await page.waitForTimeout(250);
}

console.log('1. Beta cold load');
await page.goto(BETA + '/');
await page.waitForSelector('.cell');
await page.waitForSelector('#splash:not([hidden])');
await page.tap('#splash');
await page.waitForSelector('#splash', { state: 'hidden' });
// A fresh install auto-starts the tutorial: skip it.
await page.waitForSelector('#coach:not([hidden])', { timeout: 4000 });
await page.tap('#tutSkip');
await page.waitForTimeout(300);
check('BETA badge on the title', (await page.locator('#title .beta-tag').count()) === 1);
check('flip button present in the items bar', (await page.locator('#itemFlip').count()) === 1);
check('beta fresh game starts with one of each item', (await cnt('itemFlip')) === '1' && (await cnt('itemReroll')) === '1');

console.log('2. Test panel opens from Settings (beta only)');
await page.tap('#settingsBtn');
await page.waitForSelector('#settings:not([hidden])');
check('version line says beta build 24', (await page.locator('#versionLine').textContent()).includes('build 24, beta'));
check('test-scenarios button is visible', await page.locator('#testToolsBtn').isVisible());
await page.tap('#testToolsBtn');
await page.waitForSelector('#testTools:not([hidden])');
check('six scenario buttons', (await page.locator('#testScenarioList button').count()) === 6);
check('16 piece-class checkboxes', (await page.locator('#classFilterList input').count()) === 16);
check('6 icon checkboxes', (await page.locator('#iconFilterList input').count()) === 6);
await closeTestPanel();

console.log('3. Scenario presets fill the board as declared');
const EXPECT_FILLED = [8, 16, 20, 63, 0, 20];
for (let i = 0; i < EXPECT_FILLED.length; i++) {
  await applyScenario(i);
  const filled = await filledCount();
  check('scenario ' + i + ' fills ' + EXPECT_FILLED[i] + ' cells', filled === EXPECT_FILLED[i], 'filled=' + filled);
}
check('scenario grants full item caps', (await cnt('itemFlip')) === '3' && (await cnt('itemFreeze')) === '3');

console.log('4. Freeze fix: a wasted dip is refunded AND the stack melts');
// Fillers are drawn from the piece pool, so pin them to Line 2 (class 1)
// first: the wasted-dip piece must be a known 2-cell shape for the asserts.
await openTestPanel();
await page.tap('#classFilterAll');
await page.waitForTimeout(150);
for (let i = 0; i < 16; i++) {
  if (i === 1) continue;
  await page.locator('#classFilterList input').nth(i).uncheck();
}
await page.waitForTimeout(150);
await page.locator('#testScenarioList button').nth(0).tap(); // row 4 all star except (4,8); slot 0 = star single
await page.waitForTimeout(250);
await page.tap('#itemFreeze');
await page.locator('.slot').nth(0).tap(); // dip the single
await page.waitForTimeout(300);
check('dip consumed a freeze', (await cnt('itemFreeze')) === '2');
// Hover before dropping: a dipped piece must preview an icy freeze, never
// the purple will-clear promise or gold bonus rings it cannot keep.
{
  const { boardLeft, boardTop, cell } = await getGeometry();
  const box = await page.locator('.slot').nth(0).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(350);
  const ghostBox = await page.locator('#ghost .piece').boundingBox();
  await page.mouse.move(boardLeft + 8 * cell + ghostBox.width / 2, boardTop + 4 * cell + ghostBox.height + 70, { steps: 12 });
  await page.waitForTimeout(200);
  check('dipped piece previews an icy freeze', (await page.locator('.cell.will-freeze').count()) === 9);
  check('dipped preview shows no purple clear promise', (await page.locator('.cell.will-clear').count()) === 0);
  check('dipped preview shows no gold bonus rings', (await page.locator('.cell.will-bonus').count()) === 0);
  await page.mouse.up(); // dipped single completes the row: it freezes
}
await page.waitForTimeout(900);
await dismissItemHelpCards();
check('completed row froze instead of clearing', (await page.locator('.cell.frozen').count()) === 9);
await page.tap('#itemFreeze');
await page.locator('.slot').nth(1).tap(); // dip the Line2
await page.waitForTimeout(300);
check('second dip consumed a freeze', (await cnt('itemFreeze')) === '1');
await dragPiece(1, 0, 0); // wasted dip far from the hold
await page.waitForTimeout(1600);
await dismissItemHelpCards();
check('the held row melted', (await page.locator('.cell.frozen').count()) === 0);
check('only the wasted piece remains on the board', (await filledCount()) === 2, 'filled=' + (await filledCount()));
// dip refunded (1 -> 2) and the perfect star melt earned one more (2 -> 3).
check('freeze refunded plus perfect earn', (await cnt('itemFreeze')) === '3', 'freeze=' + (await cnt('itemFreeze')));
check('melt scored as a normal clear (2 + 18 + 100)', (await score()) === 121, 'score=' + (await score()));

console.log('5. Force-1x1 reroll switch');
await openTestPanel();
await page.check('#reroll1x1Toggle');
await page.waitForTimeout(150);
await closeTestPanel();
await page.tap('#itemReroll');
await page.locator('.slot').nth(2).tap(); // swap the untouched corner piece
await page.waitForTimeout(400);
check('reroll under the switch hands back a 1x1',
  (await page.locator('.slot').nth(2).locator('.pcell').count()) === 1);

console.log('6. Class filter: L/J only, then Flip session on a chiral piece');
await openTestPanel();
// Reset section 4's Line-2 filter, then uncheck every class but L/J 4
// (index 8); the panel self-heals all-or-none.
await page.tap('#classFilterAll');
await page.waitForTimeout(150);
for (let i = 0; i < 16; i++) {
  if (i === 8) continue;
  await page.locator('#classFilterList input').nth(i).uncheck();
}
await page.waitForTimeout(150);
await page.locator('#testScenarioList button').nth(4).tap(); // fresh board, all items
await page.waitForTimeout(300);
for (let s = 0; s < 3; s++) {
  check('slot ' + s + ' holds a 4-cell L/J piece',
    (await page.locator('.slot').nth(s).locator('.pcell').count()) === 4);
}
check('chiral piece shows the flip arrow', (await page.locator('.slot').nth(0).locator('.flip-btn').count()) === 1);
check('flip stock at cap', (await cnt('itemFlip')) === '3');
await page.locator('.slot').nth(0).locator('.flip-btn').tap();
await page.waitForTimeout(300);
check('first mirror charges a Flip', (await cnt('itemFlip')) === '2');
check('bar icon sways during the flip session',
  (await page.locator('#itemFlip.mirroring').count()) === 1);
await page.locator('.slot').nth(0).locator('.flip-btn').tap();
await page.waitForTimeout(300);
check('flipping back cancels and refunds', (await cnt('itemFlip')) === '3');
check('sway stops after the cancel', (await page.locator('#itemFlip.mirroring').count()) === 0);

console.log('7. Icon filter: stars only');
await openTestPanel();
for (let i = 0; i < 6; i++) {
  if (i === 3) continue; // keep the star
  await page.locator('#iconFilterList input').nth(i).uncheck();
}
await page.waitForTimeout(150);
await page.locator('#testScenarioList button').nth(4).tap();
await page.waitForTimeout(300);
const icons = await page.locator('#tray .slot .ic').allTextContents();
check('every tray icon is a star', icons.length > 0 && icons.every((t) => t === '⭐'), icons.join(','));

console.log('7b. Presets honor the active filters');
await applyScenario(0); // perfect1 under star-only icons and L/J-only pieces
const boardIcons = await page.locator('.cell.filled .ic').allTextContents();
check('preset board re-themed to the allowed icon', boardIcons.length === 8 && boardIcons.every((t) => t === '⭐'), boardIcons.join(','));
check('preset keeps its essential Single', (await page.locator('.slot').nth(0).locator('.pcell').count()) === 1);
check('preset Single wears the allowed icon', (await page.locator('.slot').nth(0).locator('.ic').first().textContent()) === '⭐');
check('preset fillers honor the class filter',
  (await page.locator('.slot').nth(1).locator('.pcell').count()) === 4
  && (await page.locator('.slot').nth(2).locator('.pcell').count()) === 4);

console.log('8. Filters persist across a reload');
await page.reload();
await page.waitForSelector('.cell');
await page.waitForSelector('#splash:not([hidden])');
await page.tap('#splash');
await page.waitForSelector('#splash', { state: 'hidden' });
await page.waitForTimeout(300);
await openTestPanel();
check('reroll-1x1 switch persisted', await page.locator('#reroll1x1Toggle').isChecked());
check('class filter persisted', (await page.locator('#classFilterList input:checked').count()) === 1);
check('icon filter persisted', (await page.locator('#iconFilterList input:checked').count()) === 1);
await page.tap('#classFilterAll');
await page.waitForTimeout(150);
check('allow-everything re-checks all classes', (await page.locator('#classFilterList input:checked').count()) === 16);
check('allow-everything re-checks all icons', (await page.locator('#iconFilterList input:checked').count()) === 6);
await page.uncheck('#reroll1x1Toggle');
await closeTestPanel();

console.log('9. What\'s new sheet');
await page.tap('#settingsBtn');
await page.waitForSelector('#settings:not([hidden])');
await page.tap('#whatsNewBtn');
await page.waitForSelector('#releaseNotes:not([hidden])');
const firstRelease = await page.locator('#releaseNotesBody h3').first().textContent();
check('latest release listed first', firstRelease.startsWith('v2.4'), firstRelease);
check('release list covers the history', (await page.locator('#releaseNotesBody h3').count()) >= 6);
await page.tap('#releaseNotesClose');
await page.tap('#settingsDone');

console.log('9b. Bug reports: capture, then load state and pre-move state');
await applyScenario(0); // 8 star cells, slot 0 = star single
await dragPiece(0, 0, 0); // place the single far from the row: no clear
await page.waitForTimeout(700);
await dismissItemHelpCards();
check('board holds 9 cells before capture', (await filledCount()) === 9);
await openTestPanel();
await page.tap('#bugCopy');
await page.waitForTimeout(300);
const reportText = await page.locator('#bugPaste').inputValue();
let report = null;
try { report = JSON.parse(reportText); } catch (err) { /* checked below */ }
check('capture fills the box with a parseable report', !!report);
check('report identifies itself and the build',
  report && report.type === 'lizard-blockdoku-bug-report' && report.build === 24 && report.channel === 'beta');
check('report journal traces the scenario and the placement',
  report && Array.isArray(report.journal)
  && report.journal.some((l) => l.includes('scenario perfect1'))
  && report.journal.some((l) => l.includes('place s0')), report && report.journal.slice(-4).join(' | '));
check('report carries the live game (9 filled)',
  report && report.game.board.filter((v) => v !== -1).length === 9);
check('report carries the pre-move state (8 filled)',
  report && report.beforeLastMove && report.beforeLastMove.board.filter((v) => v !== -1).length === 8);
await page.tap('#testToolsDone');
await page.tap('#settingsDone');
await page.waitForTimeout(100);
await applyScenario(3); // move away: 63 filled
check('board replaced before the import test', (await filledCount()) === 63);
await openTestPanel();
await page.fill('#bugPaste', reportText);
await page.tap('#bugLoad');
await page.waitForTimeout(300);
check('loading the report restores the captured game', (await filledCount()) === 9, 'filled=' + (await filledCount()));
await openTestPanel();
await page.fill('#bugPaste', reportText);
await page.tap('#bugLoadBefore');
await page.waitForTimeout(300);
check('loading the pre-move state rewinds the last move', (await filledCount()) === 8, 'filled=' + (await filledCount()));
await openTestPanel();
await page.fill('#bugPaste', 'not json at all');
await page.tap('#bugLoad');
await page.waitForTimeout(300);
check('garbage paste changes nothing', (await filledCount()) === 8);
await page.tap('#testToolsDone');
await page.tap('#settingsDone');
await page.waitForTimeout(100);
check('game-over card offers the bug button on beta', (await page.locator('#bugGameOver').getAttribute('hidden')) === null);

console.log('10. Production path shows no beta tooling');
await page.goto(PROD + '/');
await page.waitForSelector('.cell');
await page.waitForSelector('#splash:not([hidden])');
await page.tap('#splash');
await page.waitForSelector('#splash', { state: 'hidden' });
if (await page.locator('#coach:not([hidden])').count()) {
  await page.tap('#tutSkip');
  await page.waitForTimeout(300);
}
check('no BETA badge on production', (await page.locator('#title .beta-tag').count()) === 0);
await page.tap('#settingsBtn');
await page.waitForSelector('#settings:not([hidden])');
check('test-scenarios button stays hidden on production', !(await page.locator('#testToolsBtn').isVisible()));
check('bug-report button stays hidden on production', (await page.locator('#bugGameOver').getAttribute('hidden')) !== null);
check('What\'s new is available on production', await page.locator('#whatsNewBtn').isVisible());
await page.tap('#settingsDone');

console.log('11. Console errors');
check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();
if (failures) {
  console.error('\n' + failures + ' beta check(s) failed');
  process.exit(1);
}
console.log('\nAll beta checks passed');
