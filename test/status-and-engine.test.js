import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runAction } from '../src/action.js'
import { buildCliInvocation, resolveAuthEnv, runEngineCli } from '../src/engine.js'
import { formatSummaryComment } from '../src/format.js'
import { redactSecrets } from '../src/redact.js'

const PATCH = '@@ -1,2 +1,3 @@\n const a = 1\n+const b = 2\n'

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
    action: 'opened',
    repository: { owner: { login: 'acme' }, name: 'app' },
    pull_request: {
      number: 10,
      state: 'open',
      base: { sha: 'base100', repo: { full_name: 'acme/app' } },
      head: { sha: 'head200', repo: { full_name: 'acme/app', fork: false } },
    },
  }
}

describe('partial and failed wording', () => {
  it('states partial clearly and never says "no issues found" even when findings array is empty', () => {
    const summary = formatSummaryComment({
      headSha: 'head200',
      doc: {
        status: 'partial',
        tier: 'double',
        review_id: 'rv_partial',
        passes: [
          { name: 'pass-1', status: 'ok' },
          { name: 'pass-2', status: 'failed' },
        ],
      },
      strongFindings: [],
      normalFindings: [],
    })

    assert.match(summary, /\*\*Partial review:\*\*/)
    assert.match(summary, /pass-2/)
    assert.match(summary, /incomplete/i)
    assert.doesNotMatch(summary, /no issues found/i)
    assert.doesNotMatch(summary, /No findings on the changed/i)
  })

  it('states failed clearly on status failed and never claims clean or no issues found', async () => {
    const comments = []
    const res = await runAction({
      env: makePrEnv(),
      payload: makePrPayload(),
      runEngine: async () => ({
        exitCode: 2,
        stdout: '',
        stderr: '',
        errorMessage: null,
        rawFindings: JSON.stringify({
          schema: 'megalens.findings/v1',
          review_id: 'rv_failed',
          tier: 'standard',
          status: 'failed',
          target: { kind: 'range', base: 'base100', head: 'head200', snapshot_sha256: 'abc' },
          passes: [{ name: 'codex-standard', status: 'failed' }],
          findings: [],
        }),
      }),
      createGitHubApi: () => ({
        async getPull() { return { open: true, headSha: 'head200', baseSha: 'base100' } },
        async listPullFiles() { return [{ filename: 'src/a.js', status: 'modified', patch: PATCH }] },
        async listPullReviewComments() { return [] },
        async createPullReview() { return 1 },
        async findSummaryComment() { return null },
        async createIssueComment(_o, _r, _n, body) { comments.push(body); return 99 },
        async updateIssueComment() {},
      }),
    })

    assert.equal(res.exitCode, 1)
    assert.equal(comments.length, 1)
    assert.match(comments[0], /\*\*Review failed\.\*\*/)
    assert.doesNotMatch(comments[0], /no issues found/i)
  })

  it('handles gateway refusal (exit code 3) without findings.json and redacts secrets', async () => {
    const comments = []
    const res = await runAction({
      env: makePrEnv(),
      payload: makePrPayload(),
      runEngine: async () => ({
        exitCode: 3,
        stdout: '',
        stderr: 'Gateway refused token ml_tok_secret_value_12345',
        errorMessage: null,
        rawFindings: null,
      }),
      createGitHubApi: () => ({
        async findSummaryComment() { return null },
        async createIssueComment(_o, _r, _n, body) { comments.push(body); return 100 },
        async updateIssueComment() {},
      }),
    })

    assert.equal(res.exitCode, 1)
    assert.equal(comments.length, 1)
    assert.match(comments[0], /\*\*Review failed\.\*\*/)
    assert.doesNotMatch(comments[0], /ml_tok_secret_value_12345/)
  })
})

describe('engine CLI invocation, auth modes, and secret redaction', () => {
  it('resolves gateway and BYO-key auth modes via environment variables only', () => {
    assert.deepEqual(resolveAuthEnv({ megalensToken: 'ml_tok_abc12345', openaiApiKey: '' }), {
      mode: 'gateway',
      env: { MEGALENS_TOKEN: 'ml_tok_abc12345' },
    })
    assert.deepEqual(resolveAuthEnv({ megalensToken: '', openaiApiKey: 'sk-test-fixture-1234567890' }, { byoKeyEnabled: true }), {
      mode: 'byo-key',
      env: { OPENAI_API_KEY: 'sk-test-fixture-1234567890', MEGALENS_BYO: '1' },
    })
    assert.equal(resolveAuthEnv({ megalensToken: '', openaiApiKey: '' }), null)
  })

  it('builds exact megalens-review CLI args without secrets', async () => {
    const cliBin = '/tmp/runner/megalens-engine/node_modules/.bin/megalens-review'
    const inv = buildCliInvocation({
      tier: 'standard',
      baseSha: 'base111',
      headSha: 'head222',
      outPath: '/tmp/findings.json',
      timeoutMinutes: 25,
      engineVersion: '0.1.0',
      repoPath: '/github/workspace',
      cliBin,
    })
    assert.equal(inv.command, cliBin)
    assert.deepEqual(inv.args, [
      'run', '--tier', 'standard', '--target', 'range', '--base', 'base111', '--head', 'head222',
      '--out', '/tmp/findings.json', '--timeout-min', '25',
    ])
    assert.equal(inv.args.includes('--repo'), false)

    let seenCmd = null
    let seenCwd = null
    let seenEnv = null
    const runRes = await runEngineCli(
      {
        tier: 'deep',
        baseSha: 'base111',
        headSha: 'head222',
        outPath: '/tmp/findings.json',
        timeoutMinutes: 20,
        engineVersion: '0.1.0',
        authMode: 'byo-key',
        authEnv: { OPENAI_API_KEY: 'sk-fixture-1234567890abcdef', MEGALENS_BYO: '1' },
        repoPath: '/github/workspace',
        installDir: '/tmp/runner/megalens-engine',
        cliBin,
      },
      {
        execFileImpl: async (cmd, _args, opts) => {
          seenCmd = cmd
          seenCwd = opts.cwd
          seenEnv = opts.env
          return { exitCode: 0, stdout: 'ok', stderr: '', errorMessage: null }
        },
        readFileImpl: async () => '{"schema":"megalens.findings/v1","status":"complete","findings":[]}',
        byoKeyEnabled: true,
      },
    )

    assert.equal(seenCmd, cliBin)
    assert.equal(seenCwd, '/github/workspace')
    assert.equal(seenEnv.MEGALENS_BYO, '1')
    assert.equal(seenEnv.OPENAI_API_KEY, 'sk-fixture-1234567890abcdef')
    assert.equal(runRes.exitCode, 0)
  })

  it('redacts dummy token patterns', () => {
    const cleaned = redactSecrets('Bearer abcdefghijklmnop ml_tok_12345678 ghp_1234567890abcdef sk-1234567890abcdef')
    assert.equal(cleaned, '[redacted] [redacted] [redacted] [redacted]')
  })
})
