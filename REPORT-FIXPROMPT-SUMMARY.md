# Copy fix prompt and PR walkthrough

## What changed

* Every displayed inline or summary finding has a collapsed **Fix prompt**. The plain text fence contains the file and line range when available, the issue and its impact, the expected behavior, and instructions to keep the change small, keep tests passing, and add a regression test. The formatter redacts known credentials and leaves out the evidence quote and diff text.
* Complete and partial reviews update one walkthrough per PR across tiers. The first 15 files show their change type and line counts when GitHub provides them. **Look at first** uses up to three strong findings or files with the most changed lines. The existing tier summaries still hold review status and detailed findings. A failed review or a `too_large` refusal updates the tier summary and leaves the last walkthrough identified by its commit.
* Publishing reuses the engine result and the GitHub file list already used for inline placement. There are no new model calls or credits. Walkthrough updates use the same author check and live head check as tier summary updates. Each example workflow uses a per-PR concurrency group (`README.md` notes how to combine triggers into one workflow file when cross-trigger serialization is required).

## Dry run

`node scripts/render-dry-run.mjs` loaded the saved `complete-with-route.json` engine result and captured the publish payloads with mocked GitHub calls. It rendered the same finding inline with a matching hunk and in the collapsed findings summary when the hunk was unavailable. `npm test` passed all 160 tests, including updates across pushes and tiers, stale head handling, and formatter limits.

The screenshots are local browser renders. The dry run verified expansion and the plain text code block. GitHub’s own copy control requires a live PR to verify. [GitHub documentation on collapsed sections](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections)

### Inline review comment

![Inline review comment with the Fix prompt collapsed and expanded](dry-run/inline-comment.png)

[Inline comment Markdown](dry-run/inline-comment.md)

### Findings summary

![Findings summary with the summary group and Fix prompt collapsed and expanded](dry-run/findings-summary.png)

[Findings summary Markdown](dry-run/findings-summary.md)

### PR walkthrough

![PR walkthrough with What changed and Look at first](dry-run/pr-walkthrough.png)

[PR walkthrough Markdown](dry-run/pr-walkthrough.md)

## Open questions

* Should a failed or refused run refresh the walkthrough from the diff file list alone?
* Should a future engine version provide a dedicated expected behavior field and file descriptions? The pinned schema has neither, so prompts use the reported failure and the walkthrough uses GitHub file metadata.

Git staging was blocked because `.git` is mounted read only in this workspace. The changes remain in the working tree.

## Fix round

Addressed all three findings from `/root/review-input/rv-fixprompt/GEMINI.md`:

1. **[HIGH] Unescaped HTML comment markers in `formatFixPrompt` hijack `parseInlineMarker`** (`src/format.js:100-121`, `src/format.js:183-191`, `test/fix-prompt-summary.test.js:184-224`)
   - Anchored `parseInlineMarker` (`src/format.js:103-105`) to match only a single-line marker at the trailing end of the comment body (`/(?:^|\r?\n)<!--[ \t]*(...)[ \t]*-->\s*$/i`), ignoring any marker strings embedded earlier in the body.
   - Neutralized `<!--` and `-->` sequences in `formatFixPrompt` (`src/format.js:185-189`) across `file`, `title`, `claim`, and `failure_scenario` (`text.replace(/<!(?=-)/g, '< !').replace(/--(?=>)/g, '- -')`) as defense in depth.
   - Added unit test verifying that a finding containing a forged inline marker targeting another file/line neither emits raw HTML comment delimiters in the prompt nor suppresses the target finding or fails self-deduplication in `selectNewInlineFindings`.

2. **[MEDIUM] `findSummaryCommentDetails` only matches `\n` after the marker, creating duplicate comments when bodies use `\r\n`** (`src/github-api.js:108`, `test/fix-prompt-summary.test.js:226-240`)
   - Updated `findSummaryCommentDetails` (`src/github-api.js:108`) to accept `c.body === marker || c.body.startsWith(`${marker}\n`) || c.body.startsWith(`${marker}\r\n`)`.
   - Added regression test verifying `findSummaryComment` and `findSummaryCommentDetails` match CRLF-delimited walkthrough and tier summary comments.

3. **[MEDIUM] Separate `pull_request` and `issue_comment` workflow files do not share a GitHub Actions concurrency group** (`README.md:233`, `REPORT-FIXPROMPT-SUMMARY.md:7`, `test/fix-prompt-summary.test.js:242-246`)
   - Updated `README.md:233` (and `REPORT-FIXPROMPT-SUMMARY.md:7`) to clarify that GitHub Actions `concurrency.group` only serializes runs within the same workflow file (not across separate workflow files) and showed how to combine `pull_request` and `issue_comment` into one workflow file using `group: megalens-${{ github.event.pull_request.number || github.event.issue.number }}` when cross-trigger serialization is required.
   - Added unit test asserting `README.md` documents the single-workflow scope of `concurrency.group` and the combined trigger group expression.
