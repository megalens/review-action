import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  BYO_DISABLED_MESSAGE,
  BYO_KEY_ENABLED,
  DOUBLE_DISABLED_MESSAGE,
  DOUBLE_TIER_ENABLED,
  isChildProcessDebugEnabled,
  NODE_DEBUG_CHILD_PROCESS_ERROR,
  PINNED_ENGINE_VERSION,
  runEngineCli,
} from './engine.js'
import {
  computeEffectiveStatus,
  isStrongFinding,
  isVerifiedTooLarge,
  MAX_FINDINGS_BYTES,
  parseFindingsDocument,
  sortFindings,
} from './findings.js'
import { createGitLabApi, DEFAULT_GITLAB_API_URL, GitLabApiError, normalizeGitLabApiUrl } from './gitlab-api.js'
import {
  buildGitLabPosition,
  normalizeLocalDiffHunks,
  partitionGitLabFindingsByDiff,
  readLocalGitDiffHunks,
} from './gitlab-diff.js'
import {
  formatGitLabInlineNote,
  formatGitLabSummaryNote,
  formatGitLabTooLargeNote,
  GITLAB_GATE_MARKER,
  gitlabTooLargeMessage,
  MAX_INLINE_COMMENTS,
  parseInlineMarker,
  parseSummaryMeta,
  summaryMarker,
  summaryMetaMarker,
  titleHash,
} from './gitlab-format.js'
import { createMegaLensReview, DEFAULT_MEGALENS_API_URL, MegaLensApiError, normalizeTrustedApiUrl } from './megalens-api.js'
import { errorText, redactSecrets } from './redact.js'

const GITLAB_VALID_TIERS = new Set(['standard', 'double', 'deep'])
const GITLAB_VALID_FAIL_ON = new Set(['none', 'strong'])
const GITLAB_VALID_MODES = new Set(['full', 'review', 'publish'])
const GITLAB_DEVELOPER_ACCESS_LEVEL = 30
const GITLAB_SHA_RE = /^[0-9a-f]{40,64}$/i
const GITLAB_REPO_RE = /^[A-Za-z0-9._/@:+\[\]-]{1,200}$/
const GITLAB_RESULT_SCHEMA = 'megalens.gitlab-result/v1'
const GITLAB_MAX_RESULT_BYTES = MAX_FINDINGS_BYTES + 2 * 1024 * 1024
const GITLAB_VALID_SKIP_REASONS = new Set(['unprotected_mr', 'closed', 'stale_head', 'fork_mr', 'burst_guard'])
const GITLAB_CREATION_REFUSALS = new Set([400, 401, 402, 403, 404, 413, 422, 429])
const GITLAB_RESULT_ROOT_KEYS = new Set([
  'schema',
  'kind',
  'reason',
  'strong_count',
  'review_id',
  'tier',
  'tier_warning',
  'base_sha',
  'start_sha',
  'head_sha',
  'exit_code',
  'doc',
  'error_message',
  'local_diff_hunks',
  'strong_finding_indexes',
])

export const GITLAB_BURST_GUARD_WINDOW_MS = 5 * 60 * 1000
export const GITLAB_FORK_SKIP_NOTE =
  'skipped: fork MR; MegaLens never runs with repository secrets on fork merge requests'
export const GITLAB_UNPROTECTED_SKIP_NOTE =
  'skipped: protected MegaLens credentials are not available on this unprotected MR branch (see docs/gitlab.md)'
export const GITLAB_PUBLISH_ACCOUNT_TOKEN_ERROR =
  'Refusing to run publish mode with MEGALENS_TOKEN present: restrict MEGALENS_TOKEN to the "megalens-review" environment scope in GitLab CI/CD Variables so publish jobs never receive the account token.'

/**
 * Detect whether a GitLab merge request pipeline comes from a fork (or lacks proof that it is same-project).
 * Fail-closed: on `merge_request_event`, requires `CI_PROJECT_ID`, `CI_MERGE_REQUEST_SOURCE_PROJECT_ID`,
 * AND `CI_MERGE_REQUEST_PROJECT_ID` (GitLab's target project ID) to all be present and equal.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ sourceProjectId?: string | null, targetProjectId?: string | null, isFork?: boolean } | null} [mr]
 * @returns {boolean}
 */
export function isForkMergeRequest(env = {}, mr = null) {
  const sourceId = String(env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID ?? '').trim()
  const projectId = String(env.CI_PROJECT_ID ?? '').trim()
  // GitLab defines CI_MERGE_REQUEST_PROJECT_ID as the MR target project ID.
  // Also inspect legacy CI_MERGE_REQUEST_TARGET_PROJECT_ID if present.
  const mrProjectId = String(env.CI_MERGE_REQUEST_PROJECT_ID ?? '').trim()
  const legacyTargetId = String(env.CI_MERGE_REQUEST_TARGET_PROJECT_ID ?? '').trim()

  if (mr && typeof mr === 'object') {
    if (mr.isFork === true) return true
    const mrSrc = mr.sourceProjectId != null ? String(mr.sourceProjectId).trim() : ''
    const mrTgt = mr.targetProjectId != null ? String(mr.targetProjectId).trim() : ''
    if (mrSrc && mrTgt && mrSrc !== mrTgt) return true
    if (projectId && mrSrc && mrSrc !== projectId) return true
    if (projectId && mrTgt && mrTgt !== projectId) return true
  }

  const presentIds = [sourceId, projectId, mrProjectId, legacyTargetId].filter(Boolean)
  if (presentIds.length >= 2 && new Set(presentIds).size > 1) return true

  const sourcePath = String(env.CI_MERGE_REQUEST_SOURCE_PROJECT_PATH ?? '').trim().toLowerCase()
  const projectPath = String(env.CI_PROJECT_PATH ?? '').trim().toLowerCase()
  const mrProjectPath = String(env.CI_MERGE_REQUEST_PROJECT_PATH ?? '').trim().toLowerCase()
  const legacyTargetPath = String(env.CI_MERGE_REQUEST_TARGET_PROJECT_PATH ?? '').trim().toLowerCase()
  const presentPaths = [sourcePath, projectPath, mrProjectPath, legacyTargetPath].filter(Boolean)
  if (presentPaths.length >= 2 && new Set(presentPaths).size > 1) return true

  // Fail-closed on merge_request_event: all three real GitLab project IDs must be present and equal.
  if (env.CI_PIPELINE_SOURCE === 'merge_request_event' && (!sourceId || !projectId || !mrProjectId)) {
    return true
  }

  return false
}

/**
 * Resolve the repository identifier sent to POST /api/v2/reviews.
 * Preserve the configured instance authority and the full project path.
 * @param {Record<string, string | undefined>} env
 * @param {string} apiUrl
 * @returns {string}
 */
export function resolveGitLabRepo(env = {}, apiUrl = DEFAULT_GITLAB_API_URL) {
  const projectPath = String(env.CI_PROJECT_PATH || '').trim().replace(/^\/+|\/+$/g, '')
  if (!projectPath) {
    throw new Error('Could not determine GitLab project path (CI_PROJECT_PATH is empty).')
  }
  const candidate = `${new URL(apiUrl).host}/${projectPath}`
  if (GITLAB_REPO_RE.test(candidate)) return candidate
  throw new Error('Invalid GitLab project identifier for MegaLens API.')
}

/**
 * Parse and validate GitLab CI configuration from environment variables.
 * @param {Record<string, string | undefined>} env
 */
export function parseGitLabEnv(env = {}) {
  const mode = String(env.MEGALENS_MODE || 'full').trim().toLowerCase()
  if (!GITLAB_VALID_MODES.has(mode)) {
    throw new Error(`Invalid MEGALENS_MODE "${mode}". Expected full, review, or publish.`)
  }
  const tier = String(env.MEGALENS_TIER || 'standard').trim().toLowerCase()
  if (!GITLAB_VALID_TIERS.has(tier)) {
    throw new Error(`Invalid MEGALENS_TIER "${tier}". Expected standard, double, or deep.`)
  }
  const failOn = String(env.MEGALENS_FAIL_ON || 'none').trim().toLowerCase()
  if (!GITLAB_VALID_FAIL_ON.has(failOn)) {
    throw new Error(`Invalid MEGALENS_FAIL_ON "${failOn}". Expected none or strong.`)
  }
  const inlineRaw = String(env.MEGALENS_INLINE ?? 'true').trim().toLowerCase()
  if (inlineRaw !== 'true' && inlineRaw !== 'false') {
    throw new Error(`Invalid MEGALENS_INLINE "${inlineRaw}". Expected true or false.`)
  }
  const timeoutRaw = String(env.MEGALENS_TIMEOUT_MINUTES || '25').trim()
  const timeoutMinutes = Number(timeoutRaw)
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error(`Invalid MEGALENS_TIMEOUT_MINUTES "${timeoutRaw}". Expected a positive number.`)
  }

  // GitLab SHA guidance:
  // - Merged-results / merge-train pipelines set CI_MERGE_REQUEST_SOURCE_BRANCH_SHA to the MR source head
  //   (while CI_COMMIT_SHA is the synthetic merge commit).
  // - Detached MR pipelines omit CI_MERGE_REQUEST_SOURCE_BRANCH_SHA and set CI_COMMIT_SHA to the MR head.
  const sourceBranchShaEnv = String(env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA || '').trim().toLowerCase()
  const commitShaEnv = String(env.CI_COMMIT_SHA || '').trim().toLowerCase()
  const pipelineHeadSha = sourceBranchShaEnv || commitShaEnv

  return {
    mode,
    pipelineSource: String(env.CI_PIPELINE_SOURCE || '').trim(),
    projectId: String(env.CI_PROJECT_ID || '').trim(),
    mrIid: String(env.CI_MERGE_REQUEST_IID || '').trim(),
    baseShaEnv: String(env.CI_MERGE_REQUEST_DIFF_BASE_SHA || '').trim().toLowerCase(),
    headShaEnv: commitShaEnv,
    sourceBranchShaEnv,
    pipelineHeadSha,
    refProtected: String(env.CI_COMMIT_REF_PROTECTED ?? '').trim().toLowerCase(),
    isManualJob: String(env.MEGALENS_JOB_MANUAL ?? env.CI_JOB_MANUAL ?? '').trim().toLowerCase() === 'true',
    projectDir: String(env.CI_PROJECT_DIR || process.cwd()).trim(),
    gitlabApiUrl: env.MEGALENS_GITLAB_API_URL ?? '',
    resultPath: String(env.MEGALENS_RESULT_PATH || '').trim(),
    tier,
    failOn,
    inline: inlineRaw === 'true',
    timeoutMinutes,
    engineVersion: String(env.MEGALENS_ENGINE_VERSION || PINNED_ENGINE_VERSION).trim(),
    apiUrl: String(env.MEGALENS_API_URL || DEFAULT_MEGALENS_API_URL).trim(),
    megalensToken: String(env.MEGALENS_TOKEN || '').trim(),
    gitlabToken: String(env.MEGALENS_GITLAB_TOKEN || '').trim(),
    openaiApiKey: String(env.MEGALENS_OPENAI_API_KEY || '').trim(),
  }
}

/**
 * Strictly validate a persisted GitLab review result artifact (`megalens.gitlab-result/v1`).
 * Used by `MEGALENS_MODE=publish` so retrying publication never calls POST /api/v2/reviews again.
 * @param {string | Buffer | Record<string, unknown>} input
 */
export function parseGitLabResultArtifact(input) {
  let obj
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    const byteLen = Buffer.isBuffer(input) ? input.byteLength : Buffer.byteLength(input, 'utf8')
    if (byteLen > GITLAB_MAX_RESULT_BYTES) {
      throw new Error(`Invalid GitLab result artifact: exceeds ${GITLAB_MAX_RESULT_BYTES} byte size limit.`)
    }
    const text = Buffer.isBuffer(input) ? input.toString('utf8') : input
    try {
      obj = JSON.parse(text)
    } catch (err) {
      throw new Error(`Invalid GitLab result artifact JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (input && typeof input === 'object' && !Array.isArray(input)) {
    obj = input
  } else {
    throw new Error('Invalid GitLab result artifact: root must be a JSON object.')
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Invalid GitLab result artifact: root must be a JSON object.')
  }
  for (const key of Object.keys(obj)) {
    if (!GITLAB_RESULT_ROOT_KEYS.has(key)) {
      throw new Error(`Invalid GitLab result artifact: unexpected field "${key}".`)
    }
  }
  if (obj.schema !== GITLAB_RESULT_SCHEMA) {
    throw new Error(`Unsupported GitLab result artifact schema: "${String(obj.schema ?? 'missing')}".`)
  }
  if (obj.kind === 'skip') {
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : ''
    if (!GITLAB_VALID_SKIP_REASONS.has(reason)) {
      throw new Error(`Invalid GitLab result artifact skip reason: "${reason || 'missing'}".`)
    }
    let strongCount = null
    if (obj.strong_count !== undefined && obj.strong_count !== null) {
      if (typeof obj.strong_count !== 'number' || !Number.isInteger(obj.strong_count) || obj.strong_count < 0) {
        throw new Error('Invalid GitLab result artifact: strong_count must be a non-negative integer.')
      }
      strongCount = obj.strong_count
    }
    return { schema: GITLAB_RESULT_SCHEMA, kind: 'skip', reason, strongCount }
  }
  if (obj.kind !== 'review') {
    throw new Error(`Invalid GitLab result artifact kind: "${String(obj.kind ?? 'missing')}".`)
  }
  const tier = typeof obj.tier === 'string' ? obj.tier.toLowerCase() : ''
  if (!GITLAB_VALID_TIERS.has(tier)) {
    throw new Error(`Invalid GitLab result artifact tier: "${String(obj.tier ?? 'missing')}".`)
  }
  const baseSha = typeof obj.base_sha === 'string' ? obj.base_sha.toLowerCase() : ''
  const headSha = typeof obj.head_sha === 'string' ? obj.head_sha.toLowerCase() : ''
  const startSha = typeof obj.start_sha === 'string' && obj.start_sha ? obj.start_sha.toLowerCase() : baseSha
  if (!GITLAB_SHA_RE.test(baseSha) || !GITLAB_SHA_RE.test(headSha) || !GITLAB_SHA_RE.test(startSha)) {
    throw new Error('Invalid GitLab result artifact: invalid base_sha, start_sha, or head_sha.')
  }
  const exitCode = obj.exit_code
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error('Invalid GitLab result artifact: exit_code must be an integer 0..255.')
  }
  const reviewId = obj.review_id == null
    ? null
    : typeof obj.review_id === 'string' && obj.review_id.length <= 128
      ? obj.review_id
      : (() => { throw new Error('Invalid GitLab result artifact: invalid review_id.') })()
  const tierWarning = obj.tier_warning == null
    ? null
    : typeof obj.tier_warning === 'string' && obj.tier_warning.length <= 500
      ? obj.tier_warning
      : (() => { throw new Error('Invalid GitLab result artifact: invalid tier_warning.') })()
  const errorMessage = obj.error_message == null
    ? null
    : typeof obj.error_message === 'string' && obj.error_message.length <= 2000
      ? obj.error_message
      : (() => { throw new Error('Invalid GitLab result artifact: invalid error_message.') })()

  const doc = obj.doc == null ? null : parseFindingsDocument(obj.doc)
  const localDiffHunks = obj.local_diff_hunks == null ? null : normalizeLocalDiffHunks(obj.local_diff_hunks)
  const indexes = obj.strong_finding_indexes
  const findingCount = doc?.findings.length ?? 0
  if (indexes != null && (
    !Array.isArray(indexes) || indexes.length > findingCount
    || indexes.some((i) => {
      const finding = doc?.findings[i]
      return !Number.isInteger(i) || i < 0 || i >= findingCount
        || !isStrongFinding({ ...finding, file: finding?.file || '[redacted]' })
    })
    || new Set(indexes).size !== indexes.length
  )) {
    throw new Error('Invalid GitLab result artifact: invalid local diff finding indexes.')
  }

  return {
    schema: GITLAB_RESULT_SCHEMA,
    kind: 'review',
    reviewId,
    tier,
    tierWarning,
    baseSha,
    startSha,
    headSha,
    exitCode,
    doc,
    errorMessage,
    localDiffHunks,
    strongFindingIndexes: indexes == null ? null : new Set(indexes),
  }
}

/**
 * Filter out strong findings that already have an inline MR discussion authored by our own
 * GitLab token user with the same stable identity (`file + lines + sha256(title)`).
 * Notes from any other user are ignored so markers cannot be spoofed.
 *
 * @param {Array<{ file: string, line_start: number, line_end?: number, title: string }>} strongFindings
 * @param {Array<{ notes?: Array<{ author?: { username?: string }, body?: string, system?: boolean }> }>} existingDiscussions
 * @param {{ ownUsername?: string | null }} [opts]
 */
export function selectNewGitLabInlineFindings(strongFindings, existingDiscussions, opts = {}) {
  const ownUser = typeof opts.ownUsername === 'string' && opts.ownUsername.trim()
    ? opts.ownUsername.trim().toLowerCase()
    : null
  const ownKeys = new Set()

  if (ownUser && Array.isArray(existingDiscussions)) {
    for (const discussion of existingDiscussions) {
      const notes = Array.isArray(discussion?.notes) ? discussion.notes : []
      for (const note of notes) {
        if (note?.system === true) continue
        const author = typeof note?.author?.username === 'string' ? note.author.username.toLowerCase() : ''
        if (author !== ownUser) continue
        const parsed = parseInlineMarker(note?.body)
        if (parsed) {
          ownKeys.add(`${parsed.file}\0${parsed.lineStart}-${parsed.lineEnd}\0${parsed.titleSha}`)
        }
      }
    }
  }

  const toPost = []
  let alreadyPostedCount = 0
  for (const finding of strongFindings) {
    const start = finding.line_start
    const end = finding.line_end && finding.line_end >= start ? finding.line_end : start
    const key = `${finding.file}\0${start}-${end}\0${titleHash(finding.title)}`
    if (ownKeys.has(key)) {
      alreadyPostedCount += 1
      continue
    }
    if (toPost.length < MAX_INLINE_COMMENTS) {
      toPost.push(finding)
    }
  }

  return { toPost, alreadyPostedCount }
}

/**
 * Pure planner used by both live posting and the dry-run renderer script:
 * takes a parsed `megalens.findings/v1` doc + GitLab MR diffs + optional local git diff hunks
 * and computes the exact inline discussions and ONE collapsed summary note to post.
 *
 * When `localDiffHunks` is provided, strong-finding / `fail_on: strong` eligibility uses the
 * local diff actually reviewed by the engine (even if GitLab omitted a file's patch due to diff limits),
 * while GitLab's available diff positions are used for inline discussion posting.
 *
 * @param {{
 *   doc: ReturnType<typeof parseFindingsDocument>,
 *   mrDiffs: Array<{ old_path?: string, new_path?: string, diff?: string, deleted_file?: boolean }>,
 *   localDiffHunks?: Map<string, Set<number>> | Record<string, number[]> | null,
 *   strongFindingIndexes?: Set<number> | null,
 *   diffRefs: { baseSha: string, startSha?: string, headSha: string },
 *   exitCode?: number,
 *   inline?: boolean,
 *   existingDiscussions?: Array<any>,
 *   ownUsername?: string | null,
 *   tierWarning?: string | null,
 *   errorMessage?: string | null,
 *   extraSecrets?: string[],
 *   now?: number,
 * }} input
 */
export function buildGitLabReviewPlan(input) {
  const doc = input.doc
  const exitCode = typeof input.exitCode === 'number'
    ? input.exitCode
    : doc.refused === true
      ? 3
      : doc.status === 'complete'
        ? 0
        : doc.status === 'partial'
          ? 2
          : 4
  const headSha = input.diffRefs?.headSha || doc.target?.head || ''
  const effectiveTier = doc.tier || 'standard'
  const extraSecrets = input.extraSecrets ?? []
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now()

  if (isVerifiedTooLarge(doc, exitCode, headSha)) {
    const message = gitlabTooLargeMessage(doc)
    return {
      status: 'skipped',
      reason: 'too_large',
      tier: effectiveTier,
      strongFindings: [],
      normalFindings: [],
      inlineDiscussions: [],
      alreadyPostedCount: 0,
      summaryNote: formatGitLabTooLargeNote({ headSha, tier: effectiveTier, message, now, extraSecrets }),
      message,
    }
  }

  const effectiveStatus = computeEffectiveStatus(doc.status, exitCode, doc.passes, doc.refused)
  const effectiveDoc = { ...doc, status: effectiveStatus, tier: effectiveTier }

  let strongFindings = []
  let normalFindings = []
  let inlineDiscussions = []
  let alreadyPostedCount = 0

  if (effectiveStatus !== 'failed') {
    const { inDiff, outOfDiff } = partitionGitLabFindingsByDiff(doc.findings, input.mrDiffs ?? [], {
      localDiffHunks: input.localDiffHunks ?? null,
      strongFindingIndexes: input.strongFindingIndexes,
    })
    const sortedInDiff = sortFindings(inDiff)
    strongFindings = input.strongFindingIndexes ? sortedInDiff : sortedInDiff.filter((f) => isStrongFinding(f, true))
    const nonStrongInDiff = input.strongFindingIndexes ? [] : sortedInDiff.filter((f) => !isStrongFinding(f, true))
    normalFindings = sortFindings([...nonStrongInDiff, ...outOfDiff])

    const inlineEligibleStrong = strongFindings.filter((f) => f._gitlabPosition !== null && f._gitlabPosition !== undefined)
    if (input.inline !== false && inlineEligibleStrong.length > 0) {
      const selected = selectNewGitLabInlineFindings(
        inlineEligibleStrong,
        input.existingDiscussions ?? [],
        { ownUsername: input.ownUsername ?? null },
      )
      alreadyPostedCount = selected.alreadyPostedCount
      inlineDiscussions = selected.toPost.map((finding) => ({
        finding,
        position: buildGitLabPosition(
          {
            baseSha: input.diffRefs?.baseSha || doc.target?.base || '',
            startSha: input.diffRefs?.startSha || input.diffRefs?.baseSha || doc.target?.base || '',
            headSha,
          },
          finding._gitlabPosition,
        ),
        body: formatGitLabInlineNote(finding, { extraSecrets }),
      }))
    }
  }

  const summaryNote = formatGitLabSummaryNote({
    headSha,
    doc: effectiveDoc,
    strongFindings: effectiveStatus === 'failed' ? [] : strongFindings,
    normalFindings: effectiveStatus === 'failed' ? [] : normalFindings,
    gateStrongCount: effectiveStatus === 'failed' ? 0 : strongFindings.length,
    inlinePostedCount: alreadyPostedCount + inlineDiscussions.length,
    tierWarning: input.tierWarning ?? null,
    errorMessage: input.errorMessage ?? null,
    extraSecrets,
    now,
  })

  return {
    status: effectiveStatus,
    reason: null,
    tier: effectiveTier,
    strongFindings: effectiveStatus === 'failed' ? [] : strongFindings,
    normalFindings: effectiveStatus === 'failed' ? [] : normalFindings,
    inlineDiscussions,
    alreadyPostedCount,
    summaryNote,
    message: null,
  }
}

/**
 * Sanitize and minimize a validated `megalens.findings/v1` document before persisting it to a
 * GitLab CI handoff artifact:
 * - Strips `evidence_quote` (never rendered in comments) and `dropped_findings` so raw quoted code
 *   never sits in job artifacts.
 * - Redacts known secret patterns and runtime secrets across all remaining text fields.
 *
 * @param {ReturnType<typeof parseFindingsDocument> | null | undefined} doc
 * @param {string[]} [extraSecrets]
 */
export function sanitizeFindingsDocumentForArtifact(doc, extraSecrets = []) {
  if (!doc || typeof doc !== 'object') return null
  const scrub = (val) => (typeof val === 'string' ? redactSecrets(val, extraSecrets) : val)

  const findings = Array.isArray(doc.findings)
    ? doc.findings.map((f) => {
        const clean = {
          id: scrub(f.id),
          // A redacted path cannot reliably identify a GitLab file for an inline discussion.
          file: scrub(f.file) === f.file ? f.file : '',
          ...(typeof f.line_start === 'number' ? { line_start: f.line_start } : {}),
          ...(typeof f.line_end === 'number' ? { line_end: f.line_end } : {}),
          title: scrub(f.title),
          claim: scrub(f.claim),
          failure_scenario: scrub(f.failure_scenario),
          priority: f.priority,
          strength: f.strength,
          ...(Array.isArray(f.found_by) ? { found_by: f.found_by.map((item) => scrub(item)) } : {}),
        }
        return clean
      })
    : []

  const passes = Array.isArray(doc.passes)
    ? doc.passes.map((p) => ({
        name: scrub(p.name),
        ...(typeof p.model === 'string' ? { model: scrub(p.model) } : {}),
        ...(typeof p.effort === 'string' ? { effort: scrub(p.effort) } : {}),
        status: p.status,
        ...(typeof p.minutes === 'number' ? { minutes: p.minutes } : {}),
        ...(typeof p.reason === 'string' ? { reason: scrub(p.reason) } : {}),
        ...(typeof p.route === 'string' ? { route: scrub(p.route) } : {}),
        ...(typeof p.detail === 'string' ? { detail: scrub(p.detail) } : {}),
        ...(typeof p.superseded_by === 'string' ? { superseded_by: scrub(p.superseded_by) } : {}),
        ...(typeof p.waived === 'boolean' ? { waived: p.waived } : {}),
        ...(typeof p.short_run === 'boolean' ? { short_run: p.short_run } : {}),
      }))
    : []

  const scrubNumericRecord = (obj, allowedKeys) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
    const clean = {}
    for (const k of allowedKeys) {
      if (typeof obj[k] === 'number' && Number.isInteger(obj[k]) && obj[k] >= 0) {
        clean[k] = obj[k]
      }
    }
    return clean
  }
  const usage = scrubNumericRecord(doc.usage, ['requests', 'input_tokens', 'cached_input_tokens', 'output_tokens'])
  const sandbox = scrubNumericRecord(doc.sandbox, ['excluded_files', 'skipped_files'])

  return {
    schema: doc.schema,
    review_id: doc.review_id ? scrub(doc.review_id) : null,
    tier: doc.tier,
    status: doc.status,
    target: {
      kind: doc.target?.kind,
      base: GITLAB_SHA_RE.test(doc.target?.base ?? '') ? doc.target.base : null,
      head: GITLAB_SHA_RE.test(doc.target?.head ?? '') ? doc.target.head : null,
      snapshot_sha256: /^[0-9a-f]{64}$/i.test(doc.target?.snapshot_sha256 ?? '')
        ? doc.target.snapshot_sha256 : null,
    },
    passes,
    findings,
    ...(typeof doc.dropped_by_quiet_mode === 'number' ? { dropped_by_quiet_mode: doc.dropped_by_quiet_mode } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(Array.isArray(doc.notes) ? { notes: doc.notes.map((n) => scrub(n)) } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(typeof doc.isolation === 'string' ? { isolation: scrub(doc.isolation) } : {}),
    ...(typeof doc.route === 'string' ? { route: scrub(doc.route) } : {}),
    ...(typeof doc.refused === 'boolean' ? { refused: doc.refused } : {}),
    ...(typeof doc.reason === 'string' ? { reason: scrub(doc.reason) } : {}),
    ...(typeof doc.error === 'string' ? { error: scrub(doc.error) } : {}),
  }
}

async function resolveContainedArtifactSegments(resultPath, rootDir) {
  const rawPath = String(resultPath || '').trim()
  if (!rawPath || rawPath.includes('\0')) {
    throw new Error('Invalid MEGALENS_RESULT_PATH: path must be non-empty and contain no NUL bytes.')
  }
  const baseRoot = await realpath(rootDir || process.cwd())
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(baseRoot, rawPath)
  const rel = relative(baseRoot, candidate)
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing artifact path outside workspace root: "${rawPath}".`)
  }
  const segments = rel.split(sep).filter(Boolean)
  if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) {
    throw new Error(`Invalid artifact path segments: "${rawPath}".`)
  }
  return { baseRoot, segments }
}

/**
 * Safely write a result artifact strictly inside `rootDir` without following symlinks on any
 * directory component or the target file (prevents MR-committed symlinks from truncating host files).
 *
 * @param {string} resultPath
 * @param {string} content
 * @param {string} [rootDir]
 */
export async function writeResultArtifactSafely(resultPath, content, rootDir = process.cwd()) {
  const { baseRoot, segments } = await resolveContainedArtifactSegments(resultPath, rootDir)
  let current = baseRoot

  for (let i = 0; i < segments.length - 1; i++) {
    current = join(current, segments[i])
    let st = null
    try {
      st = await lstat(current)
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err
    }
    if (!st) {
      await mkdir(current, { mode: 0o700 })
    } else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Refusing to write artifact through symlink or non-directory: "${segments.slice(0, i + 1).join('/')}".`)
    }
    const realCurrent = await realpath(current)
    if (realCurrent !== current) {
      throw new Error(`Refusing to write artifact through symlinked path: "${segments.slice(0, i + 1).join('/')}".`)
    }
  }

  const targetPath = join(current, segments[segments.length - 1])
  let targetStat = null
  try {
    targetStat = await lstat(targetPath)
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
  }
  if (targetStat) {
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new Error(`Refusing to overwrite symlink or non-regular file at artifact path: "${segments.join('/')}".`)
    }
    await unlink(targetPath)
  }

  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0)
  const fh = await open(targetPath, flags, 0o600)
  try {
    await fh.writeFile(content, 'utf8')
  } finally {
    await fh.close()
  }
}

/**
 * Safely read a result artifact strictly inside `rootDir` without following symlinks.
 *
 * @param {string} resultPath
 * @param {string} [rootDir]
 * @returns {Promise<string>}
 */
export async function readResultArtifactSafely(resultPath, rootDir = process.cwd()) {
  const { baseRoot, segments } = await resolveContainedArtifactSegments(resultPath, rootDir)
  let current = baseRoot

  for (let i = 0; i < segments.length - 1; i++) {
    current = join(current, segments[i])
    const st = await lstat(current)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Refusing to read artifact through symlink or non-directory: "${segments.slice(0, i + 1).join('/')}".`)
    }
    const realCurrent = await realpath(current)
    if (realCurrent !== current) {
      throw new Error(`Refusing to read artifact through symlinked path: "${segments.slice(0, i + 1).join('/')}".`)
    }
  }

  const targetPath = join(current, segments[segments.length - 1])
  const targetStat = await lstat(targetPath)
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error(`Refusing to read symlink or non-regular file at artifact path: "${segments.join('/')}".`)
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  const fh = await open(targetPath, flags)
  try {
    const fdStat = await fh.stat()
    if (!fdStat.isFile()) {
      throw new Error(`Refusing to read non-regular file at artifact path: "${segments.join('/')}".`)
    }
    if (fdStat.size > GITLAB_MAX_RESULT_BYTES) {
      throw new Error(`Invalid GitLab result artifact: exceeds ${GITLAB_MAX_RESULT_BYTES} byte size limit.`)
    }
    return await fh.readFile('utf8')
  } finally {
    await fh.close()
  }
}

/**
 * Run MegaLens static review inside a GitLab CI merge request pipeline.
 * Supports three modes via `MEGALENS_MODE`:
 * - `review`: reserve the MR review + create review + run engine + persist validated result artifact
 * - `publish`: read persisted validated result artifact + post inline discussions & summary note (0 credits on retry)
 * - `full` (default): create + run engine + publish in one invocation (also persists artifact if `MEGALENS_RESULT_PATH` is set)
 *
 * Designed for full dependency injection so unit tests run with zero network or subprocesses.
 */
export async function runGitLabReview(deps = {}) {
  const byoKeyEnabled = typeof deps.byoKeyEnabled === 'boolean' ? deps.byoKeyEnabled : BYO_KEY_ENABLED
  const doubleTierEnabled = typeof deps.doubleTierEnabled === 'boolean' ? deps.doubleTierEnabled : DOUBLE_TIER_ENABLED
  const getNowMs = () => (typeof deps.now === 'function' ? deps.now() : typeof deps.now === 'number' ? deps.now : Date.now())
  const env = deps.env ?? process.env
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`))
  const warn = deps.warn ?? ((line) => process.stderr.write(`Warning: ${line}\n`))
  const runEngine = deps.runEngine ?? ((opts) => runEngineCli(opts, { byoKeyEnabled, doubleTierEnabled }))
  const createApi = deps.createGitLabApi ?? ((token, opts) => createGitLabApi(token, opts))
  const createReviewFn = deps.createReview
    ?? ((opts) => createMegaLensReview({ ...opts, userAgent: 'MegaLens-GitLab-CI' }, { fetchImpl: deps.fetchImpl }))
  const readLocalDiffFn = deps.readLocalDiff
    ?? ((opts) => readLocalGitDiffHunks(opts.repoPath, opts.baseSha, opts.headSha))
  const cfg = parseGitLabEnv(env)
  const artifactRootDir = deps.artifactRootDir ?? cfg.projectDir ?? process.cwd()
  const readResultFn = deps.readResultImpl ?? ((p) => readResultArtifactSafely(p, artifactRootDir))
  const writeResultFn = deps.writeResultImpl ?? ((p, content) => writeResultArtifactSafely(p, content, artifactRootDir))
  const secretValues = [cfg.megalensToken, cfg.gitlabToken, cfg.openaiApiKey].filter(Boolean)
  const safeText = (text) => redactSecrets(String(text ?? ''), secretValues)
  const safeError = (err) => errorText(err, secretValues)
  const safeLog = (msg) => log(safeText(msg))
  const safeWarn = (msg) => warn(safeText(msg))

  const persistArtifact = async (payload) => {
    if (!cfg.resultPath) return
    await writeResultFn(cfg.resultPath, JSON.stringify(payload, null, 2))
  }

  if (cfg.pipelineSource !== 'merge_request_event' || !cfg.mrIid) {
    const msg = `skipped: not a merge_request_event pipeline (CI_PIPELINE_SOURCE="${cfg.pipelineSource}")`
    safeLog(msg)
    return { status: 'skipped', reason: 'not_mr_pipeline', exitCode: 0, message: msg }
  }

  // Fork guard: MRs from forks must NEVER run with repository secrets.
  if (isForkMergeRequest(env)) {
    safeLog(GITLAB_FORK_SKIP_NOTE)
    return { status: 'skipped', reason: 'fork_mr', exitCode: 0, message: GITLAB_FORK_SKIP_NOTE }
  }

  // Token isolation: publish mode must NEVER receive the MegaLens account token.
  if (cfg.mode === 'publish' && cfg.megalensToken) {
    safeLog(GITLAB_PUBLISH_ACCOUNT_TOKEN_ERROR)
    return { status: 'failed', exitCode: 1, error: GITLAB_PUBLISH_ACCOUNT_TOKEN_ERROR }
  }

  if (!byoKeyEnabled && cfg.openaiApiKey && cfg.mode !== 'publish') {
    safeLog(BYO_DISABLED_MESSAGE)
    return { status: 'failed', exitCode: 1, error: BYO_DISABLED_MESSAGE }
  }

  if (!doubleTierEnabled && cfg.tier === 'double') {
    safeLog(DOUBLE_DISABLED_MESSAGE)
    return { status: 'failed', exitCode: 1, error: DOUBLE_DISABLED_MESSAGE }
  }

  // Protected-variable gate: skip ineligible unprotected MRs cleanly (exit 0, 0 credits) ONLY when
  // GitLab explicitly reports CI_COMMIT_REF_PROTECTED=false and withholds BOTH protected tokens.
  // On eligible protected MRs (CI_COMMIT_REF_PROTECTED=true) or partial configs, missing credentials
  // ALWAYS fail so fail_on: strong can never pass without a review.
  if (
    cfg.refProtected === 'false'
    && !cfg.gitlabToken
    && (cfg.mode === 'publish' || !cfg.megalensToken)
  ) {
    safeLog(GITLAB_UNPROTECTED_SKIP_NOTE)
    if (cfg.mode === 'review') {
      await persistArtifact({ schema: GITLAB_RESULT_SCHEMA, kind: 'skip', reason: 'unprotected_mr' })
    }
    return { status: 'skipped', reason: 'unprotected_mr', exitCode: 0, message: GITLAB_UNPROTECTED_SKIP_NOTE }
  }

  let gitlabApiUrl
  try {
    if (!cfg.gitlabApiUrl) {
      throw new Error('Missing trusted GitLab API URL. Set the gitlab_api_url component input.')
    }
    gitlabApiUrl = normalizeGitLabApiUrl(cfg.gitlabApiUrl)
  } catch (err) {
    const reason = safeError(err)
    safeLog(reason)
    return { status: 'failed', exitCode: 1, error: reason }
  }

  if (cfg.mode === 'publish') {
    if (!cfg.resultPath) {
      const msg = 'Missing MEGALENS_RESULT_PATH: publish mode requires the persisted review result path.'
      safeLog(msg)
      return { status: 'failed', exitCode: 1, error: msg }
    }
    let artifact
    try {
      const raw = await readResultFn(cfg.resultPath)
      artifact = parseGitLabResultArtifact(raw)
    } catch (err) {
      const reason = safeError(err)
      safeLog(`Failed to read persisted review result: ${reason}`)
      return { status: 'failed', exitCode: 1, error: reason }
    }
    if (artifact.kind === 'skip') {
      if (artifact.reason === 'unprotected_mr' && cfg.refProtected !== 'false') {
        const msg =
          'Refusing unprotected_mr skip artifact on a protected or unknown-protection MR pipeline; check protected credentials.'
        safeLog(msg)
        return { status: 'failed', exitCode: 1, error: msg }
      }
      if (artifact.reason === 'burst_guard' && cfg.failOn === 'strong') {
        if (typeof artifact.strongCount !== 'number' || artifact.strongCount > 0) {
          const msg = typeof artifact.strongCount === 'number'
            ? `Found ${artifact.strongCount} strong finding(s) in cached review with MEGALENS_FAIL_ON=strong.`
            : 'Burst-guard skip artifact missing strong_count under MEGALENS_FAIL_ON=strong; refusing green pass.'
          safeLog(msg)
          return { status: 'failed', reason: 'burst_guard', exitCode: 1, error: msg }
        }
      }
      const msg = `skipped: review job skipped (${artifact.reason}); nothing to publish`
      safeLog(msg)
      return { status: 'skipped', reason: artifact.reason, exitCode: 0, message: msg }
    }
    if (!cfg.gitlabToken) {
      const msg =
        'Missing MEGALENS_GITLAB_TOKEN: create a project access token with the "api" scope and store it as a masked, protected CI/CD variable.'
      safeLog(msg)
      return { status: 'failed', exitCode: 1, error: msg }
    }
    if (!cfg.projectId) {
      const msg = 'Missing CI_PROJECT_ID: cannot identify GitLab project.'
      safeLog(msg)
      return { status: 'failed', exitCode: 1, error: msg }
    }

    const api = createApi(cfg.gitlabToken, {
      baseUrl: gitlabApiUrl,
      fetchImpl: deps.fetchImpl,
    })

    const mr = await api.getMergeRequest(cfg.projectId, cfg.mrIid)
    if (!mr.open) {
      const msg = 'skipped: merge request is not open'
      safeLog(msg)
      return { status: 'skipped', reason: 'closed', exitCode: 0, message: msg }
    }
    if (isForkMergeRequest(env, mr)) {
      safeLog(GITLAB_FORK_SKIP_NOTE)
      return { status: 'skipped', reason: 'fork_mr', exitCode: 0, message: GITLAB_FORK_SKIP_NOTE }
    }
    if (mr.headSha && mr.headSha.toLowerCase() !== artifact.headSha) {
      safeWarn(
        `MegaLens: MR head moved from ${artifact.headSha.slice(0, 7)} to ${mr.headSha.slice(0, 7)}; nothing written for this run.`,
      )
      return { status: 'skipped', reason: 'stale_head', exitCode: 0 }
    }

    return publishGitLabReview({
      api,
      cfg,
      reviewId: artifact.reviewId,
      selectedTier: artifact.tier,
      tierWarning: artifact.tierWarning,
      baseSha: artifact.baseSha,
      startSha: artifact.startSha,
      headSha: artifact.headSha,
      exitCode: artifact.exitCode,
      doc: artifact.doc,
      errorMessage: artifact.errorMessage,
      localDiffHunks: artifact.localDiffHunks,
      strongFindingIndexes: artifact.strongFindingIndexes,
      runtimeSecrets: secretValues,
      getNowMs,
      safeLog,
      safeWarn,
      safeRuntimeText: safeText,
      safeRuntimeError: safeError,
    })
  }

  // Refuse before any API call or review creation if Node child_process diagnostics are active
  // (Node writes child process env, including MEGALENS_REVIEW_ID/MEGALENS_REVIEW_KEY, straight to stderr).
  if (isChildProcessDebugEnabled(env)) {
    safeLog(NODE_DEBUG_CHILD_PROCESS_ERROR)
    return { status: 'failed', exitCode: 1, error: NODE_DEBUG_CHILD_PROCESS_ERROR }
  }

  if (cfg.engineVersion !== PINNED_ENGINE_VERSION) {
    const reason = `GitLab reviews require the pinned megalens-review engine version ${PINNED_ENGINE_VERSION}.`
    safeLog(reason)
    return { status: 'failed', exitCode: 1, error: reason }
  }

  // Validate the single trusted gateway origin BEFORE touching credentials or calling any API.
  let trustedApiUrl
  try {
    trustedApiUrl = normalizeTrustedApiUrl(cfg.apiUrl)
  } catch (err) {
    const reason = safeError(err)
    safeLog(reason)
    return { status: 'failed', exitCode: 1, error: reason }
  }

  if (!cfg.megalensToken) {
    const msg =
      'Missing MEGALENS_TOKEN: add it as a masked, protected CI/CD variable (see docs/gitlab.md).'
    safeLog(msg)
    return { status: 'failed', exitCode: 1, error: msg }
  }

  if (!cfg.gitlabToken) {
    const msg =
      'Missing MEGALENS_GITLAB_TOKEN: create a project access token with the "api" scope and store it as a masked, protected CI/CD variable.'
    safeLog(msg)
    return { status: 'failed', exitCode: 1, error: msg }
  }

  if (!cfg.projectId) {
    const msg = 'Missing CI_PROJECT_ID: cannot identify GitLab project.'
    safeLog(msg)
    return { status: 'failed', exitCode: 1, error: msg }
  }
  if (cfg.mode === 'review' && !cfg.resultPath) {
    const msg = 'Missing MEGALENS_RESULT_PATH: review mode requires a path for the publish handoff.'
    safeLog(msg)
    return { status: 'failed', exitCode: 1, error: msg }
  }

  // Spend guard: automatic MR pushes always downgrade tier "deep" to "standard".
  // Deep is reserved for explicit manual jobs (CI_JOB_MANUAL=true).
  let selectedTier = cfg.tier
  let tierWarning = null
  if (cfg.tier === 'deep' && !cfg.isManualJob) {
    selectedTier = 'standard'
    tierWarning =
      'tier "deep" is not allowed on automatic MR pushes; running "standard" instead (trigger the manual megalens-review-deep job for deep).'
    safeWarn(tierWarning)
  }

  const repo = resolveGitLabRepo(env, gitlabApiUrl)
  const api = createApi(cfg.gitlabToken, {
    baseUrl: gitlabApiUrl,
    requireViewer: cfg.mode === 'review',
    fetchImpl: deps.fetchImpl,
  })

  // Read live MR state BEFORE creating a MegaLens review (0 credits if closed, fork, stale, or burst-guarded).
  const mr = await api.getMergeRequest(cfg.projectId, cfg.mrIid)
  if (!mr.open) {
    const msg = 'skipped: merge request is not open'
    safeLog(msg)
    if (cfg.mode === 'review') {
      await persistArtifact({ schema: GITLAB_RESULT_SCHEMA, kind: 'skip', reason: 'closed' })
    }
    return { status: 'skipped', reason: 'closed', exitCode: 0, message: msg }
  }
  if (isForkMergeRequest(env, mr)) {
    safeLog(GITLAB_FORK_SKIP_NOTE)
    return { status: 'skipped', reason: 'fork_mr', exitCode: 0, message: GITLAB_FORK_SKIP_NOTE }
  }

  const liveHeadSha = (mr.headSha || '').toLowerCase()
  const pipelineHeadSha = cfg.pipelineHeadSha
  if (!GITLAB_SHA_RE.test(pipelineHeadSha)) {
    const msg =
      'Could not determine pipeline source SHA (CI_MERGE_REQUEST_SOURCE_BRANCH_SHA or CI_COMMIT_SHA is missing or invalid).'
    safeLog(msg)
    return { status: 'failed', exitCode: 1, error: msg }
  }
  if (GITLAB_SHA_RE.test(liveHeadSha) && liveHeadSha !== pipelineHeadSha) {
    safeWarn(
      `MegaLens: MR head moved from ${pipelineHeadSha.slice(0, 7)} to ${liveHeadSha.slice(0, 7)}; skipping stale pipeline at 0 credits.`,
    )
    if (cfg.mode === 'review') {
      await persistArtifact({ schema: GITLAB_RESULT_SCHEMA, kind: 'skip', reason: 'stale_head' })
    }
    return { status: 'skipped', reason: 'stale_head', exitCode: 0 }
  }

  const headSha = pipelineHeadSha
  const baseSha = (mr.baseSha || cfg.baseShaEnv || '').toLowerCase()
  const startSha = (mr.startSha || baseSha).toLowerCase()
  if (!GITLAB_SHA_RE.test(headSha) || !GITLAB_SHA_RE.test(baseSha)) {
    const msg = 'Could not resolve valid 40-hex base_sha and head_sha for this merge request.'
    safeLog(msg)
    return { status: 'failed', exitCode: 1, error: msg }
  }

  // Check the bot's summary before creating a review. Pending reviews belong to their original publish job.
  // Always reapply the configured fail_on gate using bot-authored strong=N metadata so retries cannot turn a failed gate green.
  let existingSummary = null
  if (typeof api.findSummaryNoteDetails === 'function') {
    existingSummary = await api.findSummaryNoteDetails(
      cfg.projectId,
      cfg.mrIid,
      summaryMarker(selectedTier),
    )
    const meta = parseSummaryMeta(existingSummary?.body)
    const tsMs = meta?.ts ?? (existingSummary?.updatedAt ? Date.parse(existingSummary.updatedAt) : NaN)
    const ageMs = Number.isFinite(tsMs) ? getNowMs() - tsMs : Infinity
    if (meta?.headSha === headSha && meta.tier === selectedTier && meta.status === 'pending') {
      const error = 'A MegaLens review is already reserved for this commit and tier. Retry publication in the original pipeline if it failed.'
      safeLog(error)
      return { status: 'failed', reason: 'pending_review', exitCode: 1, error }
    }
    const isRecentSameHead = (
      meta?.headSha === headSha
      && meta?.tier === selectedTier
      && ageMs >= 0
      && ageMs < GITLAB_BURST_GUARD_WINDOW_MS
    )
    if (isRecentSameHead && (meta.status === 'partial' || meta.status === 'failed')) {
      const msg = `An existing MegaLens review for this commit and tier is ${meta.status}.`
      safeLog(msg)
      if (meta.status === 'failed' || cfg.failOn === 'strong') {
        return { status: meta.status, reason: 'burst_guard', exitCode: 1, error: msg }
      }
      if (cfg.mode === 'review') {
        await persistArtifact({ schema: GITLAB_RESULT_SCHEMA, kind: 'skip', reason: 'burst_guard' })
      }
      return { status: 'skipped', reason: 'burst_guard', exitCode: 0, message: msg }
    }
    if (isRecentSameHead && meta.status === 'complete') {
      if (cfg.failOn === 'strong') {
        if (typeof meta.strongCount === 'number' && meta.strongCount > 0) {
          const gateErr = `Found ${meta.strongCount} strong finding(s) in existing review for ${headSha.slice(0, 7)} (tier ${selectedTier}) with MEGALENS_FAIL_ON=strong.`
          safeLog(gateErr)
          if (cfg.mode === 'review') {
            await persistArtifact({
              schema: GITLAB_RESULT_SCHEMA,
              kind: 'skip',
              reason: 'burst_guard',
              strong_count: meta.strongCount,
            })
          }
          return {
            status: 'complete',
            reason: 'burst_guard',
            strongCount: meta.strongCount,
            exitCode: 1,
            error: gateErr,
          }
        }
        if (meta.strongCount === 0) {
          if (!existingSummary.body.includes(GITLAB_GATE_MARKER)) {
            const error = 'The cached review used an older gate calculation. Retry after the five minute review window.'
            safeLog(error)
            return { status: 'failed', reason: 'burst_guard', exitCode: 1, error }
          }
          const burstMsg = `skipped: review summary already exists for ${headSha.slice(0, 7)} (tier ${selectedTier})`
          safeLog(burstMsg)
          if (cfg.mode === 'review') {
            await persistArtifact({
              schema: GITLAB_RESULT_SCHEMA,
              kind: 'skip',
              reason: 'burst_guard',
              strong_count: 0,
            })
          }
          return { status: 'skipped', reason: 'burst_guard', exitCode: 0, message: burstMsg }
        }
        // Legacy summary without strong=N metadata: do NOT take a green burst-guard skip under fail_on=strong.
      } else {
        const burstMsg = `skipped: review summary already exists for ${headSha.slice(0, 7)} (tier ${selectedTier})`
        safeLog(burstMsg)
        if (cfg.mode === 'review') {
          await persistArtifact({
            schema: GITLAB_RESULT_SCHEMA,
            kind: 'skip',
            reason: 'burst_guard',
            ...(typeof meta.strongCount === 'number' ? { strong_count: meta.strongCount } : {}),
          })
        }
        return { status: 'skipped', reason: 'burst_guard', exitCode: 0, message: burstMsg }
      }
    }
  }

  let reservedNoteId = null
  if (cfg.mode === 'review') {
    // The template serializes review and publish per MR and tier. Record the reservation
    // under that lock before the first billable request, even if later GitLab writes fail.
    const live = await api.getMergeRequest(cfg.projectId, cfg.mrIid)
    if (!live.open || live.headSha?.toLowerCase() !== headSha) {
      const reason = live.open ? 'stale_head' : 'closed'
      await persistArtifact({ schema: GITLAB_RESULT_SCHEMA, kind: 'skip', reason })
      return { status: 'skipped', reason, exitCode: 0 }
    }
    const body = [
      summaryMarker(selectedTier),
      summaryMetaMarker(headSha, selectedTier, 'pending', getNowMs()),
      'MegaLens review in progress. The publish job will update this note.',
    ].join('\n')
    try {
      reservedNoteId = existingSummary?.id ?? null
      if (reservedNoteId === null) {
        reservedNoteId = await api.createMergeRequestNote(cfg.projectId, cfg.mrIid, body)
      } else {
        await api.updateMergeRequestNote(cfg.projectId, cfg.mrIid, reservedNoteId, body)
      }
    } catch (err) {
      const reason = safeError(err)
      safeLog(`Failed to reserve MegaLens review in GitLab: ${reason}`)
      return { status: 'failed', exitCode: 1, error: reason }
    }
  }

  // Step 1: Create server-owned review via POST /api/v2/reviews -> short-lived single-review key.
  let created
  try {
    created = await createReviewFn({
      apiUrl: trustedApiUrl,
      token: cfg.megalensToken,
      repo,
      baseSha,
      headSha,
      tier: selectedTier,
    })
  } catch (err) {
    const reason = safeError(err)
    safeLog(`Failed to create MegaLens review (${selectedTier}): ${reason}`)
    if (reservedNoteId !== null && err instanceof MegaLensApiError && GITLAB_CREATION_REFUSALS.has(err.status)) {
      try {
        const live = await api.getMergeRequest(cfg.projectId, cfg.mrIid)
        if (live.open && live.headSha?.toLowerCase() === headSha) {
          const body = [
            summaryMarker(selectedTier),
            summaryMetaMarker(headSha, selectedTier, 'creation_refused', getNowMs()),
            'MegaLens could not start the review. Check the review job log, then retry.',
          ].join('\n')
          await api.updateMergeRequestNote(cfg.projectId, cfg.mrIid, reservedNoteId, body)
        }
      } catch (writeError) {
        safeWarn(`Could not clear the review reservation: ${safeError(writeError)}`)
      }
    }
    return { status: 'failed', exitCode: 1, error: reason }
  }

  const runtimeSecrets = [...secretValues, created.reviewKey].filter(Boolean)
  const safeRuntimeText = (text) => redactSecrets(String(text ?? ''), runtimeSecrets)
  const safeRuntimeError = (err) => errorText(err, runtimeSecrets)

  // Step 2: Run pinned megalens-review engine with ONLY the short-lived review key and the SAME validated gateway origin.
  const runnerTemp = env.MEGALENS_TMPDIR || env.RUNNER_TEMP || tmpdir()
  const outPath = deps.outPath || join(runnerTemp, `megalens-findings-mr${cfg.mrIid}-${Date.now()}.json`)

  let cliResult
  try {
    cliResult = await runEngine({
      tier: selectedTier,
      baseSha,
      headSha,
      outPath,
      timeoutMinutes: cfg.timeoutMinutes,
      engineVersion: cfg.engineVersion,
      apiUrl: trustedApiUrl,
      authMode: 'review-key',
      authEnv: {
        MEGALENS_REVIEW_ID: created.reviewId,
        MEGALENS_REVIEW_KEY: created.reviewKey,
      },
      isFork: false,
      repoPath: cfg.projectDir,
      runnerTemp,
    })
  } catch (err) {
    cliResult = {
      exitCode: 4,
      stdout: '',
      stderr: '',
      errorMessage: safeRuntimeError(err),
      rawFindings: null,
    }
  }

  let doc = null
  let parseError = null
  if (cliResult.rawFindings !== null && cliResult.rawFindings !== undefined) {
    try {
      doc = parseFindingsDocument(cliResult.rawFindings)
    } catch (err) {
      parseError = safeRuntimeError(err)
    }
  }

  let localDiffHunks = null
  if (doc && !isVerifiedTooLarge(doc, cliResult.exitCode, headSha)) {
    try {
      localDiffHunks = await readLocalDiffFn({ repoPath: cfg.projectDir, baseSha, headSha })
    } catch {
      localDiffHunks = null
    }
  }
  let strongFindingIndexes = null
  if (doc && localDiffHunks) {
    const { inDiffIndexes } = partitionGitLabFindingsByDiff(doc.findings, [], { localDiffHunks })
    strongFindingIndexes = new Set(inDiffIndexes.filter((index) => isStrongFinding(doc.findings[index])))
  } else if (doc && cfg.mode === 'review') {
    // The pinned engine marks a finding strong only if it intersects its reviewed diff.
    // Use that classification if Git cannot reproduce the diff locally, including on limited GitLab diffs.
    strongFindingIndexes = new Set(doc.findings.flatMap((finding, index) =>
      isStrongFinding(finding, true) ? [index] : [],
    ))
  }

  const rawTail = safeRuntimeText((cliResult.stderr || '').trim().split('\n').slice(-1)[0] || '')
  const computedErrorMessage = !doc
    ? (parseError
      || (cliResult.exitCode === 3 ? 'Refused by the MegaLens gateway (check token, quota, or spend cap).' : null)
      || (cliResult.errorMessage ? safeRuntimeText(cliResult.errorMessage) : null)
      || rawTail
      || `Engine exited with code ${cliResult.exitCode} without findings.json.`)
    : (doc.refused === true || cliResult.exitCode === 3)
      ? 'Refused by the MegaLens gateway (check token, quota, or spend cap).'
      : cliResult.exitCode === 4
        ? safeRuntimeText(cliResult.errorMessage || doc.error || '')
        : null

  const sanitizedDoc = sanitizeFindingsDocumentForArtifact(doc, runtimeSecrets)
  const sanitizedErrorMessage = computedErrorMessage ? safeRuntimeText(computedErrorMessage) : null
  const sanitizedTierWarning = tierWarning ? safeRuntimeText(tierWarning) : null

  // Persist the sanitized, minimized review result BEFORE calling GitLab publication APIs so:
  // 1) Credentials quoted in evidence_quote or finding text never sit in job artifacts.
  // 2) A publication failure can be retried independently via MEGALENS_MODE=publish at 0 extra credits.
  if (cfg.resultPath) {
    await persistArtifact({
      schema: GITLAB_RESULT_SCHEMA,
      kind: 'review',
      review_id: sanitizedDoc?.review_id || safeRuntimeText(created.reviewId),
      tier: selectedTier,
      tier_warning: sanitizedTierWarning,
      base_sha: baseSha,
      start_sha: startSha,
      head_sha: headSha,
      exit_code: cliResult.exitCode,
      doc: sanitizedDoc,
      error_message: sanitizedErrorMessage,
      strong_finding_indexes: strongFindingIndexes === null ? null : [...strongFindingIndexes],
    })
  }

  if (cfg.mode === 'review') {
    const isTooLarge = Boolean(sanitizedDoc && isVerifiedTooLarge(sanitizedDoc, cliResult.exitCode, headSha))
    const handoffStatus = !sanitizedDoc
      ? 'failed'
      : isTooLarge
        ? 'skipped'
        : computeEffectiveStatus(sanitizedDoc.status, cliResult.exitCode, sanitizedDoc.passes, sanitizedDoc.refused)

    // Upgrade a reserved note only when the handoff already contains the gate classification
    // that publish will use. If this write fails, the reservation still blocks a duplicate.
    if (
      handoffStatus === 'complete'
      && sanitizedDoc.target?.head?.toLowerCase() === headSha
      && strongFindingIndexes !== null
    ) {
      try {
        const live = await api.getMergeRequest(cfg.projectId, cfg.mrIid)
        if (live.open && live.headSha?.toLowerCase() === headSha) {
          const plan = buildGitLabReviewPlan({
            doc: { ...sanitizedDoc, review_id: sanitizedDoc.review_id || safeRuntimeText(created.reviewId), tier: selectedTier },
            strongFindingIndexes,
            diffRefs: { baseSha, startSha, headSha },
            exitCode: cliResult.exitCode,
            inline: false,
            tierWarning: sanitizedTierWarning,
            errorMessage: sanitizedErrorMessage,
            extraSecrets: runtimeSecrets,
            now: getNowMs(),
          })
          await api.updateMergeRequestNote(cfg.projectId, cfg.mrIid, reservedNoteId, plan.summaryNote)
        }
      } catch (err) {
        safeWarn(`MegaLens review checkpoint note deferred to publish job: ${safeRuntimeError(err)}`)
      }
    }

    safeLog(
      `MegaLens review finished (${handoffStatus}, tier ${selectedTier}) for ${headSha.slice(0, 7)}; result persisted for publication.`,
    )
    return {
      status: handoffStatus,
      ...(isTooLarge ? { reason: 'too_large' } : {}),
      reviewId: sanitizedDoc?.review_id || created.reviewId,
      resultPath: cfg.resultPath || null,
      exitCode: 0,
    }
  }

  return publishGitLabReview({
    api,
    cfg,
    reviewId: created.reviewId,
    selectedTier,
    tierWarning: sanitizedTierWarning,
    baseSha,
    startSha,
    headSha,
    exitCode: cliResult.exitCode,
    doc: sanitizedDoc,
    errorMessage: sanitizedErrorMessage,
    strongFindingIndexes,
    runtimeSecrets,
    getNowMs,
    safeLog,
    safeWarn,
    safeRuntimeText,
    safeRuntimeError,
  })
}

async function publishGitLabReview({
  api,
  cfg,
  reviewId,
  selectedTier,
  tierWarning,
  baseSha,
  startSha,
  headSha,
  exitCode: engineExitCode,
  doc,
  errorMessage,
  localDiffHunks,
  strongFindingIndexes,
  runtimeSecrets,
  getNowMs,
  safeLog,
  safeWarn,
  safeRuntimeText,
  safeRuntimeError,
}) {
  const effectiveTier = cfg.mode === 'publish' ? selectedTier : (doc?.tier || selectedTier)

  // Read the live MR before every write to check freshness and prompt eligibility.
  const readMergeRequest = () => api.getMergeRequest(cfg.projectId, cfg.mrIid)
  const isStaleHead = (live) => {
    if (live?.headSha && live.headSha.toLowerCase() !== headSha) {
      safeWarn(
        `MegaLens: MR head moved from ${headSha.slice(0, 7)} to ${live.headSha.slice(0, 7)}; nothing written for this run.`,
      )
      return true
    }
    return false
  }

  const upsertSummaryNote = async (buildBody, tierForMarker) => {
    const marker = summaryMarker(tierForMarker)
    const existingId = await api.findSummaryNote(cfg.projectId, cfg.mrIid, marker)
    const live = await readMergeRequest()
    if (isStaleHead(live)) return { action: 'skipped_stale' }
    // Timestamp the summary right at publication time so long reviews still protect immediately queued duplicates.
    const body = typeof buildBody === 'function' ? buildBody(getNowMs(), live) : buildBody
    if (existingId !== null) {
      await api.updateMergeRequestNote(cfg.projectId, cfg.mrIid, existingId, body)
      return { action: 'updated', noteId: existingId, body }
    }
    const createdId = await api.createMergeRequestNote(cfg.projectId, cfg.mrIid, body)
    return { action: 'created', noteId: createdId, body }
  }

  if (!doc) {
    const reason = errorMessage || `Engine exited with code ${engineExitCode} without findings.json.`
    const upsertRes = await upsertSummaryNote(
      (pubNow) =>
        formatGitLabSummaryNote({
          headSha,
          doc: { status: 'failed', tier: selectedTier, review_id: reviewId, passes: [] },
          tierWarning,
          errorMessage: reason,
          extraSecrets: runtimeSecrets,
          now: pubNow,
        }),
      selectedTier,
    )
    if (upsertRes.action === 'skipped_stale') {
      return { status: 'skipped', reason: 'stale_head', exitCode: 0 }
    }
    return { status: 'failed', reviewId, exitCode: 1, error: reason }
  }

  // Require target.head to match the reviewed MR head SHA.
  if (!doc.target?.head || doc.target.head.toLowerCase() !== headSha) {
    const got = typeof doc.target?.head === 'string' && GITLAB_SHA_RE.test(doc.target.head)
      ? doc.target.head.slice(0, 7)
      : 'missing'
    const mismatchMsg = `Reviewed head SHA (${got}) does not match MR head (${headSha.slice(0, 7)}).`
    const upsertRes = await upsertSummaryNote(
      (pubNow) =>
        formatGitLabSummaryNote({
          headSha,
          doc: { ...doc, review_id: doc.review_id || reviewId, tier: effectiveTier, status: 'failed' },
          tierWarning,
          errorMessage: mismatchMsg,
          extraSecrets: runtimeSecrets,
          now: pubNow,
        }),
      effectiveTier,
    )
    if (upsertRes.action === 'skipped_stale') {
      return { status: 'skipped', reason: 'stale_head', exitCode: 0 }
    }
    return { status: 'failed', reviewId: doc.review_id || reviewId, exitCode: 1, error: mismatchMsg }
  }

  const mr = await readMergeRequest()
  if (isStaleHead(mr)) {
    return { status: 'skipped', reason: 'stale_head', exitCode: 0 }
  }

  // Verified too_large refusal: post friendly MR note, green exit 0, 0 credits charged.
  if (isVerifiedTooLarge(doc, engineExitCode, headSha)) {
    const message = gitlabTooLargeMessage(doc)
    const upsertRes = await upsertSummaryNote(
      (pubNow) =>
        formatGitLabTooLargeNote({
          headSha,
          tier: effectiveTier,
          message,
          extraSecrets: runtimeSecrets,
          now: pubNow,
        }),
      effectiveTier,
    )
    if (upsertRes.action === 'skipped_stale') {
      return { status: 'skipped', reason: 'stale_head', exitCode: 0 }
    }
    safeLog(message)
    return {
      status: 'skipped',
      reason: 'too_large',
      reviewId: doc.review_id || reviewId,
      message,
      exitCode: 0,
    }
  }

  const effectiveStatus = computeEffectiveStatus(doc.status, engineExitCode, doc.passes, doc.refused)
  const effectiveDoc = {
    ...doc,
    review_id: doc.review_id || reviewId,
    status: effectiveStatus,
    tier: effectiveTier,
  }

  let mrDiffs = []
  let existingDiscussions = []
  let ownUsername = null
  if (effectiveStatus !== 'failed') {
    mrDiffs = await api.listMergeRequestDiffs(cfg.projectId, cfg.mrIid)
    if (cfg.inline) {
      ownUsername = typeof api.getViewerUsername === 'function' ? await api.getViewerUsername() : null
      existingDiscussions = typeof api.listMergeRequestDiscussions === 'function'
        ? await api.listMergeRequestDiscussions(cfg.projectId, cfg.mrIid)
        : []
    }
  }

  // Only live, same-project diff metadata can authorize a populated prompt.
  const mrPromptFallbackReason = (live) => {
    if (!live?.open) return 'merge request is no longer open'
    if (live.isFork || live.sourceProjectId !== cfg.projectId || live.targetProjectId !== cfg.projectId) {
      return 'merge request project could not be verified'
    }
    if (live.headSha?.toLowerCase() !== headSha || live.baseSha?.toLowerCase() !== baseSha
      || (live.startSha || live.baseSha)?.toLowerCase() !== startSha) {
      return 'merge request diff refs changed'
    }
    if (!Number.isSafeInteger(live.authorId) || live.authorId <= 0) {
      return 'merge request author could not be verified'
    }
    return null
  }
  const fixPromptPaths = new Set(mrDiffs
    .filter((diff) => typeof diff?.new_path === 'string' && diff.new_path.trim() && diff.deleted_file !== true)
    .map((diff) => diff.new_path))
  let verifiedAuthorId = null
  let fixPromptFallbackReason = 'no publishable findings'
  if (effectiveStatus !== 'failed' && effectiveDoc.findings.length > 0) {
    fixPromptFallbackReason = mrPromptFallbackReason(mr)
    if (!fixPromptFallbackReason) {
      if (fixPromptPaths.size === 0) {
        fixPromptFallbackReason = 'no verified diff paths'
      } else if (typeof api.getProjectMemberAccessLevel !== 'function') {
        fixPromptFallbackReason = 'membership lookup unavailable'
      } else {
        try {
          const level = await api.getProjectMemberAccessLevel(cfg.projectId, mr.authorId)
          if (level >= GITLAB_DEVELOPER_ACCESS_LEVEL) {
            verifiedAuthorId = mr.authorId
          } else {
            fixPromptFallbackReason = level == null
              ? 'author membership could not be verified'
              : 'author access level below Developer'
          }
        } catch (err) {
          // GitLab response text and network errors can contain credentials or identifying data.
          fixPromptFallbackReason = err instanceof GitLabApiError && Number.isInteger(err.status)
            ? `membership request failed with HTTP ${err.status}`
            : err?.name === 'TimeoutError'
              ? 'membership request timed out'
              : 'membership request failed'
        }
      }
    }
  }
  const isGatewayRefused = doc.refused === true || engineExitCode === 3
  const summaryErrorMessage = isGatewayRefused
    ? 'Refused by the MegaLens gateway (check token, quota, or spend cap).'
    : engineExitCode === 4
      ? safeRuntimeText(errorMessage || doc.error || '')
      : null

  const plan = buildGitLabReviewPlan({
    doc: effectiveDoc,
    mrDiffs,
    localDiffHunks,
    strongFindingIndexes,
    diffRefs: { baseSha, startSha, headSha },
    exitCode: engineExitCode,
    inline: cfg.inline,
    existingDiscussions,
    ownUsername,
    tierWarning,
    errorMessage: summaryErrorMessage,
    extraSecrets: runtimeSecrets,
    now: getNowMs(),
  })
  const hasVerifiedPath = (finding) => fixPromptPaths.has(finding.file)
  const findingFallbackReason = plan.strongFindings.some(hasVerifiedPath) || plan.normalFindings.some(hasVerifiedPath)
    ? 'finding did not meet fix prompt requirements'
    : 'no finding matched a verified diff path'
  const promptPaths = (live) => {
    if (verifiedAuthorId === null) return undefined
    const reason = mrPromptFallbackReason(live)
      ?? (live.authorId !== verifiedAuthorId ? 'merge request author changed' : null)
    fixPromptFallbackReason = reason ?? findingFallbackReason
    return reason ? undefined : fixPromptPaths
  }

  // Step 3: Post inline discussions for strong findings, rechecking freshness BEFORE EACH write.
  let inlinePostedCount = plan.alreadyPostedCount
  let inlineFailedCount = 0
  let lastInlineErr = ''
  let readyFixPromptPosted = false
  // Finding prose is sanitized before rendering and cannot introduce a code fence.
  const hasReadyFixPrompt = (body) => /^ *```\n *Fix this bug in "/m.test(body)
  if (plan.inlineDiscussions.length > 0) {
    for (const item of plan.inlineDiscussions) {
      const live = await readMergeRequest()
      if (isStaleHead(live)) {
        return { status: 'skipped', reason: 'stale_head', exitCode: 0 }
      }
      try {
        const paths = promptPaths(live)
        const body = paths
          ? formatGitLabInlineNote(item.finding, { extraSecrets: runtimeSecrets, fixPromptPaths: paths })
          : item.body
        await api.createMergeRequestDiscussion(cfg.projectId, cfg.mrIid, body, item.position)
        readyFixPromptPosted ||= Boolean(paths) && hasReadyFixPrompt(body)
        inlinePostedCount += 1
      } catch (err) {
        inlineFailedCount += 1
        lastInlineErr = safeRuntimeError(err)
      }
    }
  }

  const inlineWarning = inlineFailedCount > 0
    ? `Could not post ${inlineFailedCount} inline discussion${inlineFailedCount === 1 ? '' : 's'} (${lastInlineErr}); strong findings are listed above.`
    : null

  const upsertRes = await upsertSummaryNote(
    (pubNow, live) =>
      formatGitLabSummaryNote({
        headSha,
        doc: effectiveDoc,
        strongFindings: plan.strongFindings,
        normalFindings: plan.normalFindings,
        gateStrongCount: effectiveStatus === 'failed' ? 0 : plan.strongFindings.length,
        inlinePostedCount,
        inlineWarning,
        tierWarning,
        errorMessage: summaryErrorMessage,
        extraSecrets: runtimeSecrets,
        fixPromptPaths: promptPaths(live),
        now: pubNow,
      }),
    effectiveTier,
  )
  if (upsertRes.action === 'skipped_stale') {
    return { status: 'skipped', reason: 'stale_head', exitCode: 0 }
  }
  if (cfg.mode === 'publish') {
    safeLog(readyFixPromptPosted || hasReadyFixPrompt(upsertRes.body)
      ? 'fix prompt: ready-to-paste'
      : `fix prompt: fill-in (${fixPromptFallbackReason})`)
  }

  const strongCount = plan.strongFindings.length
  const normalCount = plan.normalFindings.length
  safeLog(
    `MegaLens review ${effectiveStatus} (${effectiveTier}) for ${headSha.slice(0, 7)}: ${strongCount} strong (${inlinePostedCount} inline), ${normalCount} summary.`,
  )

  const failForIncomplete = cfg.failOn !== 'none' && (effectiveStatus === 'partial' || effectiveStatus === 'failed')
  const failForEngine = effectiveStatus === 'failed'
  const failForFindings = cfg.failOn === 'strong' && effectiveStatus === 'complete' && strongCount > 0
  const exitCode = failForIncomplete || failForEngine || failForFindings ? 1 : 0

  let error = undefined
  if (failForIncomplete) {
    error = `Review is incomplete (${effectiveStatus}); failing because MEGALENS_FAIL_ON is "${cfg.failOn}".`
  } else if (failForEngine) {
    error = isGatewayRefused ? summaryErrorMessage : `Review failed (${effectiveStatus}).`
  } else if (failForFindings) {
    error = `Found ${strongCount} strong finding(s) with MEGALENS_FAIL_ON=strong.`
  }

  return {
    status: effectiveStatus,
    reviewId: effectiveDoc.review_id,
    strongFindings: plan.strongFindings,
    normalFindings: plan.normalFindings,
    inlinePostedCount,
    exitCode,
    ...(error ? { error } : {}),
  }
}
