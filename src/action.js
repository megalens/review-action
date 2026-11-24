import { access, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSandbox, SETUP_MODES } from './sandbox.js'
import { hasWritePermission, isBotUser, parseCommentCommand } from './commands.js'
import { partitionFindingsByDiff, resolveFindingPath } from './diff.js'
import {
  BYO_DISABLED_MESSAGE,
  BYO_KEY_ENABLED,
  DOUBLE_DISABLED_MESSAGE,
  DOUBLE_TIER_ENABLED,
  PINNED_ENGINE_VERSION,
  resolveAuthEnv,
  runEngineCli,
} from './engine.js'
export {
  BYO_DISABLED_MESSAGE,
  BYO_KEY_ENABLED,
  DOUBLE_DISABLED_MESSAGE,
  DOUBLE_TIER_ENABLED,
} from './engine.js'
import {
  computeEffectiveStatus,
  isStrongFinding,
  isVerifiedTooLarge,
  parseFindingsDocument,
  sortFindings,
  tooLargeMessage,
} from './findings.js'
import {
  formatInlineComment,
  formatSummaryComment,
  formatTooLargeComment,
  formatWalkthroughComment,
  MAX_INLINE_COMMENTS,
  parseInlineMarker,
  parseSummaryMeta,
  summaryMarker,
  titleHash,
  WALKTHROUGH_MARKER,
} from './format.js'
import { createGitHubApi, isForkPullRequest } from './github-api.js'
export { isForkPullRequest } from './github-api.js'
import { createMegaLensReview, DEFAULT_MEGALENS_API_URL, normalizeTrustedApiUrl } from './megalens-api.js'
import { errorText, redactSecrets } from './redact.js'

const VALID_TIERS = new Set(['standard', 'double', 'deep'])
const VALID_FAIL_ON = new Set(['none', 'strong'])
const VALID_MODES = new Set(['create', 'review', 'publish', 'full'])
const SUPPORTED_PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened'])
const SAFE_ARTIFACT_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/
const SHA40_RE = /^[0-9a-f]{40}$/i
const ZERO_SHA = '0'.repeat(40)
const TRUSTED_PR_AUTHORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const APP_OVERLAP_LINE_WINDOW = 5
export const BURST_GUARD_WINDOW_MS = 5 * 60 * 1000

export const DEFAULT_APP_BOT_LOGINS = ['megalens[bot]', 'megalens-app[bot]', 'megalens-review[bot]']
export const FORK_SKIP_SUMMARY = 'skipped: fork PR; a maintainer can comment /megalens review'
export const BYO_FORK_SKIP_SUMMARY = 'skipped: BYO key is not used on fork PRs; use a MegaLens token'

function changedPaths(files) {
  return new Set(files.filter(f => typeof f?.filename === 'string' && f.status !== 'removed' && f.status !== 'unchanged').map(f => f.filename))
}

/**
 * Detect whether the workflow is running on a self-hosted runner.
 * @param {Record<string, string | undefined>} env
 * @param {any} payload
 * @returns {boolean}
 */
export function isSelfHostedRunner(env = {}, payload = null) {
  const runnerEnv = String(env.RUNNER_ENVIRONMENT ?? payload?.runner?.environment ?? '').trim().toLowerCase()
  return runnerEnv === 'self-hosted'
}

/** Options for prepareSandbox. Only an exact RUNNER_ENVIRONMENT of github-hosted counts as hosted; it is a yes/no, never put in a command. */
export function sandboxOptions(env = {}, setupSandbox = 'auto', warn = undefined) {
  return { mode: setupSandbox, hosted: env.RUNNER_ENVIRONMENT === 'github-hosted', ...(warn ? { warn } : {}) }
}

/**
 * Parse owner and repo name from payload or GITHUB_REPOSITORY.
 * @param {any} payload
 * @param {Record<string, string | undefined>} env
 * @returns {{ owner: string, repo: string }}
 */
export function resolveRepository(payload, env) {
  const owner = payload?.repository?.owner?.login
  const repo = payload?.repository?.name
  if (typeof owner === 'string' && owner && typeof repo === 'string' && repo) {
    return { owner, repo }
  }
  const full = env.GITHUB_REPOSITORY || payload?.repository?.full_name || ''
  const parts = String(full).split('/')
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { owner: parts[0], repo: parts[1] }
  }
  throw new Error('Could not determine repository owner and name.')
}

/** A 40-hex SHA shown as its 7-char prefix; anything else as a fixed label, never as artifact text. */
export function shortShaOrLabel(v) {
  if (v === undefined || v === null || v === '') return 'missing'
  return typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v) ? v.slice(0, 7) : 'not a valid SHA'
}

function getInput(env, name, defaultValue = '') {
  const exactKey = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
  const altKey = `INPUT_${name.replace(/[- ]/g, '_').toUpperCase()}`
  const raw = env[exactKey] ?? env[altKey]
  if (typeof raw !== 'string') return defaultValue
  const trimmed = raw.trim()
  return trimmed === '' ? defaultValue : trimmed
}

export function parseInputs(env) {
  const tier = getInput(env, 'tier', 'standard').toLowerCase()
  if (!VALID_TIERS.has(tier)) {
    throw new Error(`Invalid tier "${tier}". Expected standard, double, or deep.`)
  }
  const failOn = getInput(env, 'fail-on', 'none').toLowerCase()
  if (!VALID_FAIL_ON.has(failOn)) {
    throw new Error(`Invalid fail-on "${failOn}". Expected none or strong.`)
  }
  const rawMode = getInput(env, 'mode', '')
  if (!rawMode && env.GITHUB_ACTIONS === 'true') {
    throw new Error('Missing required input "mode". Expected create, review, publish, or full.')
  }
  const mode = (rawMode || 'full').toLowerCase()
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid mode "${mode}". Expected create, review, publish, or full.`)
  }
  const artifactName = getInput(env, 'artifact-name', 'megalens-findings')
  if (!SAFE_ARTIFACT_NAME_RE.test(artifactName) || artifactName.includes('..')) {
    throw new Error(`Invalid artifact-name "${artifactName}". Expected 1-100 safe characters [A-Za-z0-9._-].`)
  }
  const rawHeadSha = getInput(env, 'head-sha', '')
  if (rawHeadSha && !SHA40_RE.test(rawHeadSha)) {
    throw new Error(`Invalid head-sha "${rawHeadSha}". Expected a 40-character hex SHA.`)
  }
  const rawBaseSha = getInput(env, 'base-sha', '')
  if (rawBaseSha && !SHA40_RE.test(rawBaseSha)) {
    throw new Error(`Invalid base-sha "${rawBaseSha}". Expected a 40-character hex SHA.`)
  }
  const inlineRaw = getInput(env, 'inline', '').toLowerCase()
  let inline = null
  if (inlineRaw === 'true') inline = true
  else if (inlineRaw === 'false') inline = false
  else if (inlineRaw !== '') {
    throw new Error(`Invalid inline "${inlineRaw}". Expected true or false.`)
  }

  const setupSandbox = getInput(env, 'setup-sandbox', 'auto').toLowerCase()
  if (!SETUP_MODES.includes(setupSandbox)) {
    throw new Error(`Invalid setup-sandbox "${setupSandbox}". Expected auto, force, or off.`)
  }
  const timeoutRaw = getInput(env, 'timeout-minutes', '25')
  const timeoutMinutes = Number(timeoutRaw)
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error(`Invalid timeout-minutes "${timeoutRaw}". Expected a positive number.`)
  }

  return {
    tier,
    failOn,
    mode,
    artifactName,
    headSha: rawHeadSha.toLowerCase(),
    baseSha: rawBaseSha.toLowerCase(),
    inline,
    findingsPath: getInput(env, 'findings-path', ''),
    timeoutMinutes,
    engineVersion: getInput(env, 'engine-version', PINNED_ENGINE_VERSION),
    setupSandbox,
    megalensToken: getInput(env, 'megalens-token', ''),
    reviewId: getInput(env, 'review-id', '') || String(env.MEGALENS_REVIEW_ID || '').trim(),
    reviewKey: getInput(env, 'review-key', '') || String(env.MEGALENS_REVIEW_KEY || '').trim(),
    openaiApiKey: getInput(env, 'openai-api-key', ''),
    apiUrl: getInput(env, 'api-url', '') || String(env.MEGALENS_API_URL || '').trim() || DEFAULT_MEGALENS_API_URL,
    githubToken: getInput(env, 'github-token', '') || env.GITHUB_TOKEN || '',
  }
}

function extractBodyTitleHash(body) {
  if (typeof body !== 'string') return null
  const firstLine = body.split(/\r?\n/).find((l) => l.trim().length > 0)
  if (!firstLine) return null
  const strongMatch = /^\*\*P[0-3]\s*\(strong\):\s*(.+?)\*\*$/i.exec(firstLine.trim())
  const boldMatch = /^\*\*(.+?)\*\*$/.exec(firstLine.trim())
  const rawTitle = strongMatch ? strongMatch[1] : boldMatch ? boldMatch[1] : firstLine.trim()
  return rawTitle ? titleHash(rawTitle) : null
}

/**
 * Filter out strong findings that already have an inline comment with the same
 * stable key (authored by our own login) or overlapping/within-5-lines MegaLens App
 * comment on the same file (F10).
 * Comments from any other author are ignored so markers cannot be spoofed.
 * @param {Array<{ file: string, line_start: number, line_end?: number, title: string }>} strongFindings
 * @param {Array<{ user?: { login?: string }, body?: string, path?: string, line?: number | null, original_line?: number | null }>} existingComments
 * @param {{ ownLogin?: string | null, appBotLogins?: string[] }} [opts]
 */
export function selectNewInlineFindings(strongFindings, existingComments, opts = {}) {
  const ownLogin = typeof opts.ownLogin === 'string' && opts.ownLogin.trim()
    ? opts.ownLogin.trim().toLowerCase()
    : null
  const appBots = new Set((opts.appBotLogins ?? DEFAULT_APP_BOT_LOGINS).map((l) => String(l).toLowerCase()))

  const ownKeys = new Set()
  const appKeys = new Set()
  /** @type {Array<{ file: string, start: number, end: number }>} */
  const appRanges = []

  for (const comment of existingComments) {
    const author = typeof comment?.user?.login === 'string' ? comment.user.login.toLowerCase() : ''
    if (!author) continue
    const isOwn = Boolean(ownLogin && author === ownLogin)
    const isApp = appBots.has(author)
    if (!isOwn && !isApp) continue

    const parsed = parseInlineMarker(comment?.body)
    if (parsed) {
      // GitHub still supplies the actual path when the displayed marker had to redact it.
      const file = parsed.file.includes('[redacted]') && comment.path ? comment.path : parsed.file
      const rangeKey = `${file}\0${parsed.lineStart}-${parsed.lineEnd}\0${parsed.titleSha}`
      if (isOwn) ownKeys.add(rangeKey)
      if (isApp) {
        appKeys.add(rangeKey)
        appKeys.add(`${file}\0${parsed.lineStart}\0${parsed.titleSha}`)
        appRanges.push({ file, start: parsed.lineStart, end: parsed.lineEnd })
      }
      continue
    }

    if (isApp) {
      const path = typeof comment?.path === 'string' ? comment.path : ''
      const line = typeof comment?.line === 'number'
        ? comment.line
        : typeof comment?.original_line === 'number'
          ? comment.original_line
          : null
      const hash = extractBodyTitleHash(comment?.body)
      if (path && typeof line === 'number' && line > 0) {
        appRanges.push({ file: path, start: line, end: line })
        if (hash) {
          appKeys.add(`${path}\0${line}\0${hash}`)
        }
      }
    }
  }

  const toPost = []
  const appOverlapFindings = []
  let alreadyPostedCount = 0
  for (const finding of strongFindings) {
    const start = finding.line_start
    const end = finding.line_end && finding.line_end >= start ? finding.line_end : start
    const hash = titleHash(finding.title)
    const rangeKey = `${finding.file}\0${start}-${end}\0${hash}`
    const lineKey = `${finding.file}\0${start}\0${hash}`

    const matchedAppOverlap = appRanges.some(
      (r) => r.file === finding.file && start <= r.end + APP_OVERLAP_LINE_WINDOW && end >= r.start - APP_OVERLAP_LINE_WINDOW,
    )

    if (ownKeys.has(rangeKey)) {
      alreadyPostedCount += 1
      continue
    }
    if (appKeys.has(rangeKey) || appKeys.has(lineKey) || matchedAppOverlap) {
      alreadyPostedCount += 1
      appOverlapFindings.push({ ...finding, alsoFoundByApp: true })
      continue
    }
    if (toPost.length < MAX_INLINE_COMMENTS) {
      toPost.push(finding)
    }
  }
  return { toPost, alreadyPostedCount, appOverlapFindings }
}

async function resolveDefaultPublishPath(runnerTemp, artifactName) {
  const direct = join(runnerTemp, 'findings.json')
  try {
    await access(direct)
    return direct
  } catch {
    const nested = join(runnerTemp, artifactName, 'findings.json')
    try {
      await access(nested)
      return nested
    } catch {
      return direct
    }
  }
}

/**
 * Run the MegaLens GitHub Action.
 * Designed for full dependency injection so unit tests run with zero network or subprocesses.
 */
export async function runAction(deps = {}) {
  const byoKeyEnabled = typeof deps.byoKeyEnabled === 'boolean' ? deps.byoKeyEnabled : BYO_KEY_ENABLED
  const doubleTierEnabled = typeof deps.doubleTierEnabled === 'boolean' ? deps.doubleTierEnabled : DOUBLE_TIER_ENABLED
  const nowMs = typeof deps.now === 'function' ? deps.now() : typeof deps.now === 'number' ? deps.now : Date.now()
  const env = deps.env ?? process.env
  const writeSummary = deps.writeSummary ?? (() => {})
  const setOutput = deps.setOutput ?? (() => {})
  const maskSecret = deps.maskSecret ?? (() => {})
  const rawWarn = deps.warn ?? (() => {})
  const runEngine = deps.runEngine ?? ((opts) => runEngineCli(opts, { byoKeyEnabled, doubleTierEnabled }))
  // Production only: a test that injects its own engine never touches the real runner.
  const prepareSandboxFn = deps.prepareSandbox ?? (deps.runEngine ? null : () => prepareSandbox(sandboxOptions(env, inputs.setupSandbox, warn)))
  const createApi = deps.createGitHubApi ?? ((token) => createGitHubApi(token))
  const createReviewFn = deps.createReview
    ?? ((opts) => createMegaLensReview(opts, { fetchImpl: deps.fetchImpl }))
  const readFindingsFn = deps.readFindingsImpl ?? ((p) => readFile(p, 'utf8'))
  const writeFindingsFn = deps.writeFindingsImpl ?? ((p, content) => writeFile(p, content, 'utf8'))

  const inputs = parseInputs(env)
  if (inputs.megalensToken) maskSecret(inputs.megalensToken)
  if (inputs.openaiApiKey) maskSecret(inputs.openaiApiKey)
  // In create mode, review_key is an output and must NOT be masked in that job (GitHub drops masked outputs).
  // In review/publish modes, mask review_key as the very first step.
  if (inputs.mode !== 'create' && inputs.reviewKey) {
    maskSecret(inputs.reviewKey)
  }

  const secretValues = [
    inputs.megalensToken,
    inputs.openaiApiKey,
    inputs.reviewKey,
    inputs.githubToken,
  ].filter(Boolean)

  const safeText = (text) => redactSecrets(String(text ?? ''), secretValues)
  const warn = (message) => rawWarn(safeText(message))
  const safeError = (err) => errorText(err, secretValues)

  const eventName = env.GITHUB_EVENT_NAME || ''
  const isPush = eventName === 'push'
  if (eventName === 'pull_request_target') {
    const msg = 'Refusing to run on pull_request_target: checking out PR code with repository secrets is unsafe. Use pull_request for normal PRs and issue_comment for maintainer-triggered reviews.'
    await writeSummary(msg)
    setOutput('status', 'failed')
    return { status: 'failed', exitCode: 1, error: msg }
  }

  if (!byoKeyEnabled && inputs.openaiApiKey && inputs.mode !== 'publish') {
    await writeSummary(BYO_DISABLED_MESSAGE)
    await setOutput('status', 'failed')
    return { status: 'failed', exitCode: 1, error: BYO_DISABLED_MESSAGE }
  }

  if (!doubleTierEnabled && inputs.tier === 'double') {
    await writeSummary(DOUBLE_DISABLED_MESSAGE)
    await setOutput('status', 'failed')
    return { status: 'failed', exitCode: 1, error: DOUBLE_DISABLED_MESSAGE }
  }

  if (inputs.mode === 'review' && ((inputs.headSha && !inputs.baseSha) || (!inputs.headSha && inputs.baseSha))) {
    const missing = !inputs.headSha ? 'head-sha' : 'base-sha'
    const msg = `Missing ${missing}: review mode requires both head-sha and base-sha when pinning SHAs.`
    await writeSummary(msg)
    await setOutput('status', 'failed')
    return { status: 'failed', exitCode: 1, error: msg }
  }

  if (inputs.mode === 'review' && inputs.megalensToken) {
    const msg = 'Refusing megalens-token in review mode: the review job must never receive the account token. Create the review in mode: create and pass MEGALENS_REVIEW_ID / MEGALENS_REVIEW_KEY.'
    await writeSummary(msg)
    setOutput('status', 'failed')
    return { status: 'failed', exitCode: 1, error: msg }
  }

  if (inputs.mode === 'review' && ((inputs.reviewId && !inputs.reviewKey) || (!inputs.reviewId && inputs.reviewKey))) {
    const msg = 'Missing review_id or review_key: review mode requires both MEGALENS_REVIEW_ID and MEGALENS_REVIEW_KEY.'
    await writeSummary(msg)
    setOutput('status', 'failed')
    return { status: 'failed', exitCode: 1, error: msg }
  }

  const payload = deps.payload ?? await deps.readEventPayload?.()
  if (!payload || typeof payload !== 'object') {
    throw new Error('Missing GitHub event payload.')
  }

  const auth = inputs.mode === 'review'
    ? resolveAuthEnv(
        {
          openaiApiKey: inputs.openaiApiKey,
          reviewId: inputs.reviewId,
          reviewKey: inputs.reviewKey,
        },
        { byoKeyEnabled },
      )
    : inputs.mode === 'create'
      ? (inputs.megalensToken ? { mode: 'gateway', env: { MEGALENS_TOKEN: inputs.megalensToken } } : null)
      : resolveAuthEnv(
          {
            megalensToken: inputs.megalensToken,
            openaiApiKey: inputs.openaiApiKey,
            reviewId: inputs.reviewId,
            reviewKey: inputs.reviewKey,
          },
          { byoKeyEnabled },
        )

  let owner = ''
  let repo = ''
  let pullNumber = 0
  let baseSha = ''
  let headSha = ''
  let isFork = false
  let selectedTier = inputs.tier
  let tierWarning = null
  let api = null
  let isStandalone = false

  if (eventName === 'pull_request') {
    if (!SUPPORTED_PR_ACTIONS.has(payload.action)) {
      await writeSummary(`skipped: pull_request action "${payload.action ?? ''}" is not reviewed`)
      setOutput('status', 'skipped')
      return { status: 'skipped', reason: 'unsupported_action', exitCode: 0 }
    }
    const pr = payload.pull_request
    if (!pr || typeof pr.number !== 'number') {
      throw new Error('Malformed pull_request event payload.')
    }
    if (pr.state === 'closed') {
      await writeSummary('skipped: pull request is closed')
      setOutput('status', 'skipped')
      return { status: 'skipped', reason: 'closed', exitCode: 0 }
    }

    isFork = isForkPullRequest(pr)
    if (isFork) {
      if (isSelfHostedRunner(env, payload)) {
        const selfHostedWarn = 'Warning: self-hosted runner detected on a fork PR; do not use self-hosted runners on public repos for fork PRs.'
        warn(selfHostedWarn)
        await writeSummary(`${selfHostedWarn}\n\n${FORK_SKIP_SUMMARY}`)
      } else {
        await writeSummary(FORK_SKIP_SUMMARY)
      }
      setOutput('status', 'skipped')
      return { status: 'skipped', reason: 'fork_pr', exitCode: 0 }
    }

    if (inputs.mode === 'create' && !inputs.megalensToken) {
      if (pr.user && isBotUser(pr.user)) {
        const skipMsg = `skipped: no review credentials available for bot PR (${pr.user?.login || 'bot'})`
        await writeSummary(skipMsg)
        setOutput('status', 'skipped')
        return { status: 'skipped', reason: 'no_credentials', exitCode: 0 }
      }
      const msg = 'Missing megalens-token: create mode requires megalens-token.'
      await writeSummary(msg)
      setOutput('status', 'failed')
      return { status: 'failed', exitCode: 1, error: msg }
    }

    if ((inputs.mode === 'review' || inputs.mode === 'full') && !auth) {
      const isBotPr = isBotUser(pr.user)
      const skipMsg = isBotPr
        ? `skipped: no review credentials available for bot PR (${pr.user?.login || 'bot'})`
        : 'skipped: no review credentials available'
      await writeSummary(skipMsg)
      setOutput('status', 'skipped')
      return { status: 'skipped', reason: 'no_credentials', exitCode: 0 }
    }

    if (inputs.tier === 'deep') {
      selectedTier = 'standard'
      tierWarning = 'tier "deep" is not allowed on pull_request; running "standard" instead (use /megalens deep in a PR comment).'
      warn(tierWarning)
    }

    if ((inputs.mode === 'publish' || inputs.mode === 'full') && !inputs.githubToken) {
      throw new Error('Missing github-token for GitHub API access.')
    }

    ;({ owner, repo } = resolveRepository(payload, env))
    pullNumber = pr.number
    baseSha = pr.base?.sha || ''
    headSha = pr.head?.sha || ''
    if (!baseSha || !headSha) {
      throw new Error('pull_request payload missing base.sha or head.sha.')
    }
    if (inputs.githubToken) {
      api = createApi(inputs.githubToken)
    }
  } else if (eventName === 'issue_comment') {
    if (payload.action !== 'created' || !payload.issue?.pull_request || typeof payload.issue?.number !== 'number') {
      await writeSummary('skipped: comment is not a new pull request comment')
      setOutput('status', 'skipped')
      return { status: 'skipped', reason: 'not_pr_comment', exitCode: 0 }
    }
    if (isBotUser(payload.comment?.user) || payload.sender?.type === 'Bot') {
      await writeSummary('skipped: bot comments do not trigger reviews')
      setOutput('status', 'skipped')
      return { status: 'skipped', reason: 'bot_comment', exitCode: 0 }
    }
    const command = parseCommentCommand(payload.comment?.body)
    if (!command) {
      await writeSummary('skipped: no /megalens review or /megalens deep command found')
      setOutput('status', 'skipped')
      return { status: 'skipped', reason: 'no_command', exitCode: 0 }
    }
    ;({ owner, repo } = resolveRepository(payload, env))
    pullNumber = payload.issue.number

    if (inputs.mode === 'review' && (!inputs.headSha || !inputs.baseSha)) {
      const missing = [!inputs.headSha && 'head-sha', !inputs.baseSha && 'base-sha'].filter(Boolean).join(' and ')
      const msg = `Missing ${missing}: review mode on issue_comment requires both head-sha and base-sha.`
      await writeSummary(msg)
      await setOutput('status', 'failed')
      return { status: 'failed', exitCode: 1, error: msg }
    }
    if (inputs.mode === 'publish' && !inputs.headSha) {
      const msg = 'Missing head-sha: publish mode on issue_comment requires head-sha.'
      await writeSummary(msg)
      await setOutput('status', 'failed')
      return { status: 'failed', exitCode: 1, error: msg }
    }

    const hasPinnedReviewShas = inputs.mode === 'review' && Boolean(inputs.headSha && inputs.baseSha)
    const hasPinnedPublishHead = inputs.mode === 'publish' && Boolean(inputs.headSha)

    if (!hasPinnedReviewShas) {
      if (!inputs.githubToken) {
        throw new Error('Missing github-token for checking commenter permissions.')
      }
      api = createApi(inputs.githubToken)
      if (!hasPinnedPublishHead) {
        const commenter = payload.comment?.user?.login || ''
        const allowed = await hasWritePermission(api, owner, repo, commenter)
        if (!allowed) {
          await writeSummary(`skipped: commenter @${commenter || 'unknown'} does not have write or admin permission`)
          setOutput('status', 'skipped')
          return { status: 'skipped', reason: 'unauthorized_commenter', exitCode: 0 }
        }
      }
    }

    if (!doubleTierEnabled && command === 'double') {
      await writeSummary(DOUBLE_DISABLED_MESSAGE)
      await setOutput('status', 'failed')
      return { status: 'failed', exitCode: 1, error: DOUBLE_DISABLED_MESSAGE }
    }

    if (hasPinnedReviewShas || hasPinnedPublishHead) {
      baseSha = inputs.baseSha
      headSha = inputs.headSha
    } else {
      const pr = await api.getPull(owner, repo, pullNumber)
      if (!pr.open) {
        await writeSummary('skipped: pull request is closed')
        setOutput('status', 'skipped')
        return { status: 'skipped', reason: 'closed', exitCode: 0 }
      }
      isFork = Boolean(pr.isFork)

      if (inputs.mode === 'full' && isFork) {
        const msg = 'skipped: fork PRs need the create/review/publish workflow'
        await writeSummary(msg)
        await setOutput('status', 'skipped')
        return { status: 'skipped', reason: 'fork_full_refused', exitCode: 0 }
      }

      if (isFork && inputs.openaiApiKey && inputs.mode !== 'publish') {
        warn(BYO_FORK_SKIP_SUMMARY)
        await writeSummary(BYO_FORK_SKIP_SUMMARY)
        setOutput('status', 'skipped')
        return { status: 'skipped', reason: 'byo_fork_refused', exitCode: 0 }
      }

      if (isFork && isSelfHostedRunner(env, payload)) {
        warn('Warning: self-hosted runner detected on a fork PR; do not use self-hosted runners on public repos for fork PRs.')
      }
      baseSha = inputs.baseSha || pr.baseSha
      headSha = inputs.headSha || pr.headSha
    }

    if (inputs.mode === 'create' && !inputs.megalensToken) {
      const msg = 'Missing megalens-token: create mode requires megalens-token.'
      await writeSummary(msg)
      setOutput('status', 'failed')
      return { status: 'failed', exitCode: 1, error: msg }
    }
    if ((inputs.mode === 'review' || inputs.mode === 'full') && !auth) {
      throw new Error(
        byoKeyEnabled
          ? 'Missing credentials: set MEGALENS_REVIEW_ID/MEGALENS_REVIEW_KEY, megalens-token, or openai-api-key (same-repo PRs only).'
          : 'Missing credentials: set MEGALENS_REVIEW_ID/MEGALENS_REVIEW_KEY or megalens-token.',
      )
    }

    if (command === 'deep') {
      selectedTier = 'deep'
    } else if (command === 'double') {
      selectedTier = 'double'
    } else {
      selectedTier = inputs.tier === 'double' ? 'double' : 'standard'
      if (inputs.tier === 'deep') {
        tierWarning = 'input tier "deep" ignored for /megalens review; running "standard" (comment /megalens deep for deep).'
        warn(tierWarning)
      }
    }
  } else if (eventName === 'workflow_dispatch' || isPush) {
    // Push and dispatch runs publish to the job summary without a pull request.
    const fail = async (msg) => {
      await writeSummary(msg)
      await setOutput('status', 'failed')
      return { status: 'failed', exitCode: 1, error: msg }
    }
    // A workflow that already lists workflow_dispatch for its own reasons (a PR workflow started by hand) passes no SHAs.
    // Keep the old behaviour for it: a clean skip, not a red failure. Giving only one SHA is a real mistake and fails below.
    if (!isPush && !inputs.headSha && !inputs.baseSha) {
      await writeSummary(`skipped: unsupported event "${eventName}"`)
      setOutput('status', 'skipped')
      return { status: 'skipped', reason: 'unsupported_event', exitCode: 0 }
    }
    if (inputs.mode === 'full') {
      return fail(`mode "full" is not supported on ${eventName}; use create, review and publish.`)
    }
    if (inputs.tier !== 'standard' && inputs.tier !== 'deep') {
      return fail(`Invalid tier "${inputs.tier}" for ${eventName}. Expected standard or deep.`)
    }
    if (!isPush && (!inputs.headSha || !inputs.baseSha)) {
      const missing = [!inputs.headSha && 'head-sha', !inputs.baseSha && 'base-sha'].filter(Boolean).join(' and ')
      return fail(`Missing ${missing}: workflow_dispatch requires both head-sha and base-sha (40-hex SHAs).`)
    }
    ;({ owner, repo } = resolveRepository(payload, env))
    baseSha = isPush ? payload.before : inputs.baseSha
    headSha = isPush ? payload.after : inputs.headSha
    if (isPush && (typeof baseSha !== 'string' || typeof headSha !== 'string' || !SHA40_RE.test(baseSha) || !SHA40_RE.test(headSha) || baseSha === ZERO_SHA || headSha === ZERO_SHA || baseSha === headSha)) {
      await writeSummary('skipped: push has no commit range to review')
      await setOutput('status', 'skipped')
      return { status: 'skipped', reason: 'no_push_range', exitCode: 0 }
    }
    isFork = false
    selectedTier = inputs.tier
    isStandalone = true

    if (inputs.mode === 'create' && !inputs.megalensToken) {
      return fail('Missing megalens-token: create mode requires megalens-token.')
    }
    if (inputs.mode === 'publish' && inputs.megalensToken) {
      return fail('Refusing megalens-token in publish mode: only the create job receives the account token.')
    }
    if (inputs.mode === 'review' && !auth) {
      return fail(
        byoKeyEnabled
          ? 'Missing credentials: set MEGALENS_REVIEW_ID/MEGALENS_REVIEW_KEY (from the create job) or openai-api-key.'
          : 'Missing credentials: set MEGALENS_REVIEW_ID/MEGALENS_REVIEW_KEY (from the create job).',
      )
    }
  } else {
    await writeSummary(`skipped: unsupported event "${eventName}"`)
    setOutput('status', 'skipped')
    return { status: 'skipped', reason: 'unsupported_event', exitCode: 0 }
  }

  // Burst guard (F13): in create/full modes only, skip only when an earlier complete summary for this head+tier is <5m old.
  if ((inputs.mode === 'create' || inputs.mode === 'full') && typeof api?.findSummaryCommentDetails === 'function') {
    let existingSummary = null
    try {
      existingSummary = await api.findSummaryCommentDetails(
        owner,
        repo,
        pullNumber,
        summaryMarker(selectedTier),
      )
    } catch (err) {
      // In create mode with minimal permissions, issue comments may return 401/403; allow run to proceed.
      if (!(inputs.mode === 'create' && (err?.status === 401 || err?.status === 403))) {
        throw err
      }
    }
    const meta = parseSummaryMeta(existingSummary?.body)
    const tsMs = meta?.ts ?? (existingSummary?.updatedAt ? Date.parse(existingSummary.updatedAt) : NaN)
    const ageMs = Number.isFinite(tsMs) ? nowMs - tsMs : Infinity
    if (
      meta?.headSha === headSha.toLowerCase()
      && meta?.tier === selectedTier
      && meta?.status === 'complete'
      && ageMs >= 0
      && ageMs < BURST_GUARD_WINDOW_MS
    ) {
      const burstMsg = `skipped: review summary already exists for ${headSha.slice(0, 7)} (tier ${selectedTier})`
      await writeSummary(burstMsg)
      setOutput('status', 'skipped')
      return { status: 'skipped', reason: 'burst_guard', exitCode: 0 }
    }
  }

  if (inputs.mode === 'create') {
    try {
      const created = await createReviewFn({
        apiUrl: inputs.apiUrl,
        token: inputs.megalensToken,
        repo: `${owner}/${repo}`,
        baseSha,
        headSha,
        tier: selectedTier,
      })
      await setOutput('status', 'complete')
      await setOutput('review_id', created.reviewId)
      await setOutput('review-id', created.reviewId)
      // review_key is deliberately NOT masked in create mode (GitHub drops masked job outputs)
      // and is NEVER printed or logged to stdout/stderr/summary.
      await setOutput('review_key', created.reviewKey)
      await setOutput('head_sha', headSha)
      await setOutput('base_sha', baseSha)
      await writeSummary(`Created MegaLens review \`${created.reviewId}\` (tier \`${selectedTier}\`) for \`${headSha.slice(0, 7)}\`.`)
      return {
        status: 'complete',
        reviewId: created.reviewId,
        headSha,
        baseSha,
        exitCode: 0,
      }
    } catch (err) {
      const reason = safeError(err)
      await writeSummary(`Failed to create MegaLens review (${selectedTier}): ${reason}`)
      await setOutput('status', 'failed')
      return { status: 'failed', exitCode: 1, error: reason }
    }
  }

  const runnerTemp = env.RUNNER_TEMP || tmpdir()
  let downloadedPath = null
  if (inputs.mode === 'publish' && typeof deps.downloadArtifact === 'function') {
    downloadedPath = await deps.downloadArtifact({
      name: inputs.artifactName,
      destDir: runnerTemp,
    })
  }

  let outPath = deps.outPath
    || inputs.findingsPath
    || (typeof downloadedPath === 'string' && downloadedPath ? downloadedPath : '')
    || (inputs.mode === 'publish'
      ? await resolveDefaultPublishPath(runnerTemp, inputs.artifactName)
      : inputs.mode === 'review'
        ? join(runnerTemp, 'findings.json')
        : join(runnerTemp, `megalens-findings-${pullNumber}-${Date.now()}.json`))

  let cliResult = { exitCode: 0, stdout: '', stderr: '', errorMessage: null, rawFindings: null }
  let doc = null
  let parseError = null

  if (inputs.mode === 'publish') {
    try {
      const raw = await readFindingsFn(outPath)
      cliResult.rawFindings = raw
      doc = parseFindingsDocument(raw)
      cliResult.exitCode = doc.refused === true ? 3 : doc.status === 'complete' ? 0 : doc.status === 'partial' ? 2 : 4
    } catch (err) {
      parseError = safeError(err)
      cliResult.exitCode = 4
    }
  } else {
    if ((inputs.mode === 'review' || inputs.mode === 'full') && prepareSandboxFn) {
      try { await prepareSandboxFn() } catch { /* never blocks: the engine pre-check decides */ }
    }
    try {
      const hasExplicitApiUrl = Boolean(getInput(env, 'api-url', '') || String(env.MEGALENS_API_URL || '').trim())
      const trustedApiUrl = hasExplicitApiUrl ? normalizeTrustedApiUrl(inputs.apiUrl) : undefined
      cliResult = await runEngine({
        tier: selectedTier,
        baseSha,
        headSha,
        outPath,
        timeoutMinutes: inputs.timeoutMinutes,
        engineVersion: inputs.engineVersion,
        authMode: auth.mode,
        authEnv: auth.env,
        ...(trustedApiUrl ? { apiUrl: trustedApiUrl } : {}),
        isFork,
        repoPath: env.GITHUB_WORKSPACE || process.cwd(),
        runnerTemp,
      })
    } catch (err) {
      cliResult = {
        exitCode: 4,
        stdout: '',
        stderr: '',
        errorMessage: safeError(err),
        rawFindings: null,
      }
    }

    // The engine may have used a unique output path (old file could not be removed).
    if (typeof cliResult.outPath === 'string' && cliResult.outPath) outPath = cliResult.outPath

    if (cliResult.rawFindings !== null && cliResult.rawFindings !== undefined) {
      try {
        doc = parseFindingsDocument(cliResult.rawFindings)
      } catch (err) {
        parseError = safeError(err)
      }
    }
  }

  if (inputs.mode === 'review') {
    if (!doc) {
      const rawTail = safeText(cliResult.stderr.trim().split('\n').slice(-1)[0] || '')
      const reason = parseError
        || (cliResult.exitCode === 3 ? 'Refused by the MegaLens gateway (check review key, quota, or spend cap).' : null)
        || (cliResult.errorMessage ? safeText(cliResult.errorMessage) : null)
        || rawTail
        || `Engine exited with code ${cliResult.exitCode} without findings.json.`

      const failedStub = {
        schema: 'megalens.findings/v1',
        review_id: inputs.reviewId || null,
        tier: selectedTier,
        status: 'failed',
        target: { kind: 'range', base: baseSha, head: headSha, snapshot_sha256: null },
        passes: [],
        findings: [],
        error: reason,
      }
      await writeFindingsFn(outPath, JSON.stringify(failedStub, null, 2)).catch(() => {})
      if (typeof deps.uploadArtifact === 'function') {
        await deps.uploadArtifact({ name: inputs.artifactName, path: outPath })
      }
      await writeSummary(`Review failed (${selectedTier}): ${reason}`)
      await setOutput('status', 'failed')
      if (inputs.reviewId) {
        await setOutput('review_id', inputs.reviewId)
        await setOutput('review-id', inputs.reviewId)
      }
      await setOutput('artifact-name', inputs.artifactName)
      await setOutput('findings-path', outPath)
      await setOutput('strong-count', '0')
      await setOutput('normal-count', '0')
      return { status: 'failed', exitCode: 1, error: reason }
    }

    if (isVerifiedTooLarge(doc, cliResult.exitCode, headSha)) {
      // Too large for one review: not a failure. The engine already closed the review once and used no credits.
      // The job ends green so a large PR is not blocked; the publish job (or full mode) posts the PR comment.
      const message = tooLargeMessage(doc)
      if (typeof deps.uploadArtifact === 'function') {
        await deps.uploadArtifact({ name: inputs.artifactName, path: outPath })
      }
      await writeSummary(message)
      await setOutput('status', 'skipped')
      await setOutput('reason', 'too_large')
      const tooLargeId = doc.review_id || inputs.reviewId || null
      if (tooLargeId) {
        await setOutput('review_id', tooLargeId)
        await setOutput('review-id', tooLargeId)
      }
      await setOutput('artifact-name', inputs.artifactName)
      await setOutput('findings-path', outPath)
      await setOutput('strong-count', '0')
      await setOutput('normal-count', '0')
      return { status: 'skipped', reason: 'too_large', reviewId: tooLargeId, outPath, artifactName: inputs.artifactName, message, exitCode: 0 }
    }

    const effectiveStatus = computeEffectiveStatus(doc.status, cliResult.exitCode, doc.passes, doc.refused)
    const effectiveDoc = {
      ...doc,
      review_id: doc.review_id || inputs.reviewId || null,
      status: effectiveStatus,
      tier: doc.tier || selectedTier,
    }
    if (effectiveDoc.status !== doc.status || effectiveDoc.tier !== doc.tier || effectiveDoc.review_id !== doc.review_id) {
      await writeFindingsFn(outPath, JSON.stringify(effectiveDoc, null, 2)).catch(() => {})
    }
    if (typeof deps.uploadArtifact === 'function') {
      await deps.uploadArtifact({ name: inputs.artifactName, path: outPath })
    }
    const isRefused = doc.refused === true || cliResult.exitCode === 3
    const refusedReason = isRefused ? 'Refused by the MegaLens gateway (check review key, quota, or spend cap).' : null
    await writeSummary(
      refusedReason
        ? `Review failed (${effectiveDoc.tier}): ${refusedReason}`
        : `Review ${effectiveStatus} (${effectiveDoc.tier}) for ${headSha.slice(0, 7)}.`,
    )
    await setOutput('status', effectiveStatus)
    if (effectiveDoc.review_id) {
      await setOutput('review_id', effectiveDoc.review_id)
      await setOutput('review-id', effectiveDoc.review_id)
    }
    await setOutput('artifact-name', inputs.artifactName)
    await setOutput('findings-path', outPath)
    const failForEngine = effectiveStatus === 'failed'
    const failForIncomplete = inputs.failOn !== 'none' && effectiveStatus === 'partial'
    const exitCode = failForEngine || failForIncomplete ? 1 : 0
    return {
      status: effectiveStatus,
      reviewId: effectiveDoc.review_id,
      outPath,
      artifactName: inputs.artifactName,
      exitCode,
      ...(refusedReason
        ? { error: refusedReason }
        : failForIncomplete
          ? { error: `Review incomplete (${effectiveStatus}); fail-on is ${inputs.failOn}.` }
          : {}),
    }
  }

  if (isStandalone) {
    // The review job already uploaded findings.json. Publish the result for this pinned range.
    const reasonFor = () => {
      const rawTail = safeText(cliResult.stderr.trim().split('\n').slice(-1)[0] || '')
      return parseError
        || (cliResult.exitCode === 3 ? 'Refused by the MegaLens gateway (check token, quota, or spend cap).' : null)
        || (cliResult.errorMessage ? safeText(cliResult.errorMessage) : null)
        || rawTail
        || `Engine exited with code ${cliResult.exitCode} without findings.json.`
    }
    const INVALID_ARTIFACT = 'The findings artifact is missing or is not a valid MegaLens findings document.'
    const finishFailed = async (reason, tierForSummary) => {
      await writeSummary(`MegaLens review failed (${tierForSummary}) for ${headSha.slice(0, 7)}: ${reason}`)
      await setOutput('status', 'failed')
      await setOutput('artifact-name', inputs.artifactName)
      await setOutput('strong-count', '0')
      await setOutput('normal-count', '0')
      return { status: 'failed', exitCode: 1, error: reason }
    }
    if (!doc) return finishFailed(parseError ? INVALID_ARTIFACT : reasonFor(), selectedTier)
    if (isVerifiedTooLarge(doc, cliResult.exitCode, headSha) && doc.target?.base === baseSha) {
      const message = tooLargeMessage(doc)
      await writeSummary(message)
      await setOutput('status', 'skipped')
      await setOutput('reason', 'too_large')
      if (doc.review_id) {
        await setOutput('review_id', doc.review_id)
        await setOutput('review-id', doc.review_id)
      }
      await setOutput('artifact-name', inputs.artifactName)
      await setOutput('strong-count', '0')
      await setOutput('normal-count', '0')
      return { status: 'skipped', reason: 'too_large', reviewId: doc.review_id || null, message, exitCode: 0 }
    }
    if (doc.target?.head && doc.target.head === headSha && doc.target?.base !== baseSha) {
      // Sol confirm: never echo artifact text; show only a validated SHA prefix.
      const got = shortShaOrLabel(doc.target?.base)
      return finishFailed(`Reviewed base SHA (${got}) does not match requested base (${baseSha.slice(0, 7)}).`, doc.tier || selectedTier)
    }
    if (!doc.target?.head || doc.target.head !== headSha) {
      const got = shortShaOrLabel(doc.target?.head)
      return finishFailed(`Reviewed head SHA (${got}) does not match requested head (${headSha.slice(0, 7)}).`, doc.tier || selectedTier)
    }
    const dStatus = computeEffectiveStatus(doc.status, cliResult.exitCode, doc.passes, doc.refused)
    const dTier = doc.tier || selectedTier
    const dFindings = dStatus === 'failed' ? [] : doc.findings
    const strongN = dFindings.filter((f) => isStrongFinding(f, true)).length
    const byPriority = ['P0', 'P1', 'P2', 'P3']
      .map((p) => `${p}: ${dFindings.filter((f) => String(f.priority).toUpperCase() === p).length}`)
      .join(', ')
    const refusedDispatch = doc.refused === true || cliResult.exitCode === 3
    const lines = [
      `MegaLens review ${dStatus} (${dTier}) for ${headSha.slice(0, 7)}.`,
      `Findings: ${dFindings.length} (${byPriority}). Strong: ${strongN}.`,
      isPush && dFindings.length > 0
        ? 'The workflow artifact contains the full findings.'
        : 'Findings are in the workflow artifact. No pull request was involved, so nothing was posted.',
    ]
    if (refusedDispatch) lines.unshift('Refused by the MegaLens gateway (check token, quota, or spend cap).')
    if (isPush && dFindings.length > 0) {
      let files = []
      if (inputs.githubToken) {
        try {
          files = await createApi(inputs.githubToken).listPushFiles(owner, repo, baseSha, headSha)
        } catch {
          // The summary can still list the findings with the static template.
        }
      }
      const fixPromptPaths = changedPaths(files)
      const sorted = sortFindings(dFindings.map(f => {
        const file = f.file && resolveFindingPath(f.file, fixPromptPaths)
        return file !== f.file && fixPromptPaths.has(file) ? { ...f, file } : f
      }))
      lines.push(formatSummaryComment({
        headSha,
        doc: { ...doc, status: dStatus, tier: dTier },
        strongFindings: sorted.filter(f => isStrongFinding(f, true)),
        normalFindings: sorted.filter(f => !isStrongFinding(f, true)),
        extraSecrets: secretValues,
        fixPromptPaths,
        now: nowMs,
      }))
    }
    await writeSummary(lines.join('\n\n'))
    await setOutput('status', dStatus)
    if (doc.review_id) {
      await setOutput('review_id', doc.review_id)
      await setOutput('review-id', doc.review_id)
    }
    await setOutput('artifact-name', inputs.artifactName)
    await setOutput('strong-count', String(strongN))
    await setOutput('normal-count', String(Math.max(0, dFindings.length - strongN)))
    const failIncomplete = inputs.failOn !== 'none' && dStatus === 'partial'
    const failStrong = inputs.failOn === 'strong' && dStatus === 'complete' && strongN > 0
    const exitCode = dStatus === 'failed' || failIncomplete || failStrong ? 1 : 0
    return {
      status: dStatus,
      reviewId: doc.review_id || null,
      exitCode,
      ...(dStatus === 'failed'
        ? { error: refusedDispatch ? 'Refused by the MegaLens gateway.' : `Review failed (${dStatus}).` }
        : {}),
    }
  }

  // Every write to the shared PR comment or job summary goes through here. Right before the write, the live PR
  // head is re-read: if a newer commit exists, this run writes nothing (one log line).
  const upsertPrComment = async (format, marker) => {
    const existingId = await api.findSummaryComment(owner, repo, pullNumber, marker)
    let live = null
    if (typeof api.getPull === 'function') {
      live = await api.getPull(owner, repo, pullNumber)
      if (live?.headSha && live.headSha !== headSha) {
        warn(`MegaLens: PR head moved from ${headSha.slice(0, 7)} to ${live.headSha.slice(0, 7)}; nothing written for this run.`)
        return { action: 'skipped_stale' }
      }
    }
    const body = typeof format === 'function' ? format(live) : format
    if (existingId !== null) {
      await api.updateIssueComment(owner, repo, existingId, body)
      return { action: 'updated', commentId: existingId, body }
    }
    const createdId = await api.createIssueComment(owner, repo, pullNumber, body)
    return { action: 'created', commentId: createdId, body }
  }
  const publishShared = async (format, tierForMarker, summaryText) => {
    const result = await upsertPrComment(format, summaryMarker(tierForMarker))
    if (result.action !== 'skipped_stale') await writeSummary(summaryText ?? result.body)
    return result
  }
  const staleResult = async () => {
    await setOutput('status', 'skipped')
    await setOutput('artifact-name', inputs.artifactName)
    await setOutput('strong-count', '0')
    await setOutput('normal-count', '0')
    return { status: 'skipped', reason: 'stale_head', exitCode: 0 }
  }

  if (!doc) {
    const rawTail = safeText(cliResult.stderr.trim().split('\n').slice(-1)[0] || '')
    const reason = parseError
      || (cliResult.exitCode === 3 ? 'Refused by the MegaLens gateway (check token, quota, or spend cap).' : null)
      || (cliResult.errorMessage ? safeText(cliResult.errorMessage) : null)
      || rawTail
      || `Engine exited with code ${cliResult.exitCode} without findings.json.`

    const summary = formatSummaryComment({
      headSha,
      doc: { status: 'failed', tier: selectedTier, review_id: null, passes: [] },
      tierWarning,
      errorMessage: reason,
      now: nowMs,
      extraSecrets: secretValues,
    })
    if ((await publishShared(summary, selectedTier)).action === 'skipped_stale') return staleResult()
    await setOutput('status', 'failed')
    await setOutput('artifact-name', inputs.artifactName)
    await setOutput('strong-count', '0')
    await setOutput('normal-count', '0')
    return { status: 'failed', exitCode: 1, error: reason }
  }

  // Require target.head to be present and equal to the reviewed PR head SHA.
  if (!doc.target?.head || doc.target.head !== headSha) {
    const got = shortShaOrLabel(doc.target?.head)
    const mismatchMsg = `Reviewed head SHA (${got}) does not match PR head (${headSha.slice(0, 7)}).`
    const effectiveTier = doc.tier || selectedTier
    const summary = formatSummaryComment({
      headSha,
      doc: { ...doc, tier: effectiveTier, status: 'failed' },
      tierWarning,
      errorMessage: mismatchMsg,
      now: nowMs,
      extraSecrets: secretValues,
    })
    if ((await publishShared(summary, effectiveTier)).action === 'skipped_stale') return staleResult()
    await setOutput('status', 'failed')
    await setOutput('artifact-name', inputs.artifactName)
    await setOutput('strong-count', '0')
    await setOutput('normal-count', '0')
    return { status: 'failed', exitCode: 1, error: mismatchMsg }
  }

  const effectiveStatus = computeEffectiveStatus(doc.status, cliResult.exitCode, doc.passes, doc.refused)
  const effectiveTier = doc.tier || selectedTier
  const effectiveDoc = { ...doc, status: effectiveStatus, tier: effectiveTier }

  // Early exit when the PR already moved: write nothing (publishShared re-checks right before every write).
  const readPull = () => typeof api.getPull === 'function' ? api.getPull(owner, repo, pullNumber) : null
  const latestPr = await readPull()
  if (latestPr?.headSha && latestPr.headSha !== headSha) {
    warn(`MegaLens: PR head moved from ${headSha.slice(0, 7)} to ${latestPr.headSha.slice(0, 7)}; nothing written for this run.`)
    return staleResult()
  }

  if (isVerifiedTooLarge(doc, cliResult.exitCode, headSha)) {
    // Verified refusal (exit 3, refused, too_large, head matches). The artifact head and the live PR head were
    // checked above, so a newer commit's summary is never overwritten. Green on purpose (see report).
    const message = tooLargeMessage(doc)
    const tooLargeTier = doc.tier || selectedTier
    const tooLargeComment = formatTooLargeComment({ headSha, tier: tooLargeTier, message, now: nowMs })
    if ((await publishShared(tooLargeComment, tooLargeTier, message)).action === 'skipped_stale') return staleResult()
    await setOutput('status', 'skipped')
    await setOutput('reason', 'too_large')
    if (doc.review_id) {
      await setOutput('review_id', doc.review_id)
      await setOutput('review-id', doc.review_id)
    }
    await setOutput('artifact-name', inputs.artifactName)
    await setOutput('strong-count', '0')
    await setOutput('normal-count', '0')
    return { status: 'skipped', reason: 'too_large', reviewId: doc.review_id, message, exitCode: 0 }
  }

  let allStrongFindings = []
  let displayedStrongFindings = []
  let summaryFindings = []
  let pullFiles = null
  let paths
  let inlinePostedCount = 0
  let inlineWarning = null
  const repository = `${owner}/${repo}`.toLowerCase()
  const sameRepoIds = (live) => (
    live.headRepoId == null && live.baseRepoId == null
      ? true
      : typeof live.headRepoId === 'number' && typeof live.baseRepoId === 'number' && live.headRepoId === live.baseRepoId
  )
  const promptPaths = (live) => (
    live?.headSha === headSha && live.baseSha && live.baseSha === latestPr?.baseSha && !live.isFork
      && sameRepoIds(live)
      && live.headRepoFullName?.toLowerCase() === repository && live.baseRepoFullName?.toLowerCase() === repository
      && TRUSTED_PR_AUTHORS.has(live.authorAssociation) ? paths : undefined
  )

  if (effectiveStatus !== 'failed') {
    pullFiles = await api.listPullFiles(owner, repo, pullNumber)
    paths = changedPaths(pullFiles)
    const { inDiff, outOfDiff } = partitionFindingsByDiff(doc.findings, pullFiles)
    const sortedInDiff = sortFindings(inDiff)
    allStrongFindings = sortedInDiff.filter((f) => isStrongFinding(f, true))
    displayedStrongFindings = allStrongFindings
    const nonStrongInDiff = sortedInDiff.filter((f) => !isStrongFinding(f, true))
    summaryFindings = sortFindings([...nonStrongInDiff, ...outOfDiff])

    let shouldPostInline = inputs.inline !== false
    if (inputs.inline === null && typeof api.isAppActive === 'function') {
      const appActive = await api.isAppActive(owner, repo, pullNumber, headSha)
      if (appActive) {
        shouldPostInline = false
      }
    }

    if (shouldPostInline && allStrongFindings.length > 0) {
      const ownLogin = typeof api.getViewerLogin === 'function' ? await api.getViewerLogin() : null
      const existingReviewComments = await api.listPullReviewComments(owner, repo, pullNumber)
      const { toPost, alreadyPostedCount, appOverlapFindings } = selectNewInlineFindings(
        allStrongFindings,
        existingReviewComments,
        {
          ownLogin,
          appBotLogins: deps.appBotLogins,
        },
      )
      inlinePostedCount = alreadyPostedCount
      if (appOverlapFindings.length > 0) {
        const overlapSet = new Set(appOverlapFindings.map((f) => `${f.file}\0${f.line_start}\0${f.title}`))
        displayedStrongFindings = allStrongFindings.filter((f) => !overlapSet.has(`${f.file}\0${f.line_start}\0${f.title}`))
        summaryFindings = sortFindings([...summaryFindings, ...appOverlapFindings])
      }
      if (toPost.length > 0) {
        const live = await readPull()
        if (live?.headSha && live.headSha !== headSha) return staleResult()
        const fixPromptPaths = promptPaths(live)
        const reviewComments = toPost.map((f) => ({
          path: f.file,
          line: f.line_start,
          side: 'RIGHT',
          body: formatInlineComment(f, secretValues, fixPromptPaths),
        }))
        try {
          await api.createPullReview(owner, repo, pullNumber, headSha, reviewComments)
          inlinePostedCount += toPost.length
        } catch (err) {
          inlineWarning = `Could not post inline comments (${safeError(err)}); strong findings are listed above.`
        }
      }
    }
  }

  const isGatewayRefused = doc.refused === true || cliResult.exitCode === 3
  const summaryErrorMessage = isGatewayRefused
    ? 'Refused by the MegaLens gateway (check token, quota, or spend cap).'
    : cliResult.exitCode === 4
      ? safeText(cliResult.errorMessage || doc.error || '')
      : null

  const summary = (live) => formatSummaryComment({
    headSha,
    doc: effectiveDoc,
    strongFindings: effectiveStatus === 'failed' ? [] : displayedStrongFindings,
    normalFindings: effectiveStatus === 'failed' ? [] : summaryFindings,
    inlinePostedCount,
    inlineWarning,
    tierWarning,
    errorMessage: summaryErrorMessage,
    now: nowMs,
    extraSecrets: secretValues,
    fixPromptPaths: promptPaths(live),
  })
  if (pullFiles !== null) {
    const walkthrough = formatWalkthroughComment({
      headSha,
      pullFiles,
      findings: [...displayedStrongFindings, ...summaryFindings],
      extraSecrets: secretValues,
    })
    if ((await upsertPrComment(walkthrough, WALKTHROUGH_MARKER)).action === 'skipped_stale') return staleResult()
  }
  if ((await publishShared(summary, effectiveTier)).action === 'skipped_stale') return staleResult()

  const gateStrongCount = effectiveStatus === 'failed' ? 0 : allStrongFindings.length
  const normalCount = effectiveStatus === 'failed' ? 0 : summaryFindings.length
  await setOutput('status', effectiveStatus)
  if (effectiveDoc.review_id) {
    await setOutput('review_id', effectiveDoc.review_id)
    await setOutput('review-id', effectiveDoc.review_id)
  }
  await setOutput('artifact-name', inputs.artifactName)
  await setOutput('strong-count', String(gateStrongCount))
  await setOutput('normal-count', String(normalCount))

  const failForIncomplete = inputs.failOn !== 'none' && (effectiveStatus === 'partial' || effectiveStatus === 'failed')
  const failForEngine = effectiveStatus === 'failed'
  const failForFindings = inputs.failOn === 'strong' && effectiveStatus === 'complete' && gateStrongCount > 0
  const exitCode = failForIncomplete || failForEngine || failForFindings ? 1 : 0

  let error = undefined
  if (failForIncomplete) {
    error = `Review is incomplete (${effectiveStatus}); failing because fail-on is "${inputs.failOn}".`
  } else if (failForEngine) {
    error = isGatewayRefused ? summaryErrorMessage : `Review failed (${effectiveStatus}).`
  } else if (failForFindings) {
    error = `Found ${gateStrongCount} strong finding(s) with fail-on=strong.`
  }

  return {
    status: effectiveStatus,
    reviewId: effectiveDoc.review_id,
    strongFindings: effectiveStatus === 'failed' ? [] : allStrongFindings,
    normalFindings: normalCount > 0 ? summaryFindings : [],
    inlinePostedCount,
    exitCode,
    ...(error ? { error } : {}),
  }
}
