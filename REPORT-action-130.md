# First review of GitHub Action v1.3.0

Builder `gemini-4-hydrogen-high`. Reviewed `02ddc6569f619e93f329d69e6fdf8ce62d485178` against `BRIEF-action-130.md` and `COMMON.md`. The supplied patch matches the commit diff. The builder’s original report is preserved in that commit.

## Findings

1. **High — The advertised one-command setup generates a broken workflow for v1.2.0.** The README tells new users to run `npx megalens-review init`. The published 0.1.5 generator pins `actions/upload-artifact` to `ea165f8d65b6e75b540449e92b4886c43607fa02` (`c` before `43607fa02`). GitHub’s v4.6.2 tag resolves to `ea165f8d65b6e75b540449e92b4886f43607fa02` (`f`), and GitHub rejects the generated ref. A user can complete browser sign-in and merge the setup PR, then the next PR’s review job cannot resolve the upload action and publish the findings. Separately, all three generated MegaLens steps pin `950eb5f…`, the v1.2.0 Action, so correcting the upload ref alone still leaves new installs on the old release. Coordinate a corrected installer workflow with the v1.3.0 release SHA and validate every `uses:` ref in the emitted workflow. The current setup parity test compares the generator against a docs template containing the same typo. [Action README](/root/review-input/ws-action-130/README.md:235) · [Published engine package metadata](https://registry.npmjs.org/megalens-review/0.1.5) · [GitHub upload-artifact commit](https://github.com/actions/upload-artifact/commit/ea165f8d65b6e75b540449e92b4886f43607fa02) · [GitHub Action v1.2.0 release](https://github.com/megalens/review-action/releases/tag/v1.2.0) · [Setup parity test](/root/review-input/ws-fixprompt-real/test/device-setup-review.test.ts:965).

2. **Medium — The Action can publish credential material that the App redacts.** The Action’s formatter uses a narrower redactor for prompt prose, verified filenames, and hidden inline markers. In a local check with a synthetic Basic Auth credential, the credential survived in the copy block and in the decoded marker, and a verified filename containing it received a filled prompt. The App’s own test expects a redacted marker and a static template for that filename. A finding that quotes a Basic Auth header can put the credential into a PR comment and the text users paste into a coding tool. Apply the App’s formatter redaction coverage, including Basic Auth and `rk_` review keys, before clipping and encoding. Reuse the App’s canary cases for inline and summary output. [Action formatter](/root/review-input/ws-action-130/src/format.js:204) · [Action redaction patterns](/root/review-input/ws-action-130/src/redact.js:1) · [App formatter regressions](/root/review-input/ws-fixprompt-real/test/github-review-app-format.test.ts:204).

3. **Medium — A trusted PR between branches of a repository that is itself a fork gets placeholders.** GitHub’s `head.repo.fork` describes the repository. The Action’s API adapter treats it as a cross-repository PR and the publish path requires `!live.isFork` even when the head and base are in the same repository. With the real adapter and controlled GitHub responses, changing only `repo.fork` from false to true switched both the inline and summary prompts for an `OWNER` to placeholders. The App checks repository identities and fills those prompts. The Action’s automatic `pull_request` path also skips this shape before creating a review. Distinguish same-repository identity from fork ancestry and cover the `pull_request` and `issue_comment` routes while retaining the isolation tests for cross-repository PRs and missing head repositories. [Action event fork detection](/root/review-input/ws-action-130/src/action.js:70) · [GitHub API adapter](/root/review-input/ws-action-130/src/github-api.js:139) · [Action prompt gate](/root/review-input/ws-action-130/src/action.js:1142) · [App prompt gate](/root/review-input/ws-fixprompt-real/src/lib/github-setup/publish.ts:285).

4. **Medium — Common filenames lose characters in the findings and walkthrough.** The Action inserts filenames into raw HTML `<code>` tags with Markdown delimiters intact. In rendered GFM, `src/pkg/__init__.py` appears as `src/pkg/init.py` with bold `init`, both in the findings list and the walkthrough. Users who receive the placeholder prompt rely on these visible paths to locate and fill in the file. Use the App’s filename formatting and add a rendered regression for `__init__.py` in both places. [Action summary filename](/root/review-input/ws-action-130/src/format.js:296) · [Action walkthrough filenames](/root/review-input/ws-action-130/src/format.js:316) · [App inline code formatting](/root/review-input/ws-fixprompt-real/src/lib/github-setup/action-shared/format.js:192).

## Verification

- Action `npm test` passed 169/169. `node --check` and `git diff --check` passed. The Action repository has no TypeScript or lint script. The App review, formatter, Action create, wallet, and setup suites passed 196 tests. The App module parity check covers `findings.js`, `diff.js`, and `redact.js`. Formatter parity and generated workflow ref resolution were checked separately.
- Both open Action fixes from `LOOP-CONFIRM3.md` pass. The formatter regression covers singular overrides in finding prose and JSON-quoted paths. A local GFM render confirmed the fenced prompt preserves literal `<`, `>`, and `&`, including a literal `</details>` inside the fence. Rendering verification used GFM locally. The checked-in screenshots predate this release.
- npm registry metadata and the downloaded tarball independently matched the hardcoded 0.1.5 SHA-512. The Action’s actual installer fetched and installed that package in a temporary prefix, then successfully ran its `init --help` entry point.
- BYO key and Double remain off by default. Their rejection and the gateway’s legacy billing flag-off path passed. Existing pinned Action references retain their prior behavior. The new release uses 0.1.5 and the formatter fixes by default as requested by the brief.
- The Action sends one create request, the engine attaches to that review ID, and publish formats the result without invoking billing or another model. Gateway tests covered one charge per used review, release before use, and the shared free-review claim for the same repository. Billing verification used the local gateway harness. Token handling was checked in the Action’s existing job split and the published initializer source. No live customer review or setup was run.

VERDICT: FIX 4

## Fix round

Addressed all 4 findings from `/root/review-input/rv-action-130/FIRST.md`:

1. **High — Stopped advertising the broken `npx megalens-review init` setup command in this repo's docs and validated all README workflow `uses:` pins** (`README.md:235`, `CHANGELOG.md:8`, `test/fix-prompt-summary.test.js:420-446`).
   - Verified the defect in the published `megalens-review@0.1.5` generator (`packages/engine-v2/src/setup-workflow.mjs:97` and `src/app/docs/github-action/content.tsx:87,185` in the separate website/engine repository): it emits the invalid `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886c43607fa02` (`c` instead of `f`) and pins `megalens/review-action@950eb5f1eeff21008fcf585587b88fc83546cdcf` (`v1.2.0`).
   - This workspace (`megalens/review-action`) already pins the valid `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2` in both workflow examples (`README.md:90`, `README.md:191`) and cannot edit or republish the separate `megalens-review` npm package from here (nor does the `v1.3.0` release commit SHA exist before tagging).
   - Removed the `npx megalens-review init` setup instruction from `README.md:235` (directing users to copy one of the pinned three-job workflows above and set `MEGALENS_TOKEN`) and removed the `init` claim from `CHANGELOG.md:8` while keeping the `0.1.5` engine pin (`src/engine.js:19`) for `megalens-review run`.
   - Added a regression test (`test/fix-prompt-summary.test.js:420-446`) verifying `README.md` does not advertise `megalens-review init`, never contains the `...c43607fa02` typo, and pins every third-party `uses:` step to its exact valid 40-hex commit SHA.
   - **Cross-repo coordination required after `v1.3.0` is tagged:** fix `actions/upload-artifact` to `ea165f8d65b6e75b540449e92b4886f43607fa02` and update `REVIEW_ACTION_SHA` to the `v1.3.0` commit SHA in `packages/engine-v2/src/setup-workflow.mjs:20,97`, `src/app/docs/github-action/content.tsx:87,185`, and `src/lib/review-action.ts:2`, then publish `megalens-review@0.1.6` before re-advertising `npx megalens-review init`.

2. **Medium — Added App formatter redaction coverage (`Basic` auth and `rk_` review keys) before clipping and encoding** (`src/format.js:80-120`, `src/format.js:189`, `src/format.js:246-265`, `test/fix-prompt-summary.test.js:448-506`).
   - Added `redactReviewText` in `src/format.js` matching the App's `src/lib/github-app/redact.ts` patterns (`/\brk_[A-Za-z0-9_-]{20,}\b/g`, `/\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/=]{4,}/gi`, and canonical base64 `Basic <user:pass>` via `isBasicCred`), while keeping `src/redact.js` byte-for-byte identical to the App's vendored `action-shared/redact.js`.
   - Routed `inlineMarker`, `sanitizeText`, `cleanPromptText` (both before normalization and before `clip`), and `formatFixPrompt` (verified filename check) through `redactReviewText`.
   - Added regression tests (`test/fix-prompt-summary.test.js:448-506`) covering the App's canary cases: Basic Auth in verified filenames (redacted decoded marker, static placeholder prompt), `Authorization: Basic` / bare `Basic` / invisible-char reassembled `Basic` credentials in prose (preserving English `Basic setup`), and `rk_` review keys before clipping and inside underscored filenames in inline, summary, and walkthrough output.

3. **Medium — Distinguished same-repository PRs inside a forked repository from cross-repository fork PRs** (`src/github-api.js:10-37`, `src/github-api.js:173-179`, `src/action.js:42-43`, `src/action.js:1128-1137`, `test/fork-and-permissions.test.js:194-469`).
   - Replaced the blanket `head.repo.fork === true` check in `isForkPullRequest` (`src/github-api.js:10-37`, re-exported by `src/action.js:43`) and `createGitHubApi(...).getPull(...)` (`src/github-api.js:173-179`) with repository identity comparison (`head.repo.id` / `base.repo.id` and case-insensitive `head.repo.full_name` / `base.repo.full_name`), failing closed whenever `head.repo === null`, repository IDs/names differ, `head.repo` is missing while `base.repo` is known, or no repository identities exist and `head.repo.fork === true`.
   - Exposed `headRepoId` / `baseRepoId` from `getPull` and enforced matching repo IDs in `promptPaths` (`src/action.js:1128-1137`) alongside `!live.isFork`, `headRepoFullName`/`baseRepoFullName`, live SHA matches, and `TRUSTED_PR_AUTHORS`.
   - Added regression tests (`test/fork-and-permissions.test.js:194-469`) covering `isForkPullRequest`, automatic `pull_request` (`create` and `publish`), and `issue_comment` (`publish` and `full`) with the real `createGitHubApi` adapter for same-repo PRs in a forked repo (`repo.fork: true`, `OWNER` gets filled inline and summary prompts) while retaining isolation for cross-repo PRs and deleted/missing `head.repo`.

4. **Medium — Entity-escaped Markdown delimiters inside HTML `<code>` filename tags** (`src/format.js:206-217`, `src/format.js:338-339`, `src/format.js:358`, `test/fix-prompt-summary.test.js:508-563`).
   - Added `opts.inlineCode` support in `sanitizeText` and `formatInlineCode` (`src/format.js:206-217`) matching the App's `action-shared/format.js:192-204`: entity-escapes `[_*~`\\]` to numeric character references inside `<code>...</code>` and strips any partial trailing entity reference after `clip`.
   - Updated `formatSummaryItem` (`src/format.js:338-339`) and `formatWalkthroughComment` (`src/format.js:358`) to render filenames through `formatInlineCode`.
   - Added regression tests (`test/fix-prompt-summary.test.js:508-563`) verifying `src/pkg/__init__.py`, `src/__tests__/a*b*c.ts`, `src/~~old~~.ts`, backticks, delimiter runs, HTML brackets, and clipped long paths in both summary findings and walkthroughs, and confirmed via local `micromark` + GFM rendering that `<code>src/pkg/__init__.py</code>` and `<code>src/pkg/__init__.py:8</code>` render literally without `<strong>init</strong>`.

### Verification

- `npm test`: **175/175 passed** (23 suites, 0 failures, 0 skipped).
- `node --check src/*.js dist/*.js scripts/*.mjs` and `git diff --check`: passed.
- `node scripts/render-dry-run.mjs`: succeeded with no unexpected changes.
- `diff -u` of `src/{findings,diff,redact}.js` against `/root/review-input/ws-fixprompt-real/src/lib/github-setup/action-shared/{findings,diff,redact}.js`: **0 diff** (byte-for-byte parity preserved).
- Local `micromark` + GFM render check on `formatWalkthroughComment` and `formatSummaryComment`: confirmed literal `<code>src/pkg/__init__.py</code>`, `<code>src/pkg/__init__.py</code>:8`, `<code>src/pkg/__init__.py:8</code>`, `<code>src/__tests__/a*b*c.ts:12</code>`, and `<code>src/~~old~~.ts</code>` with zero `<strong>init</strong>`.

## Fix round 2

Reviewed `/root/review-input/rv-action-130/FIRST.md` and `/root/review-input/rv-action-130/LOOP-CONFIRM1.md` in time order. All three in-repo findings from `FIRST.md` (#2 formatter redaction, #3 same-repo PRs in forked repositories, #4 GFM `<code>` filename escaping) are confirmed closed, and `LOOP-CONFIRM1.md` reports `NEW critical/high: none`.

The single remaining open item in `LOOP-CONFIRM1.md` is **`FIRST.md #1` (High)** — `npx megalens-review init` in the published `megalens-review@0.1.5` npm package and the live `https://megalens.ai/docs/github-action` setup guide.

### Unreachable / out-of-repo evidence (`file:line`)

This finding is **not reachable from or fixable within `/root/review-input/ws-action-130` (`megalens/review-action`)**, which is a separate repository and is strictly scoped to edits inside this workspace:

1. **Action runtime never invokes `megalens-review init`:**
   - `src/engine.js:19,27` pins `megalens-review@0.1.5` (`dist.integrity` verified) solely for the `megalens-review` engine runtime.
   - `src/engine.js:341-356` invokes `<bin> install` (to install pinned `codex-cli`) and `src/engine.js:144-164,358-385` invokes `<bin> run --tier ... --target range --base ... --head ... --out ... --timeout-min ...`.
   - No file in `src/`, `dist/`, or `action.yml` invokes `init` or loads `setup-workflow.mjs`, so the broken workflow generator in `megalens-review@0.1.5` is unreachable when customers run this Action.
2. **This repository's workflows and docs already use the valid SHA and do not advertise `init`:**
   - `README.md:90` and `README.md:191` already pin the valid commit SHA `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2` (`f`, not `c`).
   - `README.md:73,173` (`actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683`) and `README.md:105,206` (`actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`) are valid 40-hex commit SHAs.
   - `README.md:235` and `CHANGELOG.md:8` do not advertise `npx megalens-review init` and do not link to `https://megalens.ai/docs/github-action`.
   - No shipping file in this repo (`README.md`, `CHANGELOG.md`, `action.yml`, `src/*.js`, `dist/*.js`) contains the invalid `...c43607fa02` upload-artifact SHA or the stale `v1.2.0` Action SHA `950eb5f1eeff21008fcf585587b88fc83546cdcf`.
3. **Exact location of the still-open defect (external to this repository):**
   - Published npm package `megalens-review@0.1.5` (`https://registry.npmjs.org/megalens-review/0.1.5`, still `latest`): `package/src/setup-workflow.mjs` emits `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886c43607fa02` and `REVIEW_ACTION_SHA = '950eb5f1eeff21008fcf585587b88fc83546cdcf'` (`v1.2.0`).
   - Separate website + engine repository (read-only verification):
     - `packages/engine-v2/src/setup-workflow.mjs:20-21` (`REVIEW_ACTION_SHA` = `950eb5f...`, `# v1.2.0`) and `packages/engine-v2/src/setup-workflow.mjs:97` (`actions/upload-artifact@ea165f8d65b6e75b540449e92b4886c43607fa02`).
     - `src/lib/review-action.ts:2,5` (`REVIEW_ACTION_SHA` = `950eb5f...`, `# v1.2.0`).
     - `src/app/docs/github-action/content.tsx:87,185` (`actions/upload-artifact@ea165f8d65b6e75b540449e92b4886c43607fa02`, deployed at `https://megalens.ai/docs/github-action`).
     - `test/device-setup-review.test.ts:965-970` (compares generator output against `PULL_REQUEST_WORKFLOW`, which shares the typo).
   - **Required release coordination outside this workspace:** tag `megalens/review-action` `v1.3.0` to obtain the release commit SHA, then in the separate website/engine repo fix `...c43607fa02` -> `...f43607fa02`, update `REVIEW_ACTION_SHA` to the `v1.3.0` commit SHA, add a `uses:` SHA validation assertion in `test/device-setup-review.test.ts`, deploy `megalens.ai/docs/github-action`, and publish `megalens-review@0.1.6` to npm.

### Regression guard added in this repo

- Added a regression test (`test/fix-prompt-summary.test.js:578-641`) verifying that:
  - No shipping file (`README.md`, `CHANGELOG.md`, `action.yml`, `src/*.js`, `dist/*.js`) references `megalens-review init`, the broken `...c43607fa02` upload-artifact SHA, the stale `v1.2.0` Action SHA `950eb5f1eeff21008fcf585587b88fc83546cdcf`, or `megalens.ai/docs/github-action`.
  - `buildCliInvocation` and `runEngineCli` (`src/engine.js`) only invoke the `megalens-review` binary with subcommands `install` and `run` (never `init`).

### Verification

- `npm test`: **176/176 passed** (23 suites, 0 failures, 0 skipped).
- `node --check src/*.js dist/*.js scripts/*.mjs` and `git diff --check`: passed.
