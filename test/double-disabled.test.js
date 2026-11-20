import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { DOUBLE_DISABLED_MESSAGE, DOUBLE_TIER_ENABLED, runAction } from '../src/action.js'
import { parseCommentCommand } from '../src/commands.js'
import {
  DOUBLE_TIER_ENABLED as ENGINE_DOUBLE_TIER_ENABLED,
  runEngineCli,
} from '../src/engine.js'

const ACTION_ROOT = new URL('..', import.meta.url).pathname
const EXPECTED_MESSAGE = 'The Double tier is not available yet; use standard or deep.'
const SHA_BASE = '1111111111111111111111111111111111111111'
const SHA_HEAD = '2222222222222222222222222222222222222222'

function makePrPayload() {
  return {
    action: 'opened',
    repository: { owner: { login: 'acme' }, name: 'widget', full_name: 'acme/widget' },
    pull_request: {
      number: 42,
      state: 'open',
      user: { login: 'alice', type: 'User' },
      base: { sha: SHA_BASE, repo: { full_name: 'acme/widget', fork: false } },
      head: { sha: SHA_HEAD, repo: { full_name: 'acme/widget', fork: false } },
    },
  }
}

function makeIssueCommentPayload(body, login = 'maintainer') {
  return {
    action: 'created',
    repository: { owner: { login: 'acme' }, name: 'widget', full_name: 'acme/widget' },
    sender: { login, type: 'User' },
    issue: { number: 42, pull_request: {} },
    comment: { id: 101, body, user: { login, type: 'User' } },
  }
}

function createHarness(env = {}) {
  const outputs = {}
  const summaries = []
  const warnings = []
  return {
    env,
    outputs,
    summaries,
    warnings,
    writeSummary: async (md) => {
      summaries.push(md)
    },
    setOutput: async (k, v) => {
      outputs[k] = String(v)
    },
    warn: (w) => {
      warnings.push(w)
    },
  }
}

test('DOUBLE_TIER_ENABLED is false and cannot be overridden via env or inputs', async () => {
  assert.equal(DOUBLE_TIER_ENABLED, false)
  assert.equal(ENGINE_DOUBLE_TIER_ENABLED, false)
  assert.equal(DOUBLE_DISABLED_MESSAGE, EXPECTED_MESSAGE)

  for (const mode of ['create', 'review', 'publish', 'full']) {
    let engineCalled = false
    let fetchCalled = false
    const h = createHarness({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: 'acme/widget',
      INPUT_MODE: mode,
      INPUT_TIER: 'double',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture',
      'INPUT_GITHUB-TOKEN': 'ghs_fixture',
      MEGALENS_REVIEW_ID: 'rv_1',
      MEGALENS_REVIEW_KEY: 'ml_rk_1',
      DOUBLE_TIER_ENABLED: 'true',
      MEGALENS_DOUBLE_TIER_ENABLED: 'true',
      INPUT_DOUBLE_TIER_ENABLED: 'true',
    })

    const res = await runAction({
      ...h,
      payload: makePrPayload(),
      fetchImpl: async () => {
        fetchCalled = true
        throw new Error('fetch must not be called')
      },
      runEngine: async () => {
        engineCalled = true
        return { exitCode: 0 }
      },
    })

    assert.equal(engineCalled, false)
    assert.equal(fetchCalled, false)
    assert.equal(res.status, 'failed')
    assert.equal(res.exitCode, 1)
    assert.equal(res.error, EXPECTED_MESSAGE)
    assert.equal(h.outputs.status, 'failed')
    assert.equal(h.summaries[0], EXPECTED_MESSAGE)
  }

  // Direct runEngineCli call with tier='double' refuses without spawning process
  let execCalled = false
  await assert.rejects(
    () =>
      runEngineCli(
        {
          tier: 'double',
          baseSha: SHA_BASE,
          headSha: SHA_HEAD,
          outPath: '/tmp/x.json',
          timeoutMinutes: 5,
          cliBin: '/usr/local/bin/megalens-review',
          authMode: 'review-key',
          authEnv: { MEGALENS_REVIEW_ID: 'rv_1', MEGALENS_REVIEW_KEY: 'ml_rk_1' },
          isFork: false,
        },
        {
          execFileImpl: async () => {
            execCalled = true
            return { exitCode: 0, stdout: '', stderr: '', errorMessage: null }
          },
        },
      ),
    /The Double tier is not available yet; use standard or deep\./,
  )
  assert.equal(execCalled, false)
})

test('comment command for double is refused without running the engine', async () => {
  assert.equal(parseCommentCommand('/megalens double'), 'double')
  assert.equal(parseCommentCommand('/megalens review double'), 'double')

  for (const body of ['/megalens double', '/megalens review double']) {
    let engineCalled = false
    const h = createHarness({
      GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_REPOSITORY: 'acme/widget',
      INPUT_MODE: 'full',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture',
      'INPUT_GITHUB-TOKEN': 'ghs_fixture',
    })
    const res = await runAction({
      ...h,
      payload: makeIssueCommentPayload(body),
      createGitHubApi: () => ({
        getCollaboratorPermission: async () => 'write',
      }),
      runEngine: async () => {
        engineCalled = true
        return { exitCode: 0 }
      },
    })
    assert.equal(engineCalled, false)
    assert.equal(res.status, 'failed')
    assert.equal(res.exitCode, 1)
    assert.equal(res.error, EXPECTED_MESSAGE)
    assert.equal(h.summaries[0], EXPECTED_MESSAGE)
  }

  // Unauthorized commenter still skips without failing the job
  let engineCalled = false
  const resUnauth = await runAction({
    ...createHarness({
      GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_REPOSITORY: 'acme/widget',
      INPUT_MODE: 'create',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture',
      'INPUT_GITHUB-TOKEN': 'ghs_fixture',
    }),
    payload: makeIssueCommentPayload('/megalens double', 'outsider'),
    createGitHubApi: () => ({
      getCollaboratorPermission: async () => 'read',
    }),
    runEngine: async () => {
      engineCalled = true
      return { exitCode: 0 }
    },
  })
  assert.equal(engineCalled, false)
  assert.equal(resUnauth.status, 'skipped')
  assert.equal(resUnauth.reason, 'unauthorized_commenter')
})

test('double code path remains functional via test-only doubleTierEnabled injection', async () => {
  let capturedTier = null
  const h = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: 'acme/widget',
    INPUT_MODE: 'review',
    INPUT_TIER: 'double',
    MEGALENS_REVIEW_ID: 'rv_dbl_1',
    MEGALENS_REVIEW_KEY: 'ml_rk_dbl_1',
  })
  const doc = {
    schema: 'megalens.findings/v1',
    review_id: 'rv_dbl_1',
    tier: 'double',
    status: 'complete',
    target: { kind: 'range', base: SHA_BASE, head: SHA_HEAD, snapshot_sha256: 'a'.repeat(64) },
    passes: [{ name: 'codex-ctx', status: 'ok' }],
    findings: [],
  }
  const res = await runAction({
    ...h,
    payload: makePrPayload(),
    doubleTierEnabled: true,
    outPath: '/tmp/double-findings.json',
    writeFindingsImpl: async () => {},
    runEngine: async (opts) => {
      capturedTier = opts.tier
      return { exitCode: 0, stdout: '', stderr: '', rawFindings: JSON.stringify(doc) }
    },
  })
  assert.equal(capturedTier, 'double')
  assert.equal(res.status, 'complete')
  assert.equal(res.exitCode, 0)

  let commentTier = null
  const hComment = createHarness({
    GITHUB_EVENT_NAME: 'issue_comment',
    GITHUB_REPOSITORY: 'acme/widget',
    INPUT_MODE: 'review',
    'INPUT_HEAD-SHA': SHA_HEAD,
    'INPUT_BASE-SHA': SHA_BASE,
    MEGALENS_REVIEW_ID: 'rv_dbl_2',
    MEGALENS_REVIEW_KEY: 'ml_rk_dbl_2',
  })
  const resComment = await runAction({
    ...hComment,
    payload: makeIssueCommentPayload('/megalens double'),
    doubleTierEnabled: true,
    outPath: '/tmp/double-comment.json',
    writeFindingsImpl: async () => {},
    runEngine: async (opts) => {
      commentTier = opts.tier
      return { exitCode: 0, stdout: '', stderr: '', rawFindings: JSON.stringify({ ...doc, review_id: 'rv_dbl_2' }) }
    },
  })
  assert.equal(commentTier, 'double')
  assert.equal(resComment.status, 'complete')
})

test('README documents Standard and Deep launch tiers and notes Double is not available yet', async () => {
  const readme = await readFile(join(ACTION_ROOT, 'README.md'), 'utf8')
  assert.match(readme, /Standard.*Deep.*only/i)
  assert.match(readme, /`double` is not available yet/i)
})
