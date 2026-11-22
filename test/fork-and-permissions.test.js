import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FORK_SKIP_SUMMARY, runAction } from '../src/action.js'
import { parseCommentCommand } from '../src/commands.js'
import { WALKTHROUGH_MARKER } from '../src/format.js'
import { createGitHubApi } from '../src/github-api.js'

const PATCH = '@@ -1,2 +1,3 @@\n const a = 1\n+const b = 2\n'

describe('fork-PR skip and pull_request_target guard', () => {
  it('skips cleanly on fork pull_request without secrets, posts nothing, writes exact job summary', async () => {
    let engineCalled = false
    let apiCalled = false
    const summaries = []

    const res = await runAction({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'upstream/repo',
        'INPUT_GITHUB-TOKEN': 'ghs_readonly_fork_token',
      },
      payload: {
        action: 'opened',
        repository: { owner: { login: 'upstream' }, name: 'repo' },
        pull_request: {
          number: 19,
          state: 'open',
          base: { sha: 'base123', repo: { full_name: 'upstream/repo' } },
          head: { sha: 'head456', repo: { full_name: 'contributor/repo', fork: true } },
        },
      },
      runEngine: async () => {
        engineCalled = true
        return { exitCode: 0, stdout: '', stderr: '', errorMessage: null, rawFindings: null }
      },
      createGitHubApi: () => {
        apiCalled = true
        return {}
      },
      writeSummary: (text) => { summaries.push(text) },
    })

    assert.equal(res.exitCode, 0)
    assert.equal(res.status, 'skipped')
    assert.equal(engineCalled, false)
    assert.equal(apiCalled, false)
    assert.deepEqual(summaries, [FORK_SKIP_SUMMARY])
    assert.equal(FORK_SKIP_SUMMARY, 'skipped: fork PR; a maintainer can comment /megalens review')
  })

  it('refuses pull_request_target so PR code is never executed with repository secrets', async () => {
    const summaries = []
    const res = await runAction({
      env: {
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_REPOSITORY: 'upstream/repo',
        'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture',
      },
      payload: {},
      writeSummary: (text) => { summaries.push(text) },
    })

    assert.equal(res.exitCode, 1)
    assert.equal(res.status, 'failed')
    assert.match(summaries[0], /pull_request_target/)
  })
})

describe('commenter permission check and /megalens commands', () => {
  it('parses /megalens deep and /megalens review while ignoring HTML comments and quotes', () => {
    assert.equal(parseCommentCommand('/megalens deep'), 'deep')
    assert.equal(parseCommentCommand('Looks good\n/megalens review'), 'review')
    assert.equal(parseCommentCommand('<!-- /megalens deep -->\nPlease check'), null)
    assert.equal(parseCommentCommand('> /megalens deep'), null)
  })

  it('runs deep tier on PR head when a maintainer with write or admin permission comments /megalens deep', async () => {
    const engineCalls = []
    const createdComments = []
    const fetchCalls = []

    const fakeFetch = async (url, init) => {
      fetchCalls.push({ url, method: init.method })
      if (url.endsWith('/user') && init.method === 'GET') {
        return new Response(JSON.stringify({ login: 'github-actions[bot]', type: 'Bot' }), { status: 200 })
      }
      if (url.endsWith('/collaborators/alice/permission')) {
        return new Response(JSON.stringify({ permission: 'write' }), { status: 200 })
      }
      if (url.endsWith('/pulls/55')) {
        return new Response(
          JSON.stringify({ state: 'open', draft: false, head: { sha: 'head999' }, base: { sha: 'base888' } }),
          { status: 200 },
        )
      }
      if (url.includes('/pulls/55/files')) {
        return new Response(JSON.stringify([{ filename: 'src/x.js', status: 'modified', patch: PATCH }]), { status: 200 })
      }
      if (url.includes('/issues/55/comments') && init.method === 'GET') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/issues/55/comments') && init.method === 'POST') {
        createdComments.push(JSON.parse(init.body).body)
        return new Response(JSON.stringify({ id: 300 }), { status: 201 })
      }
      throw new Error(`Unexpected fetch: ${init.method} ${url}`)
    }

    const res = await runAction({
      env: {
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_REPOSITORY: 'acme/repo',
        'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_999',
        'INPUT_GITHUB-TOKEN': 'ghs_fixture_999',
      },
      payload: {
        action: 'created',
        repository: { owner: { login: 'acme' }, name: 'repo' },
        sender: { login: 'alice', type: 'User' },
        issue: { number: 55, pull_request: { url: 'https://api.github.com/repos/acme/repo/pulls/55' } },
        comment: { id: 12, body: '/megalens deep', user: { login: 'alice', type: 'User' } },
      },
      createGitHubApi: (token) => createGitHubApi(token, { fetchImpl: fakeFetch }),
      runEngine: async (opts) => {
        engineCalls.push(opts)
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          errorMessage: null,
          rawFindings: JSON.stringify({
            schema: 'megalens.findings/v1',
            review_id: 'rv_deep_1',
            tier: 'deep',
            status: 'complete',
            target: { kind: 'range', base: 'base888', head: 'head999', snapshot_sha256: 'abc' },
            passes: [{ name: 'codex-deep', status: 'ok' }],
            findings: [],
          }),
        }
      },
    })

    assert.equal(res.exitCode, 0)
    assert.equal(engineCalls.length, 1)
    assert.equal(engineCalls[0].tier, 'deep')
    assert.equal(engineCalls[0].baseSha, 'base888')
    assert.equal(engineCalls[0].headSha, 'head999')
    assert.ok(fetchCalls.some((c) => c.url.endsWith('/collaborators/alice/permission')))
    assert.equal(createdComments.length, 2)
    assert.ok(createdComments.some((body) => body.startsWith(WALKTHROUGH_MARKER)))
  })

  it('ignores /megalens review from a user with read or none permission', async () => {
    let engineCalled = false
    const summaries = []
    const fakeFetch = async (url) => {
      if (url.endsWith('/collaborators/outsider/permission')) {
        return new Response(JSON.stringify({ permission: 'read' }), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }

    const res = await runAction({
      env: {
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_REPOSITORY: 'acme/repo',
        'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_999',
        'INPUT_GITHUB-TOKEN': 'ghs_fixture_999',
      },
      payload: {
        action: 'created',
        repository: { owner: { login: 'acme' }, name: 'repo' },
        sender: { login: 'outsider', type: 'User' },
        issue: { number: 55, pull_request: {} },
        comment: { id: 13, body: '/megalens review', user: { login: 'outsider', type: 'User' } },
      },
      createGitHubApi: (token) => createGitHubApi(token, { fetchImpl: fakeFetch }),
      runEngine: async () => {
        engineCalled = true
        return { exitCode: 0, stdout: '', stderr: '', errorMessage: null, rawFindings: null }
      },
      writeSummary: (s) => { summaries.push(s) },
    })

    assert.equal(res.exitCode, 0)
    assert.equal(res.status, 'skipped')
    assert.equal(res.reason, 'unauthorized_commenter')
    assert.equal(engineCalled, false)
    assert.match(summaries[0], /does not have write or admin permission/)
  })
})
