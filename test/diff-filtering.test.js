import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterFindingsToDiff, hunkLinesInPatch, resolveFindingPath } from '../src/diff.js'
import { runAction } from '../src/action.js'

const SAMPLE_PATCH = [
  '@@ -10,4 +10,5 @@ function demo() {',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' const d = 5',
  '@@ -30,2 +31,3 @@ function tail() {',
  ' return a',
  '+// end',
  '}',
].join('\n')

describe('diff-hunk filtering', () => {
  it('collects only post-image lines inside @@ hunks (added and context, never deleted)', () => {
    const lines = hunkLinesInPatch(SAMPLE_PATCH)
    assert.deepEqual([...lines].sort((a, b) => a - b), [10, 11, 12, 13, 31, 32, 33])
  })

  it('keeps findings inside diff hunks and moves findings outside hunks or in other files to outOfDiff without dropping', () => {
    const pullFiles = [
      { filename: 'src/a.ts', status: 'modified', patch: SAMPLE_PATCH },
      { filename: 'src/deleted.ts', status: 'removed', patch: '@@ -1,2 +0,0 @@\n-old\n-file' },
    ]
    const findings = [
      { id: 'in-added', file: 'src/a.ts', line_start: 11, strength: 'strong' },
      { id: 'in-context', file: 'b/src/a.ts', line_start: 10, strength: 'normal' },
      { id: 'in-second-hunk', file: './src/a.ts', line_start: 32, strength: 'strong' },
      { id: 'between-hunks', file: 'src/a.ts', line_start: 20, strength: 'strong' },
      { id: 'other-file', file: 'src/missing.ts', line_start: 11, strength: 'strong' },
      { id: 'removed-file', file: 'src/deleted.ts', line_start: 1, strength: 'strong' },
      { id: 'no-line', file: 'src/a.ts', strength: 'strong' },
    ]

    const { kept, outOfDiff, droppedCount } = filterFindingsToDiff(findings, pullFiles)
    assert.deepEqual(
      kept.map((f) => ({ id: f.id, file: f.file, line_start: f.line_start })),
      [
        { id: 'in-added', file: 'src/a.ts', line_start: 11 },
        { id: 'in-context', file: 'src/a.ts', line_start: 10 },
        { id: 'in-second-hunk', file: 'src/a.ts', line_start: 32 },
      ],
    )
    assert.deepEqual(
      outOfDiff.map((f) => f.id),
      ['between-hunks', 'other-file', 'removed-file', 'no-line'],
    )
    assert.equal(droppedCount, 0)
  })

  it('preserves real a/ or b/ top-level directories when present in known PR files', () => {
    assert.equal(resolveFindingPath('b/index.ts', ['b/index.ts']), 'b/index.ts')
    assert.equal(resolveFindingPath('b/index.ts', ['index.ts']), 'index.ts')
  })

  it('refuses to post inline comments if findings.json target.head mismatches PR head sha', async () => {
    const postedReviews = []
    const postedComments = []
    const summaries = []

    const res = await runAction({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'acme/repo',
        'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_token',
        'INPUT_GITHUB-TOKEN': 'ghs_fixture_token',
      },
      payload: {
        action: 'opened',
        repository: { owner: { login: 'acme' }, name: 'repo' },
        pull_request: {
          number: 7,
          state: 'open',
          base: { sha: 'base1111', repo: { full_name: 'acme/repo' } },
          head: { sha: 'head2222', repo: { full_name: 'acme/repo', fork: false } },
        },
      },
      runEngine: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        errorMessage: null,
        rawFindings: JSON.stringify({
          schema: 'megalens.findings/v1',
          review_id: 'rv_mismatch',
          tier: 'standard',
          status: 'complete',
          target: { kind: 'range', base: 'base1111', head: 'oldhead999', snapshot_sha256: 'abc' },
          passes: [{ name: 'codex-standard', status: 'ok' }],
          findings: [{
            id: 'f1',
            file: 'src/a.ts',
            line_start: 11,
            title: 'Stale finding',
            claim: 'Bad thing',
            failure_scenario: 'Always',
            priority: 'P1',
            strength: 'strong',
          }],
        }),
      }),
      createGitHubApi: () => ({
        async findSummaryComment() { return null },
        async createIssueComment(_o, _r, _n, body) { postedComments.push(body); return 101 },
        async updateIssueComment() {},
        async createPullReview(_o, _r, _n, _sha, comments) { postedReviews.push(comments); return 201 },
      }),
      writeSummary: (s) => { summaries.push(s) },
    })

    assert.equal(res.exitCode, 1)
    assert.equal(res.status, 'failed')
    assert.equal(postedReviews.length, 0)
    assert.equal(postedComments.length, 1)
    assert.match(postedComments[0], /does not match PR head/i)
    assert.equal(summaries.length, 1)
  })
})
