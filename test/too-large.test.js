import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAction } from '../src/action.js'
import { isTooLargeDoc, parseFindingsDocument, tooLargeMessage } from '../src/findings.js'
import { PINNED_ENGINE_INTEGRITY, PINNED_ENGINE_VERSION } from '../src/engine.js'

const here = dirname(fileURLToPath(import.meta.url))
const RAW = readFileSync(join(here, 'fixtures', 'too-large-refusal.json'), 'utf8')
const HEAD = 'c'.repeat(40)
const BASE = 'b'.repeat(40)
const MESSAGE = 'MegaLens did not review this pull request: it is too large for one review (412 files, about 61,300 lines). Split it into smaller pull requests. No credits were used.'

const payload = {
  action: 'opened',
  repository: { owner: { login: 'acme' }, name: 'app' },
  pull_request: {
    number: 5, state: 'open',
    base: { sha: BASE, repo: { full_name: 'acme/app' } },
    head: { sha: HEAD, repo: { full_name: 'acme/app', fork: false } },
  },
}
const baseEnv = {
  GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'acme/app',
  'INPUT_GITHUB-TOKEN': 'ghs_fixture_123456', RUNNER_TEMP: '/tmp',
}

function harness() {
  const outputs = {}
  const summaries = []
  const warnings = []
  return {
    outputs, summaries, warnings,
    writeSummary: async (m) => { summaries.push(m) },
    setOutput: async (k, v) => { outputs[k] = String(v) },
    warn: (w) => { warnings.push(w) },
    maskSecret: () => {},
  }
}
function fakeApi(posted) {
  return {
    findSummaryComment: async () => null,
    createIssueComment: async (_o, _r, _n, body) => { posted.push(body); return 1 },
    updateIssueComment: async (_o, _r, _id, body) => { posted.push(body) },
    getPull: async () => ({ open: true, headSha: HEAD, baseSha: BASE }),
    listPullFiles: async () => { throw new Error('must not list files') },
    createPullReview: async () => { throw new Error('must not post inline comments') },
  }
}
function assertNoGenericError(texts) {
  for (const t of texts) {
    assert.doesNotMatch(t, /Refused by the MegaLens gateway/)
    assert.doesNotMatch(t, /does not match PR head/)
    assert.doesNotMatch(t, /Review failed/)
  }
}

describe('too_large refusal: parsing and message', () => {
  it('parses the fixture and detects it', () => {
    const doc = parseFindingsDocument(RAW)
    assert.equal(doc.reason, 'too_large')
    assert.equal(doc.refused, true)
    assert.equal(isTooLargeDoc(doc), true)
    assert.equal(tooLargeMessage(doc), MESSAGE)
  })
  it('also detected through passes[0].reason, and numbers are optional', () => {
    const d = JSON.parse(RAW)
    delete d.reason
    delete d.notes
    const doc = parseFindingsDocument(JSON.stringify(d))
    assert.equal(isTooLargeDoc(doc), true)
    assert.match(tooLargeMessage(doc), /^MegaLens did not review this pull request: it is too large for one review\. Split it into smaller pull requests\. No credits were used\.$/)
  })
  it('other refusals are not too_large', () => {
    const d = JSON.parse(RAW)
    d.reason = 'quota'
    d.passes[0].reason = 'quota'
    assert.equal(isTooLargeDoc(parseFindingsDocument(JSON.stringify(d))), false)
  })
})

describe('too_large refusal in every mode', () => {
  it('review mode: engine exit 3, green, summary text, artifact kept, no generic error', async () => {
    const h = harness()
    const uploads = []
    let wrote = 0
    const res = await runAction({
      ...h,
      env: { ...baseEnv, INPUT_MODE: 'review', 'INPUT_REVIEW-ID': 'rv_1', 'INPUT_REVIEW-KEY': 'rk_fixture_123', 'INPUT_HEAD-SHA': HEAD, 'INPUT_BASE-SHA': BASE },
      payload,
      prepareSandbox: () => {},
      runEngine: async () => ({ exitCode: 3, stdout: '', stderr: '', errorMessage: null, rawFindings: RAW }),
      writeFindingsImpl: async () => { wrote += 1 },
      uploadArtifact: async (a) => { uploads.push(a) },
      createGitHubApi: () => ({}),
    })
    assert.equal(res.exitCode, 0)
    assert.equal(res.status, 'skipped')
    assert.equal(res.reason, 'too_large')
    assert.equal(res.error, undefined)
    assert.deepEqual(h.summaries, [MESSAGE])
    assert.equal(h.outputs.status, 'skipped')
    assert.equal(h.outputs.reason, 'too_large')
    assert.equal(uploads.length, 1)
    assert.equal(wrote, 0, 'the engine document is kept as written')
    assertNoGenericError(h.summaries)
  })

  it('publish mode: posts the PR comment, ignores head and review id mismatch, green', async () => {
    const h = harness()
    const posted = []
    const doc = JSON.parse(RAW)
    doc.target.head = 'd'.repeat(40) // would be a head mismatch for a normal document
    const res = await runAction({
      ...h,
      env: { ...baseEnv, INPUT_MODE: 'publish' },
      payload,
      outPath: '/tmp/too-large.json',
      readFindingsImpl: async () => JSON.stringify(doc),
      createGitHubApi: () => fakeApi(posted),
    })
    assert.equal(res.exitCode, 0)
    assert.equal(res.status, 'skipped')
    assert.equal(posted.length, 1)
    assert.ok(posted[0].includes(MESSAGE))
    assert.equal(h.summaries[0], MESSAGE)
    assert.equal(h.outputs.reason, 'too_large')
    assertNoGenericError([...posted, ...h.summaries])
  })

  it('full mode: engine exit 3, posts the PR comment, green', async () => {
    const h = harness()
    const posted = []
    const res = await runAction({
      ...h,
      env: { ...baseEnv, INPUT_MODE: 'full', 'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_123456' },
      payload,
      prepareSandbox: () => {},
      runEngine: async () => ({ exitCode: 3, stdout: '', stderr: '', errorMessage: null, rawFindings: RAW }),
      writeFindingsImpl: async () => {},
      createGitHubApi: () => fakeApi(posted),
    })
    assert.equal(res.exitCode, 0)
    assert.equal(res.status, 'skipped')
    assert.equal(res.reason, 'too_large')
    assert.equal(posted.length, 1)
    assert.ok(posted[0].includes(MESSAGE))
    assert.equal(h.outputs.status, 'skipped')
    assertNoGenericError([...posted, ...h.summaries])
  })

  it('fail-on strong does not turn a too_large refusal red', async () => {
    const h = harness()
    const posted = []
    const res = await runAction({
      ...h,
      env: { ...baseEnv, INPUT_MODE: 'publish', 'INPUT_FAIL-ON': 'strong' },
      payload,
      outPath: '/tmp/too-large.json',
      readFindingsImpl: async () => RAW,
      createGitHubApi: () => fakeApi(posted),
    })
    assert.equal(res.exitCode, 0)
  })

  it('a plain gateway refusal (not too_large) still fails with the gateway message', async () => {
    const h = harness()
    const posted = []
    const d = JSON.parse(RAW)
    d.reason = 'quota'
    d.passes[0].reason = 'quota'
    d.target.head = HEAD
    const res = await runAction({
      ...h,
      env: { ...baseEnv, INPUT_MODE: 'publish' },
      payload,
      outPath: '/tmp/q.json',
      readFindingsImpl: async () => JSON.stringify(d),
      createGitHubApi: () => fakeApi(posted),
    })
    assert.equal(res.exitCode, 1)
    assert.match(posted[0], /Refused by the MegaLens gateway/)
  })
})

describe('pin-engine script', () => {
  it('rewrites the pin and adds the integrity entry; rejects bad input', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pin-'))
    mkdirSync(join(tmp, 'scripts'))
    mkdirSync(join(tmp, 'src'))
    const root = join(here, '..')
    copyFileSync(join(root, 'scripts', 'pin-engine.mjs'), join(tmp, 'scripts', 'pin-engine.mjs'))
    copyFileSync(join(root, 'src', 'engine.js'), join(tmp, 'src', 'engine.js'))
    copyFileSync(join(root, 'README.md'), join(tmp, 'README.md'))
    const integrity = 'sha512-' + 'A'.repeat(86) + '=='
    execFileSync(process.execPath, [join(tmp, 'scripts', 'pin-engine.mjs'), '0.1.2', integrity], { stdio: 'pipe' })
    const eng = readFileSync(join(tmp, 'src', 'engine.js'), 'utf8')
    assert.match(eng, /PINNED_ENGINE_VERSION = '0\.1\.2'/)
    assert.ok(eng.includes(`'0.1.2': '${integrity}'`))
    assert.ok(eng.includes(PINNED_ENGINE_INTEGRITY['0.1.1']), 'older entries kept')
    assert.match(readFileSync(join(tmp, 'README.md'), 'utf8'), /now 0\.1\.2\)/)
    // run again: replaces, does not duplicate
    const integrity2 = 'sha512-' + 'B'.repeat(86) + '=='
    execFileSync(process.execPath, [join(tmp, 'scripts', 'pin-engine.mjs'), '0.1.2', integrity2], { stdio: 'pipe' })
    const eng2 = readFileSync(join(tmp, 'src', 'engine.js'), 'utf8')
    assert.equal(eng2.split("'0.1.2':").length, 2)
    assert.throws(() => execFileSync(process.execPath, [join(tmp, 'scripts', 'pin-engine.mjs'), '0.1', 'x'], { stdio: 'pipe' }))
    assert.equal(PINNED_ENGINE_VERSION, '0.1.2') // the repo now pins the published 0.1.2
  })
})
