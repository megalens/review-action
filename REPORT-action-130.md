# Action v1.3.0 Release Prep Report (`feat/action-130`)

## What was built

1. **Closed the 2 open Action findings from `/root/review-input/rv-fixprompt-real/LOOP-CONFIRM3.md`:**
   - **Double HTML-entity escaping in fenced fix prompts (`src/format.js`):** Removed `.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')` from `cleanPromptText` so operators, generics, and markup (`<`, `>`, `&`, `&&`, `=>`, `Array<User>`, `</details>`) render literally inside fenced code blocks instead of `&lt;`/`&gt;`/`&amp;`, and reassembled secrets containing `&`/`<`/`>` are redacted before clipping.
   - **Singular override phrases in `OVERRIDE_REQUEST` (`src/format.js`):** Updated `(?:instructions|prompts|rules)` to `(?:instructions?|prompts?|rules?)` so singular prompt-injection phrases (e.g., `ignore the system prompt`, `ignore previous instruction`, `override the rule`) are neutralized in both finding prose and JSON-encoded paths.
2. **Matched App ready-to-paste fix prompt rules and formatter parity:**
   - Unified the fallback template `<summary>` label in `FIX_PROMPT` (`src/format.js`) to `<summary>Copy fix prompt</summary>` to match populated prompts and the App formatter (`src/lib/github-setup/action-shared/format.js`).
   - Added UTF-16 surrogate-pair boundary protection in `clip()` (`src/format.js`) so clipping does not leave a dangling high surrogate.
   - Updated `selectNewInlineFindings` (`src/action.js`) to fall back to `comment.path` when an inline marker path was redacted (`[redacted]`), matching App `publish.ts`.
   - Verified existing `promptPaths` trust checks (`src/action.js`: live head + base match, same-repo `headRepoFullName`/`baseRepoFullName`, `!live.isFork`, `TRUSTED_PR_AUTHORS` `OWNER`/`MEMBER`/`COLLABORATOR`, changed non-removed/non-unchanged path allowlist, linear `ahead` comparison for `push`) match the App's rules.
3. **Pinned `megalens-review@0.1.5`:**
   - Ran `node scripts/pin-engine.mjs 0.1.5 sha512-Yvx6D6UzmfspHm4mGKpueFhu/G5bmSnLRG9NgnJHnZvlfF0yd0evwUmqIcQaPD3IKHRmVWXKU6qVPRWMOOJ67w==` (integrity verified from `npm view megalens-review@0.1.5 dist.integrity`).
   - Kept prior integrity entries (`0.1.0`–`0.1.3`) in `PINNED_ENGINE_INTEGRITY`.
4. **Updated docs & dry-run fixtures for `v1.3.0`:**
   - Updated `README.md` (Copy fix prompt behavior for trusted same-repo PRs / linear pushes vs fork/unverified fallback, `0.1.5` pin note, `npx megalens-review init` setup mention, link to `CHANGELOG.md`).
   - Created `CHANGELOG.md` covering `v1.3.0`, `v1.2.0`, `v1.1.0`, and `v1.0.0` (`v1`).
   - Refreshed `dry-run/inline-comment.md`, `dry-run/findings-summary.md`, and `dry-run/pr-walkthrough.md` via `node scripts/render-dry-run.mjs`.

## Files changed

- `src/format.js` — `cleanPromptText` literal fenced text, `OVERRIDE_REQUEST` singular/plural matching, `FIX_PROMPT` `<summary>Copy fix prompt</summary>`, `clip` surrogate-pair guard.
- `src/action.js` — `selectNewInlineFindings` fallback to `comment.path` when marker file includes `[redacted]`.
- `src/engine.js` — `PINNED_ENGINE_VERSION = '0.1.5'` and `'0.1.5'` entry in `PINNED_ENGINE_INTEGRITY`.
- `README.md` — Updated Copy fix prompt docs, `0.1.5` engine pin reference, `npx megalens-review init` note, and `CHANGELOG.md` link.
- `CHANGELOG.md` — Added release changelog for `v1.3.0` and earlier releases.
- `dry-run/findings-summary.md`, `dry-run/inline-comment.md` — Refreshed via `node scripts/render-dry-run.mjs`.
- `test/fix-prompt-summary.test.js`, `test/routing-and-dedup.test.js`, `test/too-large.test.js` — Updated `<summary>Copy fix prompt</summary>` and `0.1.5` pin expectations; added regression tests for literal fenced operators/generics/markup, reassembled `&`/`<` redaction, surrogate-pair clipping, singular override phrases, and redacted-path inline deduplication.
- `REPORT-action-130.md` — This report.

## Flags

- Existing launch flags in `src/engine.js` (re-exported by `src/action.js`) remain unchanged and default OFF:
  - `BYO_KEY_ENABLED = false`
  - `DOUBLE_TIER_ENABLED = false`
- No new feature flags were added (changes are bug fixes, formatter/trust parity, engine pin bump, and `v1.3.0` docs).

## Tests & verification

- `node scripts/render-dry-run.mjs` — succeeded; regenerated `dry-run/*.md`.
- `npm test` (`node --test test/*.test.js`) — **169/169 passed** across 22 suites, 0 failures, 0 skipped.
- `git diff --check` — passed (no whitespace errors).
- `diff -u` against `/root/review-input/ws-fixprompt-real/src/lib/github-setup/action-shared/{findings,diff,redact}.js` — byte-for-byte identical (0 diff).
- Note: No separate TypeScript (`tsc`) or ESLint configuration exists in `@megalens/review-action` (`package.json` contains only `"test": "node --test test/*.test.js"`).

## Owner / Coordinator steps

1. Review commit on `feat/action-130` (and run App parity check `MEGALENS_ACTION_SOURCE_DIR=/root/review-input/ws-action-130/src npx vitest run test/github-review-app.test.ts` if desired).
2. Merge `feat/action-130` into the release branch, tag `v1.3.0` (and update major tag `v1` if applicable), and push to `megalens/review-action`.
3. Update release workflow examples or customer docs if pinning to the new `v1.3.0` commit SHA.

## Open questions

- **Same-repo PRs inside a forked repository:** As noted in `NEON.md`, `src/action.js` (`promptPaths`) keeps `!live.isFork`, so a maintainer-triggered `issue_comment` review on a same-repo PR inside a forked repository falls back to the static template because `github-api.js` sets `isFork = Boolean(data.head?.repo?.fork) || ...`. Kept `!live.isFork` to fail closed for forks; if forked repositories running self-PRs should get filled prompts, `!live.isFork` can be dropped in favor of `headRepoFullName === repository && baseRepoFullName === repository`.
- **Dry-run PNGs:** `dry-run/*.md` were regenerated; `dry-run/*.png` remain from the earlier browser render (`REPORT-FIXPROMPT-SUMMARY.md`).
