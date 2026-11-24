# GitLab preview port

Ported the reviewed GitLab CI implementation from `c2317ec` onto `gitlab-preview` at the v1.3.1 baseline (`486bc8c`). The port includes the merge request runner, CI component, Dockerfiles, setup guide, test fixtures, and local dry run. The v1.3.1 GitHub Action still uses Node 24 and its existing fix prompt, walkthrough, and redaction behavior.

The GitLab review and publish images use a digest pinned Node 24 base. GitLab reviews require `megalens-review@0.1.8` and use the shared installer to verify the npm tarball against the v1.3.1 SHA-512 pin before installation.

The port omits `patches/`. Engine `0.1.8` already includes the GitLab token, cookie, and credential path redaction, so the runner installs the verified package without an in-place patch. The source branch’s server repo key patch was also excluded. Gateway handling of GitLab repo keys remains unverified in this clone.

## Runner SHA-256

`dist/gitlab.mjs` SHA-256 and `runner_sha256` in [the CI template](templates/megalens-review.yml) both use:

```text
736886c6272cad1a7a42976d76eb0d7dc18d78f2f6581dc029dc0e29c2286658
```

## Verification

- `npm run build:gitlab` reproduced the same bundle SHA-256 and updated the template default.
- `npm test` passed all 228 tests across 29 suites on Node `v24.22.3`.
- `npm run gitlab:dry-run` rendered two inline discussions and one summary note with three summary findings. The standalone bundle skipped a push pipeline.
- The published engine tarball matched the SHA-512 pin. Its redactor removed synthetic GitLab tokens and a session cookie in UTF-8 and UTF-16LE.
- The CI template parsed as YAML. Verification was local and did not include a Docker image build or a live GitLab pipeline.
