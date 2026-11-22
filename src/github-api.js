import { redactSecrets } from './redact.js'

export class GitHubApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(redactSecrets(message))
    this.name = 'GitHubApiError'
    this.status = status
  }
}

/**
 * Create a lightweight GitHub REST API client using Node 20 built-in fetch.
 * @param {string} token
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, viewerLogin?: string }} [opts]
 */
export function createGitHubApi(token, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  /** @type {Promise<string> | null} */
  let cachedLoginPromise = null

  async function call(method, path, body) {
    return fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'MegaLens-GitHub-Action',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function fail(res, what) {
    let reason = ''
    try {
      const json = await res.json()
      if (json && typeof json.message === 'string' && json.message.length <= 200) {
        reason = json.message
      }
    } catch {
      // Ignore non-JSON error responses.
    }
    throw new GitHubApiError(res.status, `GitHub ${what} failed: HTTP ${res.status}${reason ? ` (${reason})` : ''}`)
  }

  const repoPath = (owner, repo) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`

  async function resolveViewerLogin() {
    if (typeof opts.viewerLogin === 'string' && opts.viewerLogin.trim()) {
      return opts.viewerLogin.trim()
    }
    const userRes = await call('GET', '/user')
    if (userRes.ok) {
      const data = await userRes.json()
      if (typeof data?.login === 'string' && data.login) {
        return data.login
      }
    } else if (userRes.status !== 401 && userRes.status !== 403 && userRes.status !== 404) {
      return fail(userRes, 'read authenticated user')
    }

    const appRes = await call('GET', '/app')
    if (appRes.ok) {
      const data = await appRes.json()
      if (typeof data?.slug === 'string' && data.slug) {
        return `${data.slug}[bot]`
      }
      if (typeof data?.login === 'string' && data.login) {
        return data.login
      }
    } else if (appRes.status !== 401 && appRes.status !== 403 && appRes.status !== 404) {
      return fail(appRes, 'read authenticated app')
    }

    return 'github-actions[bot]'
  }

  async function getViewerLogin() {
    if (!cachedLoginPromise) {
      cachedLoginPromise = resolveViewerLogin().catch((err) => {
        cachedLoginPromise = null
        throw err
      })
    }
    return cachedLoginPromise
  }

  async function findSummaryCommentDetails(owner, repo, issueNumber, marker, viewerLogin) {
    const ownLogin = (viewerLogin || await getViewerLogin()).toLowerCase()
    for (let page = 1; ; page++) {
      const res = await call('GET', `${repoPath(owner, repo)}/issues/${issueNumber}/comments?per_page=100&page=${page}`)
      if (!res.ok) return fail(res, 'list issue comments')
      const batch = await res.json()
      if (!Array.isArray(batch)) break
      const hit = batch.find(
        (c) =>
          typeof c?.id === 'number' &&
          typeof c?.user?.login === 'string' &&
          c.user.login.toLowerCase() === ownLogin &&
          typeof c?.body === 'string' &&
          (c.body === marker || c.body.startsWith(`${marker}\n`)),
      )
      if (hit) {
        return {
          id: hit.id,
          body: hit.body,
          createdAt: hit.created_at ?? null,
          updatedAt: hit.updated_at ?? null,
        }
      }
      if (batch.length < 100) break
    }
    return null
  }

  return {
    getViewerLogin,

    async getPull(owner, repo, pullNumber) {
      const res = await call('GET', `${repoPath(owner, repo)}/pulls/${pullNumber}`)
      if (!res.ok) return fail(res, 'read pull request')
      const data = await res.json()
      if (typeof data?.head?.sha !== 'string' || typeof data?.base?.sha !== 'string') {
        throw new GitHubApiError(502, 'GitHub pull request response missing head or base sha')
      }
      return {
        number: pullNumber,
        open: data.state === 'open',
        draft: data.draft === true,
        headSha: data.head.sha,
        baseSha: data.base.sha,
        headRepoFullName: data.head?.repo?.full_name ?? null,
        baseRepoFullName: data.base?.repo?.full_name ?? null,
        isFork: Boolean(data.head?.repo?.fork) || (
          Boolean(data.base?.repo?.full_name) && data.head?.repo?.full_name !== data.base?.repo?.full_name
        ),
      }
    },

    async listPullFiles(owner, repo, pullNumber, maxPages = 30) {
      const files = []
      for (let page = 1; page <= maxPages; page++) {
        const res = await call('GET', `${repoPath(owner, repo)}/pulls/${pullNumber}/files?per_page=100&page=${page}`)
        if (!res.ok) return fail(res, 'list pull files')
        const batch = await res.json()
        if (!Array.isArray(batch)) break
        files.push(...batch)
        if (batch.length < 100) break
      }
      return files
    },

    async getCollaboratorPermission(owner, repo, login) {
      const res = await call(
        'GET',
        `${repoPath(owner, repo)}/collaborators/${encodeURIComponent(login)}/permission`,
      )
      if (res.status === 403 || res.status === 404) return 'none'
      if (!res.ok) return fail(res, 'read collaborator permission')
      const data = await res.json()
      return typeof data?.permission === 'string' ? data.permission : 'none'
    },

    findSummaryCommentDetails,

    async findSummaryComment(owner, repo, issueNumber, marker, viewerLogin) {
      const hit = await findSummaryCommentDetails(owner, repo, issueNumber, marker, viewerLogin)
      return hit ? hit.id : null
    },

    async createIssueComment(owner, repo, issueNumber, body) {
      const res = await call('POST', `${repoPath(owner, repo)}/issues/${issueNumber}/comments`, { body })
      if (!res.ok) return fail(res, 'create issue comment')
      const data = await res.json()
      if (typeof data?.id !== 'number') {
        throw new GitHubApiError(502, 'GitHub create comment returned no id')
      }
      return data.id
    },

    async updateIssueComment(owner, repo, commentId, body) {
      const res = await call('PATCH', `${repoPath(owner, repo)}/issues/comments/${commentId}`, { body })
      if (!res.ok) return fail(res, 'update issue comment')
    },

    async listPullReviewComments(owner, repo, pullNumber, maxPages = 10) {
      const comments = []
      for (let page = 1; page <= maxPages; page++) {
        const res = await call('GET', `${repoPath(owner, repo)}/pulls/${pullNumber}/comments?per_page=100&page=${page}`)
        if (!res.ok) return fail(res, 'list pull review comments')
        const batch = await res.json()
        if (!Array.isArray(batch)) break
        comments.push(...batch)
        if (batch.length < 100) break
      }
      return comments
    },

    async createPullReview(owner, repo, pullNumber, commitId, comments) {
      const res = await call('POST', `${repoPath(owner, repo)}/pulls/${pullNumber}/reviews`, {
        commit_id: commitId,
        event: 'COMMENT',
        body: '',
        comments,
      })
      if (!res.ok) return fail(res, 'create pull request review')
      const data = await res.json()
      return typeof data?.id === 'number' ? data.id : null
    },
  }
}
