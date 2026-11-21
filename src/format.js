import { createHash } from 'node:crypto'
import { redactSecrets } from './redact.js'

export const MAX_SUMMARY_LENGTH = 65_000
export const MAX_INLINE_COMMENTS = 25

/**
 * Tier-scoped summary comment marker per F9 (`<!-- megalens:review:v1:<tier> -->`).
 * @param {string} [tier]
 * @returns {string}
 */
export function summaryMarker(tier = 'standard') {
  const safeTier = String(tier || 'standard').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'standard'
  return `<!-- megalens:review:v1:${safeTier} -->`
}

export const SUMMARY_MARKER = summaryMarker('standard')

/**
 * Hidden metadata line embedded in the summary comment to support burst guard per head+tier.
 * @param {string} headSha
 * @param {string} [tier]
 * @param {string | null} [status]
 * @param {number | null} [ts]
 * @returns {string}
 */
export function summaryMetaMarker(headSha, tier = 'standard', status = null, ts = null) {
  const safeSha = String(headSha || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'unknown'
  const safeTier = String(tier || 'standard').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'standard'
  const safeStatus = typeof status === 'string'
    ? status.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    : ''
  const parts = [`head=${safeSha}`, `tier=${safeTier}`]
  if (safeStatus) parts.push(`status=${safeStatus}`)
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) parts.push(`ts=${Math.trunc(ts)}`)
  return `<!-- megalens:meta ${parts.join(' ')} -->`
}

/**
 * Parse tier, head SHA, status, and timestamp metadata from an existing summary comment body.
 * @param {string | null | undefined} body
 * @returns {{ tier: string | null, headSha: string | null, status: string | null, ts: number | null } | null}
 */
export function parseSummaryMeta(body) {
  if (typeof body !== 'string') return null
  const markerMatch = /<!--\s*megalens:review:v1:([a-z0-9_-]+)\s*-->/i.exec(body)
  const metaMatch = /<!--\s*megalens:meta\s+([^>]+?)\s*-->/i.exec(body)
  if (!markerMatch && !metaMatch) return null
  /** @type {Record<string, string>} */
  const attrs = {}
  if (metaMatch) {
    for (const part of metaMatch[1].trim().split(/\s+/)) {
      const eq = part.indexOf('=')
      if (eq > 0) {
        attrs[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1)
      }
    }
  }
  const tsNum = attrs.ts !== undefined ? Number(attrs.ts) : NaN
  return {
    tier: (attrs.tier ?? markerMatch?.[1] ?? '').toLowerCase() || null,
    headSha: attrs.head ? attrs.head.toLowerCase() : null,
    status: attrs.status ? attrs.status.toLowerCase() : null,
    ts: Number.isFinite(tsNum) && tsNum > 0 ? tsNum : null,
  }
}

/**
 * Short sha256 prefix of a normalized finding title for stable deduplication.
 * @param {string} title
 * @returns {string}
 */
export function titleHash(title) {
  const normalized = String(title ?? '').trim().replace(/\s+/g, ' ')
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/**
 * Hidden marker embedded in each inline review comment using stable finding identity
 * (file + line range + sha256(title) prefix).
 * @param {{ file: string, line_start: number, line_end?: number, title: string }} finding
 * @returns {string}
 */
export function inlineMarker(finding) {
  const file = encodeURIComponent(String(finding?.file ?? '')).replace(/--/g, '%2D%2D')
  const start = Number(finding?.line_start) || 0
  const end = finding?.line_end && finding.line_end >= start ? Number(finding.line_end) : start
  const hash = titleHash(finding?.title ?? '')
  return `<!-- megalens-review:v1 file=${file} lines=${start}-${end} title=${hash} -->`
}

/**
 * Extract stable identity (file, lineStart, lineEnd, titleSha) from a MegaLens Action or App
 * inline review comment marker, if present.
 * @param {string | null | undefined} body
 * @returns {{ file: string, lineStart: number, lineEnd: number, titleSha: string, source: 'action' | 'app' } | null}
 */
export function parseInlineMarker(body) {
  if (typeof body !== 'string') return null
  const match =
    /<!--\s*(megalens-review:v1|megalens(?::|-)app:v1|megalens:review:v1)\s+file=([^\s]+)\s+lines?=(\d+)(?:-(\d+))?\s+title=([0-9a-f]{8,64})\s*-->/i.exec(
      body,
    )
  if (!match) return null
  const source = match[1].toLowerCase().includes('app') ? 'app' : 'action'
  let file = match[2]
  try {
    file = decodeURIComponent(file)
  } catch {
    // Keep raw token if percent-encoding was malformed.
  }
  const lineStart = Number(match[3])
  const lineEnd = match[4] ? Number(match[4]) : lineStart
  const titleSha = match[5].toLowerCase()
  if (!Number.isInteger(lineStart) || lineStart <= 0 || !Number.isInteger(lineEnd) || lineEnd < lineStart) {
    return null
  }
  return { file, lineStart, lineEnd, titleSha, source }
}

/**
 * Cut at a sentence end in the second half of the budget, else at a word boundary,
 * ending with a single ellipsis without double punctuation.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function clip(text, max) {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  if (sentence >= max / 2) return head.slice(0, sentence + 1)
  const space = head.lastIndexOf(' ')
  const cut = space >= max / 2 ? head.slice(0, space) : head
  return cut.replace(/[\s.,;:!?-]+$/, '') + '…'
}

/**
 * Sanitize model or PR text for safe markdown comment rendering:
 * - redacts secrets
 * - optionally collapses newlines (for titles/single-line fields)
 * - escapes &, <, > (prevents raw HTML and HTML comments)
 * - neutralises @mentions, fenced code block breakouts, image/link embeds (![ and ](),
 *   reference-style links (][ and ]:), bare URL/www/mailto auto-linking, #N / owner/repo#N
 *   issue cross-references, and leading /commands on any line.
 * @param {string} text
 * @param {number} max
 * @param {{ singleLine?: boolean, extraSecrets?: string[] }} [opts]
 * @returns {string}
 */
export function sanitizeText(text, max, opts = {}) {
  let safe = redactSecrets(String(text ?? ''), opts.extraSecrets).replace(/\r/g, '')
  if (opts.singleLine) {
    safe = safe.replace(/\s*\n+\s*/g, ' ').trim()
  }
  safe = safe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b')
    .replace(/```/g, "'''")
    .replace(/!\[/g, '!\u200b[')
    .replace(/\]\(/g, ']\u200b(')
    .replace(/\]\[/g, ']\u200b[')
    .replace(/\]:/g, ']\u200b:')
    .replace(/:\/\//g, '://\u200b')
    .replace(/\b(www\.)/gi, '$1\u200b')
    .replace(/mailto:/gi, 'mailto:\u200b')
    .replace(/#(?=\d)/g, '\u200b#\u200b')
    .replace(/^([ \t]*)\//gm, '$1&#47;')
  return clip(safe, max)
}

function sentenceEnd(text) {
  if (!text) return ''
  return /[.…!?]$/.test(text) ? text : `${text}.`
}

/**
 * Format one strong finding as an inline PR review comment.
 * @param {{ id: string, file: string, line_start: number, line_end?: number, title: string, claim?: string, failure_scenario?: string, priority?: string }} finding
 * @returns {string}
 */
export function formatInlineComment(finding) {
  const priority = sanitizeText(finding.priority || 'P1', 10, { singleLine: true })
  const title = sanitizeText(finding.title || 'Finding', 200, { singleLine: true })
  const parts = [`**${priority} (strong): ${title}**`]

  const claim = finding.claim ? sanitizeText(finding.claim, 800) : ''
  if (claim) parts.push('', claim)

  const scenario = finding.failure_scenario ? sanitizeText(finding.failure_scenario, 500) : ''
  if (scenario) parts.push('', `Failure scenario: ${scenario}`)

  if (finding.line_end && finding.line_end > finding.line_start) {
    parts.push('', `Lines: L${finding.line_start}-L${finding.line_end}`)
  }

  parts.push(
    '',
    '<sub>MegaLens static review. A second opinion on the diff, not a verdict.</sub>',
    inlineMarker(finding),
  )
  return parts.join('\n')
}

function formatSummaryItem(finding) {
  const priority = sanitizeText(finding.priority || 'P2', 10, { singleLine: true })
  const where = finding.file
    ? ` \`${sanitizeText(finding.file, 200, { singleLine: true })}${finding.line_start ? `:${finding.line_start}` : ''}\``
    : ''
  const title = sentenceEnd(sanitizeText(finding.title || 'Finding', 200, { singleLine: true }))
  const claim = finding.claim ? sanitizeText(finding.claim, 300, { singleLine: true }) : ''
  const appNote = finding.alsoFoundByApp ? ' *(also found by the App)*' : ''
  return `- **${priority}**${where}: ${title}${claim ? ` ${claim}` : ''}${appNote}`
}

/**
 * Format the PR summary note when the PR head moved during review (F7).
 * @param {{ reviewedSha: string, currentSha?: string, tier?: string, reviewId?: string | null, now?: number }} input
 * @returns {string}
 */
export function formatMovedSummaryComment(input) {
  const reviewedSha = input.reviewedSha || ''
  const shortReviewed = sanitizeText(reviewedSha.slice(0, 7) || 'unknown', 20, { singleLine: true })
  const shortCurrent = sanitizeText((input.currentSha || '').slice(0, 7) || 'newer', 20, { singleLine: true })
  const tier = input.tier || 'standard'
  const nowTs = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now()
  const lines = [
    summaryMarker(tier),
    summaryMetaMarker(reviewedSha, tier, 'moved', nowTs),
    `### MegaLens static review of \`${shortReviewed}\``,
    '',
    `Tier: \`${sanitizeText(tier, 20, { singleLine: true })}\`${input.reviewId ? ` · Review: \`${sanitizeText(input.reviewId, 64, { singleLine: true })}\`` : ''}`,
    '',
    `Reviewed \`${shortReviewed}\`, PR has moved (current head is \`${shortCurrent}\`). No inline comments were posted.`,
    '',
    '<sub>Static review only: no code was run.</sub>',
  ]
  return lines.join('\n')
}

/** PR comment for a change the engine refused as too large. Not a failure: nothing was reviewed and nothing was charged. */
export function formatTooLargeComment(input) {
  const headSha = input.headSha || ''
  const shortSha = sanitizeText(headSha.slice(0, 7) || 'unknown', 20, { singleLine: true })
  const tier = input.tier || 'standard'
  const nowTs = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now()
  return [
    summaryMarker(tier),
    summaryMetaMarker(headSha, tier, 'too_large', nowTs),
    `### MegaLens static review of \`${shortSha}\``,
    '',
    sanitizeText(input.message, 400, { singleLine: true }),
    '',
    '<sub>Static review only: no code was run.</sub>',
  ].join('\n')
}

/**
 * Format the single PR summary comment for a tier.
 * Non-inline findings (normal, P2/P3 strong, outside hunks, no line, no patch) go inside ONE collapsed <details> block.
 * Partial and failed runs state their status plainly and never claim no findings.
 */
export function formatSummaryComment(input) {
  const headSha = input.headSha || ''
  const shortSha = sanitizeText(headSha.slice(0, 7) || 'unknown', 20, { singleLine: true })
  const doc = input.doc ?? null
  const tier = doc?.tier || 'standard'
  const status = doc?.status ?? 'failed'
  const strong = input.strongFindings ?? []
  const normal = input.normalFindings ?? []
  const inlineCount = input.inlinePostedCount ?? 0
  const nowTs = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now()
  const failedPasses = (doc?.passes ?? [])
    .filter((p) => !p?.superseded_by && p?.status !== 'ok')
    .map((p) => sanitizeText(p.name, 60, { singleLine: true }))

  const headerLines = [
    summaryMarker(tier),
    summaryMetaMarker(headSha, tier, status, nowTs),
    `### MegaLens static review of \`${shortSha}\``,
    '',
  ]
  const metaParts = []
  if (tier) metaParts.push(`Tier: \`${sanitizeText(tier, 20, { singleLine: true })}\``)
  if (doc?.review_id) metaParts.push(`Review: \`${sanitizeText(doc.review_id, 64, { singleLine: true })}\``)
  if (metaParts.length > 0) headerLines.push(metaParts.join(' · '), '')

  if (input.tierWarning) {
    headerLines.push(`> Warning: ${sanitizeText(input.tierWarning, 240, { singleLine: true })}`, '')
  }

  const docNotes = Array.isArray(doc?.notes)
    ? doc.notes.map((n) => sanitizeText(n, 300, { singleLine: true })).filter(Boolean)
    : []
  if (docNotes.length > 0) {
    for (const note of docNotes) {
      headerLines.push(`> Note: ${note}`)
    }
    headerLines.push('')
  }

  if (status === 'failed') {
    const detail = input.errorMessage
      ? ` ${sentenceEnd(sanitizeText(input.errorMessage, 400))}`
      : failedPasses.length > 0
        ? ` Failed passes: ${failedPasses.join(', ')}.`
        : ''
    headerLines.push(
      `**Review failed.** MegaLens could not complete the review for this commit.${detail}`,
      '',
      'No clean result can be reported for a failed run.',
    )
  } else if (status === 'partial') {
    const passNote = failedPasses.length > 0 ? ` (${failedPasses.join(', ')})` : ''
    headerLines.push(
      `**Partial review:** one or more passes did not complete${passNote}. Results below may be incomplete.`,
      '',
    )
  }

  const omittedFilesCount = (doc?.sandbox?.excluded_files ?? 0) + (doc?.sandbox?.skipped_files ?? 0)

  const strongLines = []
  if (strong.length > 0) {
    const inlineNote = inlineCount > 0 ? ` (${inlineCount} inline on the diff)` : ''
    strongLines.push(`**Strong findings (${strong.length})${inlineNote}:**`, '')
    for (const f of strong) {
      strongLines.push(formatSummaryItem(f))
    }
    strongLines.push('')
  } else if (status === 'complete' && normal.length === 0) {
    if (omittedFilesCount > 0) {
      strongLines.push('No findings on the reviewed files, though some changed files were excluded or skipped (see notes above).', '')
    } else {
      strongLines.push('No findings on the changed diff hunks.', '')
    }
  } else if (status === 'partial' && normal.length === 0) {
    strongLines.push('No findings were reported by the completed passes, though this review is incomplete.', '')
  } else if (status === 'complete') {
    strongLines.push(`0 inline strong findings; ${normal.length} other finding${normal.length === 1 ? '' : 's'} below.`, '')
  } else if (status === 'partial') {
    strongLines.push(`0 inline strong findings from completed passes; ${normal.length} other finding${normal.length === 1 ? '' : 's'} below.`, '')
  }

  const normalItems = normal.map(formatSummaryItem)

  const footerLines = []
  if (input.inlineWarning) {
    footerLines.push(`Note: ${sanitizeText(input.inlineWarning, 240)}`, '')
  }
  footerLines.push('<sub>Static review only: no code was run. Findings are a second opinion for you to check, not a verdict.</sub>')

  const build = (shownNormal, omittedNormalCount) => {
    const lines = [...headerLines, ...strongLines]
    if (normalItems.length > 0) {
      lines.push(
        `<details>`,
        `<summary>${normalItems.length} summary finding${normalItems.length === 1 ? '' : 's'}</summary>`,
        '',
        ...shownNormal,
      )
      if (omittedNormalCount > 0) {
        lines.push(`- and ${omittedNormalCount} more not listed here.`)
      }
      lines.push('', '</details>', '')
    }
    lines.push(...footerLines)
    return lines.join('\n')
  }

  let body = build(normalItems, 0)
  if (body.length <= MAX_SUMMARY_LENGTH) return body

  const keptNormal = [...normalItems]
  let omitted = 0
  while (body.length > MAX_SUMMARY_LENGTH && keptNormal.length > 0) {
    keptNormal.pop()
    omitted += 1
    body = build(keptNormal, omitted)
  }
  if (body.length <= MAX_SUMMARY_LENGTH) return body

  while (body.length > MAX_SUMMARY_LENGTH && strongLines.length > 3) {
    strongLines.splice(strongLines.length - 2, 1)
    body = build(keptNormal, omitted)
  }
  return body.slice(0, MAX_SUMMARY_LENGTH)
}
