import { execFile } from 'node:child_process'
import { resolveFindingPath } from './diff.js'

const GITLAB_DIFF_SHA_RE = /^[0-9a-f]{40,64}$/i

/**
 * Parse a unified diff patch and map every post-image line number inside @@ hunks
 * to its GitLab discussion line coordinates.
 *
 * GitLab's Discussions API distinguishes added lines from context lines:
 * - Added lines (`+`): send `new_line` only (`oldLine: null`).
 * - Context lines (` `): send BOTH `old_line` and `new_line`.
 * - Deleted lines (`-`): not post-image targets (ignored).
 *
 * @param {string | undefined} patch
 * @returns {Map<number, { newLine: number, oldLine: number | null, kind: 'added' | 'context' }>}
 */
export function mapDiffPositions(patch) {
  const positions = new Map()
  if (!patch || typeof patch !== 'string') return positions

  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const raw of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      inHunk = true
      continue
    }
    if (!inHunk || !raw || raw.startsWith('\\')) continue

    if (raw.startsWith('+')) {
      positions.set(newLine, { newLine, oldLine: null, kind: 'added' })
      newLine += 1
    } else if (raw.startsWith('-')) {
      oldLine += 1
    } else {
      // Context line (starts with ' ' in standard unified diffs)
      positions.set(newLine, { newLine, oldLine, kind: 'context' })
      oldLine += 1
      newLine += 1
    }
  }

  return positions
}

const GIT_ESCAPE_BYTES = Object.freeze({
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '\\': 0x5c,
  '"': 0x22,
})

/**
 * Decode a Git C-quoted diff path (e.g. `"b/src/caf\303\251.ts"` or `"b/src/a\tb.ts"`).
 * Git emits 3-digit octal UTF-8 byte sequences when `core.quotePath` is enabled;
 * `JSON.parse()` rejects octal escapes, so we decode byte-by-byte into UTF-8.
 * @param {string} rawPath
 * @returns {string}
 */
export function unquoteGitDiffPath(rawPath) {
  const cleaned = String(rawPath || '').replace(/\r$/, '')
  const trimmed = cleaned.replace(/\t$/, '')
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1)
    /** @type {number[]} */
    const bytes = []
    for (let i = 0; i < inner.length; i++) {
      const ch = String.fromCodePoint(inner.codePointAt(i))
      if (ch === '\\' && i + 1 < inner.length) {
        const next = inner[i + 1]
        if (i + 3 < inner.length && /^[0-7]{3}$/.test(inner.slice(i + 1, i + 4))) {
          bytes.push(parseInt(inner.slice(i + 1, i + 4), 8) & 0xff)
          i += 3
          continue
        }
        if (Object.prototype.hasOwnProperty.call(GIT_ESCAPE_BYTES, next)) {
          bytes.push(GIT_ESCAPE_BYTES[next])
          i += 1
          continue
        }
        for (const b of Buffer.from(next, 'utf8')) bytes.push(b)
        i += 1
        continue
      }
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b)
      i += ch.length - 1
    }
    return Buffer.from(bytes).toString('utf8')
  }
  return trimmed
}

/**
 * Parse full `git diff --unified=3 --no-color --no-ext-diff <base> <head>` output
 * into a Map of `newPath -> Set<post-image hunk line number>`.
 * Used to determine strong-finding / fail_on gate eligibility from the local diff
 * actually reviewed by the engine, even when GitLab's API omits patch text due to diff limits.
 *
 * Tracks old/new hunk line counts so added lines starting with `++ ` (rendered as `+++ `)
 * or `diff --git ` inside a hunk are never mistaken for file headers.
 *
 * @param {string | undefined | null} diffText
 * @returns {Map<string, Set<number>>}
 */
export function parseGitUnifiedDiff(diffText) {
  /** @type {Map<string, Set<number>>} */
  const map = new Map()
  if (!diffText || typeof diffText !== 'string') return map

  let currentFile = null
  let currentLines = null
  let newLine = 0
  let oldRemaining = 0
  let newRemaining = 0
  let inHunk = false

  for (const rawLine of diffText.split('\n')) {
    const raw = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (inHunk && (oldRemaining > 0 || newRemaining > 0)) {
      if (raw.startsWith('\\')) continue
      if (raw.startsWith('+')) {
        if (currentLines) currentLines.add(newLine)
        newLine += 1
        newRemaining = Math.max(0, newRemaining - 1)
        if (oldRemaining === 0 && newRemaining === 0) inHunk = false
        continue
      }
      if (raw.startsWith('-')) {
        oldRemaining = Math.max(0, oldRemaining - 1)
        if (oldRemaining === 0 && newRemaining === 0) inHunk = false
        continue
      }
      if (raw === '' || raw.startsWith(' ')) {
        if (currentLines) currentLines.add(newLine)
        newLine += 1
        oldRemaining = Math.max(0, oldRemaining - 1)
        newRemaining = Math.max(0, newRemaining - 1)
        if (oldRemaining === 0 && newRemaining === 0) inHunk = false
        continue
      }
      // Unexpected non-hunk line ends the hunk cleanly and falls through to header parsing.
      inHunk = false
      oldRemaining = 0
      newRemaining = 0
    }

    if (raw.startsWith('diff --git ')) {
      currentFile = null
      currentLines = null
      inHunk = false
      oldRemaining = 0
      newRemaining = 0
      continue
    }
    if (raw.startsWith('+++ ')) {
      inHunk = false
      oldRemaining = 0
      newRemaining = 0
      const target = raw.slice(4)
      if (target.trim() === '/dev/null') {
        currentFile = null
        currentLines = null
        continue
      }
      const unquoted = unquoteGitDiffPath(target)
      const cleaned = unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted
      if (cleaned) {
        currentFile = cleaned
        currentLines = map.get(cleaned) ?? new Set()
        map.set(cleaned, currentLines)
      }
      continue
    }
    if (!currentFile || !currentLines) continue

    const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (header) {
      oldRemaining = header[1] !== undefined ? Number(header[1]) : 1
      newLine = Number(header[2])
      newRemaining = header[3] !== undefined ? Number(header[3]) : 1
      inHunk = oldRemaining > 0 || newRemaining > 0
      continue
    }
  }

  for (const [file, lines] of map.entries()) {
    if (lines.size === 0) map.delete(file)
  }
  return map
}

/**
 * Normalize a local diff hunk map (`Map<string, Set<number>>` or plain `{ [file]: number[] }`)
 * into a `Map<string, Set<number>>`. Returns `null` when absent.
 *
 * @param {Map<string, Set<number>> | Record<string, number[]> | null | undefined} raw
 * @returns {Map<string, Set<number>> | null}
 */
export function normalizeLocalDiffHunks(raw) {
  if (!raw) return null
  if (raw instanceof Map) {
    /** @type {Map<string, Set<number>>} */
    const out = new Map()
    for (const [file, lines] of raw.entries()) {
      if (typeof file !== 'string' || !file.trim()) continue
      const set = new Set()
      if (lines && typeof lines[Symbol.iterator] === 'function') {
        for (const n of lines) {
          if (typeof n === 'number' && Number.isInteger(n) && n > 0) set.add(n)
        }
      }
      if (set.size > 0) out.set(file, set)
    }
    return out
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    /** @type {Map<string, Set<number>>} */
    const out = new Map()
    for (const [file, lines] of Object.entries(raw)) {
      if (typeof file !== 'string' || !file.trim() || !Array.isArray(lines)) continue
      const set = new Set()
      for (const n of lines) {
        if (typeof n === 'number' && Number.isInteger(n) && n > 0) set.add(n)
      }
      if (set.size > 0) out.set(file, set)
    }
    return out
  }
  return null
}

/**
 * Convert a `Map<string, Set<number>>` into a plain JSON-serializable object `{ [file]: number[] }`.
 * @param {Map<string, Set<number>> | null | undefined} map
 * @returns {Record<string, number[]> | null}
 */
export function serializeLocalDiffHunks(map) {
  const normalized = normalizeLocalDiffHunks(map)
  if (!normalized) return null
  /** @type {Record<string, number[]>} */
  const out = {}
  for (const [file, lines] of normalized.entries()) {
    out[file] = [...lines].sort((a, b) => a - b)
  }
  return out
}

/**
 * Read local unified hunks with text diffing forced because the engine omits repository attributes.
 * Treat moves as deletes and adds to match the engine's reviewed diff.
 * Returns `null` if git is unavailable or the commits are not present in `repoPath`.
 *
 * @param {string} repoPath
 * @param {string} baseSha
 * @param {string} headSha
 * @param {{ execFileImpl?: typeof execFile }} [opts]
 * @returns {Promise<Map<string, Set<number>> | null>}
 */
export function readLocalGitDiffHunks(repoPath, baseSha, headSha, opts = {}) {
  if (
    typeof repoPath !== 'string'
    || !repoPath.trim()
    || !GITLAB_DIFF_SHA_RE.test(String(baseSha || ''))
    || !GITLAB_DIFF_SHA_RE.test(String(headSha || ''))
  ) {
    return Promise.resolve(null)
  }
  const execFn = opts.execFileImpl ?? execFile
  return new Promise((resolve) => {
    execFn(
      'git',
      ['-C', repoPath, '-c', 'core.quotepath=false', '-c', 'diff.suppressBlankEmpty=false',
        'diff', '--unified=3', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--text',
        '--src-prefix=a/', '--dst-prefix=b/', baseSha, headSha, '--'],
      { maxBuffer: 20 * 1024 * 1024, timeout: 60_000 },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        resolve(parseGitUnifiedDiff(String(stdout ?? '')))
      },
    )
  })
}

/**
 * Build a map of `new_path -> { oldPath, newPath, positions }` from GitLab MR diffs.
 * Deleted files and files without a text diff are excluded from inline eligibility.
 *
 * @param {Array<{ old_path?: string, new_path?: string, diff?: string, deleted_file?: boolean }>} mrDiffs
 * @returns {Map<string, { oldPath: string, newPath: string, positions: Map<number, { newLine: number, oldLine: number | null, kind: 'added' | 'context' }> }>}
 */
export function buildGitLabDiffMap(mrDiffs) {
  const map = new Map()
  if (!Array.isArray(mrDiffs)) return map

  for (const entry of mrDiffs) {
    if (!entry || typeof entry.new_path !== 'string' || !entry.new_path.trim()) continue
    if (entry.deleted_file === true || !entry.diff) continue
    const positions = mapDiffPositions(entry.diff)
    if (positions.size > 0) {
      const newPath = entry.new_path
      const oldPath = typeof entry.old_path === 'string' && entry.old_path.trim()
        ? entry.old_path
        : newPath
      map.set(newPath, { oldPath, newPath, positions })
    }
  }

  return map
}

/**
 * Partition findings into diff-eligible (`inDiff`, eligible for strong-finding gating and summary
 * strong listing; annotated with `_gitlabPosition` when GitLab also provided patch text for inline
 * posting, or `_gitlabPosition: null` when GitLab omitted the patch due to diff limits) and
 * summary-only (`outOfDiff`, never dropped).
 *
 * When `opts.localDiffHunks` is provided, gate/diff eligibility uses the local reviewed git diff
 * and GitLab's patch supplies inline coordinates. A persisted local match uses finding indexes
 * so artifact redaction can remove sensitive paths without changing the gate.
 *
 * @template {{ file?: string, line_start?: number, line_end?: number }} T
 * @param {T[]} findings
 * @param {Array<{ old_path?: string, new_path?: string, diff?: string, deleted_file?: boolean }>} mrDiffs
 * @param {{ localDiffHunks?: Map<string, Set<number>> | Record<string, number[]> | null, strongFindingIndexes?: Set<number> | null }} [opts]
 * @returns {{ inDiff: Array<T & { _gitlabPosition: { oldPath: string, newPath: string, newLine: number, oldLine: number | null } | null }>, outOfDiff: T[], inDiffIndexes: number[] }}
 */
export function partitionGitLabFindingsByDiff(findings, mrDiffs, opts = {}) {
  const diffMap = buildGitLabDiffMap(mrDiffs)
  const localMap = normalizeLocalDiffHunks(opts?.localDiffHunks)
  const knownDiffFiles = new Set([
    ...diffMap.keys(),
    ...(localMap ? localMap.keys() : []),
  ])
  const allMrFiles = new Set(
    (Array.isArray(mrDiffs) ? mrDiffs : [])
      .filter((d) => d && typeof d.new_path === 'string')
      .map((d) => d.new_path),
  )

  const inDiff = []
  const outOfDiff = []
  const inDiffIndexes = []

  const knownFiles = knownDiffFiles.size > 0 ? knownDiffFiles : allMrFiles
  for (const [index, finding] of findings.entries()) {
    if (!finding || typeof finding.file !== 'string') {
      outOfDiff.push(finding)
      continue
    }
    const file = finding.file
    const relativeFile = file.replace(/^\.\//, '')
    const resolvedFile = knownFiles.has(relativeFile) ? relativeFile : resolveFindingPath(file, knownFiles)
    const normalizedFinding = resolvedFile === finding.file ? finding : { ...finding, file: resolvedFile }
    const line = finding.line_start
    if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) {
      outOfDiff.push(normalizedFinding)
      continue
    }
    const fileEntry = diffMap.get(resolvedFile)
    const linePos = fileEntry?.positions.get(line) ?? null
    const localLines = localMap?.get(resolvedFile)
    let inLocalDiff = localLines?.has(line) ?? false
    if (localLines && !inLocalDiff && Number.isInteger(finding.line_end) && finding.line_end > line) {
      for (const hunkLine of localLines) {
        if (hunkLine >= line && hunkLine <= finding.line_end) {
          inLocalDiff = true
          break
        }
      }
    }
    const isInReviewedDiff = opts.strongFindingIndexes?.has(index) ?? (localMap ? inLocalDiff : Boolean(linePos))
    if (!isInReviewedDiff) {
      outOfDiff.push(normalizedFinding)
      continue
    }
    inDiffIndexes.push(index)
    inDiff.push({
      ...normalizedFinding,
      _gitlabPosition: fileEntry && linePos
        ? {
            oldPath: fileEntry.oldPath,
            newPath: fileEntry.newPath,
            newLine: linePos.newLine,
            oldLine: linePos.oldLine,
          }
        : null,
    })
  }

  return { inDiff, outOfDiff, inDiffIndexes }
}

/**
 * Build the GitLab Discussions API `position` object for one inline finding.
 * @param {{ baseSha: string, startSha: string, headSha: string }} diffRefs
 * @param {{ oldPath: string, newPath: string, newLine: number, oldLine: number | null }} linePos
 */
export function buildGitLabPosition(diffRefs, linePos) {
  /** @type {Record<string, unknown>} */
  const position = {
    position_type: 'text',
    base_sha: diffRefs.baseSha,
    start_sha: diffRefs.startSha || diffRefs.baseSha,
    head_sha: diffRefs.headSha,
    old_path: linePos.oldPath,
    new_path: linePos.newPath,
    new_line: linePos.newLine,
  }
  if (typeof linePos.oldLine === 'number' && Number.isInteger(linePos.oldLine) && linePos.oldLine > 0) {
    position.old_line = linePos.oldLine
  }
  return position
}
