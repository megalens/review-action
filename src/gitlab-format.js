import {
  formatInlineComment,
  formatSummaryComment,
  formatTooLargeComment,
  inlineMarker,
  MAX_INLINE_COMMENTS,
  MAX_SUMMARY_LENGTH,
  parseInlineMarker,
  parseSummaryMeta,
  sanitizeText,
  summaryMarker,
  summaryMetaMarker,
  titleHash,
} from './format.js'
import { redactSecrets } from './redact.js'

export const GITLAB_GATE_MARKER = '<!-- megalens:gitlab-gate:v1 -->'

export {
  inlineMarker,
  MAX_INLINE_COMMENTS,
  MAX_SUMMARY_LENGTH,
  parseInlineMarker,
  parseSummaryMeta,
  summaryMarker,
  summaryMetaMarker,
  titleHash,
}

/**
 * Neutralize GitLab Flavored Markdown (GLFM) cross-references (`!123` merge requests,
 * `$123` snippets, `%123` milestones) on top of `sanitizeText` (which already escapes HTML,
 * `@mentions`, `#123` issues, `&123` epics via `&amp;`, links, code fences, and leading `/quick_actions`).
 *
 * @param {string} text
 * @param {number} max
 * @param {{ singleLine?: boolean, extraSecrets?: string[] }} [opts]
 * @returns {string}
 */
export function sanitizeGitLabText(text, max, opts = {}) {
  const base = sanitizeText(text, max, opts)
  const neutralized = base
    .replace(/!(?=\d)/g, '!\u200b')
    .replace(/\$(?=\d)/g, '$\u200b')
    .replace(/%(?=\d)/g, '%\u200b')
  return neutralized.length <= max ? neutralized : neutralized.slice(0, max)
}

/**
 * Apply GLFM-only cross-reference neutralization (`!N`, `$N`, `%N`) to rendered markdown
 * while preserving HTML comment markers and the literal text inside copyable code fences.
 * @param {string} markdown
 * @param {string[]} [extraSecrets]
 * @returns {string}
 */
function finalizeGitLabMarkdown(markdown, extraSecrets = []) {
  const neutralized = markdown.replace(
    /<!--[\s\S]*?-->|^ *```\n[\s\S]*?\n *```$|[!$%](?=\d)/gm,
    (match) => match.length === 1 ? `${match}\u200b` : match,
  )
  return extraSecrets.length > 0 ? redactSecrets(neutralized, extraSecrets) : neutralized
}

/**
 * Format one strong finding as a GitLab inline MR discussion note.
 * Same low-noise structure and dedup marker as the GitHub Action.
 *
 * @param {{ id?: string, file: string, line_start: number, line_end?: number, title: string, claim?: string, failure_scenario?: string, priority?: string }} finding
 * @param {{ extraSecrets?: string[], fixPromptPaths?: Set<string> }} [opts]
 * @returns {string}
 */
export function formatGitLabInlineNote(finding, opts = {}) {
  return finalizeGitLabMarkdown(
    formatInlineComment(finding, opts.extraSecrets, opts.fixPromptPaths, true),
    opts.extraSecrets,
  )
}

/**
 * Format the ONE collapsed summary MR note for a tier.
 * Strong findings are listed at the top; all non-inline findings (normal, P2/P3 strong,
 * out-of-diff) go inside ONE collapsed `<details>` block.
 *
 * @param {Parameters<typeof formatSummaryComment>[0] & { extraSecrets?: string[] }} input
 * @returns {string}
 */
export function formatGitLabSummaryNote(input) {
  const gateStrongCount = input.doc?.status === 'failed'
    ? 0
    : input.gateStrongCount ?? input.strongFindings?.length ?? 0
  return finalizeGitLabMarkdown(
    formatSummaryComment({ ...input, gateStrongCount, metadataMarker: GITLAB_GATE_MARKER }),
    input?.extraSecrets,
  )
}

/**
 * Build the GitLab-worded message for a verified `too_large` refusal (0 credits charged).
 * @param {{ notes?: string[] } | null | undefined} doc
 * @returns {string}
 */
export function gitlabTooLargeMessage(doc) {
  const note = Array.isArray(doc?.notes) && typeof doc.notes[0] === 'string' ? doc.notes[0] : ''
  const m = /\((\d[\d,]*) files?, about (\d[\d,]*) lines?\)/.exec(note)
  const size = m ? ` (${m[1]} files, about ${m[2]} lines)` : ''
  return `MegaLens did not review this merge request: it is too large for one review${size}. Split it into smaller merge requests. No credits were used.`
}

/**
 * Format the MR summary note for a verified `too_large` refusal.
 * @param {{ headSha: string, tier?: string, message: string, now?: number, extraSecrets?: string[] }} input
 * @returns {string}
 */
export function formatGitLabTooLargeNote(input) {
  return finalizeGitLabMarkdown(formatTooLargeComment(input), input?.extraSecrets)
}
