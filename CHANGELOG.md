# Changelog

## v1.3.0

- **Ready-to-paste Copy fix prompt:** Inline and summary findings now include a collapsed **Copy fix prompt** section. On trusted same-repository PRs (`OWNER`, `MEMBER`, `COLLABORATOR`) and verified linear `push` comparisons, the prompt is pre-filled with the verified file path (JSON-quoted), line range, problem, failure scenario, and `expected_behavior` when provided. On fork PRs, external authors, or unverified paths, it falls back to a safe placeholder template.
- **PR walkthrough comment:** Complete and partial reviews publish and update one PR-wide walkthrough comment across tiers (`What changed` for up to 15 files and `Look at first` for up to 3 strong findings or largest changed files).
- **Prompt sanitization and formatting parity:** Preserves literal operators, generics, and markup (`<`, `>`, `&`, `</details>`) inside fenced prompt blocks without double HTML-entity escaping, neutralizes singular and plural instruction-override phrases (`instruction`/`prompt`/`rule`), avoids splitting UTF-16 surrogate pairs on clipping, and unifies the `<summary>Copy fix prompt</summary>` label across populated and fallback templates.
- **Engine pin:** Pinned `megalens-review` `0.1.5` (adds `npx megalens-review init` one-command workflow setup and tiny-diff short-run verdict improvements).

## v1.2.0

- Pinned `megalens-review` `0.1.3` (WSL2 support, project mode, local MCP); `pull_request` and `workflow_dispatch` behavior unchanged.

## v1.1.0

- Added `workflow_dispatch` support (`create`, `review`, `publish` without a pull request), verified `too_large` handling, base SHA verification, and fixed non-echoing mismatch errors.

## v1.0.0 (`v1`)

- Initial three-job (`create` -> `review` -> `publish`) GitHub Action with fork-PR isolation, diff-hunk inline routing, burst guard, stale-head guard, and pinned `megalens-review` integrity verification.
