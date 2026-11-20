const stripHtmlComments = (text) => text.replace(/<!--[\s\S]*?(?:-->|$)/g, '')

/**
 * Parse a /megalens comment command on its own line (ignoring HTML comments and quoted lines).
 * Supports `/megalens deep`, `/megalens double` (refused while Double is disabled), and `/megalens review`.
 * @param {string | null | undefined} body
 * @returns {'deep' | 'double' | 'review' | null}
 */
export function parseCommentCommand(body) {
  if (typeof body !== 'string' || body.length > 20_000) return null
  for (const line of stripHtmlComments(body).split(/\r?\n/)) {
    const doubleReviewMatch = /^\s*\/megalens\s+review\s+double\s*[.!]?\s*$/i.exec(line)
    if (doubleReviewMatch) return 'double'
    const match = /^\s*\/megalens\s+(deep|double|review)\s*[.!]?\s*$/i.exec(line)
    if (match) return /** @type {'deep' | 'double' | 'review'} */ (match[1].toLowerCase())
  }
  return null
}

/**
 * Whether a GitHub user object represents a bot account.
 * @param {{ login?: string, type?: string } | null | undefined} user
 * @returns {boolean}
 */
export function isBotUser(user) {
  if (!user) return true
  return user.type === 'Bot' || /\[bot\]$/i.test(user.login ?? '')
}

export const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write'])

/**
 * Check repository permission via the GitHub Collaborators Permission API.
 * Never trusts comment author_association alone.
 * @param {{ getCollaboratorPermission(owner: string, repo: string, login: string): Promise<string> }} api
 * @param {string} owner
 * @param {string} repo
 * @param {string} login
 * @returns {Promise<boolean>}
 */
export async function hasWritePermission(api, owner, repo, login) {
  if (!login) return false
  const permission = await api.getCollaboratorPermission(owner, repo, login)
  return WRITE_PERMISSIONS.has(String(permission).toLowerCase())
}
