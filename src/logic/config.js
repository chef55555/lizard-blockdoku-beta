/* Game constants and channel config (moved verbatim from game.js). */

const PLAYER_NAME = 'Lizard';

/* Beta channel: the same code deployed under .../lizard-blockdoku-beta/ gets
   its own save (github.io shares one localStorage origin across repos) and
   never submits to the real leaderboard. */
const IS_BETA = typeof location !== 'undefined' && location.pathname.includes('-beta');
const SAVE_KEY = IS_BETA ? 'lizard-blockdoku-beta' : 'lizard-blockdoku-v1';

/* App version shown in Settings so a stale service worker is easy to spot.
   APP_BUILD must be bumped together with the sw.js CACHE version on every
   deploy: they are numerically aligned (build 13 = cache v13). */
const APP_VERSION = 'v2.4';
const APP_BUILD = 22;

/* Global leaderboard endpoint (Lambda Function URL). Only enabled when the
   game is served from github.io: the API's CORS is pinned to that origin,
   so calls from anywhere else (localhost dev, the test suite) could never
   succeed and would only spam console errors. The game stays fully playable
   offline either way. window.__LB_URL__ is the smoke suite's mock hook. */
const LEADERBOARD_URL = (typeof window !== 'undefined' && window.__LB_URL__)
  || (typeof location !== 'undefined' && location.hostname.endsWith('github.io')
    ? 'https://5hejgq4fhsbt7wcyq7p4pa55wi0iurts.lambda-url.us-east-1.on.aws'
    : '');
const LB_KEY = 'lizard-blockdoku-lb';

/* Test switch: when true the beta may submit real scores. Kept off so beta
   playtesting never pollutes the real board (flipped on once, 2026-07-03,
   to verify the live pipeline end to end). */
const BETA_LB_SUBMITS = false;

/* Beta perk, permanent by design: fresh beta games start with one of each
   item so end-state rescues and item flows are always easy to test.
   Production fresh games start empty-handed. */
const BETA_STARTER_ITEMS = IS_BETA;

const ICONS = ['\u{1F98E}', '\u{1F338}', '\u{1F49C}', '⭐', '\u{1F353}', '\u{1F98B}']; /* lizard flower heart star berry butterfly */
const ICON_WEIGHTS = [8, 23, 23, 23, 23, 23];
const ICON_LABELS = ['Lizard Power!', 'Flower Match!', 'Heart Match!', 'Star Match!', 'Berry Match!', 'Butterfly Match!'];
const LIZARD_ICON = 0;

const N = 9;
const CELL_COUNT = 81;

export { PLAYER_NAME, IS_BETA, SAVE_KEY, APP_VERSION, APP_BUILD, LEADERBOARD_URL, LB_KEY, BETA_LB_SUBMITS, BETA_STARTER_ITEMS, ICONS, ICON_WEIGHTS, ICON_LABELS, LIZARD_ICON, N, CELL_COUNT };
