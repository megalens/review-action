# MegaLens on GitLab CI

MegaLens uses the pinned `megalens-review` engine on your GitLab runner and posts feedback on the merge request.

- **Strong findings (`P0`/`P1` inside the reviewed diff)** are posted as **inline MR discussions** anchored to the exact file and line (capped at 25 per run and deduplicated across reruns). Even if GitLab omits a file's patch text due to MR diff limits, strong findings on changed lines in the local reviewed diff (including non-ASCII/quoted paths) still appear under **Strong findings** and enforce `fail_on: strong`.
- **All other findings** (`normal`, `P2`/`P3`, or findings outside the diff hunks) go into **ONE collapsed `<details>` summary note** that is updated in place on reruns.
- **Spend guard for Deep:** Automatic MR pushes always run `standard`. Deep reviews are exposed through a zero-secret manual trigger job (`<job_name>-deep`) that chains into non-manual `<job_name>-deep-run` + `<job_name>-deep-publish` jobs so only authorized project members can trigger Deep and manual job variables can never enter a credential-bearing job.

The review job marks the commit and tier as in progress in the merge request, then saves a redacted result for the publish job. The publish job uses only `MEGALENS_GITLAB_TOKEN`. You can retry that job after a GitLab API error without creating another review.

Same credits, same 3 free Standard reviews, same size guard (`too_large` ends green with 0 credits used), and the same "no charge for our failures" billing rules as the MegaLens GitHub Action.

---

## Prerequisites (Read Before Creating Tokens)

1. **GitLab tier requirement for Project Access Tokens:**
   - **GitLab.com (SaaS):** Project Access Tokens require **GitLab Premium** or **Ultimate**. They are **not** available on GitLab.com Free, and during a GitLab.com **trial** you are limited to **one** project access token.
   - **GitLab Self-Managed & Dedicated:** Project Access Tokens are available on **any tier** (Free, Premium, or Ultimate).
2. **Self-managed Internal-visibility reach & `Reporter` + `api` capabilities:**
   - On self-managed GitLab instances, every Project Access Token creates a bot user treated as an **internal user**. When created by an internal user, a token with `api` scope can also **access all projects on the same instance whose visibility is set to Internal** (not strictly only this project).
   - Within this project, `Reporter` + `api` allows reading repository source, MR diffs, and CI job artifacts as well as creating issues and MR notes/discussions (not strictly only MR comments). Treat `MEGALENS_GITLAB_TOKEN` as a sensitive secret and always mark it **Masked + Protected**.
3. **Container executor + pre-baked runner image pinned by `@sha256` digest:**
   - Build the container image from `docker/gitlab-runner.Dockerfile` and pin it by digest. The image includes Node 24, `git`, `ca-certificates`, and `bubblewrap` (`bwrap`).
   - A **container executor** (Docker, Docker Autoscaler ephemeral VM with Docker, or Kubernetes) configured to permit unprivileged user namespaces for `bwrap` is required so GitLab actually executes the digest-pinned `image:`. GitLab `shell` executors **ignore `image:`** and share host state across jobs; do not use a `shell` runner.

---

## Setup in 5 Steps

1. **Get your MegaLens account token (`MEGALENS_TOKEN`):**
   Create a token (`ml_tok_...`) in your MegaLens account settings and accept the current data-flow notice.

2. **Create a GitLab Project Access Token (`MEGALENS_GITLAB_TOKEN`):**
   *(GitLab.com requires Premium/Ultimate — trials are limited to 1 token; self-managed/Dedicated supports all tiers. Review the Internal-visibility reach and `Reporter` + `api` scope notes above before creating.)*
   In your GitLab project, go to **Settings -> Access Tokens** and create a **Project Access Token**:
   - **Name:** `megalens-review`
   - **Role:** **Reporter** (minimum role that can read MR diffs and post/edit its own MR comments; **Developer** also works)
   - **Scope:** **`api`** (see [Why `api` is required](#token-scopes--why-read_api-is-not-enough) below)

3. **Add BOTH CI/CD variables as Masked + Protected with explicit Environment Scopes, and disable pipeline/manual variable overrides:**
   In your GitLab project, go to **Settings -> CI/CD -> Variables** *(project-level environment scopes are available on all GitLab tiers, including Free)*:
   - `MEGALENS_TOKEN` — **Masked** AND **Protected** (required), **Environment scope: `megalens-review`** (required — do **not** leave at `*` / All environments, so the publish job, manual trigger, gate job, and unrelated jobs never receive your MegaLens billing token).
   - `MEGALENS_GITLAB_TOKEN` — **Masked** AND **Protected** (required), **Environment scope: `megalens-*`** (required — restricts the posting token to `megalens-review` and `megalens-publish` jobs only, keeping it out of the zero-secret manual `<job_name>-deep` trigger, `<job_name>-gate`, and unrelated build/test jobs; both `<job_name>-deep` and `<job_name>-gate` fail closed if either token is left unscoped at `*`).
   - **Minimum role to use pipeline variables (`ci_pipeline_variables_minimum_override_role`):** Set to **No one allowed** (`no_one_allowed`, already the default for new GitLab.com projects) as defense in depth. Even if pipeline/manual variables are enabled for authorized members, all four credential-bearing jobs (`<job_name>`, `<job_name>-publish`, `<job_name>-deep-run`, `<job_name>-deep-publish`) are non-manual (`when: on_success`) so GitLab never accepts manual or retry job variables on them; manual `<job_name>-deep` carries no `environment:` and zero secrets. *(If a self-managed runner also reuses build volumes across jobs with custom helper hooks, you can additionally pin a hardened helper image built from `docker/gitlab-runner-helper.Dockerfile` via `helper_image` in runner `config.toml`.)*

   > **Important:**
   > - Both tokens **must** be **Protected**. GitLab project CI/CD variables override YAML job `variables:`, and a parent-run fork pipeline executes the fork's `.gitlab-ci.yml` with any eligible unprotected project variables. Marking both tokens **Protected** ensures fork pipelines never receive either token.
   > - `MEGALENS_TOKEN` **must** be scoped to `megalens-review` (matching `inputs.review_environment`) and `MEGALENS_GITLAB_TOKEN` **must** be scoped to `megalens-*` (matching `inputs.review_environment` and `inputs.publish_environment`, never `*`). The publish job runs in `megalens-publish` (`inputs.publish_environment`) and **refuses to run (`exit 1`)** if `MEGALENS_TOKEN` is present; `<job_name>-deep` and `<job_name>-gate` carry no `environment:` and **refuse to run (`exit 1`)** if either token is present.
   > - See [Protected Variable Requirements for MR Pipelines](#protected-variable-requirements-for-mr-pipelines) below.

4. **Include the pinned MegaLens CI component/template in `.gitlab-ci.yml`:**
   Pin the include, `runner_url`, and `image` to exact immutable release references (commit SHA and `@sha256:` image digest — both `runner_url` and `image` are required inputs):

   ```yaml
   # Option A: GitLab CI/CD Component (GitLab 16.0+, hosted on your GitLab mirror/catalog)
   include:
     - component: $CI_SERVER_FQDN/megalens/review-action/megalens-review@<RELEASE_COMMIT_SHA>
       inputs:
         stage: test
         fail_on: none         # none (default) or strong
         gitlab_api_url: https://gitlab.com/api/v4
         image: registry.example.com/megalens/gitlab-runner@sha256:<BUILT_IMAGE_DIGEST>
         runner_url: https://raw.githubusercontent.com/megalens/review-action/<RELEASE_COMMIT_SHA>/dist/gitlab.mjs

   # Option B: Direct remote include pinned to a release commit SHA
   # include:
   #   - remote: https://raw.githubusercontent.com/megalens/review-action/<RELEASE_COMMIT_SHA>/templates/megalens-review.yml
   #     inputs:
   #       stage: test
   #       fail_on: none
   #       gitlab_api_url: https://gitlab.com/api/v4
   #       image: registry.example.com/megalens/gitlab-runner@sha256:<BUILT_IMAGE_DIGEST>
   #       runner_url: https://raw.githubusercontent.com/megalens/review-action/<RELEASE_COMMIT_SHA>/dist/gitlab.mjs
   ```

   Set the required `gitlab_api_url` input in the trusted include configuration. Use `https://gitlab.com/api/v4` for GitLab.com. For other instances, include your port or installation path if needed, for example `https://gitlab.example.com:8443/gitlab/api/v4`.

   Ensure your `.gitlab-ci.yml` enables merge request pipelines (for example via `workflow: rules:`):

   ```yaml
   workflow:
     rules:
       - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
       - if: '$CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS'
         when: never
       - if: '$CI_COMMIT_BRANCH'
   ```

5. **Open an eligible same-project merge request:**
   - Automatic pushes run `megalens-review` (`standard`, environment `megalens-review`) -> `megalens-review-publish` (environment `megalens-publish`) -> `megalens-review-gate` (zero-secret fail-closed sentinel), verifying the compile-time pinned `dist/gitlab.mjs` sha256 and pinned `megalens-review` npm tarball sha512.
   - To run a **Deep** review on an MR, an authorized project member manually triggers the zero-secret `megalens-review-deep` job in the pipeline UI; `megalens-review-deep-run` and `megalens-review-deep-publish` run automatically right after it finishes.

---

## CI/CD Variables & Template Inputs

### Required CI/CD Variables

| Variable | Flags & Environment Scope | Description |
|---|---|---|
| `MEGALENS_TOKEN` | **Masked + Protected**, Environment scope **`megalens-review`** | Your MegaLens account token (`ml_tok_...`). Injected **only** into review jobs (`environment: name: megalens-review, action: access`) to call `POST /api/v2/reviews` on a trusted HTTPS MegaLens origin (`https://megalens.ai` or `https://<subdomain>.megalens.ai`) and obtain a short-lived single-review `review_id` + `review_key`. Never passed to `megalens-review`, the model sandbox, or publish jobs (publish jobs refuse to run if `MEGALENS_TOKEN` is present). |
| `MEGALENS_GITLAB_TOKEN` | **Masked + Protected**, Environment scope **`megalens-*`** *(required)* | Project Access Token (`glpat-...`) with **Reporter** (or **Developer**) role and **`api`** scope. Used only to read MR metadata/diffs and post/update MR notes and inline discussions. Never passed to `megalens-review` or the model sandbox, never injected into unscoped `<job_name>-deep` or `<job_name>-gate`, and never forwarded across HTTP redirects (`redirect: 'error'`). |

#### Token Scopes — Why `read_api` (and `$CI_JOB_TOKEN`) Are Not Enough
- **`read_api` is read-only:** It permits `GET`/`HEAD` calls only. Posting inline MR discussions (`POST /projects/:id/merge_requests/:iid/discussions`), creating the summary note (`POST /projects/:id/merge_requests/:iid/notes`), and updating the summary note in place (`PUT /projects/:id/merge_requests/:iid/notes/:note_id`) all require API write permission.
- **No narrower MR-notes scope exists in GitLab:** GitLab Project Access Tokens do not offer a `write_merge_request_notes` scope. Using a **Project** Access Token with the **Reporter** role and `api` scope prevents pushing code or changing project settings, though it still grants full Reporter API capabilities on the project (reading source, MR diffs, CI artifacts, creating issues/notes) and — on self-managed instances when created by an internal user — read access to other **Internal-visibility** projects on the instance. *(GitLab.com requires Premium or Ultimate for Project Access Tokens, with trials limited to 1 token; self-managed/Dedicated supports all tiers.)*
- **`$CI_JOB_TOKEN` cannot post MR notes:** GitLab restricts `$CI_JOB_TOKEN` to a narrow allowlist of endpoints and rejects MR note/discussion writes.

#### Protected Variable Requirements for MR Pipelines
Protecting the source branch alone is **not** sufficient to expose Protected variables in GitLab merge request pipelines. All of the following apply:

1. **GitLab 18.1+ protected-resource MR setting:** As a **Maintainer** or **Owner**, go to **Settings -> CI/CD -> Variables**, find **Access protected resources in merge request pipelines**, and enable **"Allow merge request pipelines to access protected variables and runners"**. *(Enabled by default for projects created on GitLab 18.1+; older projects upgraded to 18.1+ may need to enable it explicitly.)*
2. **Both source and target branches must be protected:** GitLab requires **both** the MR source branch (for example via a protected branch wildcard like `review/*` or `feat/*`) **and** the target branch (such as `main`) to be protected.
3. **Triggering user's target-branch permissions:** The user who triggers the MR pipeline must have permission to push or merge to the **target branch**.
4. **Never enable parent-run fork pipelines with unprotected secrets:** Keep **"Run pipelines in the parent project for merge requests from forks"** disabled, keep **both** `MEGALENS_TOKEN` and `MEGALENS_GITLAB_TOKEN` marked **Protected + Masked**, and keep `MEGALENS_TOKEN` scoped to **`megalens-review`**.
5. **Graceful skip on unprotected MRs vs. fail-closed on eligible protected MRs:**
   - When GitLab marks an MR pipeline ineligible (`CI_COMMIT_REF_PROTECTED=false`) and withholds **both** protected tokens, MegaLens prints a clear skip notice and **exits `0` at 0 credits** so routine unprotected feature-branch pipelines are not broken.
   - On an **eligible protected MR** (`CI_COMMIT_REF_PROTECTED=true`) — or whenever only one token is present — missing, misnamed, or mis-scoped credentials **fail (`exit 1`)** so `fail_on: strong` can never pass without a review.

### Template Inputs (`templates/megalens-review.yml`)

| Input | Default | Description |
|---|---|---|
| `job_name` | `megalens-review` | Base job name (creates `<job_name>`, `<job_name>-publish`, `<job_name>-gate`, `<job_name>-deep`, `<job_name>-deep-run`, `<job_name>-deep-publish`, and `<job_name>-fork-skip`). |
| `stage` | `test` | Pipeline stage. |
| `tier` | `standard` | Automatic MR push tier (`standard` only; Deep is triggered via the manual `<job_name>-deep` job, and the runtime also downgrades any non-manual `MEGALENS_TIER=deep` to `standard`). |
| `fail_on` | `none` | `none` or `strong` (fails on strong findings in the local reviewed diff or incomplete `partial`/`failed` reviews; `too_large` always stays green; burst-guard cache hits reapply `fail_on: strong` using stored bot-authored `strong=N` metadata so retrying cannot turn a failed gate green). |
| `inline` | `true` | Post strong `P0`/`P1` findings with GitLab diff positions as inline MR discussions (`false` posts the summary note only). |
| `timeout_minutes` | `25` | Maximum minutes to wait for `megalens-review`. |
| `api_url` | `https://megalens.ai` | Trusted HTTPS MegaLens gateway origin (`https://megalens.ai` or `https://<subdomain>.megalens.ai`; standard HTTPS port only; plain HTTP and localhost are rejected). Validated once before authentication and passed identically to both review creation and the engine subprocess. |
| `gitlab_api_url` | *(required)* | HTTPS GitLab API base for review and publish jobs. The component sets it from the include configuration, including for manual Deep jobs. |
| `engine_version` | `0.1.8` | Required engine version. The runner verifies the npm tarball against its pinned SHA512 digest before installation. |
| `review_environment` | `megalens-review` | GitLab environment attached to review jobs (`action: access`) for scoping `MEGALENS_TOKEN`. |
| `publish_environment` | `megalens-publish` | GitLab environment attached to publish jobs (`action: access`, receives `MEGALENS_GITLAB_TOKEN` only; refuses `MEGALENS_TOKEN`). |
| `image` | *(required)* | Node 24 image with `git`, `ca-certificates`, and `bubblewrap`. Build it from `docker/gitlab-runner.Dockerfile`, pin its `@sha256:` digest, and use a container executor. |
| `publish_image` | `node:24-bookworm-slim@sha256:32e57b57...` | Node 24 image for `<job_name>-publish` and `<job_name>-fork-skip`. |
| `runner_url` | *(required)* | Immutable HTTPS URL of `dist/gitlab.mjs` pinned to a release commit SHA. Compiled into the job script at pipeline parse time (`dependencies: []` blocks upstream dotenv overrides). |
| `runner_sha256` | *(pinned sha256)* | Expected 64-hex sha256 digest of `dist/gitlab.mjs`, compiled into the job script and verified with `crypto.timingSafeEqual` before execution. |
| `allow_failure` | `false` | Whether the MR pipeline may pass if the automatic review or publish job exits non-zero. |

---

## Fork Merge Request Behaviour

Merge requests from forks **never** run MegaLens with your project's secrets:

1. **Protected CI/CD Variables (primary security boundary):** Both `MEGALENS_TOKEN` and `MEGALENS_GITLAB_TOKEN` are **Protected + Masked** (and `MEGALENS_TOKEN` is scoped to `megalens-review`), so GitLab never injects either variable into fork pipelines (even if a fork pipeline were manually run in the parent project). Note that YAML `variables:` cannot override GitLab project CI/CD variables — Protected flags and environment scopes are what keep secrets isolated.
2. **Strict three-ID GitLab CI `rules:`:** All review/publish/deep jobs require `$CI_PROJECT_ID`, `$CI_MERGE_REQUEST_SOURCE_PROJECT_ID`, **and** `$CI_MERGE_REQUEST_PROJECT_ID` (GitLab's MR target project ID) to all be present and equal. In a normal fork-hosted MR pipeline (`CI_PROJECT_ID == CI_MERGE_REQUEST_SOURCE_PROJECT_ID != CI_MERGE_REQUEST_PROJECT_ID`), the review job is **not** selected and `<job_name>-fork-skip` runs instead (`GIT_STRATEGY: none`, `dependencies: []`, prints the skip note, exits `0`).
3. **Runtime fail-closed guard:** Both the shell script (`set +x`, no token echoing) and `dist/gitlab.mjs` require `CI_PROJECT_ID`, `CI_MERGE_REQUEST_SOURCE_PROJECT_ID`, `CI_MERGE_REQUEST_PROJECT_ID`, project paths, and live MR `source_project_id === target_project_id === CI_PROJECT_ID` to all match before calling any API.

---

## Concurrency, Artifact Security, Freshness & Billing Protections

1. All jobs set `inherit: { variables: false }`, `before_script: []`, `after_script: []`, and explicit `hooks: pre_get_sources_script` overrides so global YAML variables and project-wide default scripts/hooks never run with MegaLens tokens. Review jobs use `dependencies: []` (and `<job_name>-deep-run` uses `needs: [{ job: <job_name>-deep, artifacts: false }]`) to block earlier-stage dotenv variables. All four credential-bearing jobs (`<job_name>`, `<job_name>-publish`, `<job_name>-deep-run`, `<job_name>-deep-publish`) are non-manual (`when: on_success`) so GitLab never permits manual or retry job variables to inject `PATH`/`BASH_ENV`/`ENV`/`LD_PRELOAD` into their separate Docker helper containers before `writeExports`/`SourceEnv`/`writeGitSSLConfig`; the manual `<job_name>-deep` trigger carries no `environment:` and zero secrets. Any global OR environment-scoped (`megalens-review`, `megalens-publish`, `megalens-*`) `PATH`, `BASH_ENV`, `ENV`, or `LD_PRELOAD` CI/CD variable omits the affected credential-bearing job(s) in `rules:`, causing the unscoped `<job_name>-gate` job (`needs: [<job_name>-publish]`) to fail pipeline creation immediately (0 jobs run, 0 credits spent, 0 tokens exposed, and `fail_on: strong` can never be silently bypassed). Review jobs also set `artifacts: when: on_success`, require the `docker/gitlab-runner.Dockerfile` `readonly PATH` image hardening, unset `NODE_OPTIONS`/`NODE_DEBUG`/`NODE_DEBUG_NATIVE`, and compile API endpoints and runner pins directly from component inputs. Setting `ci_pipeline_variables_minimum_override_role` to `no_one_allowed` (and optionally pinning `docker/gitlab-runner-helper.Dockerfile` via `helper_image` on self-managed runners) adds defense in depth.
2. Before saving `.megalens-ci/review-result.json`, the runner removes evidence quotes and dropped findings, redacts known credential formats (including all documented GitLab token prefixes `glpat-`, `gldt-`, `glrt-`, `glrtr-`, `glcbt-`, `gloas-`, `glptt-`, `glft-`, `glimt-`, `glagent-`, `glsoat-`, `glffct-`, `glwt-` — including attached CLI flags like `-pgldt-...`, routable dot-separated tokens, legacy `GR1348941...` tokens, GitLab `_gitlab_session` session cookies in HTTP headers, JSON, and `curl`/Netscape TAB-delimited cookie jars, `PRIVATE-TOKEN:`/`JOB-TOKEN:` headers, URL credentials, and the runtime credentials used by the job), and records strong findings by index. The artifact sets `access: none`, which blocks user downloads via the GitLab UI and REST API; CI/CD jobs using `CI_JOB_TOKEN` (including `needs:` and any allowlisted projects in **Settings -> CI/CD -> Job token permissions**) can still fetch artifacts via the runner API, which is why thorough redaction before writing is mandatory. File checks prevent symlinks in the checkout from redirecting artifact reads or writes.
3. Review and publish jobs share a `resource_group` for each merge request and tier. The review job reserves the summary note before it asks MegaLens to create a review. If GitLab is unavailable at that step, the job fails before using credits. If GitLab becomes unavailable after the review starts, the reservation blocks a queued duplicate and the original publish job can retry with its saved result. Completed summaries reuse the same strong finding count in the merge gate, even when GitLab omits inline positions.
4. The runner checks the merge request head against the pipeline's source SHA before creating a review and checks it again before every GitLab write.

If a review is still marked as reserved, retry the publish job in the original pipeline while its artifact is available. If the review was interrupted and there is no result to publish, check its status in MegaLens before clearing the pending bot note to allow another review.

---

## What Leaves the Runner

The engine runs on the customer's own GitLab runner. The whole repo is not uploaded. Code excerpts the reviewer reads, and the diff, pass through the gateway to MegaLens and OpenAI in gateway mode.

- **To MegaLens (`POST /api/v2/reviews`):** repository identifier (GitLab instance authority from `gitlab_api_url` and the full `CI_PROJECT_PATH`), `base_sha`, `head_sha`, and `tier`, authenticated with `MEGALENS_TOKEN` against one validated trusted HTTPS gateway origin (`https://megalens.ai` or `https://<subdomain>.megalens.ai`, `redirect: 'error'`). MegaLens returns a short-lived single-review `review_id` and `review_key`.
- The local engine receives a limited environment with `PATH`, `HOME`, `RUNNER_TEMP`, and `TMPDIR` when present. It receives the same validated `MEGALENS_API_URL` and uses `MEGALENS_REVIEW_ID` and `MEGALENS_REVIEW_KEY` to authenticate. Engine `0.1.8` redacts GitLab tokens and session cookies in snapshot files and excludes paths that contain recognizable credentials.

The runner sends merge request reads and writes to the API base set by `gitlab_api_url`. It rejects redirects on requests that carry the posting token. The published note and discussions escape HTML, mentions, GitLab references, and quick actions.

---

## Runner & Sandbox Requirements (Bubblewrap & Container Executor)

`megalens-review` requires Linux `bubblewrap` (`bwrap`) and a non-root user to isolate the reviewer process:

- Build the runner image from `docker/gitlab-runner.Dockerfile` and push it to your registry. The image uses a pinned `node:24-bookworm-slim` base and runs as `USER node`. Pass the built image digest to the `image` input.
- **Container executor required (do NOT use `shell` runners):** GitLab's `shell` executor **ignores the `image:` keyword** completely and executes whatever host binaries exist on a persistent shared filesystem — so the `@sha256:` image digest does **not** pin the sandbox binaries on a shell runner. Run MegaLens on a **container executor** (Docker, Docker Autoscaler / ephemeral VM running the Docker executor, or Kubernetes) configured to permit unprivileged user namespaces for `bwrap`. If a Docker executor's seccomp/AppArmor policy blocks user namespaces inside the container, `megalens-review` stops in preflight with exit code `4` before making any model call and **0 credits are charged**.

### Runner trust

Use a runner whose administrator you trust with the job's credentials. The administrator controls `config.toml`, including `PATH` set through the runner's `environment` setting, runner hooks, and the Docker helper image. GitLab Runner can apply that environment and run its own source hook before the component's `pre_get_sources_script` hook. [GitLab Runner configuration](https://docs.gitlab.com/runner/configuration/advanced-configuration/#the-runners-section) · [Source hook order](https://github.com/gitlabhq/gitlab-runner/blob/v18.5.0/shells/abstract.go#L477-L496)

---

## Changes That Are Too Large

When the engine refuses an MR as too large for one review (exit code `3`, `refused: true`, `reason: "too_large"`), MegaLens posts a single note on the MR:

> MegaLens did not review this merge request: it is too large for one review (N files, about M lines). Split it into smaller merge requests. No credits were used.

The job ends green (exit `0`), even if `fail_on: strong` is set.

---

## Local Dry-Run Preview (Zero Network Calls)

Preview the exact inline MR discussions and collapsed summary note rendered from any saved `findings.json` without talking to GitLab or MegaLens:

```bash
npm run gitlab:dry-run
node scripts/gitlab-dry-run.mjs --findings path/to/findings.json --mr-diffs path/to/mr-diffs.json
node scripts/gitlab-dry-run.mjs --json
```
