import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FORK_SKIP_SUMMARY, isForkPullRequest, runAction } from '../src/action.js'
import { parseCommentCommand } from '../src/commands.js'
import { summaryMarker, WALKTHROUGH_MARKER } from '../src/format.js'
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

describe('same-repository PRs inside a forked repository vs cross-repository fork PRs', () => {
  const baseSha = 'a'.repeat(40)
  const headSha = 'b'.repeat(40)
  const copyBlocks = (body) => [...body.matchAll(/^( *)```\n([\s\S]*?)\n\1```$/gm)]
    .map(([, , contents]) => contents.replace(/^ {2}/gm, ''))
  const findingsRaw = JSON.stringify({
    schema: 'megalens.findings/v1',
    review_id: 'rv_fork_self_1',
    tier: 'standard',
    status: 'complete',
    target: { kind: 'range', base: baseSha, head: headSha },
    passes: [{ name: 'codex-standard', status: 'ok' }],
    findings: [
      {
        id: 'f1',
        file: 'src/x.js',
        line_start: 2,
        line_end: 2,
        title: 'Unused guard',
        claim: 'Guard skips validation on empty input',
        failure_scenario: 'Calling with empty input bypasses the check',
        expected_behavior: 'Reject empty input before returning',
        priority: 'P1',
        strength: 'strong',
      },
    ],
  })

  it('isForkPullRequest distinguishes same-repo PRs inside a fork from cross-repo and deleted-head PRs', () => {
    assert.equal(
      isForkPullRequest({
        base: { repo: { id: 777, full_name: 'alice/my-fork', fork: true } },
        head: { repo: { id: 777, full_name: 'Alice/My-Fork', fork: true } },
      }),
      false,
    )
    assert.equal(
      isForkPullRequest({
        base: { repo: { id: 777, full_name: 'alice/my-fork', fork: true } },
        head: { repo: { id: 888, full_name: 'stranger/my-fork', fork: true } },
      }),
      true,
    )
    assert.equal(
      isForkPullRequest({
        base: { repo: { id: 777, full_name: 'alice/my-fork', fork: false } },
        head: { repo: { id: 888, full_name: 'other/my-fork', fork: false } },
      }),
      true,
    )
    assert.equal(
      isForkPullRequest({
        base: { repo: { id: 777, full_name: 'alice/my-fork', fork: true } },
        head: { repo: null },
      }),
      true,
    )
    assert.equal(
      isForkPullRequest({
        base: { repo: { id: 777, full_name: 'alice/my-fork', fork: true } },
        head: {},
      }),
      true,
    )
    assert.equal(
      isForkPullRequest({
        base: { repo: { id: 777 } },
        head: { repo: { full_name: 'stranger/my-fork', fork: false } },
      }),
      true,
    )
  })

  it('pull_request create and publish run normally for same-repo PRs in a forked repo and still skip cross-repo or deleted-head PRs', async () => {
    let createdArgs = null
    const sameRepoForkPayload = {
      action: 'opened',
      repository: { owner: { login: 'alice' }, name: 'my-fork', full_name: 'alice/my-fork', fork: true },
      pull_request: {
        number: 12,
        state: 'open',
        base: { sha: baseSha, repo: { id: 777, full_name: 'alice/my-fork', fork: true } },
        head: { sha: headSha, repo: { id: 777, full_name: 'alice/my-fork', fork: true } },
      },
    }

    const createRes = await runAction({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'alice/my-fork',
        INPUT_MODE: 'create',
        'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_1234',
      },
      payload: sameRepoForkPayload,
      createReview: async (opts) => {
        createdArgs = opts
        return { reviewId: 'rv_fork_self_1', reviewKey: 'ml_rk_fixture_1234' }
      },
    })
    assert.equal(createRes.status, 'complete')
    assert.equal(createdArgs.repo, 'alice/my-fork')

    // Cross-repo PR and deleted head repo still skip cleanly on pull_request.
    for (const badHeadRepo of [
      { id: 888, full_name: 'stranger/my-fork', fork: true },
      null,
    ]) {
      let called = false
      const skipRes = await runAction({
        env: {
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_REPOSITORY: 'alice/my-fork',
          INPUT_MODE: 'create',
          'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_1234',
        },
        payload: {
          ...sameRepoForkPayload,
          pull_request: {
            ...sameRepoForkPayload.pull_request,
            head: { sha: headSha, repo: badHeadRepo },
          },
        },
        createReview: async () => {
          called = true
          return { reviewId: 'never', reviewKey: 'never' }
        },
      })
      assert.equal(skipRes.status, 'skipped')
      assert.equal(skipRes.reason, 'fork_pr')
      assert.equal(called, false)
    }

    // Real GitHub adapter on pull_request publish fills both inline and summary prompts for OWNER.
    const postedReviews = []
    const postedComments = []
    const fakeFetch = async (url, init) => {
      if (url.endsWith('/user')) return Response.json({ login: 'github-actions[bot]' })
      if (url.endsWith('/pulls/12')) {
        return Response.json({
          state: 'open',
          draft: false,
          author_association: 'OWNER',
          base: { sha: baseSha, repo: { id: 777, full_name: 'alice/my-fork', fork: true } },
          head: { sha: headSha, repo: { id: 777, full_name: 'alice/my-fork', fork: true } },
        })
      }
      if (url.includes('/pulls/12/files')) return Response.json([{ filename: 'src/x.js', status: 'modified', patch: PATCH }])
      if (url.includes('/pulls/12/comments')) return Response.json([])
      if (url.includes('/pulls/12/reviews') && init.method === 'POST') {
        postedReviews.push(...JSON.parse(init.body).comments)
        return Response.json({ id: 501 }, { status: 201 })
      }
      if (url.includes('/issues/12/comments') && init.method === 'GET') return Response.json([])
      if (url.includes('/issues/12/comments') && init.method === 'POST') {
        postedComments.push(JSON.parse(init.body).body)
        return Response.json({ id: 600 + postedComments.length }, { status: 201 })
      }
      throw new Error(`Unexpected fetch: ${init.method} ${url}`)
    }

    const pubRes = await runAction({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'alice/my-fork',
        INPUT_MODE: 'publish',
        'INPUT_GITHUB-TOKEN': 'ghs_fixture_token',
      },
      payload: sameRepoForkPayload,
      createGitHubApi: (token) => createGitHubApi(token, { fetchImpl: fakeFetch }),
      readFindingsImpl: async () => findingsRaw,
      outPath: '/tmp/findings.json',
    })
    assert.equal(pubRes.status, 'complete')
    assert.equal(postedReviews.length, 1)
    const [inlinePrompt] = copyBlocks(postedReviews[0].body)
    const summaryBody = postedComments.find((b) => b.startsWith(summaryMarker('standard')))
    const [summaryPrompt] = copyBlocks(summaryBody)
    assert.match(inlinePrompt, /^Fix this bug in "src\/x\.js" \(line 2\)\./)
    assert.equal(summaryPrompt, inlinePrompt)
  })

  it('issue_comment with real GitHub adapter fills prompts for same-repo PRs in a forked repo and isolates cross-repo/deleted-head PRs', async () => {
    const issueCommentPayload = {
      action: 'created',
      repository: { owner: { login: 'alice' }, name: 'my-fork', full_name: 'alice/my-fork', fork: true },
      sender: { login: 'alice', type: 'User' },
      issue: { number: 12, pull_request: {} },
      comment: { id: 99, body: '/megalens review', user: { login: 'alice', type: 'User' } },
    }

    const runPublishWithHeadRepo = async (headRepo) => {
      const postedReviews = []
      const postedComments = []
      const fakeFetch = async (url, init) => {
        if (url.endsWith('/user')) return Response.json({ login: 'github-actions[bot]' })
        if (url.endsWith('/pulls/12')) {
          return Response.json({
            state: 'open',
            draft: false,
            author_association: 'OWNER',
            base: { sha: baseSha, repo: { id: 777, full_name: 'alice/my-fork', fork: true } },
            head: { sha: headSha, repo: headRepo },
          })
        }
        if (url.includes('/pulls/12/files')) return Response.json([{ filename: 'src/x.js', status: 'modified', patch: PATCH }])
        if (url.includes('/pulls/12/comments')) return Response.json([])
        if (url.includes('/pulls/12/reviews') && init.method === 'POST') {
          postedReviews.push(...JSON.parse(init.body).comments)
          return Response.json({ id: 501 }, { status: 201 })
        }
        if (url.includes('/issues/12/comments') && init.method === 'GET') return Response.json([])
        if (url.includes('/issues/12/comments') && init.method === 'POST') {
          postedComments.push(JSON.parse(init.body).body)
          return Response.json({ id: 600 + postedComments.length }, { status: 201 })
        }
        throw new Error(`Unexpected fetch: ${init.method} ${url}`)
      }
      const res = await runAction({
        env: {
          GITHUB_EVENT_NAME: 'issue_comment',
          GITHUB_REPOSITORY: 'alice/my-fork',
          INPUT_MODE: 'publish',
          'INPUT_HEAD-SHA': headSha,
          'INPUT_GITHUB-TOKEN': 'ghs_fixture_token',
        },
        payload: issueCommentPayload,
        createGitHubApi: (token) => createGitHubApi(token, { fetchImpl: fakeFetch }),
        readFindingsImpl: async () => findingsRaw,
        outPath: '/tmp/findings.json',
      })
      return { res, postedReviews, postedComments }
    }

    // Same-repo PR in a forked repo -> filled prompts in both inline and summary (publish and full modes).
    const sameRepo = await runPublishWithHeadRepo({ id: 777, full_name: 'alice/my-fork', fork: true })
    assert.equal(sameRepo.res.status, 'complete')
    const [inlineFilled] = copyBlocks(sameRepo.postedReviews[0].body)
    const [summaryFilled] = copyBlocks(sameRepo.postedComments.find((b) => b.startsWith(summaryMarker('standard'))))
    assert.match(inlineFilled, /^Fix this bug in "src\/x\.js" \(line 2\)\./)
    assert.equal(summaryFilled, inlineFilled)

    const fullReviews = []
    const fullComments = []
    const fullSameRepoRes = await runAction({
      env: {
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_REPOSITORY: 'alice/my-fork',
        INPUT_MODE: 'full',
        'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_1234',
        'INPUT_GITHUB-TOKEN': 'ghs_fixture_token',
      },
      payload: issueCommentPayload,
      createGitHubApi: (token) => createGitHubApi(token, {
        fetchImpl: async (url, init) => {
          if (url.endsWith('/user')) return Response.json({ login: 'github-actions[bot]' })
          if (url.endsWith('/collaborators/alice/permission')) return Response.json({ permission: 'admin' })
          if (url.endsWith('/pulls/12')) {
            return Response.json({
              state: 'open',
              draft: false,
              author_association: 'OWNER',
              base: { sha: baseSha, repo: { id: 777, full_name: 'alice/my-fork', fork: true } },
              head: { sha: headSha, repo: { id: 777, full_name: 'alice/my-fork', fork: true } },
            })
          }
          if (url.includes('/pulls/12/files')) return Response.json([{ filename: 'src/x.js', status: 'modified', patch: PATCH }])
          if (url.includes('/pulls/12/comments')) return Response.json([])
          if (url.includes('/pulls/12/reviews') && init.method === 'POST') {
            fullReviews.push(...JSON.parse(init.body).comments)
            return Response.json({ id: 511 }, { status: 201 })
          }
          if (url.includes('/issues/12/comments') && init.method === 'GET') return Response.json([])
          if (url.includes('/issues/12/comments') && init.method === 'POST') {
            fullComments.push(JSON.parse(init.body).body)
            return Response.json({ id: 610 + fullComments.length }, { status: 201 })
          }
          throw new Error(`Unexpected fetch: ${init.method} ${url}`)
        },
      }),
      runEngine: async () => ({ exitCode: 0, stdout: '', stderr: '', errorMessage: null, rawFindings: findingsRaw }),
    })
    assert.equal(fullSameRepoRes.status, 'complete')
    assert.equal(fullReviews.length, 1)
    assert.equal(copyBlocks(fullReviews[0].body)[0], inlineFilled)
    assert.equal(copyBlocks(fullComments.find((b) => b.startsWith(summaryMarker('standard'))))[0], inlineFilled)

    // Cross-repo fork PR and deleted head repo -> placeholder template only, and full mode refuses.
    for (const untrustedHeadRepo of [
      { id: 888, full_name: 'stranger/my-fork', fork: true },
      null,
    ]) {
      const crossRepo = await runPublishWithHeadRepo(untrustedHeadRepo)
      assert.equal(crossRepo.res.status, 'complete')
      const [inlinePlaceholder] = copyBlocks(crossRepo.postedReviews[0].body)
      const [summaryPlaceholder] = copyBlocks(crossRepo.postedComments.find((b) => b.startsWith(summaryMarker('standard'))))
      assert.match(inlinePlaceholder, /Check \[file and lines\]/)
      assert.equal(summaryPlaceholder, inlinePlaceholder)

      const fullRes = await runAction({
        env: {
          GITHUB_EVENT_NAME: 'issue_comment',
          GITHUB_REPOSITORY: 'alice/my-fork',
          INPUT_MODE: 'full',
          'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_1234',
          'INPUT_GITHUB-TOKEN': 'ghs_fixture_token',
        },
        payload: issueCommentPayload,
        createGitHubApi: (token) => createGitHubApi(token, {
          fetchImpl: async (url) => {
            if (url.endsWith('/collaborators/alice/permission')) return Response.json({ permission: 'admin' })
            if (url.endsWith('/pulls/12')) {
              return Response.json({
                state: 'open',
                draft: false,
                base: { sha: baseSha, repo: { id: 777, full_name: 'alice/my-fork', fork: true } },
                head: { sha: headSha, repo: untrustedHeadRepo },
              })
            }
            throw new Error(`Unexpected fetch: ${url}`)
          },
        }),
        runEngine: async () => { assert.fail('full mode must not run engine on cross-repo or deleted-head PR') },
      })
      assert.equal(fullRes.status, 'skipped')
      assert.equal(fullRes.reason, 'fork_full_refused')
    }
  })
})
