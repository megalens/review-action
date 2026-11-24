# action-131 report
v1.3.1 = runs.using node24 (Node.js 20 deprecation warning) + engine pin megalens-review 0.1.8 with its npm dist.integrity (sha512-yvlq...LBg==, from npm view) + README engine-version line + tests: too-large pin tests updated; outdated README placeholder test (failing on published v1.3.0) replaced by a test that examples pin a real 40-char release SHA with a tag comment. npm test 177/177.

## Fix round

- Fixed FIRST.md finding 1 (Medium). The v1 findings parser now validates and preserves provider attribution on the document, passes, findings, and dropped findings. It accepts OpenAI and Google, limits provider lists to two entries, and caps fallback reasons and reviewer model names at 128 characters. A reviewer model may be null, as allowed by the pinned engine. Unknown keys are still rejected, including inside reviewer objects.
- The regression tests exercise accepted and malformed attribution and verify successful `full`-mode PR publishing for multi-reviewer Deep and provider fallback. The publishing tests use engine fixtures and a stubbed GitHub API. See `test/fable-final-fixes.test.js:93`.
- Tightened the README pin test to capture refs before validating them as 40-character hexadecimal SHAs. Removed the unused imports and verified that adding either a tag or a quoted branch alongside the valid pins fails the SHA assertion. See `test/fix-prompt-summary.test.js:686`.
- `npm test` passed all 181 tests across 24 suites on Node v22.22.0, with zero failures or skips. `git diff --check` passed.
