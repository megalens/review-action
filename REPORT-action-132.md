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
