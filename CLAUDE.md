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

- **Beta pushes**: when a version's work is committed and verified, push it to
  the beta repo so it deploys to the beta channel:
  `git push beta <version-branch>:main` (remote `beta` =
  github.com/chef55555/lizard-blockdoku-beta, GitHub Pages serves its `main`).
  Then verify the live site with
  `node tests/live-check.mjs https://chef55555.github.io/lizard-blockdoku-beta/`.
  Production deploys are separate: merge to `main` and push `origin main`.
- Bump `APP_BUILD` in `src/logic/config.js` and the `CACHE` version in `sw.js`
  together on every deploy; they are numerically aligned (build 21 = cache v21).
- **When a Pages deploy fails** (GitHub Pages is occasionally flaky): inspect
  runs with the GitHub CLI, e.g.
  `gh run list -R chef55555/lizard-blockdoku-beta --limit 5`. gh lives at
  `C:\Program Files\GitHub CLI\gh.exe` (call by full path if a stale shell
  PATH cannot find `gh`). A failed pages-build-deployment run can be
  re-triggered with an empty commit pushed to the affected repo.
- No bundler: every new module under `src/` must be added to `ASSETS` in
  `sw.js`, or installed PWAs can load a stale/missing module after an update.
- Pure game logic lives in `src/logic/*` (re-exported through the barrel
  `src/logic/index.js`) so `tests/logic.test.js` can cover it in Node:
  `node tests/logic.test.js`. DOM wiring stays in `src/main.js`.
