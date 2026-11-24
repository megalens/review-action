import { redactSecrets } from './redact.js'

export const DEFAULT_GITLAB_API_URL = 'https://gitlab.com/api/v4'

export class GitLabApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(redactSecrets(message))
    this.name = 'GitLabApiError'
    this.status = status
  }
}

/**
 * Validate GitLab API v4 base URL (HTTPS required; loopback HTTP only when explicitly enabled for local tests).
 * @param {string} [rawUrl]
 * @param {{ allowLocalHttp?: boolean }} [opts]
 * @returns {string}
 */
export function normalizeGitLabApiUrl(rawUrl, opts = {}) {
  const value = String(rawUrl ?? DEFAULT_GITLAB_API_URL).trim().replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Invalid GitLab API URL.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Unsafe GitLab API URL: credentials in URL are not allowed.')
  }
  const isLocalHttp =
    opts.allowLocalHttp === true
    && parsed.protocol === 'http:'
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('Unsafe GitLab API URL: HTTPS is required.')
  }
  if (!/^(?:\/[A-Za-z0-9._-]+)*\/api\/v4$/.test(parsed.pathname) || /[?#\\]/.test(value)) {
    throw new Error('Invalid GitLab API URL: expected a base URL ending in /api/v4.')
  }
  return `${parsed.origin}${parsed.pathname}`
}

/**
 * Lightweight GitLab REST API v4 client using Node 20 built-in fetch.
 * Uses a Project Access Token (`PRIVATE-TOKEN` header, `api` scope on the project).
 *
 * @param {string} token
 * @param {{ fetchImpl?: typeof fetch, baseUrl?: string, viewerUsername?: string, allowLocalHttp?: boolean, requireViewer?: boolean }} [opts]
 */
export function createGitLabApi(token, opts = {}) {
  const cleanToken = typeof token === 'string' ? token.trim() : ''
  if (!cleanToken) {
    throw new Error('Missing MEGALENS_GITLAB_TOKEN for GitLab API access.')
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  const baseUrl = normalizeGitLabApiUrl(opts.baseUrl, {
    allowLocalHttp: opts.allowLocalHttp === true,
  })
  /** @type {Promise<string | null> | null} */
  let cachedUsernamePromise = null

  async function call(method, path, body) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      redirect: 'error',
      headers: {
        'PRIVATE-TOKEN': cleanToken,
        Accept: 'application/json',
        'User-Agent': 'MegaLens-GitLab-CI',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (res.status >= 300 && res.status < 400) {
      throw new GitLabApiError(
        res.status,
        'GitLab API returned an HTTP redirect; refusing to follow redirects with PRIVATE-TOKEN.',
      )
    }
    return res
  }

  async function fail(res, what) {
    let reason = ''
    try {
      const json = await res.json()
      const msg = typeof json?.message === 'string'
        ? json.message
        : typeof json?.error === 'string'
          ? json.error
          : json?.message && typeof json.message === 'object'
            ? JSON.stringify(json.message)
            : ''
      if (msg) {
        reason = redactSecrets(msg, [cleanToken]).slice(0, 200)
      }
    } catch {
      // Ignore non-JSON error responses.
    }
    throw new GitLabApiError(
      res.status,
      redactSecrets(`GitLab ${what} failed: HTTP ${res.status}${reason ? ` (${reason})` : ''}`, [cleanToken]),
    )
  }

  const projectPath = (projectId) => `/projects/${encodeURIComponent(String(projectId))}`

  async function resolveViewerUsername() {
    if (typeof opts.viewerUsername === 'string' && opts.viewerUsername.trim()) {
      return opts.viewerUsername.trim()
    }
    const res = await call('GET', '/user')
    if (res.ok) {
      const data = await res.json()
      if (typeof data?.username === 'string' && data.username.trim()) {
        return data.username.trim()
      }
    } else if (res.status !== 401 && res.status !== 403 && res.status !== 404) {
      return fail(res, 'read authenticated user')
    }
    return null
  }

  async function getViewerUsername() {
    if (!cachedUsernamePromise) {
      cachedUsernamePromise = resolveViewerUsername().catch((err) => {
        cachedUsernamePromise = null
        throw err
      })
    }
    return cachedUsernamePromise
  }

  async function findSummaryNoteDetails(projectId, mrIid, marker, viewerUsername) {
    const resolvedOwn = viewerUsername ?? await getViewerUsername()
    const ownUser = typeof resolvedOwn === 'string' && resolvedOwn.trim()
      ? resolvedOwn.trim().toLowerCase()
      : null
    if (!ownUser) {
      if (opts.requireViewer) {
        throw new GitLabApiError(502, 'Could not identify the GitLab bot user for review deduplication.')
      }
      return null
    }

    for (let page = 1; page <= 10; page++) {
      const res = await call(
        'GET',
        `${projectPath(projectId)}/merge_requests/${encodeURIComponent(String(mrIid))}/notes?per_page=100&page=${page}&sort=desc&order_by=updated_at`,
      )
      if (!res.ok) return fail(res, 'list merge request notes')
      const batch = await res.json()
      if (!Array.isArray(batch)) break
      const hit = batch.find(
        (n) =>
          typeof n?.id === 'number'
          && n?.system !== true
          && typeof n?.author?.username === 'string'
          && n.author.username.toLowerCase() === ownUser
          && typeof n?.body === 'string'
          && n.body.includes(marker),
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
    getViewerUsername,

    async getMergeRequest(projectId, mrIid) {
      const res = await call(
        'GET',
        `${projectPath(projectId)}/merge_requests/${encodeURIComponent(String(mrIid))}`,
      )
      if (!res.ok) return fail(res, 'read merge request')
      const data = await res.json()
      const headSha = typeof data?.diff_refs?.head_sha === 'string' && data.diff_refs.head_sha
        ? data.diff_refs.head_sha
        : typeof data?.sha === 'string'
          ? data.sha
          : ''
      const baseSha = typeof data?.diff_refs?.base_sha === 'string' ? data.diff_refs.base_sha : ''
      const startSha = typeof data?.diff_refs?.start_sha === 'string' ? data.diff_refs.start_sha : ''
      if (!headSha) {
        throw new GitLabApiError(502, 'GitLab merge request response missing head sha')
      }
      const sourceProjectId = data?.source_project_id != null ? String(data.source_project_id) : null
      const targetProjectId = data?.target_project_id != null ? String(data.target_project_id) : null
      return {
        iid: Number(mrIid),
        open: data.state === 'opened',
        draft: Boolean(data.draft || data.work_in_progress),
        headSha,
        baseSha,
        startSha,
        sourceProjectId,
        targetProjectId,
        isFork: Boolean(sourceProjectId && targetProjectId && sourceProjectId !== targetProjectId),
      }
    },

    async listMergeRequestDiffs(projectId, mrIid, maxPages = 30) {
      const diffs = []
      for (let page = 1; page <= maxPages; page++) {
        const res = await call(
          'GET',
          `${projectPath(projectId)}/merge_requests/${encodeURIComponent(String(mrIid))}/diffs?per_page=100&page=${page}`,
        )
        if (page === 1 && res.status === 404) {
          // Compatibility fallback for older self-hosted GitLab (< 15.7) without paginated /diffs.
          const legacyRes = await call(
            'GET',
            `${projectPath(projectId)}/merge_requests/${encodeURIComponent(String(mrIid))}/changes`,
          )
          if (!legacyRes.ok) return fail(legacyRes, 'list merge request changes')
          const legacyData = await legacyRes.json()
          return Array.isArray(legacyData?.changes) ? legacyData.changes : []
        }
        if (!res.ok) return fail(res, 'list merge request diffs')
        const batch = await res.json()
        if (!Array.isArray(batch)) break
        diffs.push(...batch)
        if (batch.length < 100) break
      }
      return diffs
    },

    findSummaryNoteDetails,

    async findSummaryNote(projectId, mrIid, marker, viewerUsername) {
      const hit = await findSummaryNoteDetails(projectId, mrIid, marker, viewerUsername)
      return hit ? hit.id : null
    },

    async createMergeRequestNote(projectId, mrIid, body) {
      const res = await call(
        'POST',
        `${projectPath(projectId)}/merge_requests/${encodeURIComponent(String(mrIid))}/notes`,
        { body },
      )
      if (!res.ok) return fail(res, 'create merge request note')
      const data = await res.json()
      if (typeof data?.id !== 'number') {
        throw new GitLabApiError(502, 'GitLab create note returned no id')
      }
      return data.id
    },

    async updateMergeRequestNote(projectId, mrIid, noteId, body) {
      const res = await call(
        'PUT',
        `${projectPath(projectId)}/merge_requests/${encodeURIComponent(String(mrIid))}/notes/${encodeURIComponent(String(noteId))}`,
        { body },
      )
      if (!res.ok) return fail(res, 'update merge request note')
    },

    async listMergeRequestDiscussions(projectId, mrIid, maxPages = 10) {
      const discussions = []
      for (let page = 1; page <= maxPages; page++) {
        const res = await call(
          'GET',
          `${projectPath(projectId)}/merge_requests/${encodeURIComponent(String(mrIid))}/discussions?per_page=100&page=${page}`,
        )
        if (!res.ok) return fail(res, 'list merge request discussions')
        const batch = await res.json()
        if (!Array.isArray(batch)) break
        discussions.push(...batch)
        if (batch.length < 100) break
      }
      return discussions
    },

    async createMergeRequestDiscussion(projectId, mrIid, body, position) {
      const res = await call(
        'POST',
        `${projectPath(projectId)}/merge_requests/${encodeURIComponent(String(mrIid))}/discussions`,
        { body, position },
      )
      if (!res.ok) return fail(res, 'create merge request discussion')
      const data = await res.json()
      return typeof data?.id === 'string' || typeof data?.id === 'number' ? String(data.id) : null
    },
  }
}
