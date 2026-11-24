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

  it('publish mode: matching document posts the PR comment, green', async () => {
    const h = harness()
    const posted = []
    const res = await runAction({
      ...h,
      env: { ...baseEnv, INPUT_MODE: 'publish' },
      payload,
      outPath: '/tmp/too-large.json',
      readFindingsImpl: async () => RAW,
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

  it('publish mode: refusal for a different head is NOT green (old mismatch path)', async () => {
    const h = harness()
    const posted = []
    const doc = JSON.parse(RAW)
    doc.target.head = 'd'.repeat(40)
    const res = await runAction({
      ...h,
      env: { ...baseEnv, INPUT_MODE: 'publish' },
      payload,
      outPath: '/tmp/too-large.json',
      readFindingsImpl: async () => JSON.stringify(doc),
      createGitHubApi: () => fakeApi(posted),
    })
    assert.equal(res.exitCode, 1)
    assert.doesNotMatch(posted.join('\n'), /did not review this pull request/)
  })

  it('publish mode: PR moved to a newer commit, the newer summary is not overwritten with the refusal', async () => {
    const h = harness()
    const posted = []
    const api = { ...fakeApi(posted), getPull: async () => ({ open: true, headSha: 'e'.repeat(40), baseSha: BASE }) }
    const res = await runAction({
      ...h,
      env: { ...baseEnv, INPUT_MODE: 'publish' },
      payload,
      outPath: '/tmp/too-large.json',
      readFindingsImpl: async () => RAW,
      createGitHubApi: () => api,
    })
    assert.equal(res.reason, 'stale_head')
    assert.doesNotMatch(posted.join('\n'), /did not review this pull request/)
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

describe('too_large strictness (stale or mismatched documents)', () => {
  const reviewEnv = { ...baseEnv, INPUT_MODE: 'review', 'INPUT_REVIEW-ID': 'rv_1', 'INPUT_REVIEW-KEY': 'rk_fixture_123', 'INPUT_HEAD-SHA': HEAD, 'INPUT_BASE-SHA': BASE }
  const run = (mode, exitCode, raw) => {
    const h = harness()
    const posted = []
    const env = mode === 'review' ? reviewEnv : { ...baseEnv, INPUT_MODE: 'full', 'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_123456' }
    return runAction({
      ...h, env, payload, prepareSandbox: () => {},
      runEngine: async () => ({ exitCode, stdout: '', stderr: '', errorMessage: null, rawFindings: raw }),
      writeFindingsImpl: async () => {}, uploadArtifact: async () => {},
      createGitHubApi: () => fakeApi(posted),
    }).then((res) => ({ res, h, posted }))
  }
  for (const mode of ['review', 'full']) {
    it(`${mode}: leftover refusal with engine exit 4 stays red`, async () => {
      const { res } = await run(mode, 4, RAW)
      assert.equal(res.exitCode, 1)
      assert.notEqual(res.reason, 'too_large')
    })
    it(`${mode}: refusal document for another head stays red`, async () => {
      const d = JSON.parse(RAW)
      d.target.head = 'd'.repeat(40)
      const { res } = await run(mode, 3, JSON.stringify(d))
      assert.equal(res.exitCode, 1)
    })
    it(`${mode}: refused=false or no top-level reason is not too_large`, async () => {
      const d1 = JSON.parse(RAW); d1.refused = false
      const d2 = JSON.parse(RAW); delete d2.reason
      for (const d of [d1, d2]) {
        const { res } = await run(mode, 3, JSON.stringify(d))
        assert.equal(res.exitCode, 1)
      }
    })
    it(`${mode}: exit 3 with matching document is green; engine credential never reaches comment or summary`, async () => {
      const d = JSON.parse(RAW)
      d.notes.push('key rk_dummy_secret_value_123')
      const { res, h, posted } = await run(mode, 3, JSON.stringify(d))
      assert.equal(res.exitCode, 0)
      assert.equal(res.reason, 'too_large')
      assert.doesNotMatch([...posted, ...h.summaries].join('\n'), /rk_dummy_secret_value_123/)
    })
  }
})

describe('engine runs write to a fresh output file', () => {
  it('removes any leftover output file before running the engine', async () => {
    const { runEngineCli } = await import('../src/engine.js')
    const order = []
    await runEngineCli(
      { tier: 'standard', baseSha: 'b'.repeat(40), headSha: HEAD, outPath: '/tmp/out.json', timeoutMinutes: 5, authMode: 'gateway', authEnv: { MEGALENS_TOKEN: 'ml_tok_test12345' }, repoPath: '/w', runnerTemp: '/tmp', cliBin: '/usr/bin/fake' },
      {
        baseEnv: { PATH: '/usr/bin' },
        rmImpl: async (p) => { order.push(['rm', p]) },
        readFileImpl: async () => { order.push(['read']); return RAW },
        execFileImpl: async () => { order.push(['exec']); return { exitCode: 3, stdout: '', stderr: '', errorMessage: null } },
      },
    )
    assert.deepEqual(order, [['rm', '/tmp/out.json'], ['exec'], ['read']])
  })
})

describe('default engine pin', () => {
  it('pins the real 0.1.8 integrity string (0.1.2, 0.1.3 and 0.1.5 kept)', () => {
    assert.equal(PINNED_ENGINE_VERSION, '0.1.8')
    assert.equal(PINNED_ENGINE_INTEGRITY['0.1.8'], 'sha512-yvlqmemmvFZyr6aE9EwXojLFwiMJq1dVkkIAYL4TS0YIj5Imqpns7EyrswzCt/0szLbE4pvM0NFoUyziL0eLBg==')
    assert.equal(PINNED_ENGINE_INTEGRITY['0.1.5'], 'sha512-Yvx6D6UzmfspHm4mGKpueFhu/G5bmSnLRG9NgnJHnZvlfF0yd0evwUmqIcQaPD3IKHRmVWXKU6qVPRWMOOJ67w==')
    assert.equal(PINNED_ENGINE_INTEGRITY['0.1.3'], 'sha512-bgdgfD/atIa8A19BoAxL1UtzHCm2+oDHhrGhgywxjwguBDgACOEzyoBGDR8euyh1VqO4UjrkYtEMAUPvsqBhFw==')
    assert.equal(PINNED_ENGINE_INTEGRITY['0.1.2'], 'sha512-zC5W3zmErpSU9GXNngUSGp77fVaqDh4hQDZgPAcxnt7v/37osclGQz8/ApR0ROBu6clN19xRDnCZd2GTDivQ0g==')
  })
  it('a tampered tarball is refused with the default pin (no injected digest)', async () => {
    const { runEngineCli } = await import('../src/engine.js')
    const calls = []
    await assert.rejects(
      () => runEngineCli(
        { tier: 'standard', baseSha: 'b'.repeat(40), headSha: HEAD, outPath: '/tmp/out.json', timeoutMinutes: 5, authMode: 'gateway', authEnv: { MEGALENS_TOKEN: 'ml_tok_test12345' }, repoPath: '/w', runnerTemp: '/tmp/runner' },
        {
          baseEnv: { PATH: '/usr/bin' },
          mkdtempImpl: async (p) => `${p}xyz`,
          writeFileImpl: async () => {},
          readFileImpl: async () => Buffer.from('tampered-tarball'),
          rmImpl: async () => {},
          execFileImpl: async (command, args) => { calls.push([command, args[0]]); return { exitCode: 0, stdout: `megalens-review-${PINNED_ENGINE_VERSION}.tgz\n`, stderr: '', errorMessage: null } },
        },
      ),
      /Integrity verification failed/,
    )
    assert.deepEqual(calls, [['npm', 'pack']])
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
    assert.match(eng, /PINNED_ENGINE_VERSION = '0\.1\.2'/) // the temp copy is re-pinned to 0.1.2 by this test
    assert.ok(eng.includes(`'0.1.2': '${integrity}'`))
    assert.ok(eng.includes(PINNED_ENGINE_INTEGRITY['0.1.1']), 'older entries kept')
    assert.match(readFileSync(join(tmp, 'README.md'), 'utf8'), /now 0\.1\.2\)/)
    // run again: replaces, does not duplicate
    const integrity2 = 'sha512-' + 'B'.repeat(86) + '=='
    execFileSync(process.execPath, [join(tmp, 'scripts', 'pin-engine.mjs'), '0.1.2', integrity2], { stdio: 'pipe' })
    const eng2 = readFileSync(join(tmp, 'src', 'engine.js'), 'utf8')
    assert.equal(eng2.split("'0.1.2':").length, 2)
    assert.throws(() => execFileSync(process.execPath, [join(tmp, 'scripts', 'pin-engine.mjs'), '0.1', 'x'], { stdio: 'pipe' }))
    assert.equal(PINNED_ENGINE_VERSION, '0.1.8') // the repo now pins the published 0.1.8
  })
})

describe('fix round 2: stale refusal on disk', () => {
  const QUOTA = JSON.stringify({ ...JSON.parse(RAW), reason: 'quota_exceeded', passes: [{ reason: 'quota_exceeded' }] })
  const engineOpts = { tier: 'standard', baseSha: BASE, headSha: HEAD, outPath: '/tmp/out.json', timeoutMinutes: 5, authMode: 'gateway', authEnv: { MEGALENS_TOKEN: 'ml_tok_test12345' }, repoPath: '/w', runnerTemp: '/tmp', cliBin: '/usr/bin/fake' }

  it('rm fails: engine writes to a unique path and only that file is read', async () => {
    const { runEngineCli } = await import('../src/engine.js')
    let outArg = null
    const read = []
    const res = await runEngineCli(engineOpts, {
      baseEnv: { PATH: '/usr/bin' },
      rmImpl: async () => { throw new Error('EPERM') },
      readFileImpl: async (p) => { read.push(p); return p === '/tmp/out.json' ? RAW : QUOTA },
      execFileImpl: async (_c, args) => { outArg = args[args.indexOf('--out') + 1]; return { exitCode: 3, stdout: '', stderr: '', errorMessage: null } },
    })
    assert.notEqual(outArg, '/tmp/out.json')
    assert.match(outArg, /^\/tmp\/out\.json\.run-[0-9a-f]+$/)
    assert.deepEqual(read, [outArg])
    assert.equal(res.outPath, outArg)
    assert.equal(res.rawFindings, QUOTA)
  })

  it('rm "succeeds" but the file is still there: unique path too', async () => {
    const { runEngineCli } = await import('../src/engine.js')
    let outArg = null
    await runEngineCli(engineOpts, {
      baseEnv: { PATH: '/usr/bin' },
      rmImpl: async () => {},
      statImpl: async () => ({ size: 1 }),
      readFileImpl: async () => QUOTA,
      execFileImpl: async (_c, args) => { outArg = args[args.indexOf('--out') + 1]; return { exitCode: 3, stdout: '', stderr: '', errorMessage: null } },
    })
    assert.match(outArg, /\.run-[0-9a-f]+$/)
  })

  for (const mode of ['review', 'full']) {
    it(`${mode}: quota refusal with an undeletable same-head too_large file on disk stays red and is not too_large`, async () => {
      const { runEngineCli } = await import('../src/engine.js')
      const h = harness()
      const posted = []
      const disk = { '/tmp/findings.json': RAW }
      const env = mode === 'review'
        ? { ...baseEnv, INPUT_MODE: 'review', 'INPUT_REVIEW-ID': 'rv_1', 'INPUT_REVIEW-KEY': 'rk_fixture_123', 'INPUT_HEAD-SHA': HEAD, 'INPUT_BASE-SHA': BASE }
        : { ...baseEnv, INPUT_MODE: 'full', 'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_123456' }
      const res = await runAction({
        ...h, env, payload, prepareSandbox: () => {}, outPath: '/tmp/findings.json',
        runEngine: (opts) => runEngineCli({ ...opts, cliBin: '/usr/bin/fake' }, {
          baseEnv: { PATH: '/usr/bin' },
          rmImpl: async () => { throw new Error('EPERM') },
          readFileImpl: async (p) => disk[p],
          execFileImpl: async (_c, args) => { disk[args[args.indexOf('--out') + 1]] = QUOTA; return { exitCode: 3, stdout: '', stderr: '', errorMessage: null } },
        }),
        writeFindingsImpl: async () => {}, uploadArtifact: async () => {},
        createGitHubApi: () => fakeApi(posted),
      })
      assert.equal(res.exitCode, 1)
      assert.notEqual(res.reason, 'too_large')
      assert.notEqual(h.outputs.reason, 'too_large')
      assert.doesNotMatch([...posted, ...h.summaries].join('\n'), /too large for one review/)
    })
  }

  it('publish: an unchanged refusal artifact is only trusted when verified (quota refusal is not too_large)', async () => {
    const h = harness()
    const posted = []
    const res = await runAction({
      ...h, env: { ...baseEnv, INPUT_MODE: 'publish' }, payload, outPath: '/tmp/q.json',
      readFindingsImpl: async () => QUOTA, createGitHubApi: () => fakeApi(posted),
    })
    assert.equal(res.exitCode, 1)
    assert.notEqual(res.reason, 'too_large')
    assert.doesNotMatch(posted.join('\n'), /too large for one review/)
  })
})

describe('fix round 2: newer commit is never overwritten', () => {
  const NEW = 'e'.repeat(40)
  const pubEnv = { ...baseEnv, INPUT_MODE: 'publish' }
  // getPull answers from a list, then keeps the last answer.
  const api = (posted, heads) => {
    let i = 0
    return {
      ...fakeApi(posted),
      listPullFiles: async () => [],
      getPull: async () => ({ open: true, headSha: heads[Math.min(i++, heads.length - 1)], baseSha: BASE }),
    }
  }
  const cases = {
    'too_large document': () => RAW,
    'artifact head mismatch': () => JSON.stringify({ ...JSON.parse(RAW), refused: false, target: { ...JSON.parse(RAW).target, head: 'd'.repeat(40) } }),
    'no document (parse error)': () => 'not json',
    'normal complete document': () => JSON.stringify({ schema: 'megalens.findings/v1', review_id: 'rv_1', tier: 'standard', status: 'complete', target: { kind: 'range', base: BASE, head: HEAD }, passes: [], findings: [] }),
  }
  for (const [name, doc] of Object.entries(cases)) {
    it(`publish, PR already moved: ${name} writes nothing and logs one line`, async () => {
      const h = harness(); const posted = []
      const res = await runAction({ ...h, env: pubEnv, payload, outPath: '/tmp/x.json', readFindingsImpl: async () => doc(), createGitHubApi: () => api(posted, [NEW]) })
      assert.equal(res.exitCode, 0)
      assert.equal(res.reason, 'stale_head')
      assert.deepEqual(posted, [])
      assert.deepEqual(h.summaries, [])
      assert.equal(h.warnings.filter((w) => /moved/.test(w)).length, 1)
    })
    it(`publish, PR moves after the first check: ${name} writes nothing`, async () => {
      const h = harness(); const posted = []
      // Early check sees HEAD; the re-read right before the write sees NEW.
      const heads = name === 'no document (parse error)' || name === 'artifact head mismatch' ? [NEW] : [HEAD, NEW]
      const res = await runAction({ ...h, env: pubEnv, payload, outPath: '/tmp/x.json', readFindingsImpl: async () => doc(), createGitHubApi: () => api(posted, heads) })
      assert.equal(res.exitCode, 0)
      assert.equal(res.reason, 'stale_head')
      assert.deepEqual(posted, [])
      assert.deepEqual(h.summaries, [])
    })
  }
  it('full mode: too_large and PR moved before the write writes nothing', async () => {
    const h = harness(); const posted = []
    const res = await runAction({
      ...h, env: { ...baseEnv, INPUT_MODE: 'full', 'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_123456' }, payload, prepareSandbox: () => {},
      runEngine: async () => ({ exitCode: 3, stdout: '', stderr: '', errorMessage: null, rawFindings: RAW }),
      createGitHubApi: () => api(posted, [HEAD, NEW]),
    })
    assert.equal(res.reason, 'stale_head')
    assert.deepEqual(posted, [])
    assert.deepEqual(h.summaries, [])
  })
  it('an existing newer summary comment is not updated by the stale run', async () => {
    const h = harness(); const updates = []
    const a = { ...api([], [HEAD, NEW]), findSummaryComment: async () => 77, updateIssueComment: async (_o, _r, id, b) => { updates.push([id, b]) } }
    await runAction({ ...h, env: pubEnv, payload, outPath: '/tmp/x.json', readFindingsImpl: async () => RAW, createGitHubApi: () => a })
    assert.deepEqual(updates, [])
  })
  it('PR head unchanged still publishes normally', async () => {
    const h = harness(); const posted = []
    const res = await runAction({ ...h, env: pubEnv, payload, outPath: '/tmp/x.json', readFindingsImpl: async () => RAW, createGitHubApi: () => api(posted, [HEAD]) })
    assert.equal(res.reason, 'too_large')
    assert.equal(posted.length, 1)
  })
})

describe('fix round 2: remaining acceptance gaps', () => {
  it('a dummy credential in the engine output never reaches comment, summary, logs or warnings', async () => {
    const d = JSON.parse(RAW)
    d.notes.push('key rk_dummy_secret_value_123')
    const h = harness(); const posted = []
    const logs = []
    const orig = [console.log, console.error, console.warn, console.info]
    console.log = console.error = console.warn = console.info = (...a) => logs.push(a.join(' '))
    try {
      await runAction({
        ...h, env: { ...baseEnv, INPUT_MODE: 'full', 'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_123456' }, payload, prepareSandbox: () => {},
        runEngine: async () => ({ exitCode: 3, stdout: '', stderr: 'rk_dummy_secret_value_123', errorMessage: null, rawFindings: JSON.stringify(d) }),
        createGitHubApi: () => fakeApi(posted),
      })
    } finally { [console.log, console.error, console.warn, console.info] = orig }
    assert.doesNotMatch([...posted, ...h.summaries, ...h.warnings, ...logs].join('\n'), /rk_dummy_secret_value_123/)
  })
  it('README workflows carry the per-PR concurrency group', () => {
    const readme = readFileSync(join(here, '..', 'README.md'), 'utf8')
    assert.match(readme, /concurrency:\s*\n\s*group: megalens-\$\{\{ github\.event\.pull_request\.number \}\}\s*\n\s*cancel-in-progress: true/)
    assert.match(readme, /group: megalens-\$\{\{ github\.event\.issue\.number \}\}/)
  })
})
