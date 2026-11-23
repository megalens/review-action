import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runAction } from '../src/action.js'
import { inlineMarker, SUMMARY_MARKER, titleHash, WALKTHROUGH_MARKER } from '../src/format.js'

const PATCH = [
  '@@ -10,6 +10,7 @@ export function run(x) {',
  ' const ok = true',
  '+const bug1 = x.foo()',
  '+const bug2 = x.bar()',
  '+const note1 = x.baz()',
  ' return ok',
  '}',
].join('\n')

function makeFixtureFindings(findings) {
  return JSON.stringify({
    schema: 'megalens.findings/v1',
    review_id: 'rv_fixture_1',
    tier: 'standard',
    status: 'complete',
    target: { kind: 'range', base: 'base0001', head: 'head0002', snapshot_sha256: 'deadbeef' },
    passes: [{ name: 'codex-standard', model: 'gpt-6.2-sol', effort: 'medium', status: 'ok', minutes: 1.2 }],
    findings,
  })
}

function makePrEnv(extra = {}) {
  return {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: 'acme/app',
    'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_123456',
    'INPUT_GITHUB-TOKEN': 'ghs_fixture_123456',
    ...extra,
  }
}

function makePrPayload() {
  return {
    action: 'synchronize',
    repository: { owner: { login: 'acme' }, name: 'app' },
    pull_request: {
      number: 42,
      state: 'open',
      base: { sha: 'base0001', repo: { full_name: 'acme/app' } },
      head: { sha: 'head0002', repo: { full_name: 'acme/app', fork: false } },
    },
  }
}

describe('strong vs normal routing and fail-on', () => {
  it('posts ONE PR review for strong findings only and collapses normal findings into ONE <details> summary', async () => {
    const reviews = []
    const createdComments = []
    const updatedComments = []

    const res = await runAction({
      env: makePrEnv({ 'INPUT_FAIL-ON': 'strong' }),
      payload: makePrPayload(),
      runEngine: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        errorMessage: null,
        rawFindings: makeFixtureFindings([
          {
            id: 'f-strong',
            file: 'src/app.js',
            line_start: 11,
            line_end: 11,
            title: 'Null dereference on x',
            claim: 'x may be undefined before calling foo()',
            failure_scenario: 'Pass undefined to run()',
            priority: 'P1',
            strength: 'strong',
            found_by: ['codex-standard'],
          },
          {
            id: 'f-normal-1',
            file: 'src/app.js',
            line_start: 13,
            title: 'Missing validation on baz()',
            claim: 'baz() input is unchecked',
            failure_scenario: 'Malformed input passes through',
            priority: 'P2',
            strength: 'normal',
            found_by: ['codex-standard'],
          },
          {
            id: 'f-normal-2',
            file: 'src/app.js',
            line_start: 14,
            title: 'Return flag unused',
            claim: 'ok is always true',
            failure_scenario: 'Caller assumes false is possible',
            priority: 'P3',
            strength: 'normal',
            found_by: ['codex-standard'],
          },
        ]),
      }),
      createGitHubApi: () => ({
        async getPull() { return { open: true, headSha: 'head0002', baseSha: 'base0001' } },
        async listPullFiles() { return [{ filename: 'src/app.js', status: 'modified', patch: PATCH }] },
        async listPullReviewComments() { return [] },
        async createPullReview(_o, _r, _n, commitId, comments) { reviews.push({ commitId, comments }); return 900 },
        async findSummaryComment() { return null },
        async createIssueComment(_o, _r, _n, body) { createdComments.push(body); return 500 },
        async updateIssueComment(_o, _r, id, body) { updatedComments.push({ id, body }) },
      }),
    })

    assert.equal(res.exitCode, 1, 'fail-on: strong fails when strong findings exist')
    assert.equal(reviews.length, 1, 'posts ONE PR review')
    assert.equal(reviews[0].commitId, 'head0002')
    assert.equal(reviews[0].comments.length, 1, 'only strong finding goes inline')
    assert.equal(reviews[0].comments[0].path, 'src/app.js')
    assert.equal(reviews[0].comments[0].line, 11)
    assert.match(
      reviews[0].comments[0].body,
      new RegExp(`<!-- megalens-review:v1 file=src%2Fapp\\.js lines=11-11 title=${titleHash('Null dereference on x')} -->`),
    )

    assert.equal(createdComments.length, 2)
    assert.ok(createdComments.some((body) => body.startsWith(WALKTHROUGH_MARKER)))
    assert.equal(updatedComments.length, 0)
    const summary = createdComments.find((body) => body.startsWith(SUMMARY_MARKER))
    assert.match(summary, /\*\*Strong findings \(1\)/)
    assert.equal(summary.match(/^<details>$/gm).length, 1, 'one group for all summary findings')
    assert.equal(summary.match(/<summary>Copy fix prompt<\/summary>/g).length, 3, 'one prompt per finding')
    assert.match(summary, /2 summary findings/)
    assert.match(summary, /Missing validation on baz\(\)/)
    assert.match(summary, /Return flag unused/)
  })

  it('does not fail when fail-on is strong and only normal findings exist', async () => {
    const reviews = []
    const res = await runAction({
      env: makePrEnv({ 'INPUT_FAIL-ON': 'strong' }),
      payload: makePrPayload(),
      runEngine: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        errorMessage: null,
        rawFindings: makeFixtureFindings([
          {
            id: 'f-normal',
            file: 'src/app.js',
            line_start: 12,
            title: 'Minor naming issue',
            claim: 'Variable name is ambiguous',
            failure_scenario: 'Harder to maintain',
            priority: 'P3',
            strength: 'normal',
          },
        ]),
      }),
      createGitHubApi: () => ({
        async getPull() { return { open: true, headSha: 'head0002', baseSha: 'base0001' } },
        async listPullFiles() { return [{ filename: 'src/app.js', status: 'modified', patch: PATCH }] },
        async listPullReviewComments() { return [] },
        async createPullReview(_o, _r, _n, _c, comments) { reviews.push(comments); return 1 },
        async findSummaryComment() { return null },
        async createIssueComment() { return 2 },
        async updateIssueComment() {},
      }),
    })

    assert.equal(res.exitCode, 0)
    assert.equal(reviews.length, 0)
  })
})

describe('rerun de-duplication marker', () => {
  it('updates earlier summary comment and skips duplicate inline comments for same file, line range, and title hash', async () => {
    const reviews = []
    const createdComments = []
    const updatedComments = []

    const res = await runAction({
      env: makePrEnv(),
      payload: makePrPayload(),
      runEngine: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        errorMessage: null,
        rawFindings: makeFixtureFindings([
          {
            id: 'f-existing',
            file: 'src/app.js',
            line_start: 11,
            title: 'Existing strong issue',
            claim: 'Already posted at line 11',
            failure_scenario: 'Triggers on null',
            priority: 'P0',
            strength: 'strong',
          },
          {
            id: 'f-new',
            file: 'src/app.js',
            line_start: 12,
            title: 'New strong issue',
            claim: 'Not yet posted at line 12',
            failure_scenario: 'Throws on empty bar()',
            priority: 'P1',
            strength: 'strong',
          },
        ]),
      }),
      createGitHubApi: () => ({
        async getViewerLogin() { return 'github-actions[bot]' },
        async getPull() { return { open: true, headSha: 'head0002', baseSha: 'base0001' } },
        async listPullFiles() { return [{ filename: 'src/app.js', status: 'modified', patch: PATCH }] },
        async listPullReviewComments() {
          return [
            {
              id: 77,
              user: { login: 'github-actions[bot]', type: 'Bot' },
              path: 'src/app.js',
              line: 11,
              body: `**P0 (strong): Existing strong issue**\n\n${inlineMarker({ file: 'src/app.js', line_start: 11, title: 'Existing strong issue' })}`,
            },
          ]
        },
        async createPullReview(_o, _r, _n, _sha, comments) { reviews.push(comments); return 901 },
        async findSummaryComment(_o, _r, _n, marker) { return marker === SUMMARY_MARKER ? 555 : 557 },
        async createIssueComment(_o, _r, _n, body) { createdComments.push(body); return 556 },
        async updateIssueComment(_o, _r, id, body) { updatedComments.push({ id, body }) },
      }),
    })

    assert.equal(res.exitCode, 0)
    assert.equal(createdComments.length, 0)
    assert.equal(updatedComments.length, 2)
    assert.ok(updatedComments.find(({ id }) => id === 555).body.startsWith(SUMMARY_MARKER))
    assert.ok(updatedComments.find(({ id }) => id === 557).body.startsWith(WALKTHROUGH_MARKER))

    assert.equal(reviews.length, 1)
    assert.equal(reviews[0].length, 1, 'skips f-existing at line 11, posts only f-new at line 12')
    assert.match(
      reviews[0][0].body,
      new RegExp(`file=src%2Fapp\\.js lines=12-12 title=${titleHash('New strong issue')}`),
    )
    assert.equal(res.inlinePostedCount, 2)
  })

  it('does not create a PR review when all strong findings already exist inline', async () => {
    const reviews = []
    const res = await runAction({
      env: makePrEnv(),
      payload: makePrPayload(),
      runEngine: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        errorMessage: null,
        rawFindings: makeFixtureFindings([
          {
            id: 'f-existing',
            file: 'src/app.js',
            line_start: 11,
            title: 'Existing strong issue',
            claim: 'Already posted',
            failure_scenario: 'Triggers on null',
            priority: 'P1',
            strength: 'strong',
          },
        ]),
      }),
      createGitHubApi: () => ({
        async getViewerLogin() { return 'github-actions[bot]' },
        async getPull() { return { open: true, headSha: 'head0002', baseSha: 'base0001' } },
        async listPullFiles() { return [{ filename: 'src/app.js', status: 'modified', patch: PATCH }] },
        async listPullReviewComments() {
          return [{
            id: 77,
            user: { login: 'github-actions[bot]', type: 'Bot' },
            path: 'src/app.js',
            line: 11,
            body: inlineMarker({ file: 'src/app.js', line_start: 11, title: 'Existing strong issue' }),
          }]
        },
        async createPullReview(_o, _r, _n, _sha, comments) { reviews.push(comments); return 902 },
        async findSummaryComment() { return 555 },
        async createIssueComment() { return 556 },
        async updateIssueComment() {},
      }),
    })

    assert.equal(res.exitCode, 0)
    assert.equal(reviews.length, 0)
  })
})
