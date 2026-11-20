import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { BYO_DISABLED_MESSAGE, BYO_KEY_ENABLED, runAction } from '../src/action.js'
import {
  buildChildEnv,
  BYO_KEY_ENABLED as ENGINE_BYO_KEY_ENABLED,
  resolveAuthEnv,
  runEngineCli,
} from '../src/engine.js'

const ACTION_ROOT = new URL('..', import.meta.url).pathname
const EXPECTED_MESSAGE = 'BYO OpenAI key mode is not available yet; use megalens-token.'

function makePrPayload() {
  return {
    action: 'opened',
    repository: { owner: { login: 'acme' }, name: 'widget', full_name: 'acme/widget' },
    pull_request: {
      number: 42,
      state: 'open',
      user: { login: 'alice', type: 'User' },
      base: {
        sha: 'base111111111111111111111111111111111111',
        repo: { full_name: 'acme/widget', fork: false },
      },
      head: {
        sha: 'head222222222222222222222222222222222222',
        repo: { full_name: 'acme/widget', fork: false },
      },
    },
  }
}

function createHarness(env = {}) {
  const outputs = {}
  const summaries = []
  const masked = []
  const warnings = []
  return {
    env,
    outputs,
    summaries,
    masked,
    warnings,
    writeSummary: async (md) => {
      summaries.push(md)
    },
    setOutput: async (k, v) => {
      outputs[k] = String(v)
    },
    maskSecret: (s) => {
      masked.push(s)
    },
    warn: (w) => {
      warnings.push(w)
    },
  }
}

test('BYO_KEY_ENABLED is false and cannot be overridden via env or inputs', async () => {
  assert.equal(BYO_KEY_ENABLED, false)
  assert.equal(ENGINE_BYO_KEY_ENABLED, false)
  assert.equal(BYO_DISABLED_MESSAGE, EXPECTED_MESSAGE)

  const secretKey = 'sk-proj-env-override-attempt-1234567890'
  const h = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'review',
    'INPUT_OPENAI-API-KEY': secretKey,
    BYO_KEY_ENABLED: 'true',
    MEGALENS_BYO_KEY_ENABLED: 'true',
    INPUT_BYO_KEY_ENABLED: 'true',
    'INPUT_BYO-KEY-ENABLED': 'true',
    MEGALENS_BYO: '1',
    OPENAI_API_KEY: secretKey,
  })

  let engineCalled = false
  const res = await runAction({
    ...h,
    payload: makePrPayload(),
    runEngine: async () => {
      engineCalled = true
      return { exitCode: 0 }
    },
  })

  assert.equal(engineCalled, false)
  assert.equal(res.status, 'failed')
  assert.equal(res.exitCode, 1)
  assert.equal(res.error, EXPECTED_MESSAGE)
  assert.equal(resolveAuthEnv({ openaiApiKey: secretKey }), null)
  assert.deepEqual(buildChildEnv({ PATH: '/usr/bin' }, 'byo-key', { OPENAI_API_KEY: secretKey }), {
    PATH: '/usr/bin',
  })
})

test('openai-api-key input refuses create, review, and full jobs early without fallback or key leak', async () => {
  const secretKey = 'sk-proj-secret-byo-never-leak-9876543210'

  // 1. create mode (even when megalens-token is also supplied -> never falls back silently)
  let fetchCalled = false
  const hCreate = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'create',
    'INPUT_OPENAI-API-KEY': secretKey,
    'INPUT_MEGALENS-TOKEN': 'ml_tok_should_not_fallback_123456',
  })
  const createRes = await runAction({
    ...hCreate,
    payload: makePrPayload(),
    fetchImpl: async () => {
      fetchCalled = true
      throw new Error('fetch must not be called')
    },
  })
  assert.equal(fetchCalled, false)
  assert.equal(createRes.status, 'failed')
  assert.equal(createRes.exitCode, 1)
  assert.equal(createRes.error, EXPECTED_MESSAGE)
  assert.equal(hCreate.outputs.status, 'failed')
  assert.equal(hCreate.summaries[0], EXPECTED_MESSAGE)
  assert.ok(hCreate.masked.includes(secretKey))

  // 2. review mode (even when review-id and review-key are also supplied -> never falls back silently)
  let engineCalled = false
  const hReview = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'review',
    INPUT_OPENAI_API_KEY: secretKey,
    MEGALENS_REVIEW_ID: 'rv_should_not_fallback',
    MEGALENS_REVIEW_KEY: 'rk_should_not_fallback_123456',
  })
  const reviewRes = await runAction({
    ...hReview,
    payload: makePrPayload(),
    runEngine: async () => {
      engineCalled = true
      return { exitCode: 0 }
    },
  })
  assert.equal(engineCalled, false)
  assert.equal(reviewRes.status, 'failed')
  assert.equal(reviewRes.exitCode, 1)
  assert.equal(reviewRes.error, EXPECTED_MESSAGE)
  assert.equal(hReview.outputs.status, 'failed')
  assert.equal(hReview.summaries[0], EXPECTED_MESSAGE)
  assert.ok(hReview.masked.includes(secretKey))

  // 3. full mode on issue_comment (never calls GitHub API or engine)
  let githubCalled = false
  const hFull = createHarness({
    GITHUB_EVENT_NAME: 'issue_comment',
    INPUT_MODE: 'full',
    'INPUT_OPENAI-API-KEY': secretKey,
    'INPUT_GITHUB-TOKEN': 'ghs_unused_token_1234567890',
  })
  const fullRes = await runAction({
    ...hFull,
    payload: {
      action: 'created',
      repository: { owner: { login: 'acme' }, name: 'widget' },
      issue: { number: 42, pull_request: {} },
      comment: { user: { login: 'maintainer', type: 'User' }, body: '/megalens review' },
      sender: { type: 'User' },
    },
    createGitHubApi: () => {
      githubCalled = true
      throw new Error('GitHub API must not be called')
    },
    runEngine: async () => {
      engineCalled = true
      return { exitCode: 0 }
    },
  })
  assert.equal(githubCalled, false)
  assert.equal(engineCalled, false)
  assert.equal(fullRes.status, 'failed')
  assert.equal(fullRes.exitCode, 1)
  assert.equal(fullRes.error, EXPECTED_MESSAGE)
  assert.ok(hFull.masked.includes(secretKey))

  // Verify secret key never appears in any log, summary, warning, output, or error return
  for (const [h, res] of [
    [hCreate, createRes],
    [hReview, reviewRes],
    [hFull, fullRes],
  ]) {
    const serialized = [
      ...h.summaries,
      ...h.warnings,
      JSON.stringify(h.outputs),
      JSON.stringify(res),
    ].join('\n')
    assert.equal(serialized.includes(secretKey), false)
  }

  // 4. Direct runEngineCli call with authMode='byo-key' refuses without spawning process
  let execCalled = false
  await assert.rejects(
    () =>
      runEngineCli(
        {
          tier: 'standard',
          baseSha: 'a',
          headSha: 'b',
          outPath: '/tmp/x.json',
          timeoutMinutes: 5,
          cliBin: '/usr/local/bin/megalens-review',
          authMode: 'byo-key',
          authEnv: { OPENAI_API_KEY: secretKey, MEGALENS_BYO: '1' },
          isFork: false,
        },
        {
          execFileImpl: async () => {
            execCalled = true
            return { exitCode: 0, stdout: '', stderr: '', errorMessage: null }
          },
        },
      ),
    /BYO OpenAI key mode is not available yet; use megalens-token\./,
  )
  assert.equal(execCalled, false)
})

test('BYO code path remains functional when flipped via test-only injection', async () => {
  const secretKey = 'sk-proj-byo-enabled-test-key-1234567890'
  assert.deepEqual(resolveAuthEnv({ openaiApiKey: secretKey }, { byoKeyEnabled: true }), {
    mode: 'byo-key',
    env: { OPENAI_API_KEY: secretKey, MEGALENS_BYO: '1' },
  })

  const h = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'review',
    'INPUT_OPENAI-API-KEY': secretKey,
  })
  let capturedAuth = null
  const doc = {
    schema: 'megalens.findings/v1',
    review_id: null,
    tier: 'standard',
    status: 'complete',
    target: {
      kind: 'range',
      base: 'base111111111111111111111111111111111111',
      head: 'head222222222222222222222222222222222222',
      snapshot_sha256: 'abc',
    },
    passes: [{ name: 'codex-standard', status: 'ok' }],
    findings: [],
  }
  const res = await runAction({
    ...h,
    payload: makePrPayload(),
    byoKeyEnabled: true,
    outPath: '/tmp/byo-findings.json',
    writeFindingsImpl: async () => {},
    runEngine: async (opts) => {
      capturedAuth = { authMode: opts.authMode, authEnv: opts.authEnv }
      return { exitCode: 0, stdout: '', stderr: '', rawFindings: JSON.stringify(doc) }
    },
  })

  assert.equal(res.status, 'complete')
  assert.equal(res.exitCode, 0)
  assert.deepEqual(capturedAuth, {
    authMode: 'byo-key',
    authEnv: { OPENAI_API_KEY: secretKey, MEGALENS_BYO: '1' },
  })
  assert.ok(h.masked.includes(secretKey))
})

test('README marks openai-api-key as not available yet', async () => {
  const readme = await readFile(join(ACTION_ROOT, 'README.md'), 'utf8')
  assert.match(readme, /`openai-api-key`.*not available yet/is)
})
