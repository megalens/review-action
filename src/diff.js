/**
 * Extract post-image (RIGHT-side) line numbers that appear inside unified diff hunks.
 * Includes added (+) and context (' ') lines within @@ ... @@ hunks; excludes deleted (-) lines.
 * @param {string | undefined} patch
 * @returns {Set<number>}
 */
export function hunkLinesInPatch(patch) {
  const lines = new Set()
  if (!patch) return lines
  let n = 0
  let inHunk = false
  for (const raw of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (header) {
      n = Number(header[1])
      inHunk = true
      continue
    }
    if (!inHunk || !raw || raw.startsWith('\\') || raw.startsWith('-')) continue
    lines.add(n)
    n += 1
  }
  return lines
}

/**
 * Normalize a repository-relative path, stripping diff prefixes like a/ or b/ and ./.
 * @param {string} raw
 * @returns {string}
 */
export function normalizePath(raw) {
  return raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^[ab]\//, '')
}

/**
 * Resolve a finding's file path against the known PR diff paths.
 * Checks exact match (without ./ prefix) before stripping a/ or b/ so real a/ or b/ folders work.
 * @param {string} raw
 * @param {Iterable<string>} known
 * @returns {string}
 */
export function resolveFindingPath(raw, known) {
  const set = known instanceof Set ? known : new Set(known)
  if (set.has(raw)) return raw
  const plain = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  return set.has(plain) ? plain : normalizePath(raw)
}

/**
 * Build a map of file path -> Set of post-image hunk line numbers from GitHub pull files.
 * @param {Array<{ filename: string, status?: string, patch?: string }>} pullFiles
 * @returns {Map<string, Set<number>>}
 */
export function buildDiffHunkMap(pullFiles) {
  const map = new Map()
  for (const file of pullFiles) {
    if (!file || typeof file.filename !== 'string') continue
    if (file.status === 'removed' || !file.patch) continue
    const hunkLines = hunkLinesInPatch(file.patch)
    if (hunkLines.size > 0) {
      map.set(file.filename, hunkLines)
    }
  }
  return map
}

/**
 * Partition findings into those whose file+line_start fall inside a PR diff hunk (inline-eligible)
 * and those outside hunks / without a line / on files without a patch (summary-only, never dropped).
 * @template {{ file?: string, line_start?: number }} T
 * @param {T[]} findings
 * @param {Array<{ filename: string, status?: string, patch?: string }>} pullFiles
 * @returns {{ inDiff: T[], outOfDiff: T[] }}
 */
export function partitionFindingsByDiff(findings, pullFiles) {
  const diffMap = buildDiffHunkMap(pullFiles)
  const allPullFiles = new Set(
    pullFiles
      .filter((f) => f && typeof f.filename === 'string')
      .map((f) => f.filename),
  )

  const inDiff = []
  const outOfDiff = []

  for (const finding of findings) {
    if (!finding || typeof finding.file !== 'string' || !finding.file.trim()) {
      outOfDiff.push(finding)
      continue
    }
    const resolvedFile = resolveFindingPath(finding.file, allPullFiles)
    const normalizedFinding = resolvedFile === finding.file ? finding : { ...finding, file: resolvedFile }
    const line = finding.line_start
    if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) {
      outOfDiff.push(normalizedFinding)
      continue
    }
    const hunkLines = diffMap.get(resolvedFile)
    if (!hunkLines || !hunkLines.has(line)) {
      outOfDiff.push(normalizedFinding)
      continue
    }
    inDiff.push(normalizedFinding)
  }

  return { inDiff, outOfDiff }
}

/**
 * Compatibility wrapper returning in-diff findings as `kept` and non-inline findings as `outOfDiff`.
 * @template {{ file?: string, line_start?: number }} T
 * @param {T[]} findings
 * @param {Array<{ filename: string, status?: string, patch?: string }>} pullFiles
 * @returns {{ kept: T[], outOfDiff: T[], droppedCount: number }}
 */
export function filterFindingsToDiff(findings, pullFiles) {
  const { inDiff, outOfDiff } = partitionFindingsByDiff(findings, pullFiles)
  return { kept: inDiff, outOfDiff, droppedCount: 0 }
}
