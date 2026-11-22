import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { BYO_FORK_SKIP_SUMMARY, FORK_SKIP_SUMMARY, runAction, selectNewInlineFindings } from '../src/action.js'
import { buildChildEnv, resolveAuthEnv, runEngineCli } from '../src/engine.js'
import { MAX_FINDINGS_BYTES, parseFindingsDocument } from '../src/findings.js'
import { WALKTHROUGH_MARKER } from '../src/format.js'

const ACTION_ROOT = new URL('..', import.meta.url).pathname

function makeSameRepoPrPayload(overrides = {}) {
  return {
    action: 'opened',
    repository: {
      owner: { login: 'acme' },
      name: 'widget',
      full_name: 'acme/widget',
    },
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
      ...overrides,
    },
  }
}

function makeForkPrPayload(overrides = {}) {
  return makeSameRepoPrPayload({
    head: {
      sha: 'fork333333333333333333333333333333333333',
      repo: { full_name: 'stranger/widget', fork: true },
    },
    ...overrides,
  })
}

function makeIssueCommentPayload(body = '/megalens review', commenter = 'maintainer') {
  return {
    action: 'created',
    repository: {
      owner: { login: 'acme' },
      name: 'widget',
      full_name: 'acme/widget',
    },
    issue: {
      number: 42,
      pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/42' },
    },
    comment: {
      id: 99,
      body,
      user: { login: commenter, type: 'User' },
    },
    sender: { login: commenter, type: 'User' },
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

function createMockGitHubApi(overrides = {}) {
  const calls = {
    createIssueComment: [],
    updateIssueComment: [],
    createPullReview: [],
  }
  const api = {
    calls,
    getViewerLogin: async () => 'github-actions[bot]',
    getCollaboratorPermission: async () => 'write',
    getPull: async () => ({
      number: 42,
      open: true,
      draft: false,
      baseSha: 'base111111111111111111111111111111111111',
      headSha: 'head222222222222222222222222222222222222',
      headRepoFullName: 'acme/widget',
      baseRepoFullName: 'acme/widget',
      isFork: false,
    }),
    listPullFiles: async () => [
      {
        filename: 'src/app.js',
        status: 'modified',
        patch: '@@ -1,3 +1,6 @@\n const a = 1\n+const b = 2\n+const c = 3\n+const d = 4\n',
      },
    ],
    findSummaryCommentDetails: async () => null,
    findSummaryComment: async () => null,
    createIssueComment: async (_o, _r, _n, body) => {
      calls.createIssueComment.push(body)
      return 101
    },
    updateIssueComment: async (_o, _r, id, body) => {
      calls.updateIssueComment.push({ id, body })
    },
    listPullReviewComments: async () => [],
    createPullReview: async (_o, _r, _n, commitId, comments) => {
      calls.createPullReview.push({ commitId, comments })
      return 202
    },
    ...overrides,
  }
  return api
}

function makeValidFindings(overrides = {}) {
  return {
    schema: 'megalens.findings/v1',
    review_id: 'rv_123',
    tier: 'standard',
    status: 'complete',
    target: {
      kind: 'range',
      base: 'base111111111111111111111111111111111111',
      head: 'head222222222222222222222222222222222222',
      snapshot_sha256: 'abc123',
    },
    passes: [{ name: 'codex-standard', model: 'gpt-6.2-sol', effort: 'medium', status: 'ok', minutes: 1.2 }],
    findings: [
      {
        id: 'f1',
        file: 'src/app.js',
        line_start: 2,
        line_end: 3,
        title: 'Null dereference in handler',
        claim: 'b may be undefined at runtime.',
        failure_scenario: 'Call handler with empty input.',
        priority: 'P1',
        strength: 'strong',
        found_by: ['codex-standard'],
      },
      {
        id: 'f2',
        file: 'src/other.js',
        line_start: 10,
        title: 'Minor style note',
        claim: 'Consider renaming variable.',
        priority: 'P3',
        strength: 'normal',
        found_by: ['codex-standard'],
      },
    ],
    dropped_findings: [],
    usage: { requests: 1, input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
    ...overrides,
  }
}

test('create mode: calls POST /api/v2/reviews with repo/shas/tier, outputs unmasked review_key, never logs key', async () => {
  const fetchRequests = []
  const reviewKey = 'rk_live_secret_do_not_mask_in_create'
  const accountToken = 'ml_tok_account_secret_123456'
  const h = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'create',
    INPUT_TIER: 'double',
    INPUT_MEGALENS_TOKEN: accountToken,
    INPUT_API_URL: 'https://megalens.ai',
  })

  let engineCalled = false
  const result = await runAction({
    ...h,
    doubleTierEnabled: true,
    payload: makeSameRepoPrPayload(),
    runEngine: async () => {
      engineCalled = true
      return { exitCode: 0 }
    },
    fetchImpl: async (url, init) => {
      fetchRequests.push({ url, init })
      return new Response(JSON.stringify({ review_id: 'rv_abc', review_key: reviewKey }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  assert.equal(engineCalled, false)
  assert.equal(result.exitCode, 0)
  assert.equal(result.status, 'complete')
  assert.equal(fetchRequests.length, 1)
  assert.equal(fetchRequests[0].url, 'https://megalens.ai/api/v2/reviews')
  assert.equal(fetchRequests[0].init.method, 'POST')
  assert.equal(fetchRequests[0].init.headers.Authorization, `Bearer ${accountToken}`)
  assert.deepEqual(JSON.parse(fetchRequests[0].init.body), {
    repo: 'acme/widget',
    base_sha: 'base111111111111111111111111111111111111',
    head_sha: 'head222222222222222222222222222222222222',
    tier: 'double',
  })

  assert.equal(h.outputs.review_id, 'rv_abc')
  assert.equal(h.outputs.review_key, reviewKey)
  assert.ok(h.masked.includes(accountToken))
  assert.equal(h.masked.includes(reviewKey), false)

  const allLogs = [...h.summaries, ...h.warnings, JSON.stringify(result)].join('\n')
  assert.equal(allLogs.includes(reviewKey), false)
  assert.equal(allLogs.includes(accountToken), false)
})

test('create mode: fails clearly without megalens-token and on 403 notice_required', async () => {
  const hMissing = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'create',
    INPUT_TIER: 'standard',
  })
  const missingRes = await runAction({
    ...hMissing,
    payload: makeSameRepoPrPayload(),
  })
  assert.equal(missingRes.status, 'failed')
  assert.equal(missingRes.exitCode, 1)
  assert.match(missingRes.error, /megalens-token/i)

  const accountToken = 'ml_tok_secret_notice_999999'
  const hNotice = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'create',
    INPUT_MEGALENS_TOKEN: accountToken,
  })
  const noticeRes = await runAction({
    ...hNotice,
    payload: makeSameRepoPrPayload(),
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 'notice_required', message: `Accept notice (${accountToken})` }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
  })
  assert.equal(noticeRes.status, 'failed')
  assert.equal(noticeRes.exitCode, 1)
  assert.match(noticeRes.error, /notice_required/)
  assert.equal(noticeRes.error.includes(accountToken), false)
})

test('create mode: fork PR on pull_request skips cleanly without calling API', async () => {
  let called = false
  const h = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'create',
  })
  const res = await runAction({
    ...h,
    payload: makeForkPrPayload(),
    fetchImpl: async () => {
      called = true
      throw new Error('should not fetch')
    },
  })
  assert.equal(called, false)
  assert.equal(res.status, 'skipped')
  assert.equal(res.reason, 'fork_pr')
  assert.equal(res.exitCode, 0)
  assert.equal(h.summaries[0], FORK_SKIP_SUMMARY)
})

test('review mode: masks review_key first, refuses megalens-token, allowlists env, never leaks review_key', async () => {
  const reviewKey = 'rk_ephemeral_secret_xyz987'
  const hFailToken = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'review',
    INPUT_MEGALENS_TOKEN: 'ml_tok_should_not_be_here_1234',
    MEGALENS_REVIEW_ID: 'rv_123',
    MEGALENS_REVIEW_KEY: reviewKey,
  })
  const refused = await runAction({
    ...hFailToken,
    payload: makeSameRepoPrPayload(),
  })
  assert.equal(refused.status, 'failed')
  assert.equal(refused.exitCode, 1)
  assert.match(refused.error, /never receive the account token/i)
  assert.ok(hFailToken.masked.includes(reviewKey))

  const capturedChildEnvs = []
  const uploaded = []
  const written = {}
  const h = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'review',
    INPUT_TIER: 'standard',
    INPUT_ARTIFACT_NAME: 'custom-findings',
    MEGALENS_REVIEW_ID: 'rv_123',
    MEGALENS_REVIEW_KEY: reviewKey,
    MEGALENS_TOKEN: 'ml_tok_leaked_parent_env_999',
    GITHUB_TOKEN: 'ghp_parent_github_token_1234567890',
    ACTIONS_RUNTIME_TOKEN: 'runtime_secret_should_not_pass',
    RUNNER_TEMP: '/tmp/runner-temp-test',
    PATH: '/usr/bin',
  })

  const doc = makeValidFindings()
  const res = await runAction({
    ...h,
    payload: makeSameRepoPrPayload(),
    outPath: '/tmp/runner-temp-test/findings.json',
    uploadArtifact: async (info) => uploaded.push(info),
    writeFindingsImpl: async (p, content) => {
      written[p] = content
    },
    runEngine: async (opts) => {
      const cliRes = await runEngineCli(
        {
          ...opts,
          cliBin: '/usr/local/bin/megalens-review',
          installDir: '/tmp/runner-temp-test',
        },
        {
          baseEnv: h.env,
          execFileImpl: async (_cmd, _args, execOpts) => {
            capturedChildEnvs.push(execOpts.env)
            return {
              exitCode: 0,
              stdout: `done key=${reviewKey}`,
              stderr: `debug ${reviewKey}`,
              errorMessage: null,
            }
          },
          readFileImpl: async () => JSON.stringify(doc),
        },
      )
      return cliRes
    },
  })

  assert.equal(res.exitCode, 0)
  assert.equal(res.status, 'complete')
  assert.equal(h.masked[0], reviewKey)
  assert.equal(capturedChildEnvs.length, 1)
  assert.deepEqual(Object.keys(capturedChildEnvs[0]).sort(), [
    'MEGALENS_REVIEW_ID',
    'MEGALENS_REVIEW_KEY',
    'PATH',
    'RUNNER_TEMP',
  ])
  assert.equal(capturedChildEnvs[0].MEGALENS_REVIEW_ID, 'rv_123')
  assert.equal(capturedChildEnvs[0].MEGALENS_REVIEW_KEY, reviewKey)
  assert.equal(capturedChildEnvs[0].MEGALENS_TOKEN, undefined)
  assert.equal(capturedChildEnvs[0].GITHUB_TOKEN, undefined)
  assert.equal(capturedChildEnvs[0].ACTIONS_RUNTIME_TOKEN, undefined)

  assert.deepEqual(uploaded, [{ name: 'custom-findings', path: '/tmp/runner-temp-test/findings.json' }])
  assert.equal(h.outputs['artifact-name'], 'custom-findings')

  const combinedOutputs = [
    JSON.stringify(h.outputs),
    ...h.summaries,
    ...h.warnings,
    ...Object.values(written),
    JSON.stringify(res),
  ].join('\n')
  assert.equal(combinedOutputs.includes(reviewKey), false)
})

test('publish mode: rejects oversized and schema-invalid artifacts', async () => {
  const api = createMockGitHubApi()
  const oversized = JSON.stringify({
    ...makeValidFindings(),
    findings: [
      {
        id: 'big',
        file: 'a.js',
        title: 'Too big',
        claim: 'x'.repeat(MAX_FINDINGS_BYTES + 100),
        priority: 'P1',
        strength: 'strong',
      },
    ],
  })

  const hBig = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'publish',
    INPUT_GITHUB_TOKEN: 'ghs_test_token_1234567890123456',
  })
  const bigRes = await runAction({
    ...hBig,
    payload: makeSameRepoPrPayload(),
    createGitHubApi: () => api,
    readFindingsImpl: async () => oversized,
  })
  assert.equal(bigRes.status, 'failed')
  assert.equal(bigRes.exitCode, 1)
  assert.equal(api.calls.createPullReview.length, 0)
  assert.match(api.calls.createIssueComment.at(-1), /Review failed/)

  const invalidCases = [
    JSON.stringify({ ...makeValidFindings(), schema: 'wrong/v0' }),
    JSON.stringify({ ...makeValidFindings(), extraRootField: true }),
    JSON.stringify({
      ...makeValidFindings(),
      findings: [{ id: '1', file: 'a.js', title: 'Bad', priority: 'P9', strength: 'strong' }],
    }),
    JSON.stringify({
      ...makeValidFindings(),
      findings: [{ id: '1', file: 'a.js', title: 'Bad', priority: 'P1', strength: 'strong', line_start: '10' }],
    }),
    JSON.stringify({
      ...makeValidFindings(),
      findings: [{ id: '1', file: 'a.js', title: 'Bad', priority: 'P1', strength: 'critical' }],
    }),
    JSON.stringify({
      ...makeValidFindings(),
      findings: [{ id: '1', file: 'a.js', title: 'x'.repeat(501), priority: 'P1', strength: 'strong' }],
    }),
  ]

  for (const badRaw of invalidCases) {
    assert.throws(() => parseFindingsDocument(badRaw))
    const hBad = createHarness({
      GITHUB_EVENT_NAME: 'pull_request',
      INPUT_MODE: 'publish',
      INPUT_GITHUB_TOKEN: 'ghs_test_token_1234567890123456',
    })
    const badRes = await runAction({
      ...hBad,
      payload: makeSameRepoPrPayload(),
      createGitHubApi: () => createMockGitHubApi(),
      readFindingsImpl: async () => badRaw,
    })
    assert.equal(badRes.status, 'failed')
    assert.equal(badRes.exitCode, 1)
  }
})

test('publish mode: sanitizes untrusted text, respects inline=false, dedupes App overlaps, never leaks key', async () => {
  const reviewKey = 'rk_should_never_appear_in_publish'
  const api = createMockGitHubApi()
  const tamperedValid = makeValidFindings({
    findings: [
      {
        id: 'f1',
        file: 'src/app.js',
        line_start: 2,
        title: 'XSS <script>alert(1)</script> @org/team',
        claim: '/megalens deep\n![bad](https://evil.test/x.png) ```js\nevil()\n```',
        priority: 'P1',
        strength: 'strong',
      },
    ],
  })

  const hNoInline = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'publish',
    INPUT_INLINE: 'false',
    INPUT_ARTIFACT_NAME: 'my-findings',
    INPUT_GITHUB_TOKEN: 'ghs_test_token_1234567890123456',
    MEGALENS_REVIEW_KEY: reviewKey,
  })
  const downloaded = []
  const resNoInline = await runAction({
    ...hNoInline,
    payload: makeSameRepoPrPayload(),
    createGitHubApi: () => api,
    downloadArtifact: async (info) => {
      downloaded.push(info)
      return '/tmp/findings.json'
    },
    readFindingsImpl: async () => JSON.stringify(tamperedValid),
  })

  assert.equal(resNoInline.exitCode, 0)
  assert.equal(downloaded[0].name, 'my-findings')
  assert.equal(api.calls.createPullReview.length, 0)
  assert.equal(api.calls.createIssueComment.length, 2)
  const [walkthrough, summaryBody] = api.calls.createIssueComment
  const visibleSummary = summaryBody.replace(/^  ```\n[\s\S]*?^  ```$/gm, '')
  assert.equal(visibleSummary.includes('<script>'), false)
  assert.equal(visibleSummary.includes('@org/team'), false)
  assert.equal(visibleSummary.includes('![bad]('), false)
  assert.equal(visibleSummary.includes('```'), false)
  assert.equal(/\n\/megalens deep/.test(summaryBody), false)
  assert.equal(summaryBody.includes(reviewKey), false)
  assert.ok(walkthrough.startsWith(WALKTHROUGH_MARKER))
  assert.equal(walkthrough.includes(reviewKey), false)
  assert.equal(hNoInline.masked.includes(reviewKey), true)

  // App overlap within 5 lines (different title) moves finding to summary and skips duplicate inline comment.
  const dedupe = selectNewInlineFindings(
    [{ file: 'src/app.js', line_start: 12, line_end: 14, title: 'Different wording' }],
    [
      {
        user: { login: 'megalens[bot]' },
        path: 'src/app.js',
        line: 10,
        body: '**P1 (strong): App title**\n<!-- megalens-app:v1 file=src%2Fapp.js lines=10-10 title=0123456789abcdef -->',
      },
    ],
  )
  assert.equal(dedupe.toPost.length, 0)
  assert.equal(dedupe.appOverlapFindings.length, 1)
  assert.equal(dedupe.appOverlapFindings[0].alsoFoundByApp, true)
})

test('BYO openai-api-key is refused on fork PRs (pull_request, issue_comment, and engine)', async () => {
  const byoKey = 'sk-proj-byo-fork-test-key-1234567890'
  let engineRan = false

  const hPr = createHarness({
    GITHUB_EVENT_NAME: 'pull_request',
    INPUT_MODE: 'review',
    INPUT_OPENAI_API_KEY: byoKey,
  })
  const prRes = await runAction({
    ...hPr,
    payload: makeForkPrPayload(),
    byoKeyEnabled: true,
    runEngine: async () => {
      engineRan = true
      return { exitCode: 0 }
    },
  })
  assert.equal(engineRan, false)
  assert.equal(prRes.status, 'skipped')
  assert.equal(prRes.reason, 'fork_pr')
  assert.equal(prRes.exitCode, 0)
  assert.equal(hPr.summaries[0], FORK_SKIP_SUMMARY)

  const apiFork = createMockGitHubApi({
    getPull: async () => ({
      number: 42,
      open: true,
      draft: false,
      baseSha: 'base111111111111111111111111111111111111',
      headSha: 'fork333333333333333333333333333333333333',
      headRepoFullName: 'stranger/widget',
      baseRepoFullName: 'acme/widget',
      isFork: true,
    }),
  })
  const hComment = createHarness({
    GITHUB_EVENT_NAME: 'issue_comment',
    INPUT_MODE: 'create',
    INPUT_OPENAI_API_KEY: byoKey,
    INPUT_GITHUB_TOKEN: 'ghs_test_token_1234567890123456',
  })
  const commentRes = await runAction({
    ...hComment,
    payload: makeIssueCommentPayload('/megalens review', 'maintainer'),
    byoKeyEnabled: true,
    createGitHubApi: () => apiFork,
    runEngine: async () => {
      engineRan = true
      return { exitCode: 0 }
    },
  })
  assert.equal(engineRan, false)
  assert.equal(commentRes.status, 'skipped')
  assert.equal(commentRes.reason, 'byo_fork_refused')
  assert.equal(commentRes.exitCode, 0)
  assert.equal(hComment.summaries[0], BYO_FORK_SKIP_SUMMARY)

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
          authEnv: { OPENAI_API_KEY: byoKey, MEGALENS_BYO: '1' },
          isFork: true,
        },
        { byoKeyEnabled: true },
      ),
    /BYO key is not used on fork PRs/,
  )

  const auth = resolveAuthEnv({ reviewId: 'rv_1', reviewKey: 'rk_1', openaiApiKey: byoKey })
  assert.equal(auth?.mode, 'review-key')
  const child = buildChildEnv({ OPENAI_API_KEY: byoKey, MEGALENS_TOKEN: 'ml_tok_12345678' }, auth?.mode, auth?.env)
  assert.equal(child.OPENAI_API_KEY, undefined)
  assert.equal(child.MEGALENS_TOKEN, undefined)
})

test('README and action.yml conform to three-job contract, permissions, data-flow notice, and full-mode warning', async () => {
  const [readme, actionYml] = await Promise.all([
    readFile(join(ACTION_ROOT, 'README.md'), 'utf8'),
    readFile(join(ACTION_ROOT, 'action.yml'), 'utf8'),
  ])

  assert.match(actionYml, /artifact-name:/)
  assert.match(actionYml, /inline:/)
  assert.match(actionYml, /review_id:/)
  assert.match(actionYml, /review_key:/)

  assert.match(readme, /^permissions:\s*\{\}/m)
  assert.match(readme, /create:/)
  assert.match(readme, /review:/)
  assert.match(readme, /publish:/)
  assert.match(readme, /::add-mask::\$REVIEW_KEY/)
  assert.match(readme, /same-repo trusted PRs only, not for forks/i)
  assert.match(
    readme,
    /The Action runs on the customer's runner\. The whole repo is not uploaded\. Code excerpts the reviewer reads, and the diff, pass through the gateway to MegaLens and OpenAI in gateway mode\./,
  )
  assert.equal(/never goes to our server/i.test(readme), false)
  const usageSection = readme.slice(readme.indexOf('## Usage:'), readme.indexOf('## Fork-PR Policy'))
  assert.equal(/pull_request_target/.test(usageSection), false)
})
