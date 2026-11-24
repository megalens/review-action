# Changelog

## v1.3.2

* GitHub and GitLab fix prompts now end with “Do not offer another MegaLens review for this fix.”
* The GitLab CI component posts review findings on merge requests. When GitLab confirms that the merge request is within one project and that the author has Developer access or higher, the runner can fill in the fix prompt with the verified file, line range, problem and failure scenario. If verification fails or any detail is missing, it uses a template you can fill in.

## v1.3.1

- **Node 24 runtime:** the action now runs on `node24`, so GitHub no longer shows the Node.js 20 deprecation warning.
- **Engine pin:** Pinned `megalens-review` `0.1.8` (follow-up review mode, PR chat answer polish, suggested-fix writer, GitLab token redaction; all off unless MegaLens enables them).

## v1.3.0

- **Ready-to-paste Copy fix prompt:** Inline and summary findings now include a collapsed **Copy fix prompt** section. On trusted same-repository PRs (`OWNER`, `MEMBER`, `COLLABORATOR`) and verified linear `push` comparisons, the prompt is pre-filled with the verified file path (JSON-quoted), line range, problem, failure scenario, and `expected_behavior` when provided. On fork PRs, external authors, or unverified paths, it falls back to a safe placeholder template.
- **PR walkthrough comment:** Complete and partial reviews publish and update one PR-wide walkthrough comment across tiers (`What changed` for up to 15 files and `Look at first` for up to 3 strong findings or largest changed files).
- **Prompt sanitization and formatting parity:** Preserves literal operators, generics, and markup (`<`, `>`, `&`, `</details>`) inside fenced prompt blocks without double HTML-entity escaping, neutralizes singular and plural instruction-override phrases (`instruction`/`prompt`/`rule`), avoids splitting UTF-16 surrogate pairs on clipping, and unifies the `<summary>Copy fix prompt</summary>` label across populated and fallback templates.
- **Engine pin:** Pinned `megalens-review` `0.1.5` (tiny-diff short-run verdict improvements).
- **Formatting & trust parity:** Redacts Basic Auth headers/credentials and `rk_` review keys across comments, prompts, and inline markers; entity-escapes Markdown delimiters inside HTML `<code>` filename tags (preserving paths such as `__init__.py` in GFM); and distinguishes same-repository PRs inside forked repositories from cross-repository fork PRs.

## v1.2.0

- Pinned `megalens-review` `0.1.3` (WSL2 support, project mode, local MCP); `pull_request` and `workflow_dispatch` behavior unchanged.

## v1.1.0

- Added `workflow_dispatch` support (`create`, `review`, `publish` without a pull request), verified `too_large` handling, base SHA verification, and fixed non-echoing mismatch errors.

## v1.0.0 (`v1`)

- Initial three-job (`create` -> `review` -> `publish`) GitHub Action with fork-PR isolation, diff-hunk inline routing, burst guard, stale-head guard, and pinned `megalens-review` integrity verification.
