const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bml_(?:tok|oat|rk)_[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
]

/**
 * Replace credential-like substrings and any known runtime secrets before logging or posting.
 * @param {string} text
 * @param {string[]} [extraSecrets]
 * @returns {string}
 */
export function redactSecrets(text, extraSecrets = []) {
  let out = String(text)
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
