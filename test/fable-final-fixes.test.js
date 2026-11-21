import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseArgs } from 'node:util'
import { BURST_GUARD_WINDOW_MS, runAction } from '../src/action.js'
import {
  buildCliInvocation,
  computeSha512Integrity,
  ENGINE_PACKAGE_NAME,
  installPinnedEngine,
  runEngineCli,
} from '../src/engine.js'
import { computeEffectiveStatus, parseFindingsDocument } from '../src/findings.js'
import { formatSummaryComment, sanitizeText, summaryMarker, summaryMetaMarker } from '../src/format.js'

const ACTION_ROOT = new URL('..', import.meta.url).pathname
const ENGINE_DOCS_DIR = join(ACTION_ROOT, 'test', 'fixtures', 'engine-docs')
const SHA_BASE = '1111111111111111111111111111111111111111'
const SHA_HEAD = '2222222222222222222222222222222222222222'
const SHA_MOVED = '3333333333333333333333333333333333333333'
const SNAPSHOT_SHA = 'a'.repeat(64)

function makeHarness(env = {}) {
  const outputs = {}
  const summaries = []
  const warnings = []
  const masked = []
  return {
    env,
    outputs,
    summaries,
    warnings,
    masked,
    writeSummary: async (md) => {
      summaries.push(md)
    },
    setOutput: async (k, v) => {
      outputs[k] = String(v)
    },
    warn: (w) => {
      warnings.push(w)
    },
    maskSecret: (s) => {
      masked.push(s)
    },
  }
}

function makeIssueCommentPayload(body = '/megalens review', login = 'maintainer') {
  return {
    action: 'created',
    repository: { owner: { login: 'acme' }, name: 'widget', full_name: 'acme/widget' },
    sender: { login, type: 'User' },
    issue: { number: 7, pull_request: {} },
    comment: { id: 99, body, user: { login, type: 'User' } },
  }
}

describe('Fable final review fixes (items 1-8)', () => {
  it('1. buildCliInvocation drops --repo, passes engine cli.mjs parseArgs, and runEngineCli uses repoPath as cwd', async () => {
    const inv = buildCliInvocation({
      cliBin: '/tmp/install/node_modules/.bin/megalens-review',
      tier: 'standard',
      baseSha: SHA_BASE,
      headSha: SHA_HEAD,
      outPath: '/tmp/out/findings.json',
      timeoutMinutes: 20,
      repoPath: '/github/workspace',
    })
    assert.equal(inv.args.includes('--repo'), false)
    assert.equal(inv.args[0], 'run')

    // Match cli.mjs:79-87 strict parseArgs schema
    const { values } = parseArgs({
      args: inv.args.slice(1),
      options: {
        tier: { type: 'string' },
        target: { type: 'string', default: 'uncommitted' },
        base: { type: 'string' },
        head: { type: 'string' },
        'first-review': { type: 'string' },
        quiet: { type: 'boolean', default: false },
        out: { type: 'string' },
        'timeout-min': { type: 'string' },
        background: { type: 'boolean', default: false },
      },
      strict: true,
    })
    assert.equal(values.tier, 'standard')
    assert.equal(values.target, 'range')
    assert.equal(values.base, SHA_BASE)
    assert.equal(values.head, SHA_HEAD)
    assert.equal(values.out, '/tmp/out/findings.json')
    assert.equal(values['timeout-min'], '20')

    let capturedExec = null
    await runEngineCli(
      {
        cliBin: '/tmp/install/node_modules/.bin/megalens-review',
        tier: 'standard',
        baseSha: SHA_BASE,
        headSha: SHA_HEAD,
        outPath: '/tmp/findings.json',
        timeoutMinutes: 15,
        repoPath: '/github/workspace/pr-checkout',
        authMode: 'review-key',
        authEnv: { MEGALENS_REVIEW_ID: 'rv_1', MEGALENS_REVIEW_KEY: 'ml_rk_test_secret_123' },
      },
      {
        baseEnv: { PATH: '/usr/bin', HOME: '/home/runner' },
        execFileImpl: async (cmd, args, opts) => {
          capturedExec = { cmd, args, opts }
          return { exitCode: 0, stdout: '', stderr: '', errorMessage: null }
        },
        readFileImpl: async () => {
          throw new Error('no file')
        },
      },
    )
    assert.equal(capturedExec.opts.cwd, '/github/workspace/pr-checkout')
    assert.equal(capturedExec.args.includes('--repo'), false)
  })

  it('2. parseFindingsDocument accepts real engine docs (route/detail/superseded_by/waived/short_run) and skips superseded passes', async () => {
    const readFixture = async (name) => JSON.parse(await readFile(join(ENGINE_DOCS_DIR, name), 'utf8'))

    // 2a. Complete review with root & pass route + real engine findings
    const completeDoc = await readFixture('complete-with-route.json')
    const parsedComplete = parseFindingsDocument(completeDoc)
    assert.equal(parsedComplete.route, 'openai')
    assert.equal(parsedComplete.passes[0].route, 'openai')
    assert.equal(parsedComplete.findings.length, 1)
    assert.equal(computeEffectiveStatus(parsedComplete.status, 0, parsedComplete.passes, parsedComplete.refused), 'complete')

    // Excluded/skipped files with empty findings suppresses "No findings on the changed diff hunks."
    const excludedDoc = await readFixture('excluded-empty.json')
    const parsedExcluded = parseFindingsDocument(excludedDoc)
    assert.deepEqual(parsedExcluded.sandbox, { excluded_files: 1, skipped_files: 0 })
    const summaryOmitted = formatSummaryComment({
      headSha: SHA_HEAD,
      doc: { ...parsedComplete, status: 'complete', notes: parsedExcluded.notes, sandbox: parsedExcluded.sandbox, findings: [] },
      strongFindings: [],
      normalFindings: [],
    })
    assert.match(summaryOmitted, /> Note: 1 changed file\(s\) were not sent for review/)
    assert.equal(summaryOmitted.includes('No findings on the changed diff hunks.'), false)
    assert.match(summaryOmitted, /excluded or skipped/)

    // 2b. Failed pass with detail
    const failedDoc = await readFixture('failed-with-detail.json')
    const parsedFailed = parseFindingsDocument(failedDoc)
    assert.equal(parsedFailed.passes[0].detail, 'boom')
    assert.equal(computeEffectiveStatus(parsedFailed.status, 4, parsedFailed.passes, parsedFailed.refused), 'failed')

    // 2c. Short-run re-run (superseded_by + waived) that succeeded -> complete, not partial
    const rerunCompleteDoc = await readFixture('short-run-rerun-complete.json')
    const parsedRerunComplete = parseFindingsDocument(rerunCompleteDoc)
    assert.equal(parsedRerunComplete.passes[0].superseded_by, 'codex-standard-r2')
    assert.equal(parsedRerunComplete.passes[0].waived, true)
    assert.match(parsedRerunComplete.passes[0].detail, /2 tool calls/)
    assert.equal(
      computeEffectiveStatus(parsedRerunComplete.status, 0, parsedRerunComplete.passes, parsedRerunComplete.refused),
      'complete',
    )

    // 2d. Short-run re-run where the re-run ALSO has short_run: true -> partial (even if doc/exit claim complete)
    const rerunPartialDoc = await readFixture('short-run-rerun-partial.json')
    const parsedRerunPartial = parseFindingsDocument(rerunPartialDoc)
    assert.equal(parsedRerunPartial.passes[1].short_run, true)
    assert.equal(
      computeEffectiveStatus(parsedRerunPartial.status, 2, parsedRerunPartial.passes, parsedRerunPartial.refused),
      'partial',
    )
    assert.equal(computeEffectiveStatus('complete', 0, parsedRerunPartial.passes, false), 'partial')

    // 2e. Failed passes list in formatSummaryComment skips superseded passes
    const supersededFailedSummary = formatSummaryComment({
      headSha: SHA_HEAD,
      doc: {
        ...parsedRerunComplete,
        status: 'failed',
        passes: [
          parsedRerunComplete.passes[0],
          { name: 'codex-standard-r2', model: 'gpt-6.2-sol', effort: 'medium', status: 'failed', minutes: 0, reason: 'crashed' },
        ],
      },
      strongFindings: [],
      normalFindings: [],
    })
    assert.match(supersededFailedSummary, /Failed passes: codex-standard-r2\./)
    assert.equal(supersededFailedSummary.includes('Failed passes: codex-standard,'), false)

    // 2f. Type and length cap validation on new fields
    assert.throws(() => parseFindingsDocument({ ...completeDoc, route: 'x'.repeat(65) }), /route exceeds max length 64/)
    assert.throws(
      () => parseFindingsDocument({ ...completeDoc, passes: [{ ...completeDoc.passes[0], route: 'x'.repeat(65) }] }),
      /passes\[0\]\.route exceeds max length 64/,
    )
    assert.throws(
      () => parseFindingsDocument({ ...completeDoc, passes: [{ ...completeDoc.passes[0], detail: 'x'.repeat(2001) }] }),
      /passes\[0\]\.detail exceeds max length 2000/,
    )
    assert.throws(
      () => parseFindingsDocument({ ...completeDoc, passes: [{ ...completeDoc.passes[0], superseded_by: 'x'.repeat(65) }] }),
      /passes\[0\]\.superseded_by exceeds max length 64/,
    )
    assert.throws(
      () => parseFindingsDocument({ ...completeDoc, passes: [{ ...completeDoc.passes[0], waived: 'yes' }] }),
      /passes\[0\]\.waived must be a boolean/,
    )
    assert.throws(
      () => parseFindingsDocument({ ...completeDoc, passes: [{ ...completeDoc.passes[0], short_run: 1 }] }),
      /passes\[0\]\.short_run must be a boolean/,
    )

    // 2g. refused: true maps to gateway-refused message in publish mode
    const refusedDoc = {
      ...completeDoc,
      target: { ...completeDoc.target, base: SHA_BASE, head: SHA_HEAD },
      status: 'failed',
      passes: [{ name: 'gateway', model: '-', effort: '-', status: 'failed', minutes: 0, reason: 'quota' }],
      findings: [],
      refused: true,
    }
    const parsedRefused = parseFindingsDocument(refusedDoc)
    assert.equal(parsedRefused.refused, true)

    const posted = []
    const h = makeHarness({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: 'acme/widget',
      INPUT_MODE: 'publish',
      'INPUT_GITHUB-TOKEN': 'ghs_fixture_token',
    })
    const res = await runAction({
      ...h,
      payload: {
        action: 'opened',
        repository: { owner: { login: 'acme' }, name: 'widget' },
        pull_request: {
          number: 7,
          state: 'open',
          base: { sha: SHA_BASE, repo: { full_name: 'acme/widget', fork: false } },
          head: { sha: SHA_HEAD, repo: { full_name: 'acme/widget', fork: false } },
        },
      },
      outPath: '/tmp/refused.json',
      readFindingsImpl: async () => JSON.stringify(refusedDoc),
      createGitHubApi: () => ({
        findSummaryComment: async () => null,
        createIssueComment: async (_o, _r, _n, body) => { posted.push(body); return 1 },
        getPull: async () => ({ open: true, headSha: SHA_HEAD, baseSha: SHA_BASE }),
      }),
    })
    assert.equal(res.status, 'failed')
    assert.equal(res.exitCode, 1)
    assert.match(posted[0], /Refused by the MegaLens gateway/)
  })

  it('3. installPinnedEngine uses megalens-review, runEngineCli runs <bin> install before run, and runAction catches thrown runEngine errors', async () => {
    assert.equal(ENGINE_PACKAGE_NAME, 'megalens-review')
    const tarballBytes = Buffer.from('fake-megalens-review-tgz')
    const integrity = computeSha512Integrity(tarballBytes)
    const calls = []

    const execFileImpl = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      if (cmd === 'npm' && args[0] === 'pack') {
        return { exitCode: 0, stdout: 'megalens-review-0.1.0.tgz\n', stderr: '', errorMessage: null }
      }
      return { exitCode: 0, stdout: '', stderr: '', errorMessage: null }
    }

    const installed = await installPinnedEngine(
      {
        version: '0.1.0',
        expectedIntegrity: integrity,
        runnerTemp: '/tmp/runner',
        baseEnv: { PATH: '/usr/bin', HOME: '/home/runner' },
      },
      {
        execFileImpl,
        mkdtempImpl: async () => '/tmp/runner/megalens-engine-123',
        writeFileImpl: async () => {},
        readFileImpl: async () => tarballBytes,
      },
    )
    assert.equal(installed.binPath, '/tmp/runner/megalens-engine-123/node_modules/.bin/megalens-review')
    assert.equal(calls[0].args.at(-1), 'megalens-review@0.1.0')

    calls.length = 0
    await runEngineCli(
      {
        tier: 'standard',
        baseSha: SHA_BASE,
        headSha: SHA_HEAD,
        outPath: '/tmp/out.json',
        timeoutMinutes: 10,
        engineVersion: '0.1.0',
        engineIntegrity: integrity,
        repoPath: '/github/workspace',
        runnerTemp: '/tmp/runner',
        authMode: 'review-key',
        authEnv: { MEGALENS_REVIEW_ID: 'rv_1', MEGALENS_REVIEW_KEY: 'ml_rk_secret_abc' },
      },
      {
        baseEnv: { PATH: '/usr/bin', HOME: '/home/runner', UNRELATED_SECRET: 'must_not_leak' },
        execFileImpl,
        mkdtempImpl: async () => '/tmp/runner/megalens-engine-456',
        writeFileImpl: async () => {},
        readFileImpl: async (p) => (p.endsWith('.tgz') ? tarballBytes : Promise.reject(new Error('no out'))),
        rmImpl: async () => {},
      },
    )

    assert.equal(calls.length, 4) // npm pack, npm install, megalens-review install, megalens-review run
    assert.equal(calls[2].cmd, '/tmp/runner/megalens-engine-456/node_modules/.bin/megalens-review')
    assert.deepEqual(calls[2].args, ['install'])
    assert.equal(calls[2].opts.cwd, '/tmp/runner/megalens-engine-456')
    assert.equal(calls[2].opts.env.HOME, '/home/runner')
    assert.equal(calls[2].opts.env.MEGALENS_REVIEW_KEY, undefined)
    assert.equal(calls[3].args[0], 'run')
    assert.equal(calls[3].opts.cwd, '/github/workspace')
    assert.equal(calls[3].opts.env.MEGALENS_REVIEW_KEY, 'ml_rk_secret_abc')
    assert.equal(calls[3].opts.env.UNRELATED_SECRET, undefined)

    // Thrown runEngine in review mode writes failed stub + uploads artifact instead of crashing uncaught
    let writtenStub = null
    let uploaded = null
    const h = makeHarness({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: 'acme/widget',
      INPUT_MODE: 'review',
      MEGALENS_REVIEW_ID: 'rv_fail_1',
      MEGALENS_REVIEW_KEY: 'ml_rk_secret_fail',
    })
    const res = await runAction({
      ...h,
      outPath: '/tmp/failed-stub.json',
      payload: {
        action: 'opened',
        repository: { owner: { login: 'acme' }, name: 'widget' },
        pull_request: {
          number: 7,
          state: 'open',
          base: { sha: SHA_BASE, repo: { full_name: 'acme/widget', fork: false } },
          head: { sha: SHA_HEAD, repo: { full_name: 'acme/widget', fork: false } },
        },
      },
      runEngine: async () => {
        throw new Error('Failed to fetch megalens-review@0.1.0 with ml_rk_secret_fail')
      },
      writeFindingsImpl: async (_p, content) => {
        writtenStub = JSON.parse(content)
      },
      uploadArtifact: async (a) => {
        uploaded = a
      },
    })
    assert.equal(res.status, 'failed')
    assert.equal(res.exitCode, 1)
    assert.ok(writtenStub)
    assert.equal(writtenStub.status, 'failed')
    assert.equal(writtenStub.error.includes('ml_rk_secret_fail'), false)
    assert.deepEqual(uploaded, { name: 'megalens-findings', path: '/tmp/failed-stub.json' })
  })

  it('4. create outputs head_sha/base_sha; review uses pinned SHAs with no getPull; publish compares pinned SHA to live head', async () => {
    // 4a. Invalid SHA rejected
    await assert.rejects(
      () =>
        runAction({
          ...makeHarness({
            GITHUB_EVENT_NAME: 'issue_comment',
            INPUT_MODE: 'review',
            'INPUT_HEAD-SHA': 'not-a-sha',
            'INPUT_BASE-SHA': SHA_BASE,
          }),
          payload: makeIssueCommentPayload('/megalens review'),
        }),
      /Invalid head-sha/,
    )

    // 4b. create outputs head_sha & base_sha
    const hCreate = makeHarness({
      GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_REPOSITORY: 'acme/widget',
      INPUT_MODE: 'create',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_test',
      'INPUT_GITHUB-TOKEN': 'ghs_test',
    })
    const createRes = await runAction({
      ...hCreate,
      payload: makeIssueCommentPayload('/megalens review'),
      createGitHubApi: () => ({
        getCollaboratorPermission: async () => 'write',
        getPull: async () => ({ open: true, isFork: true, baseSha: SHA_BASE, headSha: SHA_HEAD }),
      }),
      createReview: async () => ({ reviewId: 'rv_pin_1', reviewKey: 'ml_rk_pin_1' }),
    })
    assert.equal(createRes.exitCode, 0)
    assert.equal(hCreate.outputs.head_sha, SHA_HEAD)
    assert.equal(hCreate.outputs.base_sha, SHA_BASE)

    // 4c. review mode with pinned SHAs calls neither getPull nor getCollaboratorPermission
    let apiCreated = false
    let engineOpts = null
    const hReview = makeHarness({
      GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_REPOSITORY: 'acme/widget',
      INPUT_MODE: 'review',
      'INPUT_HEAD-SHA': SHA_HEAD,
      'INPUT_BASE-SHA': SHA_BASE,
      MEGALENS_REVIEW_ID: 'rv_pin_1',
      MEGALENS_REVIEW_KEY: 'ml_rk_pin_1',
    })
    const reviewRes = await runAction({
      ...hReview,
      payload: makeIssueCommentPayload('/megalens review'),
      outPath: '/tmp/pin-review.json',
      createGitHubApi: () => {
        apiCreated = true
        throw new Error('GitHub API must not be called in review mode with pinned SHAs')
      },
      runEngine: async (opts) => {
        engineOpts = opts
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          rawFindings: JSON.stringify({
            schema: 'megalens.findings/v1',
            review_id: 'rv_pin_1',
            tier: 'standard',
            status: 'complete',
            target: { kind: 'range', base: SHA_BASE, head: SHA_HEAD, snapshot_sha256: SNAPSHOT_SHA },
            passes: [{ name: 'codex-standard', status: 'ok' }],
            findings: [],
          }),
        }
      },
    })
    assert.equal(apiCreated, false)
    assert.equal(reviewRes.status, 'complete')
    assert.equal(engineOpts.headSha, SHA_HEAD)
    assert.equal(engineOpts.baseSha, SHA_BASE)

    // 4d. publish mode with pinned head-sha detects PR moved to SHA_MOVED and posts moved note
    const posted = []
    const hPublish = makeHarness({
      GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_REPOSITORY: 'acme/widget',
      INPUT_MODE: 'publish',
      'INPUT_HEAD-SHA': SHA_HEAD,
      'INPUT_GITHUB-TOKEN': 'ghs_publish',
    })
    const pubRes = await runAction({
      ...hPublish,
      payload: makeIssueCommentPayload('/megalens review'),
      outPath: '/tmp/pin-publish.json',
      readFindingsImpl: async () =>
        JSON.stringify({
          schema: 'megalens.findings/v1',
          review_id: 'rv_pin_1',
          tier: 'standard',
          status: 'complete',
          target: { kind: 'range', base: SHA_BASE, head: SHA_HEAD, snapshot_sha256: SNAPSHOT_SHA },
          passes: [{ name: 'codex-standard', status: 'ok' }],
          findings: [],
        }),
      createGitHubApi: () => ({
        getPull: async () => ({ open: true, isFork: true, baseSha: SHA_BASE, headSha: SHA_MOVED }),
        findSummaryComment: async () => null,
        createIssueComment: async (_o, _r, _n, body) => { posted.push(body); return 1 },
      }),
    })
    assert.equal(pubRes.status, 'skipped')
    assert.equal(pubRes.reason, 'stale_head')
    assert.equal(pubRes.exitCode, 0)
    assert.equal(posted.length, 0) // newer commit: nothing written

    // 4e. README checks out pinned head_sha, lists create in needs for every job reading needs.create.outputs.*, and omits internal Review notes
    const readme = await readFile(join(ACTION_ROOT, 'README.md'), 'utf8')
    assert.match(readme, /ref:\s*\$\{\{\s*needs\.create\.outputs\.head_sha\s*\}\}/)
    assert.equal(readme.includes('refs/pull/'), false)
    assert.equal(/##\s*Review notes/i.test(readme), false)

    const yamlBlocks = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1])
    assert.ok(yamlBlocks.length >= 2)
    for (const block of yamlBlocks) {
      const jobsSection = block.split(/^jobs:\s*$/m)[1]
      assert.ok(jobsSection, 'workflow block must define jobs:')
      const jobChunks = jobsSection.split(/\n(?=  [a-zA-Z0-9_-]+:\s*(?:\n|$))/).filter((c) => c.trim())
      for (const chunk of jobChunks) {
        const jobMatch = /^\s*([a-zA-Z0-9_-]+):/m.exec(chunk)
        if (!jobMatch) continue
        const jobName = jobMatch[1]
        if (chunk.includes('needs.create.outputs.')) {
          const needsInline = /^\s{4}needs:\s*\[([^\]]+)\]/m.exec(chunk)
          const needsSingle = /^\s{4}needs:\s*([a-zA-Z0-9_-]+)\s*$/m.exec(chunk)
          const needsList = /^\s{4}needs:\s*\n((?:\s{6}-\s*[a-zA-Z0-9_-]+\s*\n?)+)/m.exec(chunk)
          const deps = needsInline
            ? needsInline[1].split(',').map((s) => s.trim())
            : needsSingle
              ? [needsSingle[1].trim()]
              : needsList
                ? [...needsList[1].matchAll(/-\s*([a-zA-Z0-9_-]+)/g)].map((m) => m[1])
                : []
          assert.ok(
            deps.includes('create'),
            `job "${jobName}" reads needs.create.outputs.* but its needs (${JSON.stringify(deps)}) does not include "create"`,
          )
        }
      }
    }

    // 4f. On issue_comment, review requires head-sha + base-sha and publish requires head-sha
    const missingBothReview = await runAction({
      ...makeHarness({
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_REPOSITORY: 'acme/widget',
        INPUT_MODE: 'review',
        MEGALENS_REVIEW_ID: 'rv_pin_1',
        MEGALENS_REVIEW_KEY: 'ml_rk_pin_1',
      }),
      payload: makeIssueCommentPayload('/megalens review'),
    })
    assert.equal(missingBothReview.status, 'failed')
    assert.equal(missingBothReview.exitCode, 1)
    assert.match(missingBothReview.error, /head-sha/)
    assert.match(missingBothReview.error, /base-sha/)

    const missingBaseReview = await runAction({
      ...makeHarness({
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_REPOSITORY: 'acme/widget',
        INPUT_MODE: 'review',
        'INPUT_HEAD-SHA': SHA_HEAD,
        MEGALENS_REVIEW_ID: 'rv_pin_1',
        MEGALENS_REVIEW_KEY: 'ml_rk_pin_1',
      }),
      payload: makeIssueCommentPayload('/megalens review'),
    })
    assert.equal(missingBaseReview.status, 'failed')
    assert.equal(missingBaseReview.exitCode, 1)
    assert.match(missingBaseReview.error, /base-sha/)

    const missingHeadPublish = await runAction({
      ...makeHarness({
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_REPOSITORY: 'acme/widget',
        INPUT_MODE: 'publish',
        'INPUT_GITHUB-TOKEN': 'ghs_publish',
      }),
      payload: makeIssueCommentPayload('/megalens review'),
    })
    assert.equal(missingHeadPublish.status, 'failed')
    assert.equal(missingHeadPublish.exitCode, 1)
    assert.match(missingHeadPublish.error, /head-sha/)

    await assert.rejects(
      () =>
        runAction({
          ...makeHarness({
            GITHUB_EVENT_NAME: 'issue_comment',
            INPUT_MODE: 'publish',
            'INPUT_HEAD-SHA': 'g'.repeat(40),
          }),
          payload: makeIssueCommentPayload('/megalens review'),
        }),
      /Invalid head-sha/,
    )
  })

  it('5. full mode skips fork PRs on issue_comment and mode is required in action.yml / GitHub Actions', async () => {
    let engineCalled = false
    const h = makeHarness({
      GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_REPOSITORY: 'acme/widget',
      INPUT_MODE: 'full',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_secret',
      'INPUT_GITHUB-TOKEN': 'ghs_secret',
    })
    const res = await runAction({
      ...h,
      payload: makeIssueCommentPayload('/megalens review'),
      createGitHubApi: () => ({
        getCollaboratorPermission: async () => 'write',
        getPull: async () => ({ open: true, isFork: true, baseSha: SHA_BASE, headSha: SHA_HEAD }),
      }),
      runEngine: async () => {
        engineCalled = true
        return { exitCode: 0 }
      },
    })
    assert.equal(engineCalled, false)
    assert.equal(res.status, 'skipped')
    assert.equal(res.exitCode, 0)
    assert.equal(h.summaries[0], 'skipped: fork PRs need the create/review/publish workflow')

    const actionYml = await readFile(join(ACTION_ROOT, 'action.yml'), 'utf8')
    assert.match(actionYml, /mode:\s*\n\s+description:[^\n]*\n\s+required:\s*true/)
    await assert.rejects(
      () => runAction({ ...makeHarness({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' }), payload: {} }),
      /Missing required input "mode"/,
    )
  })

  it('6. burst guard skips only recent complete summaries in create/full, never over failed/partial/moved or in review/publish', async () => {
    const now = 1_700_000_000_000
    const makeCreateHarness = () =>
      makeHarness({
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'acme/widget',
        INPUT_MODE: 'create',
        'INPUT_MEGALENS-TOKEN': 'ml_tok_secret',
        'INPUT_GITHUB-TOKEN': 'ghs_secret',
      })
    const prPayload = {
      action: 'opened',
      repository: { owner: { login: 'acme' }, name: 'widget' },
      pull_request: {
        number: 7,
        state: 'open',
        base: { sha: SHA_BASE, repo: { full_name: 'acme/widget', fork: false } },
        head: { sha: SHA_HEAD, repo: { full_name: 'acme/widget', fork: false } },
      },
    }

    // 6a. Recent complete summary -> skipped
    let createCalls = 0
    const resSkip = await runAction({
      ...makeCreateHarness(),
      payload: prPayload,
      now,
      createGitHubApi: () => ({
        findSummaryCommentDetails: async () => ({
          id: 1,
          body: `${summaryMarker('standard')}\n${summaryMetaMarker(SHA_HEAD, 'standard', 'complete', now - 60_000)}`,
        }),
      }),
      createReview: async () => {
        createCalls += 1
        return { reviewId: 'rv_1', reviewKey: 'ml_rk_1' }
      },
    })
    assert.equal(resSkip.status, 'skipped')
    assert.equal(resSkip.reason, 'burst_guard')
    assert.equal(createCalls, 0)

    // 6b. Failed, partial, moved, or expired summaries -> NOT skipped
    for (const [status, ts] of [
      ['failed', now - 10_000],
      ['partial', now - 10_000],
      ['moved', now - 10_000],
      ['complete', now - BURST_GUARD_WINDOW_MS - 1000],
    ]) {
      let called = false
      const resRun = await runAction({
        ...makeCreateHarness(),
        payload: prPayload,
        now,
        createGitHubApi: () => ({
          findSummaryCommentDetails: async () => ({
            id: 2,
            body: `${summaryMarker('standard')}\n${summaryMetaMarker(SHA_HEAD, 'standard', status, ts)}`,
          }),
        }),
        createReview: async () => {
          called = true
          return { reviewId: `rv_${status}`, reviewKey: 'ml_rk_2' }
        },
      })
      assert.equal(called, true, `expected create not to skip over ${status} summary`)
      assert.equal(resRun.status, 'complete')
    }

    // 6c. review mode never runs burst guard even if a recent complete summary exists
    let findCalledInReview = false
    const resReview = await runAction({
      ...makeHarness({
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'acme/widget',
        INPUT_MODE: 'review',
        MEGALENS_REVIEW_ID: 'rv_ok',
        MEGALENS_REVIEW_KEY: 'ml_rk_ok',
      }),
      payload: prPayload,
      now,
      outPath: '/tmp/burst-review.json',
      createGitHubApi: () => ({
        findSummaryCommentDetails: async () => {
          findCalledInReview = true
          return {
            id: 3,
            body: `${summaryMarker('standard')}\n${summaryMetaMarker(SHA_HEAD, 'standard', 'complete', now - 1000)}`,
          }
        },
      }),
      runEngine: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        rawFindings: JSON.stringify({
          schema: 'megalens.findings/v1',
          review_id: 'rv_ok',
          tier: 'standard',
          status: 'complete',
          target: { kind: 'range', base: SHA_BASE, head: SHA_HEAD, snapshot_sha256: SNAPSHOT_SHA },
          passes: [{ name: 'codex-standard', status: 'ok' }],
          findings: [],
        }),
      }),
    })
    assert.equal(findCalledInReview, false)
    assert.equal(resReview.status, 'complete')
  })

  it('7. strong finding overlapping a MegaLens App comment still counts toward strong-count and fail-on: strong', async () => {
    const h = makeHarness({
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: 'acme/widget',
      INPUT_MODE: 'publish',
      'INPUT_FAIL-ON': 'strong',
      'INPUT_GITHUB-TOKEN': 'ghs_publish',
    })
    const postedSummaries = []
    let createdInlineReview = false

    const res = await runAction({
      ...h,
      payload: {
        action: 'opened',
        repository: { owner: { login: 'acme' }, name: 'widget' },
        pull_request: {
          number: 7,
          state: 'open',
          base: { sha: SHA_BASE, repo: { full_name: 'acme/widget', fork: false } },
          head: { sha: SHA_HEAD, repo: { full_name: 'acme/widget', fork: false } },
        },
      },
      outPath: '/tmp/overlap.json',
      readFindingsImpl: async () =>
        JSON.stringify({
          schema: 'megalens.findings/v1',
          review_id: 'rv_overlap',
          tier: 'standard',
          status: 'complete',
          target: { kind: 'range', base: SHA_BASE, head: SHA_HEAD, snapshot_sha256: SNAPSHOT_SHA },
          passes: [{ name: 'codex-standard', status: 'ok' }],
          findings: [
            {
              id: 'f1',
              file: 'src/a.ts',
              line_start: 42,
              title: 'SQL injection in query builder',
              claim: 'User input concatenated into SQL',
              failure_scenario: 'Pass quotes in query param',
              priority: 'P0',
              strength: 'strong',
              found_by: ['codex-standard'],
            },
          ],
        }),
      createGitHubApi: () => ({
        getPull: async () => ({ open: true, headSha: SHA_HEAD, baseSha: SHA_BASE }),
        listPullFiles: async () => [
          {
            filename: 'src/a.ts',
            status: 'modified',
            patch: '@@ -40,3 +40,5 @@\n const x = 1\n+const y = 2\n+const z = 3\n',
          },
        ],
        getViewerLogin: async () => 'github-actions[bot]',
        listPullReviewComments: async () => [
          { user: { login: 'megalens[bot]' }, path: 'src/a.ts', line: 45, body: 'Unrelated App note' },
        ],
        createPullReview: async () => {
          createdInlineReview = true
          return 1
        },
        findSummaryComment: async () => null,
        createIssueComment: async (_o, _r, _n, body) => {
          postedSummaries.push(body)
          return 10
        },
      }),
    })

    assert.equal(createdInlineReview, false)
    assert.equal(h.outputs['strong-count'], '1')
    assert.equal(res.exitCode, 1)
    assert.match(res.error, /Found 1 strong finding\(s\) with fail-on=strong/)
    assert.match(postedSummaries[0], /also found by the App/)
  })

  it('8. sanitizeText breaks bare URLs, reference-style links, and issue cross-references', () => {
    const evil = 'see https://evil.example/login and www.evil.example [fix][1] #1 other/repo#2\n[1]: https://evil.example'
    const safe = sanitizeText(evil, 1000)

    assert.equal(/https?:\/\/[A-Za-z0-9]/.test(safe), false)
    assert.equal(/\bwww\.[A-Za-z0-9]/i.test(safe), false)
    assert.equal(safe.includes(']['), false)
    assert.equal(safe.includes(']:'), false)
    assert.equal(/#\d/.test(safe), false)
    assert.equal(/other\/repo#\d/.test(safe), false)
    assert.equal(createHash('sha256').update(safe).digest('hex').length, 64)
  })
})
