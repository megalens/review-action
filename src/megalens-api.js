import { redactSecrets } from './redact.js'

export const DEFAULT_MEGALENS_API_URL = 'https://megalens.ai'

export class MegaLensApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {string | null} [code]
   */
  constructor(status, message, code = null) {
    super(message)
    this.name = 'MegaLensApiError'
    this.status = status
    this.code = code
  }
}

/**
 * Validate MegaLens API base URL (HTTPS required, except localhost/127.0.0.1 for local tests).
 * @param {string} rawUrl
 * @returns {string}
 */
export function normalizeApiUrl(rawUrl) {
  const value = String(rawUrl || DEFAULT_MEGALENS_API_URL).trim().replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Invalid MegaLens API URL: "${value}".`)
  }
  const isLocalHttp =
    parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    throw new Error(`Unsafe MegaLens API URL "${value}": HTTPS is required.`)
  }
  return value
}

/**
 * Create a server-owned review via POST /api/v2/reviews.
 * Sends only repo, base_sha, head_sha, and tier (contract section 6).
 * @param {{
 *   apiUrl?: string,
 *   token: string,
 *   repo: string,
 *   baseSha: string,
 *   headSha: string,
 *   tier: string,
 * }} opts
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<{ reviewId: string, reviewKey: string }>}
 */
export async function createMegaLensReview(opts, deps = {}) {
  const token = typeof opts?.token === 'string' ? opts.token.trim() : ''
  if (!token) {
    throw new Error('Missing megalens-token: create mode requires megalens-token.')
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  const baseUrl = normalizeApiUrl(opts.apiUrl || DEFAULT_MEGALENS_API_URL)

  const res = await fetchImpl(`${baseUrl}/api/v2/reviews`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'MegaLens-GitHub-Action',
    },
    body: JSON.stringify({
      repo: opts.repo,
      base_sha: opts.baseSha,
      head_sha: opts.headSha,
      tier: opts.tier,
    }),
  })

  if (!res.ok) {
    let bodyJson = null
    try {
      bodyJson = await res.json()
    } catch {
      bodyJson = null
    }
    const code = typeof bodyJson?.code === 'string'
      ? bodyJson.code
      : typeof bodyJson?.error === 'string'
        ? bodyJson.error
        : null
    const rawMsg = typeof bodyJson?.message === 'string' ? bodyJson.message : ''
    const detail = redactSecrets(rawMsg, [token]).slice(0, 200)

    if (res.status === 403 && (code === 'notice_required' || /notice_required/i.test(rawMsg))) {
      throw new MegaLensApiError(
        403,
        'MegaLens create review refused (403 notice_required): accept the current data-flow notice on your MegaLens account before running reviews.',
        'notice_required',
      )
    }

    throw new MegaLensApiError(
      res.status,
      redactSecrets(
        `MegaLens create review failed: HTTP ${res.status}${detail ? ` (${detail})` : ''}`,
        [token],
      ),
      code,
    )
  }

  const data = await res.json()
  const reviewId = typeof data?.review_id === 'string' ? data.review_id.trim() : ''
  const reviewKey = typeof data?.review_key === 'string' ? data.review_key.trim() : ''
  if (!reviewId || !reviewKey) {
    throw new MegaLensApiError(502, 'MegaLens create review response missing review_id or review_key.')
  }
  return { reviewId, reviewKey }
}
