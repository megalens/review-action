# Review Action v1.3.2

Implemented in the supplied clone on `release/v1.3.2`, starting from `1b6f596`.

## Changes

- GitHub and GitLab use the same closing line inside every populated and fallback copy block. `Do not offer another MegaLens review for this fix.` The checked in GitHub Markdown previews were regenerated.
- GitLab checks the live merge request's source project, target project, author ID and diff refs. Publication uses the existing GitLab posting token to look up the author's effective project role, including inherited membership. An active Developer, Maintainer or Owner can receive populated prompts for files verified in the current merge request diff. The line range and descriptions come from the validated finding. [GitLab project members API](https://docs.gitlab.com/api/project_members/#retrieve-a-member-of-a-project) · [GitLab merge requests API](https://docs.gitlab.com/api/merge_requests/#retrieve-a-single-merge-request)
- The runner uses the fill in template if membership lookup fails, a required detail is missing, or live metadata no longer matches at publication. Fork merge requests keep the existing skip behavior. The review phase can still write a checkpoint with the fallback template. The membership lookup runs at publication and has a five second timeout.
- Added the v1.3.2 changelog, rebuilt `dist/gitlab.mjs`, and updated the template pin. The prior digest appeared only in the template. The test computes the digest from the bundle.

## Verification

- `npm test` passed all 248 tests. The new GitLab cases use a mocked REST API and check the posting credential, role threshold, unavailable membership, missing evidence, fork handling, stale diff refs, and the exact last line of both prompt variants.
- `npm run gitlab:dry-run` succeeded offline. All seven rendered prompts end with the requested line.
- `node --check dist/gitlab.mjs` and `git diff --check` passed. The template pin matches the bundle SHA256 `0e759488e3910a6dcdd516686e779441339000fdbdbc51f56328405d456c7719`.

## Scope

For the site comparison, I used the exact sentence quoted in the brief. A direct comparison with the site file was unavailable under the instruction to leave `/var/www` untouched. The changes are local to this clone. No commit, push, tag or publication was performed.

## Fix round

Read the review history in timestamp order. The latest review reported one high-severity issue, a fill-in prompt on an inline GitLab finding for a same-project Owner.

Replayed all three captured GitLab responses through the original runner with only HTTP mocked and a locally written review artifact. With the captured diff refs and a complete finding, the runner posted ready-to-paste prompts inline and in the summary. The membership request ran after the diffs request and before the first write. The API reads the returned diff refs, project IDs and author ID at `src/gitlab-api.js:192`, then validates the returned membership at `src/gitlab-api.js:219`. Publish constructs that client with the GitLab posting credential at `src/gitlab-runner.js:834` and uses the reviewed artifact’s refs at `src/gitlab-runner.js:856`. The claimed trust-check failure did not reproduce with the captured responses.

A missing failure scenario reproduced the fill-in prompt with the same responses, because GitLab requires a location, problem and scenario at `src/format.js:291`. A simulated HTTP 403 on the membership request also reproduced it. The live findings artifact and the membership response seen by the posting credential were unavailable, so the historical cause remains unverified.

Successful finding publication now logs one prompt decision at `src/gitlab-runner.js:1594`. A ready-to-paste result means at least one newly published body contained a populated prompt. Fill-in reasons distinguish unverified membership, HTTP failure, stale merge request metadata, an unverified finding path and findings that lack required details. The log uses fixed text and an optional HTTP status. The trust gate requires same-project metadata, matching live refs, an active Developer-or-higher author, a verified path and sufficient finding details.

The regression at `test/gitlab.test.js:1415` uses the captured API fields and original diff, with a constructed finding because the live artifact was unavailable. It covers inline and summary-only publication, missing details, an unmatched path, denied membership and changed refs. The rebuilt bundle was also replayed through its CLI entry point with all three original response bodies.

`npm test` passed 255 tests. The GitLab dry run rendered seven prompts with the required closing line. Bundle syntax and `git diff --check` passed. The bundle SHA-256 matches the template pin at `templates/megalens-review.yml:64` and is `a6cce7a890a439188ddc0a01ccda02fb9548acf9b2c381ad2388e220ff13faeb`.
