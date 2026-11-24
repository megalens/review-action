# MegaLens GitHub Action

Runs the `megalens-review` engine CLI (`ENGINE-V2-CONTRACT.md`) inside an isolated temp directory on your GitHub Actions runner and publishes line-anchored review feedback on pull requests.

## Security Model & Three-Job Split (`create` -> `review` -> `publish`)

- **No secrets for forks:** On `pull_request` events from fork repositories (and Dependabot/no-secret PRs), the Action exits cleanly with `0` and never runs the engine or leaks credentials.
- **BYO `openai-api-key` is not available yet (and is refused on fork PRs):** Only a MegaLens token (`megalens-token`) via the three-job `create` -> `review` -> `publish` workflow is supported right now.
- **Three-job isolation (`create` -> `review` -> `publish`):**
  1. **`create` job (`mode: create`, no checkout, `permissions: {}` on `pull_request`):** holds `megalens-token`, calls `POST /api/v2/reviews` with `repo`, `base_sha`, `head_sha`, and `tier`, and outputs `review_id` and `review_key`. The short-lived `review_key` is **not** masked in `create` (GitHub drops masked job outputs) and is never printed or logged.
  2. **`review` job (`mode: review`, `permissions: contents: read` only):** its **first step** masks `review_key` with `::add-mask::`, checks out PR code with `persist-credentials: false`, never receives `megalens-token` or `pull-requests: write`, runs the engine CLI with allowlisted env (`MEGALENS_REVIEW_ID` and `MEGALENS_REVIEW_KEY` only), and uploads `findings.json` as artifact `artifact-name` (default `megalens-findings`).
  3. **`publish` job (`mode: publish`, `permissions: contents: read`, `pull-requests: write`, no checkout):** holds **no** MegaLens/OpenAI secrets and does **not** check out PR code. It downloads the `megalens-findings` artifact, validates it strictly against `megalens.findings/v1` (size cap, types, string lengths, enums, no extra fields), sanitizes all strings, and posts inline review comments, one tier-scoped findings summary (`<!-- megalens:review:v1:<tier> -->`), and a PR walkthrough.
- **Minimum permissions (`permissions: {}` at top level):**
  - `contents: read` — read repository files for review / PR metadata.
  - `pull-requests: write` — post the PR review for `strong` P0/P1 findings and create/update the PR summary comment via the PR/issue comments endpoint. **`issues: write` is not needed.**
- **`full` mode (`mode: full`):** **same-repo trusted PRs only, not for forks.** Always use the three-job `create` -> `review` -> `publish` split for any repository that accepts fork PRs.
- **Pin third-party actions and `megalens/review-action` by commit SHA** (the examples below pin `megalens/review-action` to the v1.3.0 commit in every job with the 40-character release commit SHA).
- **Self-hosted runners:** **Do not use self-hosted runners on public repositories for fork PRs.** A fork PR or compromised checkout on a persistent runner can expose cached credentials or host state. The Action emits a warning when `RUNNER_ENVIRONMENT == self-hosted` on a fork PR.

## What Leaves the Runner

The Action runs on the customer's runner. The whole repo is not uploaded. Code excerpts the reviewer reads, and the diff, pass through the gateway to MegaLens and OpenAI in gateway mode.

- **Gateway mode (default):** `create` obtains a single-review `review_id` and `review_key` via `MEGALENS_TOKEN`; `review` passes `MEGALENS_REVIEW_ID` and `MEGALENS_REVIEW_KEY` to `megalens-review`.
- **BYO-key mode (not available yet):** `openai-api-key` is currently disabled; create/review jobs fail early with `BYO OpenAI key mode is not available yet; use megalens-token.` (When enabled in a future release on non-fork PRs, `megalens-review` sets `MEGALENS_BYO=1` and sends model requests directly to OpenAI using your key.)

## Usage: Standard Tier (`pull_request`)

Launch tiers are **Standard** and **Deep** only (`double` is not available yet and is refused with `The Double tier is not available yet; use standard or deep.`). Use `standard` (default) on `pull_request` events (`deep` is refused on `pull_request` and downgraded to `standard` with a warning):


```yaml
name: MegaLens Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions: {}

concurrency:
  group: megalens-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  create:
    runs-on: ubuntu-latest
    permissions: {}
    outputs:
      review_id: ${{ steps.create.outputs.review_id }}
      review_key: ${{ steps.create.outputs.review_key }}
      head_sha: ${{ steps.create.outputs.head_sha }}
      base_sha: ${{ steps.create.outputs.base_sha }}
    steps:
      - id: create
        uses: megalens/review-action@38aae94fbc4f4bdb05964c249d106c1c13cb632c # v1.3.0
        with:
          mode: create
          tier: standard
          megalens-token: ${{ secrets.MEGALENS_TOKEN }}

  review:
    needs: create
    if: ${{ needs.create.outputs.review_id != '' }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Mask review key
        env:
          REVIEW_KEY: ${{ needs.create.outputs.review_key }}
        run: echo "::add-mask::$REVIEW_KEY"

      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: megalens/review-action@38aae94fbc4f4bdb05964c249d106c1c13cb632c # v1.3.0
        env:
          MEGALENS_REVIEW_ID: ${{ needs.create.outputs.review_id }}
          MEGALENS_REVIEW_KEY: ${{ needs.create.outputs.review_key }}
        with:
          mode: review
          tier: standard
          head-sha: ${{ needs.create.outputs.head_sha }}
          base-sha: ${{ needs.create.outputs.base_sha }}
          artifact-name: megalens-findings
          findings-path: ${{ runner.temp }}/findings.json

      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        if: always()
        with:
          name: megalens-findings
          path: ${{ runner.temp }}/findings.json
          if-no-files-found: ignore

  publish:
    needs: [create, review]
    if: always() && needs.review.result != 'skipped'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0
        with:
          name: megalens-findings
          path: ${{ runner.temp }}

      - uses: megalens/review-action@38aae94fbc4f4bdb05964c249d106c1c13cb632c # v1.3.0
        with:
          mode: publish
          tier: standard
          head-sha: ${{ needs.create.outputs.head_sha }}
          artifact-name: megalens-findings
          findings-path: ${{ runner.temp }}/findings.json
          inline: true
          fail-on: none
```

## Usage: Comment-Triggered Review (`issue_comment`)

Run `deep` (`/megalens deep`) or `standard` (`/megalens review`) when a maintainer with `write`, `maintain`, or `admin` repository access comments on a pull request (including fork PRs after maintainer inspection). `create` pins `head_sha` and `base_sha` at trigger time so `review` checks out the exact inspected commit and `publish` detects if the PR moved:


```yaml
name: MegaLens Comment Review

on:
  issue_comment:
    types: [created]

permissions: {}

concurrency:
  group: megalens-${{ github.event.issue.number }}
  cancel-in-progress: true

jobs:
  create:
    if: >-
      github.event.issue.pull_request &&
      (contains(github.event.comment.body, '/megalens deep') ||
       contains(github.event.comment.body, '/megalens review'))
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      review_id: ${{ steps.create.outputs.review_id }}
      review_key: ${{ steps.create.outputs.review_key }}
      head_sha: ${{ steps.create.outputs.head_sha }}
      base_sha: ${{ steps.create.outputs.base_sha }}
    steps:
      - id: create
        uses: megalens/review-action@38aae94fbc4f4bdb05964c249d106c1c13cb632c # v1.3.0
        with:
          mode: create
          tier: standard
          megalens-token: ${{ secrets.MEGALENS_TOKEN }}

  review:
    needs: create
    if: ${{ needs.create.outputs.review_id != '' }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Mask review key
        env:
          REVIEW_KEY: ${{ needs.create.outputs.review_key }}
        run: echo "::add-mask::$REVIEW_KEY"

      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          ref: ${{ needs.create.outputs.head_sha }}
          fetch-depth: 0
          persist-credentials: false

      - uses: megalens/review-action@38aae94fbc4f4bdb05964c249d106c1c13cb632c # v1.3.0
        env:
          MEGALENS_REVIEW_ID: ${{ needs.create.outputs.review_id }}
          MEGALENS_REVIEW_KEY: ${{ needs.create.outputs.review_key }}
        with:
          mode: review
          tier: standard
          head-sha: ${{ needs.create.outputs.head_sha }}
          base-sha: ${{ needs.create.outputs.base_sha }}
          artifact-name: megalens-findings
          findings-path: ${{ runner.temp }}/findings.json

      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        if: always()
        with:
          name: megalens-findings
          path: ${{ runner.temp }}/findings.json
          if-no-files-found: ignore

  publish:
    needs: [create, review]
    if: always() && needs.review.result != 'skipped'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0
        with:
          name: megalens-findings
          path: ${{ runner.temp }}

      - uses: megalens/review-action@38aae94fbc4f4bdb05964c249d106c1c13cb632c # v1.3.0
        with:
          mode: publish
          tier: standard
          head-sha: ${{ needs.create.outputs.head_sha }}
          artifact-name: megalens-findings
          findings-path: ${{ runner.temp }}/findings.json
          inline: true
          fail-on: none
```

> **Note:** Never run `npm install`, build scripts, or tests from untrusted PR code in the same job that holds secrets. Always keep `create` (`megalens-token`, no checkout), `review` (`contents: read` only, `MEGALENS_REVIEW_ID`/`MEGALENS_REVIEW_KEY` only), and `publish` (`pull-requests: write`, no PR checkout, no secrets) separate.
> **Bubblewrap requirement:** `megalens-review` requires `bwrap` (bubblewrap) and a non-root user. In `review` and `full` mode the Action checks this before the engine runs, and the input `setup-sandbox` decides whether it may change the machine:
> - `auto` (default): on a GitHub-hosted runner (`RUNNER_ENVIRONMENT` is `github-hosted`) the Action installs bubblewrap if it is missing, checks that the nested sandbox starts, and only if it is blocked (Ubuntu AppArmor) sets one kernel setting and, if that is not enough, unloads two AppArmor profiles. These are changes to that runner machine; GitHub-hosted runners are thrown away after the job. No workflow step is needed, and an older workflow that still has the install step keeps working. On any other runner, `auto` makes no sudo call and changes nothing; it logs the commands below.
> - `force`: the same changes on any runner, including a self-hosted one. On a self-hosted machine the Action prints a `::warning::`: the install stays, and the kernel and AppArmor change covers the whole machine and lasts until the runner is rebooted.
> - `off`: the Action only checks and logs. It never calls sudo.
>
> To do the setup yourself (self-hosted runners, or `setup-sandbox: off`): `sudo apt-get install -y bubblewrap`, then if the sandbox is still blocked `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` and `sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict` (and `/etc/apparmor.d/unprivileged_userns` if that file exists). If the sandbox still cannot start, the engine stops before any review with exit code 4 and nothing is charged.
> Set `inline: false` in `publish` to skip inline comments (for example, when the MegaLens GitHub App is active on the repository).

Open **Copy fix prompt** under a finding to copy a ready-to-paste prompt for your coding tool. For trusted same-repository pull requests (`OWNER`, `MEMBER`, or `COLLABORATOR`) and verified linear `push` comparisons, the prompt includes the verified file path, line range, problem summary, failure scenario, and expected behavior; for fork pull requests, external authors, or unverified paths, it uses a safe placeholder template for you to fill in after checking the code.

After a complete or partial review, MegaLens updates one walkthrough comment per PR across review tiers. It lists up to 15 changed files and up to three places to start reading. It uses the review result and the PR file list, with no extra model calls or credits. Keep the same comment author across runs so `publish` updates the existing comment in place.

### Manual setup

1. Look up the 40-character commit SHA for the `megalens/review-action` release you want to install on the [GitHub Releases](https://github.com/megalens/review-action/releases) page (target: `v1.3.0`), or resolve it from Git once the release tag is published:
   ```bash
   git ls-remote --tags https://github.com/megalens/review-action.git v1.3.0 'v1.3.0^{}' | tail -n 1 | awk '{print $1}'
   ```
2. Copy one of the three-job workflow templates above into `.github/workflows/`. They already pin `megalens/review-action` to the v1.3.0 commit in all three jobs (`create`, `review`, `publish`).
3. Add your `MEGALENS_TOKEN` repository secret under **Settings -> Secrets and variables -> Actions**.

See [CHANGELOG.md](CHANGELOG.md) for release notes (current release target: `v1.3.0`).

Both workflows use the same concurrency group for a given PR. GitHub Actions shares concurrency groups across workflow files in the same repository. With `cancel-in-progress: true`, a new run can cancel a running review for the same PR from either workflow. [GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency#example-only-cancel-in-progress-jobs-or-runs-for-the-current-workflow)

## Usage: Manual Run Without a Pull Request (`workflow_dispatch`)

Use this to review a commit range that has no pull request, for example from a tool that starts the run with `gh workflow run`. The same three jobs run. `create` calls `POST /api/v2/reviews` with the same body as the PR path (`repo`, `base_sha`, `head_sha`, `tier`), so the same credits and the same free-review and abuse guards apply.

- **Who can start it:** GitHub only lets people with write access to the repository start a `workflow_dispatch` run. It is trusted like a maintainer comment.
- **No fork path:** dispatch reviews a commit range of the repository the run belongs to, checked out by the workflow in that repository. Check the repository name in the run before you start it: in a clone of a fork, tools such as `gh` can point at the parent repository, and GitHub serves commits from a fork network through the parent. Only someone with write access to the repository can start a dispatch run.
- **A workflow that already lists `workflow_dispatch`** and passes neither `head-sha` nor `base-sha` is skipped cleanly (exit 0), as before. Passing only one of them fails.
- **Inputs:** `head-sha` and `base-sha` (both 40-hex, both required in every mode), and `tier` (`standard` or `deep`). `full` mode and `double` are refused.
- **Token:** `megalens-token` stays in the `create` job only, as for pull requests.
- **Publish without a PR:** `publish` posts no comment and no inline review, and has no burst guard or head-moved check. It validates `findings.json` against the schema, checks that the reviewed head equals `head-sha`, and writes a short job summary (status and counts only, no code). The findings stay in the workflow artifact `megalens-findings`, which the `review` job uploads. `publish` needs only `contents: read`.
- **Result:** a `failed` review fails the job. A `partial` review is never reported as clean.

```text
on:
  workflow_dispatch:
    inputs:
      tier: { description: 'standard or deep', required: true, default: 'standard' }
      base_sha: { description: 'Base commit (40-hex)', required: true }
      head_sha: { description: 'Head commit (40-hex)', required: true }
```

Wire the inputs into the `with:` blocks of the three jobs as `tier: ${{ inputs.tier }}`, `base-sha: ${{ inputs.base_sha }}` and `head-sha: ${{ inputs.head_sha }}`, and check out `ref: ${{ inputs.head_sha }}` in the `review` job.

## Fork-PR Policy

- On `pull_request` events from a fork, the Action **always skips** (regardless of whether secrets are configured) with exit `0` and writes:
  `skipped: fork PR; a maintainer can comment /megalens review`
- BYO `openai-api-key` is **not available yet** (and when enabled will remain **refused on fork PRs**, including maintainer-triggered comments, with:
  `skipped: BYO key is not used on fork PRs; use a MegaLens token`).
- A maintainer with `write`, `maintain`, or `admin` permission can inspect the PR first and then comment `/megalens review` or `/megalens deep` to run the review via the `issue_comment` workflow.
- **Never use `pull_request_target` with PR checkout and secrets.** This Action refuses to run on `pull_request_target` (exit `1`).

## Inputs

| Input | Default | Description |
|---|---|---|
| `tier` | `standard` | Review tier (`standard` on `pull_request`; `deep` via `/megalens deep`; `double` is not available yet). |
| `mode` | *(required)* | `create` (create review via `POST /api/v2/reviews`), `review` (run engine with `MEGALENS_REVIEW_ID`/`MEGALENS_REVIEW_KEY`), `publish` (validate & post `findings.json`), or `full` (**same-repo trusted PRs only, not for forks**). |
| `artifact-name` | `megalens-findings` | Artifact name for `findings.json` shared between `review` and `publish`. |
| `head-sha` | `""` | Pinned PR head SHA for `review` and `publish` modes (40-hex SHA). |
| `base-sha` | `""` | Pinned PR base SHA for `review` and `publish` modes (40-hex SHA). |
| `inline` | `""` (`true` unless App active) | `true` or `false`. Set `false` to skip inline comments when the MegaLens GitHub App is active. |
| `findings-path` | `""` | Path to read/write `findings.json` when splitting `review` and `publish` jobs. |
| `megalens-token` | `""` | MegaLens account token for `create` mode (never pass to `review` or `publish`). |
| `review-id` | `""` | MegaLens review ID for `review` mode (or pass `MEGALENS_REVIEW_ID` env). |
| `review-key` | `""` | Short-lived review key for `review` mode (or pass `MEGALENS_REVIEW_KEY` env). |
| `openai-api-key` | `""` | **Not available yet** — BYO-key mode is currently disabled (create/review jobs fail early; use `megalens-token`). |
| `api-url` | `https://megalens.ai` | MegaLens API base URL for `create` mode. |
| `fail-on` | `none` | Fail the job when findings match (`none` or `strong`; incomplete runs fail when set). |
| `timeout-minutes` | `25` | Maximum minutes to wait for `megalens-review`. |
| `engine-version` | `""` | `megalens-review` version. Empty uses the version pinned in the Action (`PINNED_ENGINE_VERSION`, now 0.1.8). |
| `github-token` | `${{ github.token }}` | GitHub token used for PR comments and permission checks. |

## Outputs

| Output | Description |
|---|---|
| `status` | `complete`, `partial`, `failed`, or `skipped`. |
| `review_id` | Review ID from `create` mode or `findings.json` when available. |
| `review_key` | Short-lived review key from `create` mode (not masked in `create`; masked first in `review`). |
| `head_sha` | Pinned PR head SHA resolved in `create` mode. |
| `base_sha` | Pinned PR base SHA resolved in `create` mode. |
| `review-id` | Legacy alias for `review_id`. |
| `artifact-name` | Artifact name used for `findings.json`. |
| `findings-path` | Path where `findings.json` was written in `review` mode. |
| `strong-count` | Number of strong findings (`P0`/`P1` inside PR diff hunks, including App-overlapped strong findings). |
| `normal-count` | Number of summary-only findings placed in the collapsed `<details>` block. |

## Changes that are too large

When the engine refuses a change as too large for one review (exit code 3, reason `too_large`), the Action does not show a gateway or head-mismatch error. It posts (publish and full mode) or writes to the job summary (all modes): "MegaLens did not review this pull request: it is too large for one review (N files, about M lines). Split it into smaller pull requests. No credits were used." The job ends green (`status` output `skipped`, `reason` output `too_large`), so a large pull request is not blocked by a failed check.
