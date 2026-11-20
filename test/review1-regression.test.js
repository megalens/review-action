import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runAction, selectNewInlineFindings } from '../src/action.js'
import { parseCommentCommand } from '../src/commands.js'
import { partitionFindingsByDiff } from '../src/diff.js'
import { buildChildEnv, computeSha512Integrity, runEngineCli } from '../src/engine.js'
import { computeEffectiveStatus, isStrongFinding } from '../src/findings.js'
import {
  formatInlineComment,
  formatSummaryComment,
  inlineMarker,
  parseInlineMarker,
  sanitizeText,
  summaryMarker,
  titleHash,
} from '../src/format.js'
import { createGitHubApi } from '../src/github-api.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

function makePrPayload(overrides = {}) {
  return {
    action: 'opened',
    repository: { owner: { login: 'acme' }, name: 'app', full_name: 'acme/app' },
    pull_request: {
      number: 42,
      state: 'open',
      user: { login: 'alice', type: 'User' },
      base: { sha: '1111111111111111111111111111111111111111', repo: { full_name: 'acme/app', fork: false } },
      head: { sha: '2222222222222222222222222222222222222222', repo: { full_name: 'acme/app', fork: false } },
      ...overrides,
    },
  }
}

function makeFakeApi(overrides = {}) {
  const createdReviews = []
  const createdComments = []
  const updatedComments = []
  return {
    createdReviews,
    createdComments,
    updatedComments,
    async getViewerLogin() {
      return 'github-actions[bot]'
    },
    async getPull() {
      return {
        number: 42,
        open: true,
        draft: false,
        headSha: '2222222222222222222222222222222222222222',
        baseSha: '1111111111111111111111111111111111111111',
        isFork: false,
      }
    },
    async getCollaboratorPermission() {
      return 'write'
    },
    async listPullFiles() {
      return [
        {
          filename: 'src/a.js',
          status: 'modified',
          patch: '@@ -1,2 +1,5 @@\n const a = 1\n+const b = 2\n+const c = 3\n+const d = 4\n',
        },
      ]
    },
    async findSummaryCommentDetails() {
      return null
    },
    async findSummaryComment() {
      return null
    },
    async createIssueComment(_owner, _repo, _num, body) {
      createdComments.push(body)
      return 100 + createdComments.length
    },
    async updateIssueComment(_owner, _repo, id, body) {
      updatedComments.push({ id, body })
    },
    async listPullReviewComments() {
      return []
    },
    async createPullReview(_owner, _repo, _num, commitId, comments) {
      createdReviews.push({ commitId, comments })
      return 900
    },
    ...overrides,
  }
}

function makeDoc(overrides = {}) {
  return {
    schema: 'megalens.findings/v1',
    review_id: 'rv_test_1',
    tier: 'standard',
    status: 'complete',
    target: {
      kind: 'range',
      base: '1111111111111111111111111111111111111111',
      head: '2222222222222222222222222222222222222222',
      snapshot_sha256: 'abc',
    },
    passes: [{ name: 'codex-standard', status: 'ok' }],
    findings: [],
    ...overrides,
  }
}

// 1. Isolated engine install under RUNNER_TEMP with sha512 integrity check + cwd isolation
test('1. runEngineCli installs pinned engine into empty RUNNER_TEMP dir, verifies sha512, runs <bin> install then <bin> run in repoPath', async () => {
  const fakeTarball = Buffer.from('fake-tarball-content')
  const expectedIntegrity = computeSha512Integrity(fakeTarball)
  const calls = []
  const writtenFiles = []

  const res = await runEngineCli(
    {
      tier: 'standard',
      baseSha: 'base123',
      headSha: 'head456',
      outPath: '/tmp/runner/out.json',
      timeoutMinutes: 10,
      engineVersion: '0.1.0',
      engineIntegrity: expectedIntegrity,
      authMode: 'gateway',
      authEnv: { MEGALENS_TOKEN: 'ml_tok_test12345' },
      repoPath: '/github/workspace/pr-checkout',
      runnerTemp: '/tmp/runner',
    },
    {
      baseEnv: { PATH: '/usr/bin', HOME: '/home/runner', RUNNER_TEMP: '/tmp/runner', TMPDIR: '/tmp' },
      async mkdtempImpl(prefix) {
        return `${prefix}abc`
      },
      async writeFileImpl(path, content) {
        writtenFiles.push({ path, content })
      },
      async readFileImpl(path) {
        if (path.endsWith('.tgz')) return fakeTarball
        return JSON.stringify(makeDoc())
      },
      async rmImpl() {},
      async execFileImpl(command, args, options) {
        calls.push({ command, args, options })
        if (command === 'npm' && args[0] === 'pack') {
          return { exitCode: 0, stdout: 'megalens-review-0.1.0.tgz\n', stderr: '', errorMessage: null }
        }
        return { exitCode: 0, stdout: 'ok', stderr: '', errorMessage: null }
      },
    },
  )

  assert.equal(res.exitCode, 0)
  assert.equal(calls.length, 4)
  assert.equal(calls[0].command, 'npm')
  assert.ok(calls[0].args.includes('--ignore-scripts'))
  assert.ok(calls[0].args.includes('--userconfig'))
  assert.equal(calls[0].options.cwd, '/tmp/runner/megalens-engine-abc')
  assert.equal(calls[0].options.env.MEGALENS_TOKEN, undefined)

  assert.equal(calls[1].command, 'npm')
  assert.equal(calls[1].args[0], 'install')
  assert.ok(calls[1].args.includes('--prefix'))
  assert.ok(calls[1].args.includes('--userconfig'))
  assert.ok(calls[1].args.includes('--ignore-scripts'))
  assert.equal(calls[1].options.cwd, '/tmp/runner/megalens-engine-abc')
  assert.equal(calls[1].options.env.MEGALENS_TOKEN, undefined)

  assert.equal(calls[2].command, '/tmp/runner/megalens-engine-abc/node_modules/.bin/megalens-review')
  assert.deepEqual(calls[2].args, ['install'])
  assert.equal(calls[2].options.cwd, '/tmp/runner/megalens-engine-abc')
  assert.equal(calls[2].options.env.MEGALENS_TOKEN, undefined)

  assert.equal(calls[3].command, '/tmp/runner/megalens-engine-abc/node_modules/.bin/megalens-review')
  assert.equal(calls[3].args[0], 'run')
  assert.equal(calls[3].options.cwd, '/github/workspace/pr-checkout')
  assert.equal(calls[3].args.includes('--repo'), false)
  assert.equal(calls[3].options.env.MEGALENS_TOKEN, 'ml_tok_test12345')
  assert.equal(writtenFiles[0].path, '/tmp/runner/megalens-engine-abc/.npmrc')
  assert.equal(writtenFiles[0].content, '')
})

test('1b. install rejects tarball on sha512 integrity mismatch before npm install or execution', async () => {
  const calls = []
  await assert.rejects(
    () =>
      runEngineCli(
        {
          tier: 'standard',
          baseSha: 'b',
          headSha: 'h',
          outPath: '/tmp/out.json',
          timeoutMinutes: 5,
          engineVersion: '0.1.0',
          engineIntegrity: `sha512-${'B'.repeat(86)}==`,
          authMode: 'gateway',
          authEnv: { MEGALENS_TOKEN: 'ml_tok_test12345' },
          repoPath: '/github/workspace',
          runnerTemp: '/tmp/runner',
        },
        {
          baseEnv: { PATH: '/usr/bin' },
          async mkdtempImpl(p) {
            return `${p}xyz`
          },
          async writeFileImpl() {},
          async readFileImpl() {
            return Buffer.from('tampered-tarball')
          },
          async rmImpl() {},
          async execFileImpl(command, args) {
            calls.push([command, args[0]])
            return { exitCode: 0, stdout: 'megalens-engine-v2-0.1.0.tgz\n', stderr: '', errorMessage: null }
          },
        },
      ),
    /Integrity verification failed/,
  )
  assert.deepEqual(calls, [['npm', 'pack']])
})

// 2. Child env allowlist
test('2. buildChildEnv strips INPUT_*, ACTIONS_RUNTIME_TOKEN, GITHUB_TOKEN and unrelated secrets', () => {
  const pollutedEnv = {
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/home/runner',
    RUNNER_TEMP: '/tmp/runner',
    TMPDIR: '/tmp',
    'INPUT_GITHUB-TOKEN': 'ghp_secret1234567890123456',
    'INPUT_OPENAI-API-KEY': 'sk-secret1234567890123456',
    ACTIONS_RUNTIME_TOKEN: 'eyJ.secret.jwt',
    GITHUB_TOKEN: 'ghs_secret1234567890123456',
    AWS_SECRET_ACCESS_KEY: 'aws_secret',
  }

  const gwEnv = buildChildEnv(pollutedEnv, 'gateway', {
    MEGALENS_TOKEN: 'ml_tok_123',
    OPENAI_API_KEY: 'sk-should-not-copy',
  })
  assert.deepEqual(gwEnv, {
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/home/runner',
    RUNNER_TEMP: '/tmp/runner',
    TMPDIR: '/tmp',
    MEGALENS_TOKEN: 'ml_tok_123',
  })

  const byoEnv = buildChildEnv(
    pollutedEnv,
    'byo-key',
    {
      OPENAI_API_KEY: 'sk-byo-123',
      MEGALENS_TOKEN: 'ml_should_not_copy',
    },
    { byoKeyEnabled: true },
  )
  assert.deepEqual(byoEnv, {
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/home/runner',
    RUNNER_TEMP: '/tmp/runner',
    TMPDIR: '/tmp',
    OPENAI_API_KEY: 'sk-byo-123',
    MEGALENS_BYO: '1',
  })
})

// 3. Always skip fork PRs on pull_request regardless of secrets
test('3. pull_request always skips fork PRs even when megalens-token or openai-api-key is set', async () => {
  let engineCalled = false
  const forkPayload = makePrPayload({
    head: { sha: '2222', repo: { full_name: 'attacker/app', fork: true } },
  })

  for (const extraEnv of [
    { 'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890' },
    { 'INPUT_OPENAI-API-KEY': 'sk-1234567890123456' },
  ]) {
    const summaries = []
    const res = await runAction({
      env: { GITHUB_EVENT_NAME: 'pull_request', ...extraEnv },
      payload: forkPayload,
      byoKeyEnabled: Boolean(extraEnv['INPUT_OPENAI-API-KEY']),
      writeSummary: (m) => summaries.push(m),
      runEngine: async () => {
        engineCalled = true
        return { exitCode: 0, stdout: '', stderr: '', rawFindings: null }
      },
    })
    assert.equal(res.status, 'skipped')
    assert.equal(res.reason, 'fork_pr')
    assert.equal(res.exitCode, 0)
    assert.equal(engineCalled, false)
    assert.match(summaries[0], /skipped: fork PR/)
  }
})

// 4. Non-inline findings go into collapsed <details> summary and never say "No findings"
test('4. findings outside hunks, without line, or on files without patch go to <details> summary', async () => {
  const pullFiles = [
    { filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b\n' },
    { filename: 'assets/logo.png', status: 'modified' }, // no patch
  ]
  const findings = [
    { id: '1', file: 'src/a.js', line_start: 99, title: 'Out of hunk', priority: 'P1', strength: 'strong' },
    { id: '2', file: 'src/a.js', title: 'No line number', priority: 'P1', strength: 'strong' },
    { id: '3', file: 'assets/logo.png', line_start: 1, title: 'No patch file', priority: 'P2', strength: 'normal' },
  ]
  const { inDiff, outOfDiff } = partitionFindingsByDiff(findings, pullFiles)
  assert.equal(inDiff.length, 0)
  assert.equal(outOfDiff.length, 3)

  const api = makeFakeApi({ listPullFiles: async () => pullFiles })
  const res = await runAction({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: makePrPayload(),
    createGitHubApi: () => api,
    runEngine: async () => ({ exitCode: 0, stdout: '', stderr: '', rawFindings: JSON.stringify(makeDoc({ findings })) }),
  })

  assert.equal(res.strongFindings.length, 0)
  assert.equal(res.normalFindings.length, 3)
  assert.equal(api.createdReviews.length, 0)
  assert.equal(api.createdComments.length, 1)
  const body = api.createdComments[0]
  assert.ok(body.includes('<details>'))
  assert.ok(body.includes('Out of hunk'))
  assert.ok(body.includes('No line number'))
  assert.ok(body.includes('No patch file'))
  assert.ok(!body.includes('No findings on the changed diff hunks'))
})

// 5. Effective status = worst of doc.status, exit-code status, pass statuses; never "No findings" unless complete
test('5. computeEffectiveStatus and summary never report incomplete run clean', async () => {
  assert.equal(computeEffectiveStatus('complete', 2, [{ status: 'ok' }]), 'partial')
  assert.equal(computeEffectiveStatus('complete', 0, [{ status: 'ok' }, { status: 'failed' }]), 'partial')
  assert.equal(computeEffectiveStatus('complete', 0, [{ status: 'failed' }]), 'failed')
  assert.equal(computeEffectiveStatus('complete', 3, [{ status: 'ok' }]), 'failed')

  const api = makeFakeApi()
  const res = await runAction({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: makePrPayload(),
    createGitHubApi: () => api,
    runEngine: async () => ({
      exitCode: 2,
      stdout: '',
      stderr: '',
      rawFindings: JSON.stringify(makeDoc({ status: 'complete', passes: [{ name: 'p1', status: 'ok' }] })),
    }),
  })

  assert.equal(res.status, 'partial')
  assert.equal(res.exitCode, 0)
  assert.ok(api.createdComments[0].includes('Partial review'))
  assert.ok(!api.createdComments[0].includes('No findings on the changed diff hunks'))
})

// 6. Partial/failed fails job as "incomplete" when fail-on is set
test('6. fail-on=strong fails partial reviews as incomplete', async () => {
  const api = makeFakeApi()
  const res = await runAction({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
      'INPUT_FAIL-ON': 'strong',
    },
    payload: makePrPayload(),
    createGitHubApi: () => api,
    runEngine: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      rawFindings: JSON.stringify(makeDoc({ status: 'partial', findings: [] })),
    }),
  })

  assert.equal(res.status, 'partial')
  assert.equal(res.exitCode, 1)
  assert.match(res.error, /incomplete/i)
})

// 7. Dedupe key = file + line range + sha256(title) prefix; ignores markers from other authors
test('7. selectNewInlineFindings uses file+line range+titleHash and ignores non-own authors', () => {
  const f1 = { id: 'run2-id', file: 'src/a.js', line_start: 2, line_end: 4, title: 'SQL injection' }
  const markerF1 = inlineMarker(f1)
  assert.ok(!markerF1.includes('run2-id'))
  assert.ok(markerF1.includes(`title=${titleHash('SQL injection')}`))

  const parsed = parseInlineMarker(markerF1)
  assert.deepEqual(parsed, {
    file: 'src/a.js',
    lineStart: 2,
    lineEnd: 4,
    titleSha: titleHash('SQL injection'),
    source: 'action',
  })

  // Comment authored by attacker spoofing marker must NOT dedupe
  const spoofed = selectNewInlineFindings(
    [f1],
    [{ user: { login: 'attacker' }, body: formatInlineComment(f1), path: 'src/a.js', line: 2 }],
    { ownLogin: 'github-actions[bot]' },
  )
  assert.equal(spoofed.toPost.length, 1)

  // Comment authored by ownLogin DOES dedupe across different per-run finding IDs
  const ownDup = selectNewInlineFindings(
    [{ ...f1, id: 'run99-different-id' }],
    [{ user: { login: 'github-actions[bot]' }, body: formatInlineComment(f1), path: 'src/a.js', line: 2 }],
    { ownLogin: 'github-actions[bot]' },
  )
  assert.equal(ownDup.toPost.length, 0)
  assert.equal(ownDup.alreadyPostedCount, 1)

  // Same title+line in a different file is NOT deduped
  const diffFile = selectNewInlineFindings(
    [{ ...f1, file: 'src/b.js' }],
    [{ user: { login: 'github-actions[bot]' }, body: formatInlineComment(f1), path: 'src/a.js', line: 2 }],
    { ownLogin: 'github-actions[bot]' },
  )
  assert.equal(diffFile.toPost.length, 1)
})

// 8. Re-check PR head on both events; moved note; require target.head == reviewed sha
test('8. requires target.head == headSha and posts moved note with no inline comments on issue_comment & pull_request', async () => {
  // Missing target.head fails
  const apiMissing = makeFakeApi()
  const missingHeadRes = await runAction({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: makePrPayload(),
    createGitHubApi: () => apiMissing,
    runEngine: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      rawFindings: JSON.stringify(makeDoc({ target: { kind: 'range', base: '111', head: null } })),
    }),
  })
  assert.equal(missingHeadRes.status, 'failed')
  assert.equal(missingHeadRes.exitCode, 1)

  // Moved PR head on issue_comment (same-repo full mode) posts moved note and no inline comments
  let getPullCalls = 0
  const apiMoved = makeFakeApi({
    async getPull() {
      getPullCalls += 1
      return {
        number: 42,
        open: true,
        headSha: getPullCalls === 1 ? '2222222222222222222222222222222222222222' : '9999999999999999999999999999999999999999',
        baseSha: '1111111111111111111111111111111111111111',
        isFork: false,
      }
    },
  })
  const movedRes = await runAction({
    env: {
      GITHUB_EVENT_NAME: 'issue_comment',
      INPUT_MODE: 'full',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: {
      action: 'created',
      repository: { owner: { login: 'acme' }, name: 'app' },
      issue: { number: 42, pull_request: {} },
      comment: { user: { login: 'maintainer', type: 'User' }, body: '/megalens review' },
      sender: { type: 'User' },
    },
    createGitHubApi: () => apiMoved,
    runEngine: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      rawFindings: JSON.stringify(
        makeDoc({
          findings: [{ id: '1', file: 'src/a.js', line_start: 2, title: 'Bug', priority: 'P0', strength: 'strong' }],
        }),
      ),
    }),
  })
  assert.equal(movedRes.status, 'skipped')
  assert.equal(movedRes.reason, 'stale_head')
  assert.equal(movedRes.exitCode, 0)
  assert.equal(apiMoved.createdReviews.length, 0)
  assert.equal(apiMoved.createdComments.length, 1)
  assert.match(apiMoved.createdComments[0], /Reviewed `2222222`, PR has moved/)

  // Moved PR head on fork PR (publish mode with pinned head-sha) posts moved note and no inline comments
  const apiForkMoved = makeFakeApi({
    async getPull() {
      return {
        number: 42,
        open: true,
        headSha: '9999999999999999999999999999999999999999',
        baseSha: '1111111111111111111111111111111111111111',
        isFork: true,
      }
    },
  })
  const forkMovedRes = await runAction({
    env: {
      GITHUB_EVENT_NAME: 'issue_comment',
      INPUT_MODE: 'publish',
      'INPUT_HEAD-SHA': '2222222222222222222222222222222222222222',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: {
      action: 'created',
      repository: { owner: { login: 'acme' }, name: 'app' },
      issue: { number: 42, pull_request: {} },
      comment: { user: { login: 'maintainer', type: 'User' }, body: '/megalens review' },
      sender: { type: 'User' },
    },
    createGitHubApi: () => apiForkMoved,
    readFindingsImpl: async () =>
      JSON.stringify(
        makeDoc({
          findings: [{ id: '1', file: 'src/a.js', line_start: 2, title: 'Bug', priority: 'P0', strength: 'strong' }],
        }),
      ),
  })
  assert.equal(forkMovedRes.status, 'skipped')
  assert.equal(forkMovedRes.reason, 'stale_head')
  assert.equal(forkMovedRes.exitCode, 0)
  assert.equal(apiForkMoved.createdReviews.length, 0)
  assert.equal(apiForkMoved.createdComments.length, 1)
  assert.match(apiForkMoved.createdComments[0], /Reviewed `2222222`, PR has moved/)
})

// 9. Summary lookup matches token's own login (PAT, App, or github-actions[bot])
test('9. findSummaryComment matches token own login for PAT and installation tokens', async () => {
  const comments = [
    { id: 1, user: { login: 'other-bot[bot]', type: 'Bot' }, body: summaryMarker('standard') },
    { id: 2, user: { login: 'alice-pat', type: 'User' }, body: summaryMarker('standard') },
    { id: 3, user: { login: 'my-app[bot]', type: 'Bot' }, body: summaryMarker('standard') },
  ]

  const patApi = createGitHubApi('tok', {
    fetchImpl: async (url) => {
      if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'alice-pat', type: 'User' }), { status: 200 })
      return new Response(JSON.stringify(comments), { status: 200 })
    },
  })
  assert.equal(await patApi.findSummaryComment('acme', 'app', 42, summaryMarker('standard')), 2)

  const appApi = createGitHubApi('tok', {
    fetchImpl: async (url) => {
      if (url.endsWith('/user')) return new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 })
      if (url.endsWith('/app')) return new Response(JSON.stringify({ slug: 'my-app' }), { status: 200 })
      return new Response(JSON.stringify(comments), { status: 200 })
    },
  })
  assert.equal(await appApi.findSummaryComment('acme', 'app', 42, summaryMarker('standard')), 3)

  const defaultBotApi = createGitHubApi('tok', {
    fetchImpl: async (url) => {
      if (url.endsWith('/user') || url.endsWith('/app')) return new Response('{}', { status: 403 })
      return new Response(
        JSON.stringify([{ id: 4, user: { login: 'github-actions[bot]', type: 'Bot' }, body: summaryMarker('standard') }]),
        { status: 200 },
      )
    },
  })
  assert.equal(await defaultBotApi.findSummaryComment('acme', 'app', 42, summaryMarker('standard')), 4)
})

// 10. Refuse deep on pull_request (treat as standard with warning); refuse double by default; /megalens review honors enabled input tier
test('10. pull_request downgrades deep to standard with warning; double is refused by default and honored when enabled', async () => {
  const warnings = []
  let usedTier = null
  await runAction({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      'INPUT_TIER': 'deep',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: makePrPayload(),
    warn: (w) => warnings.push(w),
    createGitHubApi: () => makeFakeApi(),
    runEngine: async (opts) => {
      usedTier = opts.tier
      return { exitCode: 0, stdout: '', stderr: '', rawFindings: JSON.stringify(makeDoc({ tier: opts.tier })) }
    },
  })
  assert.equal(usedTier, 'standard')
  assert.equal(warnings.length, 1)

  // Owner decision: double tier is refused by default without running engine
  let doubleEngineCalled = false
  const refusedDouble = await runAction({
    env: {
      GITHUB_EVENT_NAME: 'issue_comment',
      'INPUT_TIER': 'double',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: {
      action: 'created',
      repository: { owner: { login: 'acme' }, name: 'app' },
      issue: { number: 42, pull_request: {} },
      comment: { user: { login: 'maintainer', type: 'User' }, body: '/megalens review' },
      sender: { type: 'User' },
    },
    createGitHubApi: () => makeFakeApi(),
    runEngine: async () => {
      doubleEngineCalled = true
      return { exitCode: 0, stdout: '', stderr: '', rawFindings: JSON.stringify(makeDoc()) }
    },
  })
  assert.equal(refusedDouble.status, 'failed')
  assert.equal(refusedDouble.exitCode, 1)
  assert.equal(doubleEngineCalled, false)

  // When doubleTierEnabled is injected for testing, /megalens review honors double tier
  let commentTier = null
  await runAction({
    env: {
      GITHUB_EVENT_NAME: 'issue_comment',
      'INPUT_TIER': 'double',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: {
      action: 'created',
      repository: { owner: { login: 'acme' }, name: 'app' },
      issue: { number: 42, pull_request: {} },
      comment: { user: { login: 'maintainer', type: 'User' }, body: '/megalens review' },
      sender: { type: 'User' },
    },
    doubleTierEnabled: true,
    createGitHubApi: () => makeFakeApi(),
    runEngine: async (opts) => {
      commentTier = opts.tier
      return { exitCode: 0, stdout: '', stderr: '', rawFindings: JSON.stringify(makeDoc({ tier: opts.tier })) }
    },
  })
  assert.equal(commentTier, 'double')

  // /megalens deep comment runs deep tier
  let deepCommentTier = null
  await runAction({
    env: {
      GITHUB_EVENT_NAME: 'issue_comment',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: {
      action: 'created',
      repository: { owner: { login: 'acme' }, name: 'app' },
      issue: { number: 42, pull_request: {} },
      comment: { user: { login: 'maintainer', type: 'User' }, body: '/megalens deep' },
      sender: { type: 'User' },
    },
    createGitHubApi: () => makeFakeApi(),
    runEngine: async (opts) => {
      deepCommentTier = opts.tier
      return { exitCode: 0, stdout: '', stderr: '', rawFindings: JSON.stringify(makeDoc({ tier: opts.tier })) }
    },
  })
  assert.equal(deepCommentTier, 'deep')
})

// 11. Dependabot / no-secret same-repo PR skips cleanly with exit 0
test('11. pull_request without secrets (e.g. Dependabot) skips cleanly with exit 0', async () => {
  const summaries = []
  const res = await runAction({
    env: { GITHUB_EVENT_NAME: 'pull_request', 'INPUT_GITHUB-TOKEN': 'ghs_tok' },
    payload: makePrPayload({ user: { login: 'dependabot[bot]', type: 'Bot' } }),
    writeSummary: (m) => summaries.push(m),
  })
  assert.equal(res.status, 'skipped')
  assert.equal(res.reason, 'no_credentials')
  assert.equal(res.exitCode, 0)
  assert.match(summaries[0], /dependabot\[bot\]/)
})

// 12. sanitizeText escapes < > &, collapses newlines in titles, neutralises leading / and embeds
test('12. sanitizeText neutralises HTML, image/link embeds, newlines in titles, and /megalens commands', () => {
  const raw = '<script>alert(1)</script> & ![img](https://evil.test/x.png) [link](https://x)\n/megalens deep\n  /megalens review'
  const out = sanitizeText(raw, 500)
  assert.ok(!out.includes('<script>'))
  assert.ok(out.includes('&lt;script&gt;'))
  assert.ok(out.includes('&amp;'))
  assert.ok(!out.includes('!['))
  assert.ok(!out.includes(']('))
  assert.equal(parseCommentCommand(out), null)
  assert.ok(!/^\s*\//m.test(out))

  const formatted = formatSummaryComment({
    headSha: '2222222',
    doc: makeDoc({ status: 'complete' }),
    strongFindings: [
      {
        file: 'src/a.js',
        line_start: 2,
        priority: 'P0',
        strength: 'strong',
        title: 'Bad title\n/megalens deep',
        claim: 'line1\n/megalens deep',
      },
    ],
  })
  assert.equal(parseCommentCommand(formatted), null)
  assert.ok(!formatted.includes('Bad title\n'))
})

// 13. isStrongFinding requires strong AND P0/P1 AND file+line inside hunk
test('13. isStrongFinding requires strong + P0/P1 + file+line in diff hunk', () => {
  assert.equal(isStrongFinding({ strength: 'strong', priority: 'P0', file: 'a.js', line_start: 1 }, true), true)
  assert.equal(isStrongFinding({ strength: 'strong', priority: 'P1', file: 'a.js', line_start: 1 }, true), true)
  assert.equal(isStrongFinding({ strength: 'strong', priority: 'P2', file: 'a.js', line_start: 1 }, true), false)
  assert.equal(isStrongFinding({ strength: 'normal', priority: 'P0', file: 'a.js', line_start: 1 }, true), false)
  assert.equal(isStrongFinding({ strength: 'strong', priority: 'P0', file: 'a.js', line_start: 1 }, false), false)
  assert.equal(isStrongFinding({ strength: 'strong', priority: 'P0', file: 'a.js' }, true), false)
})

// 14. Tier-scoped summary marker, burst guard, self-hosted warning, README lint, App dedupe
test('14a. tier-scoped summary marker and burst guard per head+tier', async () => {
  const existingStandard = formatSummaryComment({
    headSha: '2222222222222222222222222222222222222222',
    doc: makeDoc({ tier: 'standard', status: 'complete' }),
  })
  assert.ok(existingStandard.includes('<!-- megalens:review:v1:standard -->'))

  let engineCalls = 0
  const api = makeFakeApi({
    async findSummaryCommentDetails(_o, _r, _n, marker) {
      if (marker === '<!-- megalens:review:v1:standard -->') {
        return { id: 55, body: existingStandard }
      }
      return null
    },
  })

  const skippedBurst = await runAction({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      'INPUT_TIER': 'standard',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: makePrPayload(),
    createGitHubApi: () => api,
    runEngine: async () => {
      engineCalls += 1
      return { exitCode: 0, stdout: '', stderr: '', rawFindings: JSON.stringify(makeDoc()) }
    },
  })
  assert.equal(skippedBurst.status, 'skipped')
  assert.equal(skippedBurst.reason, 'burst_guard')
  assert.equal(engineCalls, 0)

  // Different tier (deep via /megalens deep, and double when enabled) is NOT blocked by standard summary
  const deepRun = await runAction({
    env: {
      GITHUB_EVENT_NAME: 'issue_comment',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: {
      action: 'created',
      repository: { owner: { login: 'acme' }, name: 'app' },
      issue: { number: 42, pull_request: {} },
      comment: { user: { login: 'maintainer', type: 'User' }, body: '/megalens deep' },
      sender: { type: 'User' },
    },
    createGitHubApi: () => api,
    runEngine: async () => {
      engineCalls += 1
      return { exitCode: 0, stdout: '', stderr: '', rawFindings: JSON.stringify(makeDoc({ tier: 'deep' })) }
    },
  })
  assert.equal(deepRun.status, 'complete')
  assert.equal(engineCalls, 1)

  const doubleRun = await runAction({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      'INPUT_TIER': 'double',
      'INPUT_MEGALENS-TOKEN': 'ml_tok_1234567890',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: makePrPayload(),
    doubleTierEnabled: true,
    createGitHubApi: () => api,
    runEngine: async () => {
      engineCalls += 1
      return { exitCode: 0, stdout: '', stderr: '', rawFindings: JSON.stringify(makeDoc({ tier: 'double' })) }
    },
  })
  assert.equal(doubleRun.status, 'complete')
  assert.equal(engineCalls, 2)
})

test('14b. self-hosted runner warns on fork PR', async () => {
  const warnings = []
  const summaries = []
  const res = await runAction({
    env: { GITHUB_EVENT_NAME: 'pull_request', RUNNER_ENVIRONMENT: 'self-hosted' },
    payload: makePrPayload({ head: { sha: '2222', repo: { full_name: 'fork/app', fork: true } } }),
    warn: (w) => warnings.push(w),
    writeSummary: (m) => summaries.push(m),
  })
  assert.equal(res.status, 'skipped')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /self-hosted/i)
  assert.match(summaries[0], /self-hosted/i)
})

test('14c. dedupes inline comments against MegaLens GitHub App bot', () => {
  const f1 = { file: 'src/a.js', line_start: 2, line_end: 2, title: 'Null deref' }
  const { toPost, alreadyPostedCount } = selectNewInlineFindings(
    [f1],
    [
      {
        user: { login: 'megalens[bot]', type: 'Bot' },
        path: 'src/a.js',
        line: 2,
        body: `**P1 (strong): Null deref**\n\n<!-- megalens:app:v1 file=src%2Fa.js line=2 title=${titleHash('Null deref')} -->`,
      },
    ],
    { ownLogin: 'github-actions[bot]' },
  )
  assert.equal(toPost.length, 0)
  assert.equal(alreadyPostedCount, 1)
})

test('14d. README workflow templates follow F4-F6, F14, F16, F19', async () => {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
  assert.ok(readme.includes('permissions: {}'))
  assert.ok(readme.includes('contents: read'))
  assert.ok(readme.includes('pull-requests: write'))
  assert.ok(!/^\s*issues:\s*write\b/m.test(readme))
  assert.ok(!/uses:\s*pull_request_target/i.test(readme))
  assert.ok(!/uses:\s*actions\/checkout@v/i.test(readme))
  assert.ok(!/uses:\s*megalens\/review-action@v1\s*$/m.test(readme))
  assert.match(readme, /actions\/checkout@[0-9a-f]{40}/)
  assert.match(readme, /actions\/upload-artifact@[0-9a-f]{40}/)
  assert.match(readme, /actions\/download-artifact@[0-9a-f]{40}/)
  assert.match(readme, /megalens\/review-action@[0-9a-f]{40}/)
  assert.match(readme, /self-hosted runners on public repositories for fork PRs/i)
})

test('14e. two-job split: mode=review writes findings without posting; mode=publish posts without secrets', async () => {
  const files = new Map()
  const doc = makeDoc({
    findings: [{ id: '1', file: 'src/a.js', line_start: 2, title: 'Leak', priority: 'P0', strength: 'strong' }],
  })
  const reviewApi = makeFakeApi()
  const reviewRes = await runAction({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      'INPUT_MODE': 'review',
      'INPUT_FINDINGS-PATH': '/tmp/findings.json',
      MEGALENS_REVIEW_ID: 'rv_test_1',
      MEGALENS_REVIEW_KEY: 'rk_test_mock_key_12345',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: makePrPayload(),
    createGitHubApi: () => reviewApi,
    writeFindingsImpl: async (p, content) => {
      files.set(p, content)
    },
    runEngine: async ({ outPath }) => {
      const json = JSON.stringify(doc)
      files.set(outPath, json)
      return { exitCode: 0, stdout: '', stderr: '', rawFindings: json }
    },
  })
  assert.equal(reviewRes.status, 'complete')
  assert.equal(reviewApi.createdComments.length, 0)
  assert.equal(reviewApi.createdReviews.length, 0)

  const publishApi = makeFakeApi()
  const publishRes = await runAction({
    env: {
      GITHUB_EVENT_NAME: 'pull_request',
      'INPUT_MODE': 'publish',
      'INPUT_FINDINGS-PATH': '/tmp/findings.json',
      'INPUT_GITHUB-TOKEN': 'ghs_tok',
    },
    payload: makePrPayload(),
    createGitHubApi: () => publishApi,
    readFindingsImpl: async (p) => files.get(p),
    runEngine: async () => {
      throw new Error('publish mode must never run engine')
    },
  })
  assert.equal(publishRes.status, 'complete')
  assert.equal(publishRes.strongFindings.length, 1)
  assert.equal(publishApi.createdReviews.length, 1)
  assert.equal(publishApi.createdComments.length, 1)
})
