const VALID_STATUSES = new Set(['complete', 'partial', 'failed'])
const VALID_TIERS = new Set(['standard', 'double', 'deep'])
const VALID_TARGET_KINDS = new Set(['uncommitted', 'range'])
const VALID_PASS_STATUSES = new Set(['ok', 'failed'])
const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3'])
const VALID_STRENGTHS = new Set(['strong', 'normal'])
const VALID_DROP_REASONS = new Set(['dedupe', 'quiet'])

const PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3']
const INLINE_PRIORITIES = new Set(['P0', 'P1'])
const STATUS_RANK = { complete: 0, partial: 1, failed: 2 }

export const MAX_FINDINGS_BYTES = 5 * 1024 * 1024
export const MAX_FINDINGS_COUNT = 1000
export const MAX_PASSES_COUNT = 50
export const MAX_DROPPED_COUNT = 2000
export const MAX_NOTES_COUNT = 100
export const MAX_STRING_LENGTHS = Object.freeze({
  id: 128,
  file: 1024,
  title: 500,
  claim: 10_000,
  failure_scenario: 10_000,
  evidence_quote: 4000,
  found_by_item: 128,
  review_id: 128,
  sha: 128,
  pass_name: 128,
  pass_model: 128,
  pass_effort: 64,
  pass_reason: 128,
  pass_detail: 2000,
  route: 64,
  superseded_by: 64,
  audit_label: 128,
  note: 1000,
  isolation: 64,
  error: 2000,
  reason: 128,
})

const ALLOWED_ROOT_KEYS = new Set([
  'schema',
  'review_id',
  'tier',
  'status',
  'target',
  'passes',
  'findings',
  'dropped_by_quiet_mode',
  'dropped_findings',
  'usage',
  'notes',
  'sandbox',
  'isolation',
  'route',
  'refused',
  'reason',
  'error',
])
const ALLOWED_SANDBOX_KEYS = new Set(['excluded_files', 'skipped_files'])
const ALLOWED_TARGET_KEYS = new Set(['kind', 'base', 'head', 'snapshot_sha256'])
const ALLOWED_PASS_KEYS = new Set([
  'name',
  'model',
  'effort',
  'status',
  'minutes',
  'reason',
  'route',
  'detail',
  'superseded_by',
  'waived',
  'short_run',
])
const ALLOWED_FINDING_KEYS = new Set([
  'id',
  'file',
  'line_start',
  'line_end',
  'title',
  'claim',
  'failure_scenario',
  'priority',
  'strength',
  'found_by',
  'evidence_quote',
])
const ALLOWED_DROPPED_KEYS = new Set(['finding', 'drop_reason', 'kept_id', 'audit_label', 'audit_tokens'])
const ALLOWED_USAGE_KEYS = new Set(['requests', 'input_tokens', 'cached_input_tokens', 'output_tokens'])

function assertPlainObject(val, label) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new Error(`Invalid findings.json: ${label} must be a JSON object.`)
  }
}

function assertAllowedKeys(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid findings.json: unexpected field "${key}" in ${label}.`)
    }
  }
}

function assertBoundedString(val, maxLen, label, { required = false, nonEmpty = false } = {}) {
  if (val === undefined || val === null) {
    if (required) {
      throw new Error(`Invalid findings.json: ${label} is required.`)
    }
    return val === null ? null : undefined
  }
  if (typeof val !== 'string') {
    throw new Error(`Invalid findings.json: ${label} must be a string.`)
  }
  if (val.length > maxLen) {
    throw new Error(`Invalid findings.json: ${label} exceeds max length ${maxLen}.`)
  }
  if (nonEmpty && val.trim().length === 0) {
    throw new Error(`Invalid findings.json: ${label} must not be empty.`)
  }
  return val
}

function assertOptionalNonNegInt(val, label) {
  if (val === undefined || val === null) return undefined
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
    throw new Error(`Invalid findings.json: ${label} must be a non-negative integer.`)
  }
  return val
}

function validateFinding(f, index, labelPrefix = 'findings') {
  const label = `${labelPrefix}[${index}]`
  assertPlainObject(f, label)
  assertAllowedKeys(f, ALLOWED_FINDING_KEYS, label)

  const idRaw = assertBoundedString(f.id, MAX_STRING_LENGTHS.id, `${label}.id`)
  const fileRaw = assertBoundedString(f.file, MAX_STRING_LENGTHS.file, `${label}.file`)
  const titleRaw = assertBoundedString(f.title, MAX_STRING_LENGTHS.title, `${label}.title`, {
    required: true,
    nonEmpty: true,
  })
  const claimRaw = assertBoundedString(f.claim, MAX_STRING_LENGTHS.claim, `${label}.claim`)
  const scenarioRaw = assertBoundedString(
    f.failure_scenario,
    MAX_STRING_LENGTHS.failure_scenario,
    `${label}.failure_scenario`,
  )
  const evidenceRaw = assertBoundedString(
    f.evidence_quote,
    MAX_STRING_LENGTHS.evidence_quote,
    `${label}.evidence_quote`,
  )

  if (typeof f.priority !== 'string' || !VALID_PRIORITIES.has(f.priority.toUpperCase())) {
    throw new Error(`Invalid findings.json: ${label}.priority must be one of P0, P1, P2, P3.`)
  }
  if (typeof f.strength !== 'string' || !VALID_STRENGTHS.has(f.strength)) {
    throw new Error(`Invalid findings.json: ${label}.strength must be "strong" or "normal".`)
  }

  let lineStart
  if (f.line_start !== undefined && f.line_start !== null) {
    if (typeof f.line_start !== 'number' || !Number.isInteger(f.line_start) || f.line_start <= 0) {
      throw new Error(`Invalid findings.json: ${label}.line_start must be a positive integer.`)
    }
    lineStart = f.line_start
  }

  let lineEnd
  if (f.line_end !== undefined && f.line_end !== null) {
    if (typeof f.line_end !== 'number' || !Number.isInteger(f.line_end) || f.line_end <= 0) {
      throw new Error(`Invalid findings.json: ${label}.line_end must be a positive integer.`)
    }
    if (lineStart !== undefined && f.line_end < lineStart) {
      throw new Error(`Invalid findings.json: ${label}.line_end cannot be less than line_start.`)
    }
    lineEnd = f.line_end
  }

  let foundBy = []
  if (f.found_by !== undefined && f.found_by !== null) {
    if (!Array.isArray(f.found_by) || f.found_by.length > 20) {
      throw new Error(`Invalid findings.json: ${label}.found_by must be an array of up to 20 strings.`)
    }
    foundBy = f.found_by.map((item, j) =>
      assertBoundedString(item, MAX_STRING_LENGTHS.found_by_item, `${label}.found_by[${j}]`, { required: true }),
    )
  }

  return {
    id: idRaw && idRaw.trim() ? idRaw.trim() : `finding-${index + 1}`,
    file: fileRaw ?? '',
    line_start: lineStart,
    line_end: lineEnd,
    title: titleRaw.trim(),
    claim: claimRaw ? claimRaw.trim() : '',
    failure_scenario: scenarioRaw ? scenarioRaw.trim() : '',
    priority: f.priority.toUpperCase(),
    strength: f.strength,
    found_by: foundBy,
    evidence_quote: typeof evidenceRaw === 'string' ? evidenceRaw : undefined,
  }
}

/**
 * Parse and strictly validate a megalens.findings/v1 JSON payload:
 * enforces size cap, required schema/types, string lengths, enum values, and no unexpected fields.
 * @param {string | Buffer | Record<string, unknown>} input
 */
export function parseFindingsDocument(input) {
  let doc
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    const byteLen = Buffer.isBuffer(input) ? input.byteLength : Buffer.byteLength(input, 'utf8')
    if (byteLen > MAX_FINDINGS_BYTES) {
      throw new Error(`Invalid findings.json: exceeds ${MAX_FINDINGS_BYTES} byte size limit.`)
    }
    const text = Buffer.isBuffer(input) ? input.toString('utf8') : input
    try {
      doc = JSON.parse(text)
    } catch (err) {
      throw new Error(`Invalid findings.json JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    assertPlainObject(input, 'root')
    const serializedBytes = Buffer.byteLength(JSON.stringify(input), 'utf8')
    if (serializedBytes > MAX_FINDINGS_BYTES) {
      throw new Error(`Invalid findings.json: exceeds ${MAX_FINDINGS_BYTES} byte size limit.`)
    }
    doc = input
  }

  assertPlainObject(doc, 'root')
  assertAllowedKeys(doc, ALLOWED_ROOT_KEYS, 'root')

  if (doc.schema !== 'megalens.findings/v1') {
    throw new Error(`Unsupported findings schema: ${String(doc.schema ?? 'missing')}`)
  }
  if (typeof doc.status !== 'string' || !VALID_STATUSES.has(doc.status)) {
    throw new Error(`Invalid findings status: ${String(doc.status ?? 'missing')}`)
  }

  const reviewId = assertBoundedString(doc.review_id, MAX_STRING_LENGTHS.review_id, 'review_id') ?? null

  let tier = null
  if (doc.tier !== undefined && doc.tier !== null) {
    if (typeof doc.tier !== 'string' || !VALID_TIERS.has(doc.tier)) {
      throw new Error(`Invalid findings.json: tier must be standard, double, or deep (got "${String(doc.tier)}").`)
    }
    tier = doc.tier
  }

  if (!Array.isArray(doc.findings)) {
    throw new Error('Invalid findings.json: findings must be an array.')
  }
  if (doc.findings.length > MAX_FINDINGS_COUNT) {
    throw new Error(`Invalid findings.json: findings count exceeds max ${MAX_FINDINGS_COUNT}.`)
  }
  const findings = doc.findings.map((f, index) => validateFinding(f, index, 'findings'))

  let passes = []
  if (doc.passes !== undefined) {
    if (!Array.isArray(doc.passes)) {
      throw new Error('Invalid findings.json: passes must be an array.')
    }
    if (doc.passes.length > MAX_PASSES_COUNT) {
      throw new Error(`Invalid findings.json: passes count exceeds max ${MAX_PASSES_COUNT}.`)
    }
    passes = doc.passes.map((p, index) => {
      const label = `passes[${index}]`
      assertPlainObject(p, label)
      assertAllowedKeys(p, ALLOWED_PASS_KEYS, label)
      const name = assertBoundedString(p.name, MAX_STRING_LENGTHS.pass_name, `${label}.name`, {
        required: true,
        nonEmpty: true,
      })
      if (typeof p.status !== 'string' || !VALID_PASS_STATUSES.has(p.status)) {
        throw new Error(`Invalid findings.json: ${label}.status must be "ok" or "failed".`)
      }
      const model = assertBoundedString(p.model, MAX_STRING_LENGTHS.pass_model, `${label}.model`)
      const effort = assertBoundedString(p.effort, MAX_STRING_LENGTHS.pass_effort, `${label}.effort`)
      const reason = assertBoundedString(p.reason, MAX_STRING_LENGTHS.pass_reason, `${label}.reason`)
      const route = assertBoundedString(p.route, MAX_STRING_LENGTHS.route, `${label}.route`)
      const detail = assertBoundedString(p.detail, MAX_STRING_LENGTHS.pass_detail, `${label}.detail`)
      const supersededBy = assertBoundedString(
        p.superseded_by,
        MAX_STRING_LENGTHS.superseded_by,
        `${label}.superseded_by`,
      )
      let waived
      if (p.waived !== undefined) {
        if (typeof p.waived !== 'boolean') {
          throw new Error(`Invalid findings.json: ${label}.waived must be a boolean.`)
        }
        waived = p.waived
      }
      let shortRun
      if (p.short_run !== undefined) {
        if (typeof p.short_run !== 'boolean') {
          throw new Error(`Invalid findings.json: ${label}.short_run must be a boolean.`)
        }
        shortRun = p.short_run
      }
      if (p.minutes !== undefined && p.minutes !== null) {
        if (typeof p.minutes !== 'number' || !Number.isFinite(p.minutes) || p.minutes < 0) {
          throw new Error(`Invalid findings.json: ${label}.minutes must be a non-negative number.`)
        }
      }
      return {
        name,
        model: typeof model === 'string' ? model : undefined,
        effort: typeof effort === 'string' ? effort : undefined,
        status: p.status,
        minutes: typeof p.minutes === 'number' ? p.minutes : undefined,
        ...(typeof reason === 'string' ? { reason } : {}),
        ...(typeof route === 'string' ? { route } : {}),
        ...(typeof detail === 'string' ? { detail } : {}),
        ...(typeof supersededBy === 'string' ? { superseded_by: supersededBy } : {}),
        ...(typeof waived === 'boolean' ? { waived } : {}),
        ...(typeof shortRun === 'boolean' ? { short_run: shortRun } : {}),
      }
    })
  }

  const target = { kind: null, base: null, head: null, snapshot_sha256: null }
  if (doc.target !== undefined) {
    assertPlainObject(doc.target, 'target')
    assertAllowedKeys(doc.target, ALLOWED_TARGET_KEYS, 'target')
    if (doc.target.kind !== undefined && doc.target.kind !== null) {
      if (typeof doc.target.kind !== 'string' || !VALID_TARGET_KINDS.has(doc.target.kind)) {
        throw new Error(`Invalid findings.json: target.kind must be "uncommitted" or "range".`)
      }
      target.kind = doc.target.kind
    }
    target.base = assertBoundedString(doc.target.base, MAX_STRING_LENGTHS.sha, 'target.base') ?? null
    target.head = assertBoundedString(doc.target.head, MAX_STRING_LENGTHS.sha, 'target.head') ?? null
    target.snapshot_sha256 =
      assertBoundedString(doc.target.snapshot_sha256, MAX_STRING_LENGTHS.sha, 'target.snapshot_sha256') ?? null
  }

  const droppedByQuiet = assertOptionalNonNegInt(doc.dropped_by_quiet_mode, 'dropped_by_quiet_mode')

  let droppedFindings
  if (doc.dropped_findings !== undefined) {
    if (!Array.isArray(doc.dropped_findings)) {
      throw new Error('Invalid findings.json: dropped_findings must be an array.')
    }
    if (doc.dropped_findings.length > MAX_DROPPED_COUNT) {
      throw new Error(`Invalid findings.json: dropped_findings exceeds max ${MAX_DROPPED_COUNT}.`)
    }
    droppedFindings = doc.dropped_findings.map((d, index) => {
      const label = `dropped_findings[${index}]`
      assertPlainObject(d, label)
      assertAllowedKeys(d, ALLOWED_DROPPED_KEYS, label)
      if (typeof d.drop_reason !== 'string' || !VALID_DROP_REASONS.has(d.drop_reason)) {
        throw new Error(`Invalid findings.json: ${label}.drop_reason must be "dedupe" or "quiet".`)
      }
      const finding = validateFinding(d.finding, index, 'dropped_findings')
      const keptId = assertBoundedString(d.kept_id, MAX_STRING_LENGTHS.id, `${label}.kept_id`)
      const auditLabel = assertBoundedString(d.audit_label, MAX_STRING_LENGTHS.audit_label, `${label}.audit_label`)
      const auditTokens = assertOptionalNonNegInt(d.audit_tokens, `${label}.audit_tokens`)
      return {
        finding,
        drop_reason: d.drop_reason,
        ...(typeof keptId === 'string' ? { kept_id: keptId } : {}),
        ...(typeof auditLabel === 'string' ? { audit_label: auditLabel } : {}),
        ...(typeof auditTokens === 'number' ? { audit_tokens: auditTokens } : {}),
      }
    })
  }

  let usage
  if (doc.usage !== undefined) {
    assertPlainObject(doc.usage, 'usage')
    assertAllowedKeys(doc.usage, ALLOWED_USAGE_KEYS, 'usage')
    usage = {}
    for (const k of ALLOWED_USAGE_KEYS) {
      if (doc.usage[k] !== undefined) {
        usage[k] = assertOptionalNonNegInt(doc.usage[k], `usage.${k}`)
      }
    }
  }

  const topReason = assertBoundedString(doc.reason, MAX_STRING_LENGTHS.reason, 'reason')
  const errorStr = assertBoundedString(doc.error, MAX_STRING_LENGTHS.error, 'error')

  let notes
  if (doc.notes !== undefined) {
    if (!Array.isArray(doc.notes)) {
      throw new Error('Invalid findings.json: notes must be an array.')
    }
    if (doc.notes.length > MAX_NOTES_COUNT) {
      throw new Error(`Invalid findings.json: notes count exceeds max ${MAX_NOTES_COUNT}.`)
    }
    notes = doc.notes.map((n, index) =>
      assertBoundedString(n, MAX_STRING_LENGTHS.note, `notes[${index}]`, { required: true }),
    )
  }

  let sandbox
  if (doc.sandbox !== undefined) {
    assertPlainObject(doc.sandbox, 'sandbox')
    assertAllowedKeys(doc.sandbox, ALLOWED_SANDBOX_KEYS, 'sandbox')
    sandbox = {}
    for (const k of ALLOWED_SANDBOX_KEYS) {
      if (doc.sandbox[k] !== undefined) {
        sandbox[k] = assertOptionalNonNegInt(doc.sandbox[k], `sandbox.${k}`)
      }
    }
  }

  const isolation = assertBoundedString(doc.isolation, MAX_STRING_LENGTHS.isolation, 'isolation')
  const route = assertBoundedString(doc.route, MAX_STRING_LENGTHS.route, 'route')

  let refused
  if (doc.refused !== undefined) {
    if (typeof doc.refused !== 'boolean') {
      throw new Error('Invalid findings.json: refused must be a boolean.')
    }
    refused = doc.refused
  }

  return {
    schema: 'megalens.findings/v1',
    review_id: reviewId,
    tier,
    status: doc.status,
    target,
    passes,
    findings,
    ...(typeof droppedByQuiet === 'number' ? { dropped_by_quiet_mode: droppedByQuiet } : {}),
    ...(droppedFindings !== undefined ? { dropped_findings: droppedFindings } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(typeof isolation === 'string' ? { isolation } : {}),
    ...(typeof route === 'string' ? { route } : {}),
    ...(typeof refused === 'boolean' ? { refused } : {}),
    ...(typeof topReason === 'string' ? { reason: topReason } : {}),
    ...(typeof errorStr === 'string' ? { error: errorStr } : {}),
  }
}

/**
 * Compute effective review status = worst of doc.status, exit-code status
 * (0 = complete, 2 = partial, 3/4/other = failed), and live pass statuses.
 * Superseded passes (those with `superseded_by`) are skipped; a live pass with
 * `short_run: true` makes the review partial.
 * A gateway-refused document is always failed.
 * @param {'complete' | 'partial' | 'failed'} docStatus
 * @param {number} exitCode
 * @param {Array<{ status?: string, superseded_by?: string, short_run?: boolean }>} [passes]
 * @param {boolean} [refused]
 * @returns {'complete' | 'partial' | 'failed'}
 */
export function computeEffectiveStatus(docStatus, exitCode, passes = [], refused = false) {
  if (refused === true) return 'failed'
  const docNorm = VALID_STATUSES.has(docStatus) ? docStatus : 'failed'

  let exitStatus = 'failed'
  if (exitCode === 0) exitStatus = 'complete'
  else if (exitCode === 2) exitStatus = 'partial'

  let passStatus = 'complete'
  if (Array.isArray(passes) && passes.length > 0) {
    const livePasses = passes.filter((p) => !p?.superseded_by)
    if (livePasses.length > 0) {
      const failedCount = livePasses.filter((p) => p?.status !== 'ok').length
      if (failedCount === livePasses.length) passStatus = 'failed'
      else if (failedCount > 0 || livePasses.some((p) => p?.short_run === true)) passStatus = 'partial'
    }
  }

  let worst = docNorm
  for (const candidate of [exitStatus, passStatus]) {
    if (STATUS_RANK[candidate] > STATUS_RANK[worst]) {
      worst = candidate
    }
  }
  return worst
}

/**
 * Priority rank for sorting (P0 highest).
 * @param {string} priority
 * @returns {number}
 */
export function priorityRank(priority) {
  const idx = PRIORITY_ORDER.indexOf(String(priority ?? '').toUpperCase())
  return idx === -1 ? PRIORITY_ORDER.length : idx
}

/**
 * Sort findings by priority (P0..P3), then strong before normal, then file and line.
 * @template {{ priority?: string, strength?: string, file?: string, line_start?: number }} T
 * @param {T[]} findings
 * @returns {T[]}
 */
export function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const pDiff = priorityRank(a.priority) - priorityRank(b.priority)
    if (pDiff !== 0) return pDiff
    const sDiff = (a.strength === 'strong' ? 0 : 1) - (b.strength === 'strong' ? 0 : 1)
    if (sDiff !== 0) return sDiff
    const fDiff = String(a.file ?? '').localeCompare(String(b.file ?? ''))
    if (fDiff !== 0) return fDiff
    return (a.line_start ?? 0) - (b.line_start ?? 0)
  })
}

/**
 * Whether a finding qualifies for inline PR review commenting:
 * strength === 'strong' AND priority is P0/P1 AND file+line_start fall inside a diff hunk.
 * @param {{ strength?: string, priority?: string, file?: string, line_start?: number }} finding
 * @param {boolean} [inDiffHunk=true]
 * @returns {boolean}
 */
export function isStrongFinding(finding, inDiffHunk = true) {
  if (!finding || finding.strength !== 'strong') return false
  const priority = String(finding.priority ?? '').toUpperCase()
  if (!INLINE_PRIORITIES.has(priority)) return false
  if (typeof finding.file !== 'string' || !finding.file.trim()) return false
  if (typeof finding.line_start !== 'number' || !Number.isInteger(finding.line_start) || finding.line_start <= 0) {
    return false
  }
  return Boolean(inDiffHunk)
}

/** True when the engine refused the change as too large for one review (engine exit 3, reason too_large). */
export function isTooLargeDoc(doc) {
  if (!doc || typeof doc !== 'object') return false
  if (doc.reason === 'too_large') return true
  return Array.isArray(doc.passes) && doc.passes[0]?.reason === 'too_large'
}

/**
 * Strict check used by the Action: engine exit 3 AND refused=true AND top-level reason too_large AND the
 * document's head equals the target head. Anything else is not treated as a too-large refusal.
 */
export function isVerifiedTooLarge(doc, exitCode, headSha) {
  if (!doc || typeof doc !== 'object') return false
  return exitCode === 3
    && doc.refused === true
    && doc.reason === 'too_large'
    && typeof headSha === 'string' && headSha !== ''
    && doc.target?.head === headSha
}

/**
 * The one message shown for a too-large refusal. Numbers come from the engine's first note
 * ("... (N files, about M lines) ..."); without them the sentence simply leaves them out.
 */
export function tooLargeMessage(doc) {
  const note = Array.isArray(doc?.notes) && typeof doc.notes[0] === 'string' ? doc.notes[0] : ''
  const m = /\((\d[\d,]*) files?, about (\d[\d,]*) lines?\)/.exec(note)
  const size = m ? ` (${m[1]} files, about ${m[2]} lines)` : ''
  return `MegaLens did not review this pull request: it is too large for one review${size}. Split it into smaller pull requests. No credits were used.`
}
