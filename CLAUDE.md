# Project instructions

Lizard's Blockdoku: a gift PWA (plain ES modules, no bundler) deployed to GitHub Pages
in two channels, production and beta (same code, beta is served under a `-beta` path).

## Working rules

- **Release notes**: every user-visible change ships with an entry in
  `src/release-notes.js`. Keep the list ordered latest release first.
- **Branching**: every version gets its own branch named after the version
  (e.g. `v2.5`), branched from `main`. Merge the branch back to `main` when the
  version is released.
- **Subagents**: always use Opus-model subagents for everything delegated to
  the Agent tool (pass `model: "opus"`).

## Deploy conventions

- Bump `APP_BUILD` in `src/logic/config.js` and the `CACHE` version in `sw.js`
  together on every deploy; they are numerically aligned (build 21 = cache v21).
- No bundler: every new module under `src/` must be added to `ASSETS` in
  `sw.js`, or installed PWAs can load a stale/missing module after an update.
- Pure game logic lives in `src/logic/*` (re-exported through the barrel
  `src/logic/index.js`) so `tests/logic.test.js` can cover it in Node:
  `node tests/logic.test.js`. DOM wiring stays in `src/main.js`.
