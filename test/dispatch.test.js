import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAction } from '../src/action.js'

const BASE = '1111111111111111111111111111111111111111'
const HEAD = '2222222222222222222222222222222222222222'
const TOKEN = 'mlt_secret_token_value_123456'
const REVIEW_KEY = 'rk_dispatch_secret_key_654321'

function payload() {
  return {
    inputs: { tier: 'standard', base_sha: BASE, head_sha: HEAD },
    repository: { owner: { login: 'acme' }, name: 'widget', full_name: 'acme/widget' },
  }
}

function harness(env) {
  const h = { env: { GITHUB_EVENT_NAME: 'workflow_dispatch', ...env }, outputs: {}, summaries: [], masked: [], warnings: [] }
  h.writeSummary = async (m) => { h.summaries.push(m) }
  h.setOutput = async (k, v) => { h.outputs[k] = String(v) }
  h.maskSecret = (s) => { h.masked.push(s) }
  h.warn = (w) => { h.warnings.push(w) }
  return h
}

function doc(overrides = {}) {
  return {
    schema: 'megalens.findings/v1',
    review_id: 'rv_d1',
    tier: 'standard',
    status: 'complete',
    target: { kind: 'range', base: BASE, head: HEAD, snapshot_sha256: 'abc' },
    passes: [{ name: 'codex-standard', status: 'ok' }],
    findings: [
      { id: 'f1', file: 'src/a.js', line_start: 3, line_end: 3, title: 'Null deref', claim: 'c', failure_scenario: 's', priority: 'P1', strength: 'strong', found_by: ['codex-standard'] },
      { id: 'f2', file: 'src/b.js', line_start: 9, line_end: 9, title: 'Minor', claim: 'c', failure_scenario: 's', priority: 'P3', strength: 'normal', found_by: ['codex-standard'] },
    ],
    ...overrides,
  }
}

const noApi = () => { throw new Error('GitHub API must not be used on workflow_dispatch') }

test('create on dispatch: same gateway body as the PR path (repo, base_sha, head_sha, tier), outputs set', async () => {
  const h = harness({ INPUT_MODE: 'create', INPUT_TIER: 'deep', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD, 'INPUT_MEGALENS-TOKEN': TOKEN, INPUT_MEGALENS_TOKEN: TOKEN })
  let body = null
  const res = await runAction({
    ...h, payload: payload(), createGitHubApi: noApi,
    fetchImpl: async (url, init) => {
      body = { url, init, json: JSON.parse(init.body) }
      return { ok: true, status: 200, json: async () => ({ review_id: 'rv_1', review_key: REVIEW_KEY }) }
    },
  })
  assert.equal(res.status, 'complete')
  assert.deepEqual(body.json, { repo: 'acme/widget', base_sha: BASE, head_sha: HEAD, tier: 'deep' })
  assert.equal(h.outputs.review_id, 'rv_1')
  assert.equal(h.outputs.head_sha, HEAD)
  assert.equal(h.outputs.base_sha, BASE)
  assert.equal(h.summaries.join('\n').includes(REVIEW_KEY), false)
})

test('create on dispatch: missing token fails, missing or invalid SHAs refused', async () => {
  const noTok = harness({ INPUT_MODE: 'create', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD })
  const r1 = await runAction({ ...noTok, payload: payload() })
  assert.equal(r1.status, 'failed')
  assert.match(r1.error, /megalens-token/)

  const noSha = harness({ INPUT_MODE: 'create', INPUT_MEGALENS_TOKEN: TOKEN, INPUT_HEAD_SHA: HEAD })
  const r2 = await runAction({ ...noSha, payload: payload() })
  assert.equal(r2.status, 'failed')
  assert.match(r2.error, /base-sha/)

  // no SHAs at all (a PR workflow that also lists workflow_dispatch, started by hand): a clean skip as before this change
  for (const mode of ['create', 'review', 'publish', 'full']) {
    const h = harness({ INPUT_MODE: mode, ...(mode === 'create' ? { INPUT_MEGALENS_TOKEN: TOKEN } : {}) })
    const r = await runAction({ ...h, payload: { ...payload(), inputs: { tier: 'standard' } }, fetchImpl: async () => { throw new Error('must not call gateway') }, createGitHubApi: noApi })
    assert.equal(r.status, 'skipped'); assert.equal(r.exitCode, 0); assert.equal(r.reason, 'unsupported_event'); assert.equal(h.outputs.status, 'skipped')
  }

  for (const bad of ['abc123', 'zz'.repeat(20), `${HEAD}0`, 'main']) {
    const h = harness({ INPUT_MODE: 'create', INPUT_MEGALENS_TOKEN: TOKEN, INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: bad })
    await assert.rejects(runAction({ ...h, payload: payload(), fetchImpl: async () => { throw new Error('must not call gateway') } }), /Invalid head-sha/)
  }
})

test('dispatch refuses full mode, double tier and unknown tier', async () => {
  const full = harness({ INPUT_MODE: 'full', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD })
  assert.equal((await runAction({ ...full, payload: payload() })).status, 'failed')
  const dbl = harness({ INPUT_MODE: 'create', INPUT_TIER: 'double', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD, INPUT_MEGALENS_TOKEN: TOKEN })
  assert.equal((await runAction({ ...dbl, payload: payload() })).status, 'failed')
  const dbl2 = harness({ INPUT_MODE: 'create', INPUT_TIER: 'double', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD, INPUT_MEGALENS_TOKEN: TOKEN })
  const r = await runAction({ ...dbl2, payload: payload(), doubleTierEnabled: true })
  assert.equal(r.status, 'failed')
  assert.match(r.error, /standard or deep/)
})

test('review on dispatch: runs engine on head/base inputs, deep allowed, no token, no PR API', async () => {
  const h = harness({ INPUT_MODE: 'review', INPUT_TIER: 'deep', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD, MEGALENS_REVIEW_ID: 'rv_1', MEGALENS_REVIEW_KEY: REVIEW_KEY })
  let engineOpts = null
  const res = await runAction({
    ...h, payload: payload(), createGitHubApi: noApi,
    readFindingsImpl: async () => '', writeFindingsImpl: async () => {},
    runEngine: async (o) => { engineOpts = o; return { exitCode: 0, stdout: '', stderr: '', errorMessage: null, rawFindings: JSON.stringify(doc({ tier: 'deep' })) } },
  })
  assert.equal(res.status, 'complete')
  assert.equal(engineOpts.tier, 'deep')
  assert.equal(engineOpts.baseSha, BASE)
  assert.equal(engineOpts.headSha, HEAD)
  assert.equal(engineOpts.isFork, false)
  assert.deepEqual(engineOpts.authEnv, { MEGALENS_REVIEW_ID: 'rv_1', MEGALENS_REVIEW_KEY: REVIEW_KEY })
  assert.ok(h.masked.includes(REVIEW_KEY))
})

test('review on dispatch refuses the account token and missing credentials', async () => {
  const tok = harness({ INPUT_MODE: 'review', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD, INPUT_MEGALENS_TOKEN: TOKEN })
  assert.equal((await runAction({ ...tok, payload: payload() })).status, 'failed')
  const none = harness({ INPUT_MODE: 'review', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD })
  const r = await runAction({ ...none, payload: payload(), runEngine: async () => { throw new Error('no engine') } })
  assert.equal(r.status, 'failed')
  assert.match(r.error, /Missing credentials/)
})

test('publish on dispatch without a PR: no API calls, job summary has counts and status only', async () => {
  const h = harness({ INPUT_MODE: 'publish', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD })
  const res = await runAction({ ...h, payload: payload(), createGitHubApi: noApi, readFindingsImpl: async () => JSON.stringify(doc()) })
  assert.equal(res.status, 'complete')
  assert.equal(res.exitCode, 0)
  assert.equal(h.outputs.status, 'complete')
  assert.equal(h.outputs['strong-count'], '1')
  assert.equal(h.outputs['normal-count'], '1')
  const text = h.summaries.join('\n')
  assert.match(text, /complete \(standard\)/)
  assert.match(text, /Findings: 2 \(P0: 0, P1: 1, P2: 0, P3: 1\)/)
  assert.equal(text.includes('Null deref'), false)
  assert.equal(text.includes('src/a.js'), false)
})

test('publish on dispatch: partial is not clean, failed and bad artifacts exit 1, head mismatch fails', async () => {
  const partial = harness({ INPUT_MODE: 'publish', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD })
  const rp = await runAction({ ...partial, payload: payload(), readFindingsImpl: async () => JSON.stringify(doc({ status: 'partial', passes: [{ name: 'a', status: 'ok' }, { name: 'b', status: 'failed' }] })) })
  assert.equal(rp.status, 'partial')
  assert.match(partial.summaries.join('\n'), /partial/)

  const failed = harness({ INPUT_MODE: 'publish', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD })
  const rf = await runAction({ ...failed, payload: payload(), readFindingsImpl: async () => JSON.stringify(doc({ status: 'failed', findings: [], error: 'x' })) })
  assert.equal(rf.status, 'failed')
  assert.equal(rf.exitCode, 1)

  const bad = harness({ INPUT_MODE: 'publish', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD })
  const rb = await runAction({ ...bad, payload: payload(), readFindingsImpl: async () => '{"schema":"wrong"}' })
  assert.equal(rb.status, 'failed')
  assert.equal(rb.exitCode, 1)

  const moved = harness({ INPUT_MODE: 'publish', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD })
  const rm = await runAction({ ...moved, payload: payload(), readFindingsImpl: async () => JSON.stringify(doc({ target: { kind: 'range', base: BASE, head: BASE, snapshot_sha256: null } })) })
  assert.equal(rm.status, 'failed')
  assert.match(rm.error, /does not match/)
})

test('pull_request_target is still refused and other events are still skipped', async () => {
  const prt = harness({ GITHUB_EVENT_NAME: 'pull_request_target', INPUT_MODE: 'create', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD })
  assert.equal((await runAction({ ...prt, payload: payload() })).status, 'failed')
  const push = harness({ GITHUB_EVENT_NAME: 'push', INPUT_MODE: 'create' })
  assert.equal((await runAction({ ...push, payload: payload() })).status, 'skipped')
})

test('dispatch publish: a verified too_large refusal is a green skip, not a token/quota failure', async () => {
  const raw = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/too-large-refusal.json', import.meta.url), 'utf8'))
  const b = raw.target.base
  const hd = raw.target.head
  const h = harness({ INPUT_MODE: 'publish', INPUT_BASE_SHA: b, INPUT_HEAD_SHA: hd })
  const res = await runAction({ ...h, payload: payload(), createGitHubApi: noApi, readFindingsImpl: async () => JSON.stringify(raw) })
  assert.equal(res.status, 'skipped')
  assert.equal(res.reason, 'too_large')
  assert.equal(res.exitCode, 0)
  assert.equal(h.outputs.status, 'skipped')
  assert.equal(h.outputs.reason, 'too_large')
  const text = h.summaries.join('\n')
  assert.match(text, /too large/)
  assert.equal(/token|quota|spend cap/.test(text), false)
})

test('dispatch publish: artifact with the right head but a different base fails', async () => {
  const h = harness({ INPUT_MODE: 'publish', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD })
  const other = '3333333333333333333333333333333333333333'
  const res = await runAction({ ...h, payload: payload(), readFindingsImpl: async () => JSON.stringify(doc({ target: { kind: 'range', base: other, head: HEAD, snapshot_sha256: 'abc' } })) })
  assert.equal(res.status, 'failed')
  assert.equal(res.exitCode, 1)
  assert.match(res.error, /base SHA/)
  assert.equal(h.outputs.status, 'failed')
})

test('dispatch publish: invalid artifact text is never copied into the summary or error', async () => {
  const h = harness({ INPUT_MODE: 'publish', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD })
  const secretLine = 'const API_SECRET = "do-not-leak-this-source-line"'
  const res = await runAction({ ...h, payload: payload(), readFindingsImpl: async () => secretLine })
  assert.equal(res.status, 'failed')
  assert.equal(res.exitCode, 1)
  assert.equal(h.summaries.join('\n').includes('do-not-leak'), false)
  assert.equal(String(res.error).includes('do-not-leak'), false)
  assert.match(res.error, /not a valid MegaLens findings document/)
})

test('dispatch: missing review credentials point at review id/key, and publish rejects the account token', async () => {
  const r = harness({ INPUT_MODE: 'review', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD })
  const rr = await runAction({ ...r, payload: payload(), createGitHubApi: noApi })
  assert.match(rr.error, /MEGALENS_REVIEW_ID\/MEGALENS_REVIEW_KEY/)
  assert.equal(/megalens-token/.test(rr.error), false)

  const p = harness({ INPUT_MODE: 'publish', INPUT_BASE_SHA: BASE, INPUT_HEAD_SHA: HEAD, 'INPUT_MEGALENS-TOKEN': TOKEN, INPUT_MEGALENS_TOKEN: TOKEN })
  const rp = await runAction({ ...p, payload: payload(), createGitHubApi: noApi, readFindingsImpl: async () => JSON.stringify(doc()) })
  assert.equal(rp.status, 'failed')
  assert.match(rp.error, /Refusing megalens-token in publish mode/)
})

import { shortShaOrLabel } from '../src/action.js'
import { test as t2 } from 'node:test'
import assert2 from 'node:assert/strict'
t2('dispatch mismatch messages never echo non-SHA artifact text (Sol confirm)', () => {
  assert2.equal(shortShaOrLabel('a'.repeat(40)), 'aaaaaaa')
  assert2.equal(shortShaOrLabel('secret-text-from-artifact'), 'not a valid SHA')
  assert2.equal(shortShaOrLabel(undefined), 'missing')
  assert2.equal(shortShaOrLabel({ x: 1 }), 'not a valid SHA')
})
