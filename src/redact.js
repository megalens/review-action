const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /gl(?:pat|cbt|rtr|rt|oas|oa|dt|ptt|ft|imt|agent|soat|ffct|wt)-(?=[A-Za-z0-9_.-]{16,})[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?![A-Za-z0-9_-])/g,
  /GR1348941[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
  /_gitlab_session["']?(?:\s*[:=,]\s*|[ \t]*\t[ \t]*|[ \t]+(?=["']?(?:(?:cell-[0-9]+-)?[0-9a-f]{16,}|(?=[A-Za-z0-9._%~+/=-]{16,})(?=[A-Za-z0-9._%~+/=-]*[0-9])[A-Za-z0-9._%~+/=-]+)))["']?(?=[A-Za-z0-9._%~+:/=-]{16,})[A-Za-z0-9_%~+/=-]+(?:[.:]+[A-Za-z0-9_%~+/=-]+)*/gi,
  /\bml_(?:tok|oat|rk)_[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
  /\bsk-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g,
  /\brk_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:PRIVATE|JOB)-TOKEN:\s*[A-Za-z0-9._~+/=-]{8,}/gi,
]
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:<>"'`]+:[^\s/<>"'`]+@(?=[^\s/<>"'`]+)/gi

// Playwright cookie records can use JSON, Python dictionaries, or JavaScript objects.
// Keep this helper self-contained so the pinned engine can use the same implementation.
export function redactPlaywrightGitLabCookies(text, replacement) {
  if (!text.includes('_gitlab_session')) return text
  const quoted = String.raw`"(?:[^"\\\r\n]|\\[^\r\n])*"|'(?:[^'\\\r\n]|\\[^\r\n])*'`
  const flatObject = new RegExp(String.raw`\{(?:[^{}"'\\]|${quoted})*\}`, 'g')
  const identifier = String.raw`[$_\p{ID_Start}][$\p{ID_Continue}\u200c\u200d]*`
  const field = new RegExp(String.raw`(${quoted}|${identifier})(?:(\s*:\s*)(${quoted}))?`, 'gu')
  const fieldName = (key) => key.replace(/^["']|["']$/g, '')
  return text.replace(flatObject, (object) => {
    if (!object.includes('_gitlab_session')) return object
    // Read strings and identifiers as whole tokens to keep embedded text inert.
    const session = Array.from(object.matchAll(field)).some(([, key, , value]) =>
      fieldName(key) === 'name' && value?.slice(1, -1) === '_gitlab_session',
    )
    if (!session) return object
    return object.replace(field, (match, key, separator, value) => {
      if (fieldName(key) !== 'value' || !value || value.length === 2) return match
      const quote = value[0]
      return `${key}${separator}${quote}${replacement()}${quote}`
    })
  })
}

/**
 * Replace credential-like substrings and any known runtime secrets before logging or posting.
 * @param {string} text
 * @param {string[]} [extraSecrets]
 * @returns {string}
 */
export function redactSecrets(text, extraSecrets = []) {
  let out = redactPlaywrightGitLabCookies(String(text), () => '[redacted]').replace(URL_CREDENTIALS, '$1***@')
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      out = out.split(secret).join('[redacted]')
    }
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[redacted]')
  }
  return out
}

/**
 * Format an unknown error safely for logs or summaries.
 * @param {unknown} err
 * @param {string[]} [extraSecrets]
 * @returns {string}
 */
export function errorText(err, extraSecrets = []) {
  const raw = err instanceof Error ? err.message : String(err)
  return redactSecrets(raw, extraSecrets).slice(0, 500)
}
