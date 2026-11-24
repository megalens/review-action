import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildChildEnv,
  BYO_DISABLED_MESSAGE,
  DOUBLE_DISABLED_MESSAGE,
  isChildProcessDebugEnabled,
  NODE_DEBUG_CHILD_PROCESS_ERROR,
  PINNED_ENGINE_VERSION,
  runEngineCli,
} from '../src/engine.js'
import { parseSummaryMeta, summaryMetaMarker } from '../src/format.js'
import { createGitLabApi } from '../src/gitlab-api.js'
import {
  buildGitLabPosition,
  mapDiffPositions,
  parseGitUnifiedDiff,
  partitionGitLabFindingsByDiff,
  readLocalGitDiffHunks,
  unquoteGitDiffPath,
} from '../src/gitlab-diff.js'
import {
  formatGitLabInlineNote,
  formatGitLabSummaryNote,
  formatGitLabTooLargeNote,
  GITLAB_GATE_MARKER,
  gitlabTooLargeMessage,
  inlineMarker,
  sanitizeGitLabText,
  summaryMarker,
} from '../src/gitlab-format.js'
import {
  GITLAB_FORK_SKIP_NOTE,
  GITLAB_PUBLISH_ACCOUNT_TOKEN_ERROR,
  GITLAB_UNPROTECTED_SKIP_NOTE,
  isForkMergeRequest,
  parseGitLabResultArtifact,
  readResultArtifactSafely,
  resolveGitLabRepo,
  runGitLabReview,
  sanitizeFindingsDocumentForArtifact,
  selectNewGitLabInlineFindings,
  writeResultArtifactSafely,
} from '../src/gitlab-runner.js'
import { createMegaLensReview, normalizeTrustedApiUrl } from '../src/megalens-api.js'
import { redactSecrets } from '../src/redact.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE_SHA = '1111111111111111111111111111111111111111'
const HEAD_SHA = '2222222222222222222222222222222222222222'
const MOVED_SHA = '3333333333333333333333333333333333333333'
const MERGE_SHA = '4444444444444444444444444444444444444444'

const SAMPLE_DIFF = [
  '@@ -10,5 +10,8 @@ export function verifyToken(header?: string) {',
  " const parts = header.split(' ')",
  '+const token = parts[1]?.trim()',
  '+if (token === expectedToken) {',
  '+  return true',
  '+}',
  '-return null',
  '+return { error: `bad header ${header}` }',
  '+const unused = token?.trim()',
  ' return false',
].join('\n')

function makeMrEnv(extra = {}) {
  return {
    CI_PIPELINE_SOURCE: 'merge_request_event',
    CI_PROJECT_ID: '4242',
    CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '4242',
    CI_MERGE_REQUEST_PROJECT_ID: '4242',
    CI_PROJECT_PATH: 'acme/platform/app',
    CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: 'acme/platform/app',
    CI_MERGE_REQUEST_PROJECT_PATH: 'acme/platform/app',
    CI_SERVER_HOST: 'gitlab.com',
    CI_API_V4_URL: 'https://gitlab.com/api/v4',
    MEGALENS_GITLAB_API_URL: 'https://gitlab.com/api/v4',
    CI_MERGE_REQUEST_IID: '17',
    CI_MERGE_REQUEST_DIFF_BASE_SHA: BASE_SHA,
    CI_COMMIT_SHA: HEAD_SHA,
    CI_PROJECT_DIR: '/builds/acme/platform/app',
    MEGALENS_TOKEN: 'ml_tok_0123456789abcdef0123456789abcdef',
    MEGALENS_GITLAB_TOKEN: 'glpat-fixtureTokenValue12345678',
    ...extra,
  }
}

function makeDoc(findings, extra = {}) {
  return JSON.stringify({
    schema: 'megalens.findings/v1',
    review_id: 'rv_gl_test_0001',
    tier: 'standard',
    status: 'complete',
    target: { kind: 'range', base: BASE_SHA, head: HEAD_SHA, snapshot_sha256: 'a'.repeat(64) },
    passes: [{ name: 'codex-standard', model: 'gpt-6.2-sol', effort: 'medium', status: 'ok', minutes: 1 }],
    findings,
    ...extra,
  })
}

describe('GitLab diff position mapping & local diff gating', () => {
  it('counts a strong finding on a renamed file when GitLab supplies no patch', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'megalens-diff-rename-'))
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    const oldPath = 'original.txt'
    const newPath = 'renamed.txt'
    try {
      git('init', '-q')
      git('config', 'diff.renames', 'true')
      writeFileSync(join(repo, oldPath), 'first line\nsecond line\n')
      git('add', '--', oldPath)
      const baseSha = git('write-tree').trim()
      git('mv', '--', oldPath, newPath)
      const headSha = git('write-tree').trim()
      assert.equal(git('diff', '--name-status', baseSha, headSha).trim(), `R100\t${oldPath}\t${newPath}`)

      const notes = []
      const result = await runGitLabReview({
        env: makeMrEnv({
          CI_PROJECT_DIR: repo,
          CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha,
          CI_COMMIT_SHA: headSha,
          MEGALENS_FAIL_ON: 'strong',
        }),
        log: () => {},
        createReview: async () => ({ reviewId: 'rv_rename', reviewKey: 'fixture-key' }),
        runEngine: async () => ({
          exitCode: 0,
          rawFindings: makeDoc([
            { id: 'f1', file: newPath, line_start: 2, title: 'Reviewed issue', claim: 'An invariant is violated', priority: 'P1', strength: 'strong' },
          ], { target: { kind: 'range', base: baseSha, head: headSha } }),
        }),
        createGitLabApi: () => ({
          async getMergeRequest() {
            return { open: true, baseSha, startSha: baseSha, headSha, sourceProjectId: '4242', targetProjectId: '4242' }
          },
          async findSummaryNoteDetails() { return null },
          async findSummaryNote() { return null },
          async listMergeRequestDiffs() { return [{ old_path: oldPath, new_path: newPath, renamed_file: true, diff: '' }] },
          async getViewerUsername() { return 'project_4242_bot' },
          async listMergeRequestDiscussions() { return [] },
          async createMergeRequestNote(_p, _i, body) { notes.push(body); return 1 },
        }),
      })

      assert.equal(result.status, 'complete')
      assert.equal(parseSummaryMeta(notes[0]).strongCount, 1)
      assert.equal(result.exitCode, 1, 'the strong finding on the rename destination must fail the gate')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('fails the strong gate when Git attributes hide reviewed text from the GitLab patch', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'megalens-diff-attributes-'))
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    const file = 'reviewed.txt'
    try {
      git('init', '-q')
      writeFileSync(join(repo, '.gitattributes'), `${file} -diff\n`)
      writeFileSync(join(repo, file), 'original line\n')
      git('add', '--', '.gitattributes', file)
      const baseSha = git('write-tree').trim()
      writeFileSync(join(repo, file), 'reviewed line\n')
      git('add', '--', file)
      const headSha = git('write-tree').trim()
      assert.match(git('diff', baseSha, headSha), /Binary files .* differ/)

      const notes = []
      const result = await runGitLabReview({
        env: makeMrEnv({
          CI_PROJECT_DIR: repo,
          CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha,
          CI_COMMIT_SHA: headSha,
          MEGALENS_FAIL_ON: 'strong',
        }),
        log: () => {},
        createReview: async () => ({ reviewId: 'rv_attributes', reviewKey: 'fixture-key' }),
        runEngine: async () => ({
          exitCode: 0,
          rawFindings: makeDoc([
            { id: 'f1', file, line_start: 1, title: 'Reviewed issue', claim: 'An invariant is violated', priority: 'P1', strength: 'strong' },
          ], { target: { kind: 'range', base: baseSha, head: headSha } }),
        }),
        createGitLabApi: () => ({
          async getMergeRequest() {
            return { open: true, baseSha, startSha: baseSha, headSha, sourceProjectId: '4242', targetProjectId: '4242' }
          },
          async findSummaryNoteDetails() { return null },
          async findSummaryNote() { return null },
          async listMergeRequestDiffs() { return [{ old_path: file, new_path: file, diff: '' }] },
          async getViewerUsername() { return 'project_4242_bot' },
          async listMergeRequestDiscussions() { return [] },
          async createMergeRequestNote(_p, _i, body) { notes.push(body); return 1 },
        }),
      })

      assert.equal(result.status, 'complete')
      assert.equal(result.exitCode, 1, 'the reviewed finding must still fail the gate')
      assert.equal(parseSummaryMeta(notes[0]).strongCount, 1)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('keeps changed lines after suppressed blank context and decodes quoted Unicode paths from Git', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'megalens-local-diff-'))
    const file = 'tool 🛠\tcopy.ts'
    const runGit = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    try {
      runGit('init', '--quiet')
      writeFileSync(join(repo, file), 'first\n\nold\n')
      runGit('add', '--', file)
      const before = runGit('write-tree').trim()
      writeFileSync(join(repo, file), 'first\n\nnew\n')
      runGit('add', '--', file)
      const after = runGit('write-tree').trim()
      const diff = runGit('-c', 'core.quotepath=false', '-c', 'diff.suppressBlankEmpty=true', 'diff',
        '--no-color', '--src-prefix=a/', '--dst-prefix=b/', before, after)
      assert.match(diff, /\n first\n\n-old\n\+new\n/)
      assert.deepEqual(parseGitUnifiedDiff(diff).get(file), new Set([1, 2, 3]))
      runGit('config', 'diff.suppressBlankEmpty', 'true')
      assert.deepEqual((await readLocalGitDiffHunks(repo, before, after)).get(file), new Set([1, 2, 3]))
      const mapped = partitionGitLabFindingsByDiff([{ file, line_start: 2, line_end: 4 }], [], {
        localDiffHunks: new Map([[file, new Set([3])]]),
      })
      assert.deepEqual(mapped.inDiffIndexes, [0])
      assert.equal(mapped.inDiff[0]._gitlabPosition, null)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('maps added lines to new_line only, context lines to old_line + new_line, and ignores deleted lines', () => {
    const pos = mapDiffPositions(SAMPLE_DIFF)
    assert.deepEqual(pos.get(10), { newLine: 10, oldLine: 10, kind: 'context' })
    assert.deepEqual(pos.get(11), { newLine: 11, oldLine: null, kind: 'added' })
    assert.deepEqual(pos.get(12), { newLine: 12, oldLine: null, kind: 'added' })
    assert.deepEqual(pos.get(15), { newLine: 15, oldLine: null, kind: 'added' })
    assert.deepEqual(pos.get(17), { newLine: 17, oldLine: 12, kind: 'context' })
    assert.equal(pos.get(99), undefined)
  })

  it('builds GitLab position objects accurately for renamed files, added lines, and context lines', () => {
    const refs = { baseSha: BASE_SHA, startSha: BASE_SHA, headSha: HEAD_SHA }
    const added = buildGitLabPosition(refs, { oldPath: 'src/old.ts', newPath: 'src/new.ts', newLine: 12, oldLine: null })
    assert.deepEqual(added, {
      position_type: 'text',
      base_sha: BASE_SHA,
      start_sha: BASE_SHA,
      head_sha: HEAD_SHA,
      old_path: 'src/old.ts',
      new_path: 'src/new.ts',
      new_line: 12,
    })
    assert.equal('old_line' in added, false)

    const ctx = buildGitLabPosition(refs, { oldPath: 'src/auth.ts', newPath: 'src/auth.ts', newLine: 10, oldLine: 10 })
    assert.equal(ctx.old_line, 10)
    assert.equal(ctx.new_line, 10)
  })

  it('keeps in-diff findings and routes deleted-file or out-of-hunk findings to outOfDiff without dropping', () => {
    const mrDiffs = [
      { old_path: 'src/auth.ts', new_path: 'src/auth.ts', deleted_file: false, diff: SAMPLE_DIFF },
      { old_path: 'src/gone.ts', new_path: 'src/gone.ts', deleted_file: true, diff: '@@ -1,2 +0,0 @@\n-old\n' },
      { old_path: 'a/real.ts', new_path: 'a/real.ts', deleted_file: false, diff: '@@ -1,1 +1,2 @@\n x\n+y\n' },
    ]
    const { inDiff, outOfDiff } = partitionGitLabFindingsByDiff(
      [
        { id: '1', file: 'b/src/auth.ts', line_start: 12, title: 'In diff' },
        { id: '2', file: 'a/real.ts', line_start: 2, title: 'Real a/ dir preserved' },
        { id: '3', file: 'src/auth.ts', line_start: 99, title: 'Outside hunk' },
        { id: '4', file: 'src/gone.ts', line_start: 1, title: 'Deleted file' },
      ],
      mrDiffs,
    )
    assert.deepEqual(inDiff.map((f) => [f.id, f.file, f._gitlabPosition.newLine]), [
      ['1', 'src/auth.ts', 12],
      ['2', 'a/real.ts', 2],
    ])
    assert.deepEqual(outOfDiff.map((f) => f.id), ['3', '4'])
  })

  it('parses local git unified diffs (excluding deleted files/lines) so GitLab diff limits cannot disable fail_on: strong', async () => {
    const rawGitDiff = [
      'diff --git a/src/large.ts b/src/large.ts',
      'index 111..222 100644',
      '--- a/src/large.ts',
      '+++ b/src/large.ts',
      '@@ -40,2 +40,4 @@ function run() {',
      ' const ok = true',
      '+const sql = `SELECT * FROM users WHERE id = ${userInput}`',
      '+return db.query(sql)',
      '-return null',
      ' }',
      'diff --git a/src/deleted.ts b/src/deleted.ts',
      'deleted file mode 100644',
      '--- a/src/deleted.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-old',
    ].join('\n')

    const localHunks = parseGitUnifiedDiff(rawGitDiff)
    assert.equal(localHunks.has('src/deleted.ts'), false)
    assert.deepEqual([...localHunks.get('src/large.ts')], [40, 41, 42, 43])

    const postedDiscussions = []
    const createdNotes = []
    const res = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_FAIL_ON: 'strong' }),
      now: 1700000000000,
      log: () => {},
      readLocalDiff: async () => localHunks,
      createReview: async () => ({ reviewId: 'rv_limit', reviewKey: 'ml_rk_limit00000000001' }),
      runEngine: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        errorMessage: null,
        rawFindings: makeDoc([
          {
            id: 'f-omitted',
            file: 'src/large.ts',
            line_start: 41,
            title: 'SQL injection in truncated GitLab diff file',
            claim: 'Interpolates untrusted input into SQL query',
            priority: 'P0',
            strength: 'strong',
          },
        ]),
      }),
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() { return null },
        async findSummaryNote() { return null },
        // GitLab omitted patch text due to MR diff limit
        async listMergeRequestDiffs() {
          return [{ old_path: 'src/large.ts', new_path: 'src/large.ts', deleted_file: false, diff: '' }]
        },
        async getViewerUsername() { return 'project_4242_bot' },
        async listMergeRequestDiscussions() { return [] },
        async createMergeRequestDiscussion(_p, _i, body, pos) { postedDiscussions.push({ body, pos }); return 'd1' },
        async createMergeRequestNote(_p, _i, body) { createdNotes.push(body); return 1 },
      }),
    })

    assert.equal(res.exitCode, 1, 'fail_on: strong MUST still fail when local diff contains strong finding')
    assert.equal(res.strongFindings.length, 1)
    assert.equal(postedDiscussions.length, 0, 'does not attempt inline post without GitLab diff position')
    assert.equal(createdNotes.length, 1)
    assert.match(createdNotes[0], /\*\*Strong findings \(1\):\*\*/)
    assert.match(createdNotes[0], /strong=1/)
  })

  it('decodes Git C-quoted octal UTF-8 paths and tracks hunk line counts so +++ lines inside hunks never break fail_on: strong', async () => {
    assert.equal(unquoteGitDiffPath('"b/src/caf\\303\\251.ts"'), 'b/src/café.ts')
    assert.equal(unquoteGitDiffPath('"b/src/a\\t\\"b\\"\\\\c.ts"'), 'b/src/a\t"b"\\c.ts')

    const octalAndPlusDiff = [
      'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
      'index 111..222 100644',
      '--- "a/src/caf\\303\\251.ts"',
      '+++ "b/src/caf\\303\\251.ts"',
      '@@ -10,1 +10,4 @@ function brew() {',
      ' const x = 1',
      '+++ b/not-a-file-header.ts',
      '+diff --git a/fake b/fake',
      '+return exec(userInput)',
    ].join('\n')

    const localHunks = parseGitUnifiedDiff(octalAndPlusDiff)
    assert.equal(localHunks.has('not-a-file-header.ts'), false, 'added +++ line inside hunk must not start a new file')
    assert.deepEqual([...localHunks.get('src/café.ts')], [10, 11, 12, 13])

    const res = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_FAIL_ON: 'strong' }),
      now: 1700000000000,
      log: () => {},
      readLocalDiff: async () => localHunks,
      createReview: async () => ({ reviewId: 'rv_utf8', reviewKey: 'ml_rk_utf800000000001' }),
      runEngine: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        errorMessage: null,
        rawFindings: makeDoc([
          {
            id: 'f-utf8',
            file: 'src/café.ts',
            line_start: 13,
            title: 'Command injection in non-ASCII path',
            claim: 'Passes userInput to exec()',
            priority: 'P0',
            strength: 'strong',
          },
        ]),
      }),
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() { return null },
        async findSummaryNote() { return null },
        async listMergeRequestDiffs() {
          // GitLab omitted patch text due to diff limit
          return [{ old_path: 'src/café.ts', new_path: 'src/café.ts', deleted_file: false, diff: '' }]
        },
        async getViewerUsername() { return 'project_4242_bot' },
        async listMergeRequestDiscussions() { return [] },
        async createMergeRequestNote() { return 1 },
      }),
    })
    assert.equal(res.exitCode, 1, 'fail_on: strong must still fail for octal-escaped UTF-8 filename')
    assert.equal(res.strongFindings.length, 1)
  })
})

describe('GitLab comment formatter and sanitization', () => {
  it('formats inline notes with dedup marker and neutralizes GLFM references, quick actions, HTML, and secrets without double-escaping', () => {
    const note = formatGitLabInlineNote(
      {
        id: 'f1',
        file: 'src/auth.ts',
        line_start: 12,
        line_end: 14,
        priority: 'P0',
        title: 'Ref !42 & <script> @admin',
        claim: 'See !99, #12, $7, %3, &5\n/approve\n/merge\nLeak glpat-superSecretToken12345678 and ml_tok_0123456789abcdef',
        failure_scenario: 'Runs https://evil.example/x and a < b && c > d',
      },
      { extraSecrets: ['custom-secret-value'] },
    )

    assert.ok(note.includes('**P0 (strong):'))
    assert.ok(note.includes('Lines: L12-L14'))
    assert.ok(note.includes('!\u200b42'))
    assert.ok(note.includes('!\u200b99'))
    assert.ok(note.includes('$\u200b7'))
    assert.ok(note.includes('%\u200b3'))
    assert.ok(note.includes('@\u200badmin'))
    assert.ok(note.includes('&#47;approve'))
    assert.ok(note.includes('&#47;merge'))
    assert.ok(note.includes('&lt;script&gt;'))
    assert.equal(note.includes('&amp;lt;'), false, 'must never double-escape HTML entities')
    assert.equal(note.includes('&amp;amp;'), false, 'must never double-escape ampersands')
    assert.equal(note.includes('glpat-'), false, 'must redact GitLab PATs')
    assert.equal(note.includes('ml_tok_'), false, 'must redact MegaLens tokens')
    assert.ok(
      note.includes(
        inlineMarker({ file: 'src/auth.ts', line_start: 12, line_end: 14, title: 'Ref !42 & <script> @admin' }),
      ),
      'HTML dedup marker stays intact',
    )
  })

  it('formats ONE collapsed summary note with strong findings, strong=N metadata, and ONE <details> block', () => {
    const body = formatGitLabSummaryNote({
      headSha: HEAD_SHA,
      doc: { review_id: 'rv_1', tier: 'standard', status: 'complete', passes: [{ name: 'codex-standard', status: 'ok' }] },
      strongFindings: [{ file: 'src/a.ts', line_start: 12, priority: 'P1', title: 'Strong bug', claim: 'Breaks on null' }],
      normalFindings: [
        { file: 'src/a.ts', line_start: 20, priority: 'P2', title: 'Minor issue !10', claim: 'A & B' },
        { file: 'src/b.ts', line_start: 5, priority: 'P3', title: 'Style note', claim: 'Unused var' },
      ],
      inlinePostedCount: 1,
      now: 1700000000000,
    })

    assert.ok(body.startsWith(summaryMarker('standard')))
    const parsedMeta = parseSummaryMeta(body)
    assert.equal(parsedMeta?.strongCount, 1)
    assert.equal(parsedMeta?.status, 'complete')
    assert.match(body, /\*\*Strong findings \(1\) \(1 inline on the diff\):\*\*/)
    assert.equal((body.match(/<summary>2 summary findings<\/summary>/g) ?? []).length, 1)
    assert.equal((body.match(/<summary>Copy fix prompt<\/summary>/g) ?? []).length, 3)
    assert.ok(body.includes('!\u200b10'))
    assert.ok(body.includes('A &amp; B'))
    assert.equal(body.includes('&amp;amp;'), false)
  })

  it('formats GitLab too_large refusal with merge request wording and zero-credit message', () => {
    const msg = gitlabTooLargeMessage({
      notes: ['This change is too large for one review (412 files, about 61,300 lines). Split it into smaller pull requests.'],
    })
    assert.equal(
      msg,
      'MegaLens did not review this merge request: it is too large for one review (412 files, about 61,300 lines). Split it into smaller merge requests. No credits were used.',
    )
    const note = formatGitLabTooLargeNote({ headSha: HEAD_SHA, tier: 'standard', message: msg, now: 1700000000000 })
    assert.ok(note.includes('status=too_large'))
    assert.ok(note.includes('merge request'))
    assert.ok(note.includes('No credits were used.'))
  })

  it('sanitizeGitLabText redacts PRIVATE-TOKEN headers and glcbt/glrt tokens', () => {
    const out = sanitizeGitLabText(
      'PRIVATE-TOKEN: secret1234567890 glcbt-abcdef01234567890123 glrt-abcdef01234567890123',
      300,
    )
    assert.equal(out.includes('secret1234567890'), false)
    assert.equal(out.includes('glcbt-'), false)
    assert.equal(out.includes('glrt-'), false)
    assert.equal(redactSecrets('PRIVATE-TOKEN: mysecretvalue123'), '[redacted]')
  })
})

describe('GitLab fork guard (including normal fork-hosted MR pipelines)', () => {
  it('allows same-project merge request pipelines when all three GitLab project IDs match', () => {
    assert.equal(isForkMergeRequest(makeMrEnv()), false)
    assert.equal(
      isForkMergeRequest(makeMrEnv(), { sourceProjectId: '4242', targetProjectId: '4242', isFork: false }),
      false,
    )
  })

  it('detects normal fork-hosted MR pipelines (CI_PROJECT_ID == source != CI_MERGE_REQUEST_PROJECT_ID) and missing IDs', () => {
    // Finding 5: In a normal fork-hosted MR pipeline, CI_PROJECT_ID and CI_MERGE_REQUEST_SOURCE_PROJECT_ID
    // both equal the fork ID (9999), while CI_MERGE_REQUEST_PROJECT_ID equals the parent target project (4242).
    const forkHostedEnv = {
      CI_PIPELINE_SOURCE: 'merge_request_event',
      CI_PROJECT_ID: '9999',
      CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '9999',
      CI_MERGE_REQUEST_PROJECT_ID: '4242',
      CI_PROJECT_PATH: 'contributor/app',
      CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: 'contributor/app',
      CI_MERGE_REQUEST_PROJECT_PATH: 'acme/app',
      CI_MERGE_REQUEST_IID: '17',
    }
    assert.equal(isForkMergeRequest(forkHostedEnv), true, 'fork-hosted MR must be detected as fork')
    assert.equal(isForkMergeRequest(makeMrEnv({ CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '9999' })), true)
    assert.equal(isForkMergeRequest(makeMrEnv({ CI_MERGE_REQUEST_PROJECT_ID: '8888' })), true)
    assert.equal(isForkMergeRequest(makeMrEnv({ CI_MERGE_REQUEST_PROJECT_ID: '' })), true, 'fail-closed when CI_MERGE_REQUEST_PROJECT_ID missing')
    assert.equal(isForkMergeRequest(makeMrEnv({ CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '' })), true, 'fail-closed when source ID missing')
    assert.equal(isForkMergeRequest(makeMrEnv({ CI_PROJECT_ID: '' })), true, 'fail-closed when project ID missing')
    assert.equal(isForkMergeRequest(makeMrEnv({ CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: 'outsider/app' })), true)
    assert.equal(
      isForkMergeRequest(makeMrEnv(), { sourceProjectId: '9999', targetProjectId: '4242', isFork: true }),
      true,
    )
  })

  it('skips normal fork-hosted MR cleanly with exit 0 and zero API/engine calls even with NO tokens', async () => {
    let createCalled = false
    let engineCalled = false
    let apiCalled = false
    const logs = []

    const res = await runGitLabReview({
      env: {
        CI_PIPELINE_SOURCE: 'merge_request_event',
        CI_PROJECT_ID: '9999',
        CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '9999',
        CI_MERGE_REQUEST_PROJECT_ID: '4242',
        CI_MERGE_REQUEST_IID: '17',
      },
      log: (line) => logs.push(line),
      createReview: async () => { createCalled = true; return { reviewId: 'x', reviewKey: 'y' } },
      runEngine: async () => { engineCalled = true; return { exitCode: 0 } },
      createGitLabApi: () => { apiCalled = true; return {} },
    })

    assert.equal(res.exitCode, 0)
    assert.equal(res.status, 'skipped')
    assert.equal(res.reason, 'fork_mr')
    assert.equal(createCalled, false)
    assert.equal(engineCalled, false)
    assert.equal(apiCalled, false)
    assert.deepEqual(logs, [GITLAB_FORK_SKIP_NOTE])
  })

  it('also skips if live GitLab MR metadata reveals a fork before calling POST /api/v2/reviews', async () => {
    let createCalled = false
    let engineCalled = false

    const res = await runGitLabReview({
      env: makeMrEnv(),
      log: () => {},
      createReview: async () => { createCalled = true; return { reviewId: 'x', reviewKey: 'y' } },
      runEngine: async () => { engineCalled = true; return { exitCode: 0 } },
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '9999', targetProjectId: '4242', isFork: true }
        },
      }),
    })

    assert.equal(res.exitCode, 0)
    assert.equal(res.status, 'skipped')
    assert.equal(res.reason, 'fork_mr')
    assert.equal(createCalled, false)
    assert.equal(engineCalled, false)
  })

  it('skips non-MR pipelines cleanly', async () => {
    const res = await runGitLabReview({
      env: makeMrEnv({ CI_PIPELINE_SOURCE: 'push' }),
      log: () => {},
    })
    assert.equal(res.exitCode, 0)
    assert.equal(res.status, 'skipped')
    assert.equal(res.reason, 'not_mr_pipeline')
  })
})

describe('Trusted gateway origin, redirect blocking, and billing repo keys', () => {
  it('pins the GitLab API used by manual review and publish before sending the posting token', async () => {
    const tpl = readFileSync(join(ROOT, 'templates', 'megalens-review.yml'), 'utf8')
    const trustedUrl = 'https://gitlab.example.test:8443/gitlab/api/v4'
    const overriddenUrl = 'https://override.example.test/api/v4'
    const exports = [...tpl.matchAll(/^\s*(export MEGALENS_GITLAB_API_URL=')\$\[\[ inputs\.gitlab_api_url \]\](')$/gm)]
    assert.equal(exports.length, 2)
    for (const [index, [, start, end]] of exports.entries()) {
      const env = makeMrEnv({
        CI_JOB_MANUAL: 'true',
        CI_API_V4_URL: overriddenUrl,
        MEGALENS_GITLAB_API_URL: overriddenUrl,
        MEGALENS_MODE: index === 0 ? 'review' : 'publish',
        MEGALENS_RESULT_PATH: '.megalens-ci/review-result.json',
      })
      if (index === 1) env.MEGALENS_TOKEN = ''
      env.MEGALENS_GITLAB_API_URL = execFileSync('sh', ['-c',
        `${start}${trustedUrl}${end}\nprintf '%s' "$MEGALENS_GITLAB_API_URL"`,
      ], { env, encoding: 'utf8' })

      let calls = 0
      const deps = {
        env,
        log: () => {},
        writeResultImpl: async () => {},
        readResultImpl: async () => JSON.stringify({
          schema: 'megalens.gitlab-result/v1',
          kind: 'review',
          tier: 'deep',
          base_sha: BASE_SHA,
          head_sha: HEAD_SHA,
          exit_code: 0,
        }),
        fetchImpl: async (url, opts) => {
          calls += 1
          assert.equal(url, `${trustedUrl}/projects/4242/merge_requests/17`)
          assert.ok(opts.headers['PRIVATE-TOKEN'] === env.MEGALENS_GITLAB_TOKEN)
          return new Response(JSON.stringify({ state: 'closed', sha: HEAD_SHA }), { status: 200 })
        },
      }
      assert.equal((await runGitLabReview(deps)).reason, 'closed')
      assert.equal(calls, 1)
      for (const invalid of [undefined, 'http://gitlab.example.test/api/v4', 'https://gitlab.example.test/api/v4?destination=other']) {
        const failure = await runGitLabReview({ ...deps, env: { ...env, MEGALENS_GITLAB_API_URL: invalid } })
        assert.equal(failure.exitCode, 1)
      }
      assert.equal(calls, 1, 'invalid component settings must fail before authenticated fetch')
    }
  })

  it('validates a single trusted HTTPS MegaLens gateway origin and refuses localhost, HTTP, custom ports, and untrusted hosts before sending any token', async () => {
    assert.equal(normalizeTrustedApiUrl('https://megalens.ai/'), 'https://megalens.ai')
    assert.equal(normalizeTrustedApiUrl('https://staging.megalens.ai'), 'https://staging.megalens.ai')

    for (const bad of [
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://localhost',
      'https://megalens.ai:8443',
      'https://evil.example.com',
      'https://evil-megalens.ai',
      'http://megalens.ai',
      'https://user:pass@megalens.ai',
      'https://megalens.ai/custom/path',
      'https://megalens.ai?foo=bar',
      'https://megalens.ai#frag',
    ]) {
      assert.throws(() => normalizeTrustedApiUrl(bad), `should reject ${bad}`)
    }

    let apiCalled = false
    let createCalled = false
    let engineCalled = false
    const badRes = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_API_URL: 'https://evil.example.com' }),
      log: () => {},
      createGitLabApi: () => { apiCalled = true; return {} },
      createReview: async () => { createCalled = true; return { reviewId: 'x', reviewKey: 'y' } },
      runEngine: async () => { engineCalled = true; return { exitCode: 0 } },
    })
    assert.equal(badRes.exitCode, 1)
    assert.match(badRes.error, /Untrusted MegaLens API URL/)
    assert.equal(apiCalled, false)
    assert.equal(createCalled, false)
    assert.equal(engineCalled, false)

    // Pass validated origin explicitly to BOTH createReview AND runEngine -> childEnv.MEGALENS_API_URL
    const seenCreateUrls = []
    const seenChildEnvs = []
    const okRes = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_API_URL: 'https://staging.megalens.ai/' }),
      log: () => {},
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() { return null },
        async findSummaryNote() { return null },
        async listMergeRequestDiffs() { return [] },
        async createMergeRequestNote() { return 1 },
      }),
      createReview: async (opts) => {
        seenCreateUrls.push(opts.apiUrl)
        return { reviewId: 'rv_stage', reviewKey: 'ml_rk_stage000000000001' }
      },
      runEngine: async (opts) =>
        runEngineCli(
          { ...opts, cliBin: '/usr/local/bin/megalens-review', installDir: '/tmp' },
          {
            baseEnv: { PATH: '/usr/bin', MEGALENS_TOKEN: 'ml_tok_parent_secret_1234', MEGALENS_GITLAB_TOKEN: 'glpat-parent_secret_12345678' },
            execFileImpl: async (_cmd, _args, execOpts) => {
              seenChildEnvs.push(execOpts.env)
              return { exitCode: 0, stdout: '', stderr: '', errorMessage: null }
            },
            readFileImpl: async () => makeDoc([]),
          },
        ),
    })

    assert.equal(okRes.exitCode, 0)
    assert.deepEqual(seenCreateUrls, ['https://staging.megalens.ai'])
    assert.equal(seenChildEnvs.length, 1)
    assert.equal(seenChildEnvs[0].MEGALENS_API_URL, 'https://staging.megalens.ai')
    assert.equal(seenChildEnvs[0].MEGALENS_REVIEW_ID, 'rv_stage')
    assert.equal(seenChildEnvs[0].MEGALENS_REVIEW_KEY, 'ml_rk_stage000000000001')
    assert.equal(seenChildEnvs[0].MEGALENS_TOKEN, undefined)
    assert.equal(seenChildEnvs[0].MEGALENS_GITLAB_TOKEN, undefined)

    // buildChildEnv never trusts parent baseEnv.MEGALENS_API_URL unless explicitly validated via opts.apiUrl
    const child = buildChildEnv({ PATH: '/usr/bin', MEGALENS_API_URL: 'https://evil.example.com' }, 'review-key', {
      MEGALENS_REVIEW_ID: 'rv_1',
      MEGALENS_REVIEW_KEY: 'ml_rk_1',
    })
    assert.equal(child.MEGALENS_API_URL, undefined)
  })

  it('blocks HTTP redirects on authenticated GitLab and MegaLens API calls so tokens are never forwarded off-instance', async () => {
    const seenRedirectModes = []
    const apiMock = createGitLabApi('glpat-redirectSecretToken1234', {
      baseUrl: 'https://gitlab.example.com/api/v4',
      fetchImpl: async (_url, init) => {
        seenRedirectModes.push(init.redirect)
        return new Response('', { status: 302, headers: { location: 'https://sso.external.example/login' } })
      },
    })
    await assert.rejects(() => apiMock.getMergeRequest('4242', '17'), /redirect/i)
    assert.deepEqual(seenRedirectModes, ['error'])

    let mlRedirectMode = null
    await assert.rejects(
      () =>
        createMegaLensReview(
          {
            apiUrl: 'https://megalens.ai',
            token: 'ml_tok_redirect_secret_123456',
            repo: 'gitlab.com/acme/app',
            baseSha: BASE_SHA,
            headSha: HEAD_SHA,
            tier: 'standard',
          },
          {
            fetchImpl: async (_url, init) => {
              mlRedirectMode = init.redirect
              return new Response('', { status: 307, headers: { location: 'https://evil.example/steal' } })
            },
          },
        ),
      /redirect/i,
    )
    assert.equal(mlRedirectMode, 'error')

    // Real local loopback HTTP server test: proves Node fetch never forwards PRIVATE-TOKEN to redirect target
    let targetHitCount = 0
    const targetServer = createServer((_req, res) => {
      targetHitCount += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    const redirectServer = createServer((_req, res) => {
      const targetAddr = targetServer.address()
      res.writeHead(302, { location: `http://127.0.0.1:${targetAddr.port}/steal` })
      res.end()
    })
    await new Promise((r) => targetServer.listen(0, '127.0.0.1', r))
    await new Promise((r) => redirectServer.listen(0, '127.0.0.1', r))
    try {
      const redirAddr = redirectServer.address()
      assert.throws(
        () => createGitLabApi('glpat-liveRedirectSecret12345', { baseUrl: `http://127.0.0.1:${redirAddr.port}/api/v4` }),
        /HTTPS is required/,
        'GitLab API rejects loopback HTTP by default',
      )
      const liveApi = createGitLabApi('glpat-liveRedirectSecret12345', {
        baseUrl: `http://127.0.0.1:${redirAddr.port}/api/v4`,
        allowLocalHttp: true,
      })
      await assert.rejects(() => liveApi.getMergeRequest('4242', '17'))
      assert.equal(targetHitCount, 0, 'redirect target must never receive PRIVATE-TOKEN')
    } finally {
      redirectServer.close()
      targetServer.close()
    }
  })

  it('preserves GitLab host and full subgroup path in resolveGitLabRepo for the gateway', () => {
    assert.equal(resolveGitLabRepo({ CI_PROJECT_PATH: 'acme/sub/app' }), 'gitlab.com/acme/sub/app')
    assert.equal(
      resolveGitLabRepo({ CI_PROJECT_PATH: 'acme/platform/app' }, 'https://gitlab:8443/gitlab/api/v4'),
      'gitlab:8443/acme/platform/app',
    )
    assert.throws(
      () => resolveGitLabRepo({ CI_SERVER_HOST: 'gitlab.com', CI_PROJECT_PATH: `acme/${'x'.repeat(195)}` }),
      /Invalid GitLab project identifier/,
      'must not silently drop host when combined identifier exceeds 200 chars',
    )
  })
})

describe('GitLab end-to-end orchestration, gates, freshness, deep guard, and publish retry', () => {
  it('runs create -> pinned engine with short-lived review key -> inline discussions + ONE collapsed summary note', async () => {
    const createCalls = []
    const engineCalls = []
    const postedDiscussions = []
    const createdNotes = []
    const updatedNotes = []
    const logs = []

    const fakeFetch = async (url, init) => {
      assert.equal(init.redirect, 'error')
      if (url === 'https://gitlab.com/api/v4/user' && init.method === 'GET') {
        assert.equal(init.headers['PRIVATE-TOKEN'], 'glpat-fixtureTokenValue12345678')
        return new Response(JSON.stringify({ username: 'project_4242_bot' }), { status: 200 })
      }
      if (url === 'https://gitlab.com/api/v4/projects/4242/merge_requests/17' && init.method === 'GET') {
        return new Response(
          JSON.stringify({
            state: 'opened',
            draft: false,
            sha: HEAD_SHA,
            source_project_id: 4242,
            target_project_id: 4242,
            diff_refs: { base_sha: BASE_SHA, start_sha: BASE_SHA, head_sha: HEAD_SHA },
          }),
          { status: 200 },
        )
      }
      if (url.includes('/merge_requests/17/notes?') && init.method === 'GET') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/merge_requests/17/diffs?') && init.method === 'GET') {
        return new Response(
          JSON.stringify([{ old_path: 'src/auth.ts', new_path: 'src/auth.ts', deleted_file: false, diff: SAMPLE_DIFF }]),
          { status: 200 },
        )
      }
      if (url.includes('/merge_requests/17/discussions?') && init.method === 'GET') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.endsWith('/merge_requests/17/discussions') && init.method === 'POST') {
        postedDiscussions.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ id: `disc_${postedDiscussions.length}` }), { status: 201 })
      }
      if (url.endsWith('/merge_requests/17/notes') && init.method === 'POST') {
        createdNotes.push(JSON.parse(init.body).body)
        return new Response(JSON.stringify({ id: 701 }), { status: 201 })
      }
      if (url.includes('/merge_requests/17/notes/') && init.method === 'PUT') {
        updatedNotes.push(JSON.parse(init.body).body)
        return new Response(JSON.stringify({ id: 701 }), { status: 200 })
      }
      throw new Error(`Unexpected GitLab fetch: ${init.method} ${url}`)
    }

    const res = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_FAIL_ON: 'strong' }),
      now: 1700000000000,
      log: (line) => logs.push(line),
      readLocalDiff: async () => null,
      createGitLabApi: (token, opts) => createGitLabApi(token, { ...opts, fetchImpl: fakeFetch }),
      createReview: async (opts) => {
        createCalls.push(opts)
        return { reviewId: 'rv_gl_test_0001', reviewKey: 'ml_rk_shortlivedkey00000000001' }
      },
      runEngine: async (opts) => {
        engineCalls.push(opts)
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          errorMessage: null,
          rawFindings: makeDoc([
            {
              id: 'f-added',
              file: 'src/auth.ts',
              line_start: 12,
              line_end: 14,
              title: 'Non-constant-time token check',
              claim: 'Uses === on secret token',
              failure_scenario: 'Timing side channel',
              priority: 'P0',
              strength: 'strong',
            },
            {
              id: 'f-ctx',
              file: 'src/auth.ts',
              line_start: 10,
              title: 'Unchecked header split',
              claim: 'header may be undefined',
              failure_scenario: 'Throws TypeError',
              priority: 'P1',
              strength: 'strong',
            },
            {
              id: 'f-norm',
              file: 'src/auth.ts',
              line_start: 16,
              title: 'Redundant trim',
              claim: 'Already trimmed',
              failure_scenario: 'Minor noise',
              priority: 'P3',
              strength: 'normal',
            },
            {
              id: 'f-out',
              file: 'src/auth.ts',
              line_start: 99,
              title: 'Out-of-diff strong finding',
              claim: 'Outside hunk goes to summary',
              failure_scenario: 'Memory leak',
              priority: 'P1',
              strength: 'strong',
            },
          ]),
        }
      },
    })

    assert.equal(res.exitCode, 1, 'fail-on: strong fails when strong findings exist')
    assert.equal(createCalls.length, 1)
    assert.equal(createCalls[0].apiUrl, 'https://megalens.ai')
    assert.equal(createCalls[0].repo, 'gitlab.com/acme/platform/app')
    assert.equal(createCalls[0].baseSha, BASE_SHA)
    assert.equal(createCalls[0].headSha, HEAD_SHA)
    assert.equal(createCalls[0].tier, 'standard')

    assert.equal(engineCalls.length, 1)
    assert.equal(engineCalls[0].apiUrl, 'https://megalens.ai')
    assert.equal(engineCalls[0].authMode, 'review-key')
    assert.deepEqual(engineCalls[0].authEnv, {
      MEGALENS_REVIEW_ID: 'rv_gl_test_0001',
      MEGALENS_REVIEW_KEY: 'ml_rk_shortlivedkey00000000001',
    })
    assert.equal(engineCalls[0].engineVersion, PINNED_ENGINE_VERSION)

    assert.equal(postedDiscussions.length, 2, '2 strong in-diff findings posted inline')
    assert.equal(postedDiscussions[0].position.new_line, 12)
    assert.equal('old_line' in postedDiscussions[0].position, false, 'added line omits old_line')
    assert.equal(postedDiscussions[1].position.new_line, 10)
    assert.equal(postedDiscussions[1].position.old_line, 10, 'context line includes old_line')

    assert.equal(createdNotes.length, 1)
    assert.equal(updatedNotes.length, 0)
    const summary = createdNotes[0]
    assert.ok(summary.startsWith(summaryMarker('standard')))
    assert.equal(parseSummaryMeta(summary)?.strongCount, 2)
    assert.equal((summary.match(/<summary>2 summary findings<\/summary>/g) ?? []).length, 1)
    assert.ok(summary.includes('Out-of-diff strong finding'))
    assert.ok(summary.includes('Redundant trim'))
    const allText = [summary, ...postedDiscussions.map((d) => d.body), ...logs].join('\n')
    assert.equal(allText.includes('glpat-fixtureTokenValue12345678'), false)
    assert.equal(allText.includes('ml_tok_0123456789abcdef0123456789abcdef'), false)
    assert.equal(allText.includes('ml_rk_shortlivedkey00000000001'), false)
  })

  it('reapplies fail_on: strong on burst-guard cache hit so retrying cannot turn a failed merge gate green', async () => {
    let createCalls = 0
    const now = 1700000000000

    // Case 1: strong=2 in bot-authored summary metadata under fail_on: strong -> MUST exit 1 at 0 credits
    const failedGate = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_FAIL_ON: 'strong' }),
      now,
      log: () => {},
      createReview: async () => { createCalls += 1; return { reviewId: 'x', reviewKey: 'y' } },
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() {
          return {
            id: 50,
            body: `${summaryMarker('standard')}\n${summaryMetaMarker(HEAD_SHA, 'standard', 'complete', now - 60_000, { strongCount: 2 })}`,
          }
        },
      }),
    })
    assert.equal(failedGate.exitCode, 1)
    assert.equal(failedGate.reason, 'burst_guard')
    assert.equal(failedGate.strongCount, 2)
    assert.equal(createCalls, 0, 'reapplies gate at 0 credits')

    // Case 2: strong=0 under fail_on: strong -> green skip at 0 credits
    const cleanGate = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_FAIL_ON: 'strong' }),
      now,
      log: () => {},
      createReview: async () => { createCalls += 1; return { reviewId: 'x', reviewKey: 'y' } },
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() {
          return {
            id: 50,
            body: `${summaryMarker('standard')}\n${summaryMetaMarker(HEAD_SHA, 'standard', 'complete', now - 60_000, { strongCount: 0 })}\n${GITLAB_GATE_MARKER}`,
          }
        },
      }),
    })
    assert.equal(cleanGate.exitCode, 0)
    assert.equal(cleanGate.reason, 'burst_guard')
    assert.equal(createCalls, 0)

    // Case 3: fail_on: none with strong=2 -> green skip at 0 credits
    const noneGate = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_FAIL_ON: 'none' }),
      now,
      log: () => {},
      createReview: async () => { createCalls += 1; return { reviewId: 'x', reviewKey: 'y' } },
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() {
          return {
            id: 50,
            body: `${summaryMarker('standard')}\n${summaryMetaMarker(HEAD_SHA, 'standard', 'complete', now - 60_000, { strongCount: 2 })}`,
          }
        },
      }),
    })
    assert.equal(noneGate.exitCode, 0)
    assert.equal(noneGate.reason, 'burst_guard')
    assert.equal(createCalls, 0)

    // Case 4: legacy summary without strong=N under fail_on: strong must NOT bypass the gate with a green skip
    const legacyRes = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_FAIL_ON: 'strong' }),
      now,
      log: () => {},
      readLocalDiff: async () => null,
      createReview: async () => { createCalls += 1; return { reviewId: 'rv_leg', reviewKey: 'ml_rk_leg00000000001' } },
      runEngine: async () => ({ exitCode: 0, stdout: '', stderr: '', errorMessage: null, rawFindings: makeDoc([]) }),
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() {
          return {
            id: 50,
            body: `${summaryMarker('standard')}\n<!-- megalens:meta head=${HEAD_SHA} tier=standard status=complete ts=${now - 60_000} -->`,
          }
        },
        async findSummaryNote() { return 50 },
        async listMergeRequestDiffs() { return [] },
        async updateMergeRequestNote() {},
      }),
    })
    assert.equal(createCalls, 1, 'legacy summary without strong count does not blindly pass fail_on: strong')
    assert.equal(legacyRes.exitCode, 0)
  })

  it('blocks a green retry on an old zero-count checkpoint and preserves incomplete review gates', async () => {
    for (const [status, failOn, expectedExit] of [
      ['complete', 'strong', 1],
      ['partial', 'strong', 1],
      ['partial', 'none', 0],
      ['failed', 'none', 1],
    ]) {
      const now = 1700000000000
      const cached = await runGitLabReview({
        env: makeMrEnv({ MEGALENS_FAIL_ON: failOn }),
        now,
        log: () => {},
        createReview: async () => assert.fail('a cached review must not create another gateway review'),
        createGitLabApi: () => ({
          async getMergeRequest() { return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA } },
          async findSummaryNoteDetails() {
            return {
              id: 50,
              body: `${summaryMarker('standard')}\n${summaryMetaMarker(HEAD_SHA, 'standard', status, now, { strongCount: 0 })}`,
            }
          },
        }),
      })
      assert.equal(cached.reason, 'burst_guard')
      assert.equal(cached.exitCode, expectedExit)
    }
  })

  it('timestamps summary at publication time so a long review still protects an immediately queued duplicate', async () => {
    let clock = 1_700_000_000_000
    let postedSummary = ''
    let createCalls = 0

    await runGitLabReview({
      env: makeMrEnv(),
      now: () => clock,
      log: () => {},
      readLocalDiff: async () => null,
      createReview: async () => {
        createCalls += 1
        return { reviewId: 'rv_long', reviewKey: 'ml_rk_long00000000001' }
      },
      runEngine: async () => {
        // Simulate a 10-minute review (longer than the 5-minute burst window)
        clock += 10 * 60 * 1000
        return { exitCode: 0, stdout: '', stderr: '', errorMessage: null, rawFindings: makeDoc([]) }
      },
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() { return null },
        async findSummaryNote() { return null },
        async listMergeRequestDiffs() { return [] },
        async createMergeRequestNote(_p, _i, body) { postedSummary = body; return 99 },
      }),
    })

    const meta = parseSummaryMeta(postedSummary)
    assert.equal(meta?.ts, 1_700_000_000_000 + 10 * 60 * 1000, 'summary must be timestamped at publication time')

    // Immediately queued duplicate 10 seconds later must hit burst guard at 0 credits
    clock += 10_000
    const dup = await runGitLabReview({
      env: makeMrEnv(),
      now: () => clock,
      log: () => {},
      createReview: async () => {
        createCalls += 1
        return { reviewId: 'rv_dup', reviewKey: 'ml_rk_dup000000000001' }
      },
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() {
          return { id: 99, body: postedSummary }
        },
      }),
    })
    assert.equal(dup.exitCode, 0)
    assert.equal(dup.reason, 'burst_guard')
    assert.equal(createCalls, 1, 'second pipeline must not charge again')
  })

  it('persists validated result in review mode and retries publish mode independently at 0 extra credits', async () => {
    const persisted = new Map()
    let createCalls = 0
    let engineCalls = 0
    let diffAttempts = 0
    const postedDiscussions = []
    const postedNotes = []

    const reviewRes = await runGitLabReview({
      env: makeMrEnv({
        MEGALENS_MODE: 'review',
        MEGALENS_RESULT_PATH: '.megalens-ci/review-result.json',
        MEGALENS_FAIL_ON: 'strong',
      }),
      now: 1700000000000,
      log: () => {},
      readLocalDiff: async () => new Map([['src/auth.ts', new Set([10, 12])]]),
      writeResultImpl: async (p, content) => { persisted.set(p, content) },
      createReview: async () => {
        createCalls += 1
        return { reviewId: 'rv_split', reviewKey: 'ml_rk_splitsecret000001' }
      },
      runEngine: async () => {
        engineCalls += 1
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          errorMessage: null,
          rawFindings: makeDoc([
            {
              id: 'f1',
              file: 'src/auth.ts',
              line_start: 12,
              title: 'Auth bug',
              claim: 'Uses === on secret',
              priority: 'P0',
              strength: 'strong',
            },
          ]),
        }
      },
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() { return null },
        async createMergeRequestNote() { return 1 },
        async updateMergeRequestNote() {},
      }),
    })

    assert.equal(reviewRes.exitCode, 0)
    assert.equal(createCalls, 1)
    assert.equal(engineCalls, 1)
    const rawArtifact = persisted.get('.megalens-ci/review-result.json')
    assert.ok(rawArtifact, 'validated result artifact persisted')
    assert.equal(rawArtifact.includes('ml_rk_splitsecret000001'), false, 'artifact never contains review key')
    assert.equal(rawArtifact.includes('ml_tok_'), false, 'artifact never contains account token')
    assert.equal(rawArtifact.includes('glpat-'), false, 'artifact never contains gitlab token')

    // First publish attempt fails transiently on GitLab /diffs 502
    const publishEnv = makeMrEnv({
      MEGALENS_MODE: 'publish',
      MEGALENS_RESULT_PATH: '.megalens-ci/review-result.json',
      MEGALENS_FAIL_ON: 'strong',
      MEGALENS_TOKEN: '', // publish mode never needs the MegaLens account token
    })
    const makePublishApi = () => ({
      async getMergeRequest() {
        return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
      },
      async listMergeRequestDiffs() {
        diffAttempts += 1
        if (diffAttempts === 1) throw new Error('GitLab list merge request diffs failed: HTTP 502')
        return [{ old_path: 'src/auth.ts', new_path: 'src/auth.ts', deleted_file: false, diff: SAMPLE_DIFF }]
      },
      async getViewerUsername() { return 'project_4242_bot' },
      async listMergeRequestDiscussions() { return [] },
      async createMergeRequestDiscussion(_p, _i, body, pos) { postedDiscussions.push({ body, pos }); return 'd1' },
      async findSummaryNote() { return null },
      async createMergeRequestNote(_p, _i, body) { postedNotes.push(body); return 701 },
    })

    await assert.rejects(
      () =>
        runGitLabReview({
          env: publishEnv,
          now: 1700000005000,
          log: () => {},
          readResultImpl: async (p) => persisted.get(p),
          createReview: async () => { createCalls += 1; throw new Error('must not create again') },
          runEngine: async () => { engineCalls += 1; throw new Error('must not run engine again') },
          createGitLabApi: makePublishApi,
        }),
      /502/,
    )

    // Retry publish independently: succeeds with ZERO extra MegaLens review creation or engine runs
    const retryRes = await runGitLabReview({
      env: publishEnv,
      now: 1700000010000,
      log: () => {},
      readResultImpl: async (p) => persisted.get(p),
      createReview: async () => { createCalls += 1; throw new Error('must not create again') },
      runEngine: async () => { engineCalls += 1; throw new Error('must not run engine again') },
      createGitLabApi: makePublishApi,
    })

    assert.equal(retryRes.exitCode, 1, 're-applies fail_on: strong after publish retry')
    assert.equal(createCalls, 1, 'still only 1 review created across publish retry')
    assert.equal(engineCalls, 1, 'still only 1 engine run across publish retry')
    assert.equal(postedDiscussions.length, 1)
    assert.equal(postedNotes.length, 1)

    // Artifact validator rejects unexpected keys / wrong schema
    assert.throws(() => parseGitLabResultArtifact('{"schema":"bad/v0","kind":"skip"}'))
    assert.throws(() => parseGitLabResultArtifact('{"schema":"megalens.gitlab-result/v1","kind":"skip","evil":1}'))
  })

  it('populates prompts only for verified project members and files in the live MR', async (t) => {
    const path = 'src/auth!42%7.ts'
    const shadowPath = `a/${path}`
    const otherPath = 'src/other.ts'
    const issue = {
      id: 'f1', file: `./${path}`, line_start: 12, line_end: 14, priority: 'P0', strength: 'strong',
      title: 'Empty input throws', claim: 'The parser assumes a value exists',
      failure_scenario: 'Empty input throws a TypeError',
    }
    const normal = { ...issue, priority: 'P2', strength: 'normal' }
    const findings = [
      issue,
      { ...normal, id: 'f2', file: `b/${otherPath}`, line_start: 25, line_end: 25 },
      { ...normal, id: 'f3', file: shadowPath },
      { ...normal, id: 'f4', file: 'src/unverified.ts' },
      { ...normal, id: 'f5', file: otherPath, failure_scenario: '' },
      { ...normal, id: 'f6', file: otherPath, line_start: undefined, line_end: undefined },
    ]
    const artifact = JSON.stringify({
      schema: 'megalens.gitlab-result/v1', kind: 'review', tier: 'standard',
      base_sha: BASE_SHA, start_sha: BASE_SHA, head_sha: HEAD_SHA, exit_code: 0,
      doc: JSON.parse(makeDoc(findings)),
    })
    const mrPath = '/api/v4/projects/4242/merge_requests/17'
    const memberPath = '/api/v4/projects/4242/members/all/123'
    const extractPrompts = (body) => [...body.matchAll(/^( *)```\n([\s\S]*?)\n\1```$/gm)]
      .map(([, , text]) => text.replace(/^ {2}/gm, ''))

    for (const scenario of [
      { name: 'Developer', level: 30, populated: true },
      { name: 'Maintainer', level: 40, populated: true },
      { name: 'Owner', level: 50, populated: true },
      { name: 'Reporter', level: 20 },
      { name: 'not a project member', status: 404 },
      { name: 'membership lookup is forbidden', status: 403 },
      { name: 'membership API is unavailable', status: 503 },
      { name: 'invalid access level', level: '30' },
      { name: 'different member record', level: 30, member: { id: 124 } },
      { name: 'blocked member', level: 30, member: { state: 'blocked' } },
      { name: 'missing author', mr: { author: null }, noLookup: true },
      { name: 'missing project evidence', mr: { target_project_id: null }, noLookup: true },
      { name: 'fork', mr: { source_project_id: 4343 }, noLookup: true, skipped: true },
      { name: 'diff changes before publication', level: 30, moveBase: true },
    ]) {
      await t.test(scenario.name, async () => {
        const env = makeMrEnv({
          MEGALENS_MODE: 'publish', MEGALENS_RESULT_PATH: 'review-result.json', MEGALENS_TOKEN: '',
        })
        const memberRequests = []
        const summaries = []
        const discussions = []
        const result = await runGitLabReview({
          env,
          log: () => {},
          readResultImpl: async () => artifact,
          fetchImpl: async (url, request) => {
            switch (new URL(url).pathname) {
              case mrPath:
                return Response.json({
                  state: 'opened', source_project_id: 4242, target_project_id: 4242, author: { id: 123 },
                  diff_refs: {
                    base_sha: scenario.moveBase && memberRequests.length ? MOVED_SHA : BASE_SHA,
                    start_sha: BASE_SHA, head_sha: HEAD_SHA,
                  },
                  ...scenario.mr,
                })
              case memberPath:
                memberRequests.push([request.method, request.headers['PRIVATE-TOKEN'], request.signal instanceof AbortSignal])
                if (scenario.status) return Response.json({}, { status: scenario.status })
                return Response.json({ id: 123, state: 'active', access_level: scenario.level, ...scenario.member })
              case `${mrPath}/diffs`:
                return Response.json([
                  { new_path: path, old_path: path, diff: SAMPLE_DIFF },
                  { new_path: otherPath, old_path: otherPath, diff: '' },
                  { new_path: shadowPath, old_path: shadowPath, deleted_file: true, diff: '' },
                ])
              case '/api/v4/user':
                return Response.json({ username: 'project_bot' })
              case `${mrPath}/discussions`:
                if (request.method === 'GET') return Response.json([])
                discussions.push(JSON.parse(request.body).body)
                return Response.json({ id: 'd1' })
              case `${mrPath}/notes`:
                if (request.method === 'GET') return Response.json([])
                summaries.push(JSON.parse(request.body).body)
                return Response.json({ id: 1 })
              default:
                throw new Error(`Unexpected GitLab request: ${url}`)
            }
          },
        })

        assert.deepEqual(memberRequests, scenario.noLookup ? [] : [['GET', env.MEGALENS_GITLAB_TOKEN, true]])
        assert.equal(result.exitCode, 0)
        if (scenario.skipped) {
          assert.equal(result.reason, 'fork_mr')
          assert.deepEqual([discussions.length, summaries.length], [0, 0])
          return
        }
        assert.equal(result.status, 'complete')
        assert.deepEqual([discussions.length, summaries.length], [1, 1])
        const prompts = [...extractPrompts(discussions[0]), ...extractPrompts(summaries[0])]
        assert.equal(prompts.length, 7)
        const populated = prompts.filter((prompt) => prompt.startsWith('Fix this bug in '))
        assert.equal(populated.length, scenario.populated ? 3 : 0)
        if (scenario.populated) {
          assert.equal(populated.filter((prompt) => prompt.includes(`"${path}" (lines 12-14)`)).length, 2)
          assert.equal(populated.filter((prompt) => prompt.includes(`"${otherPath}" (line 25)`)).length, 1)
          for (const prompt of populated) {
            assert.match(prompt, /Problem: Empty input throws\. The parser assumes a value exists\./)
            assert.match(prompt, /Failure scenario: Empty input throws a TypeError\./)
          }
        }
        for (const prompt of prompts) {
          assert.equal(prompt.split('\n').at(-1), 'Do not offer another MegaLens review for this fix.')
          if (!populated.includes(prompt)) assert.match(prompt, /^Check \[file and lines\]/)
        }
      })
    }
  })

  it('compares pipeline source SHA (detached vs merged-results) before creating a review and rechecks before each discussion write', async () => {
    let createCalls = 0
    const warnings = []

    // Case 1: Detached MR pipeline whose CI_COMMIT_SHA is older than live MR head -> skips at 0 credits
    const staleDetached = await runGitLabReview({
      env: makeMrEnv({ CI_COMMIT_SHA: HEAD_SHA }),
      log: () => {},
      warn: (w) => warnings.push(w),
      createReview: async () => { createCalls += 1; return { reviewId: 'x', reviewKey: 'y' } },
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: MOVED_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
      }),
    })
    assert.equal(staleDetached.exitCode, 0)
    assert.equal(staleDetached.reason, 'stale_head')
    assert.equal(createCalls, 0, 'older detached pipeline must skip before creating review')

    // Case 2: Merged-results pipeline uses CI_MERGE_REQUEST_SOURCE_BRANCH_SHA (not synthetic merge CI_COMMIT_SHA)
    const seenHeadShas = []
    const mergedResultsOk = await runGitLabReview({
      env: makeMrEnv({
        CI_COMMIT_SHA: MERGE_SHA,
        CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: HEAD_SHA,
      }),
      log: () => {},
      readLocalDiff: async () => null,
      createReview: async (opts) => {
        seenHeadShas.push(opts.headSha)
        return { reviewId: 'rv_mr', reviewKey: 'ml_rk_mr0000000000001' }
      },
      runEngine: async (opts) => {
        seenHeadShas.push(opts.headSha)
        return { exitCode: 0, stdout: '', stderr: '', errorMessage: null, rawFindings: makeDoc([]) }
      },
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() { return null },
        async findSummaryNote() { return null },
        async listMergeRequestDiffs() { return [] },
        async createMergeRequestNote() { return 1 },
      }),
    })
    assert.equal(mergedResultsOk.exitCode, 0)
    assert.deepEqual(seenHeadShas, [HEAD_SHA, HEAD_SHA], 'must use source branch SHA, never synthetic merge SHA')

    // Case 3: MR head moves BETWEEN discussion #1 and discussion #2 -> stops before discussion #2 and skips summary note
    let mrReadCount = 0
    let discussionsPosted = 0
    let summaryPosted = false
    const midWriteStale = await runGitLabReview({
      env: makeMrEnv(),
      log: () => {},
      warn: () => {},
      readLocalDiff: async () => null,
      createReview: async () => ({ reviewId: 'rv_mid', reviewKey: 'ml_rk_mid000000000001' }),
      runEngine: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        errorMessage: null,
        rawFindings: makeDoc([
          { id: 'f1', file: 'src/auth.ts', line_start: 12, title: 'Bug 1', claim: 'c1', priority: 'P0', strength: 'strong' },
          { id: 'f2', file: 'src/auth.ts', line_start: 10, title: 'Bug 2', claim: 'c2', priority: 'P1', strength: 'strong' },
        ]),
      }),
      createGitLabApi: () => ({
        async getMergeRequest() {
          mrReadCount += 1
          // Read 1 (pre-create): HEAD_SHA
          // Read 2 (post-engine pre-diff): HEAD_SHA
          // Read 3 (before discussion #1): HEAD_SHA
          // Read 4 (before discussion #2): MOVED_SHA!
          return {
            open: true,
            headSha: mrReadCount <= 3 ? HEAD_SHA : MOVED_SHA,
            baseSha: BASE_SHA,
            startSha: BASE_SHA,
            sourceProjectId: '4242',
            targetProjectId: '4242',
            isFork: false,
          }
        },
        async findSummaryNoteDetails() { return null },
        async findSummaryNote() { return null },
        async listMergeRequestDiffs() {
          return [{ old_path: 'src/auth.ts', new_path: 'src/auth.ts', deleted_file: false, diff: SAMPLE_DIFF }]
        },
        async getViewerUsername() { return 'project_4242_bot' },
        async listMergeRequestDiscussions() { return [] },
        async createMergeRequestDiscussion() { discussionsPosted += 1; return `d${discussionsPosted}` },
        async createMergeRequestNote() { summaryPosted = true; return 1 },
      }),
    })
    assert.equal(midWriteStale.exitCode, 0)
    assert.equal(midWriteStale.reason, 'stale_head')
    assert.equal(discussionsPosted, 1, 'stops immediately before discussion #2 when head moves mid-loop')
    assert.equal(summaryPosted, false, 'does not post stale summary note')
  })

  it('downgrades automatic MR pushes with tier=deep to standard and allows deep on manual jobs (CI_JOB_MANUAL=true)', async () => {
    const autoTiers = []
    const autoWarnings = []
    const autoNotes = []

    const autoRes = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_TIER: 'deep' }),
      log: () => {},
      warn: (w) => autoWarnings.push(w),
      readLocalDiff: async () => null,
      createReview: async (opts) => {
        autoTiers.push(`create:${opts.tier}`)
        return { reviewId: 'rv_auto', reviewKey: 'ml_rk_auto00000000001' }
      },
      runEngine: async (opts) => {
        autoTiers.push(`engine:${opts.tier}`)
        return { exitCode: 0, stdout: '', stderr: '', errorMessage: null, rawFindings: makeDoc([], { tier: opts.tier }) }
      },
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() { return null },
        async findSummaryNote() { return null },
        async listMergeRequestDiffs() { return [] },
        async createMergeRequestNote(_p, _i, body) { autoNotes.push(body); return 1 },
      }),
    })
    assert.equal(autoRes.exitCode, 0)
    assert.deepEqual(autoTiers, ['create:standard', 'engine:standard'])
    assert.match(autoWarnings[0], /tier "deep" is not allowed on automatic MR pushes/)
    assert.match(autoNotes[0], /tier "deep" is not allowed on automatic MR pushes/)

    const manualTiers = []
    const manualRes = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_TIER: 'deep', CI_JOB_MANUAL: 'true' }),
      log: () => {},
      readLocalDiff: async () => null,
      createReview: async (opts) => {
        manualTiers.push(`create:${opts.tier}`)
        return { reviewId: 'rv_man', reviewKey: 'ml_rk_man000000000001' }
      },
      runEngine: async (opts) => {
        manualTiers.push(`engine:${opts.tier}`)
        return { exitCode: 0, stdout: '', stderr: '', errorMessage: null, rawFindings: makeDoc([], { tier: opts.tier }) }
      },
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() { return null },
        async findSummaryNote() { return null },
        async listMergeRequestDiffs() { return [] },
        async createMergeRequestNote() { return 1 },
      }),
    })
    assert.equal(manualRes.exitCode, 0)
    assert.deepEqual(manualTiers, ['create:deep', 'engine:deep'])
  })

  it('skips unprotected MRs cleanly (exit 0) when both tokens are withheld, but FAILS eligible protected MRs missing credentials so fail_on: strong cannot pass without a review', async () => {
    const logs1 = []
    const unprotected = await runGitLabReview({
      env: makeMrEnv({
        CI_COMMIT_REF_PROTECTED: 'false',
        MEGALENS_TOKEN: '',
        MEGALENS_GITLAB_TOKEN: '',
      }),
      log: (l) => logs1.push(l),
    })
    assert.equal(unprotected.exitCode, 0)
    assert.equal(unprotected.status, 'skipped')
    assert.equal(unprotected.reason, 'unprotected_mr')
    assert.deepEqual(logs1, [GITLAB_UNPROTECTED_SKIP_NOTE])

    // Partial unprotected misconfiguration (only one token missing on CI_COMMIT_REF_PROTECTED=false) still fails
    const partialUnprotected = await runGitLabReview({
      env: makeMrEnv({
        CI_COMMIT_REF_PROTECTED: 'false',
        MEGALENS_TOKEN: 'ml_tok_leaked_unprotected_1234',
        MEGALENS_GITLAB_TOKEN: '',
      }),
      log: () => {},
    })
    assert.equal(partialUnprotected.exitCode, 1)

    // Eligible protected MR (CI_COMMIT_REF_PROTECTED=true) with BOTH credentials missing/misnamed MUST FAIL (even under fail_on: strong or none)
    let artifactWritten = false
    const protectedMissingStrong = await runGitLabReview({
      env: makeMrEnv({
        MEGALENS_MODE: 'review',
        MEGALENS_RESULT_PATH: '.megalens-ci/review-result.json',
        MEGALENS_FAIL_ON: 'strong',
        CI_COMMIT_REF_PROTECTED: 'true',
        MEGALENS_TOKEN: '',
        MEGALENS_GITLAB_TOKEN: '',
      }),
      log: () => {},
      writeResultImpl: async () => { artifactWritten = true },
    })
    assert.equal(protectedMissingStrong.exitCode, 1, 'protected MR missing both credentials must never pass fail_on: strong')
    assert.equal(artifactWritten, false, 'must never write a skip artifact when protected credentials are missing')

    const protectedMissingNone = await runGitLabReview({
      env: makeMrEnv({
        CI_COMMIT_REF_PROTECTED: 'true',
        MEGALENS_TOKEN: '',
        MEGALENS_GITLAB_TOKEN: '',
      }),
      log: () => {},
    })
    assert.equal(protectedMissingNone.exitCode, 1, 'protected MR missing both credentials must fail')

    // Publish mode rejects protected_vars_unavailable, unknown skip reasons, unprotected_mr on protected MRs, and failing burst_guard skips
    for (const badSkip of [
      {
        label: 'protected_vars_unavailable',
        payload: '{"schema":"megalens.gitlab-result/v1","kind":"skip","reason":"protected_vars_unavailable"}',
        extraEnv: { CI_COMMIT_REF_PROTECTED: 'true', MEGALENS_FAIL_ON: 'strong' },
      },
      {
        label: 'unknown skip reason',
        payload: '{"schema":"megalens.gitlab-result/v1","kind":"skip","reason":"mystery"}',
        extraEnv: { CI_COMMIT_REF_PROTECTED: 'true', MEGALENS_FAIL_ON: 'strong' },
      },
      {
        label: 'unprotected_mr skip on protected MR',
        payload: '{"schema":"megalens.gitlab-result/v1","kind":"skip","reason":"unprotected_mr"}',
        extraEnv: { CI_COMMIT_REF_PROTECTED: 'true', MEGALENS_FAIL_ON: 'strong' },
      },
      {
        label: 'burst_guard skip with strong_count > 0 under fail_on: strong',
        payload: '{"schema":"megalens.gitlab-result/v1","kind":"skip","reason":"burst_guard","strong_count":2}',
        extraEnv: { CI_COMMIT_REF_PROTECTED: 'true', MEGALENS_FAIL_ON: 'strong' },
      },
      {
        label: 'burst_guard skip without strong_count under fail_on: strong',
        payload: '{"schema":"megalens.gitlab-result/v1","kind":"skip","reason":"burst_guard"}',
        extraEnv: { CI_COMMIT_REF_PROTECTED: 'true', MEGALENS_FAIL_ON: 'strong' },
      },
    ]) {
      const pubRes = await runGitLabReview({
        env: makeMrEnv({
          MEGALENS_MODE: 'publish',
          MEGALENS_RESULT_PATH: '.megalens-ci/review-result.json',
          MEGALENS_TOKEN: '',
          ...badSkip.extraEnv,
        }),
        log: () => {},
        readResultImpl: async () => badSkip.payload,
      })
      assert.equal(pubRes.exitCode, 1, `publish must reject ${badSkip.label}`)
    }

    // Publish mode accepts unprotected_mr ONLY when CI_COMMIT_REF_PROTECTED === 'false'
    const validUnprotectedPub = await runGitLabReview({
      env: makeMrEnv({
        MEGALENS_MODE: 'publish',
        MEGALENS_RESULT_PATH: '.megalens-ci/review-result.json',
        CI_COMMIT_REF_PROTECTED: 'false',
        MEGALENS_TOKEN: '',
        MEGALENS_GITLAB_TOKEN: '',
      }),
      log: () => {},
      readResultImpl: async () => '{"schema":"megalens.gitlab-result/v1","kind":"skip","reason":"unprotected_mr"}',
    })
    assert.equal(validUnprotectedPub.exitCode, 0)
    assert.equal(validUnprotectedPub.reason, 'unprotected_mr')
  })

  it('refuses publish mode when MEGALENS_TOKEN is present (token isolation)', async () => {
    let apiCalled = false
    const res = await runGitLabReview({
      env: makeMrEnv({
        MEGALENS_MODE: 'publish',
        MEGALENS_RESULT_PATH: '.megalens-ci/review-result.json',
        MEGALENS_TOKEN: 'ml_tok_must_never_reach_publish_1234',
      }),
      log: () => {},
      createGitLabApi: () => { apiCalled = true; return {} },
      readResultImpl: async () => '{"schema":"megalens.gitlab-result/v1","kind":"skip","reason":"closed"}',
    })
    assert.equal(res.exitCode, 1)
    assert.equal(res.error, GITLAB_PUBLISH_ACCOUNT_TOKEN_ERROR)
    assert.equal(apiCalled, false, 'publish must refuse before touching GitLab API when MEGALENS_TOKEN is set')
  })

  it('redacts credentials and strips evidence_quote + dropped_findings before persisting review-result.json artifact', async () => {
    const persisted = new Map()
    let checkpoint = null
    let membershipLookups = 0
    const secretGhp = 'ghp_1234567890abcdef1234567890abcdef'
    const secretGlpat = 'glpat-quotedSecretToken987654321'
    const secretMltok = 'ml_tok_quotedAccountSecret123456'
    const secretReviewKey = 'ml_rk_quotedReviewKeySecret123456'
    const secretPem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj\n-----END PRIVATE KEY-----'

    const rawFindings = JSON.stringify({
      schema: 'megalens.findings/v1',
      review_id: 'rv_redact_001',
      tier: 'standard',
      status: 'complete',
      target: { kind: 'range', base: BASE_SHA, head: HEAD_SHA, snapshot_sha256: 'a'.repeat(64) },
      passes: [
        {
          name: 'codex-standard',
          model: 'gpt-6.2-sol',
          effort: 'medium',
          status: 'ok',
          minutes: 1,
          detail: `Bearer ${secretReviewKey}`,
        },
      ],
      notes: [`Quoted ${secretGlpat} in note`],
      error: `Leaked ${secretMltok}`,
      findings: [
        {
          id: 'f-cred',
          file: `src/${secretGhp}.ts`,
          line_start: 12,
          title: `Hardcoded token ${secretGhp}`,
          claim: `Exposes ${secretGlpat}, ${secretMltok}, and postgres://reader:sample-password@example.invalid/test`,
          failure_scenario: `Allows auth using ${secretReviewKey}`,
          evidence_quote: `const KEY = "${secretPem}"\nconst PAT = "${secretGhp}"`,
          priority: 'P0',
          strength: 'strong',
        },
      ],
      dropped_findings: [
        {
          drop_reason: 'quiet',
          finding: {
            id: 'f-drop',
            file: 'src/secret.ts',
            line_start: 5,
            title: `Dropped ${secretGhp}`,
            claim: `Contains ${secretGlpat}`,
            evidence_quote: secretPem,
            priority: 'P3',
            strength: 'normal',
          },
        },
      ],
    })

    const res = await runGitLabReview({
      env: makeMrEnv({
        MEGALENS_MODE: 'review',
        MEGALENS_RESULT_PATH: '.megalens-ci/review-result.json',
      }),
      now: 1700000000000,
      log: () => {},
      readLocalDiff: async () => new Map([[`src/${secretGhp}.ts`, new Set([12])]]),
      writeResultImpl: async (p, content) => { persisted.set(p, content) },
      createReview: async () => ({ reviewId: 'rv_redact_001', reviewKey: secretReviewKey }),
      runEngine: async () => ({ exitCode: 0, stdout: '', stderr: '', errorMessage: null, rawFindings }),
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false, authorId: 123 }
        },
        async getProjectMemberAccessLevel() { membershipLookups += 1; return 30 },
        async findSummaryNoteDetails() { return null },
        async createMergeRequestNote() { return 1 },
        async updateMergeRequestNote(_p, _i, _id, body) {
          checkpoint = body
        },
      }),
    })

    assert.equal(res.exitCode, 0)
    assert.equal(membershipLookups, 0, 'review mode must not look up project membership')
    const artifactText = persisted.get('.megalens-ci/review-result.json')
    assert.ok(artifactText)
    for (const secret of [secretGhp, secretGlpat, secretMltok, secretReviewKey, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj', 'sample-password']) {
      assert.equal(artifactText.includes(secret), false, 'artifact must never contain the credential fixture')
    }
    const parsedArtifact = parseGitLabResultArtifact(artifactText)
    assert.equal(parsedArtifact.doc.dropped_findings, undefined, 'dropped_findings must be stripped from artifact')
    assert.equal(parsedArtifact.doc.findings[0].evidence_quote, undefined, 'evidence_quote must be stripped from artifact')
    assert.equal(parsedArtifact.doc.findings[0].file, '')
    assert.deepEqual(parsedArtifact.strongFindingIndexes, new Set([0]))
    assert.equal(parsedArtifact.localDiffHunks, null)
    assert.ok(parsedArtifact.doc.findings[0].title.includes('[redacted]'))
    assert.equal(parseSummaryMeta(checkpoint)?.strongCount, 1)
    assert.equal(sanitizeFindingsDocumentForArtifact(null), null)
  })

  it('prevents MR-committed symlinks and traversal paths from redirecting artifact writes or reads outside the checkout', async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'megalens-symlink-test-'))
    const outsideDir = join(tmpBase, 'outside')
    const outsideVictim = join(outsideDir, 'victim.txt')
    const outsideResult = join(outsideDir, 'review-result.json')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(outsideVictim, 'DO_NOT_OVERWRITE_VICTIM', 'utf8')
    writeFileSync(outsideResult, 'DO_NOT_OVERWRITE_DIR_TARGET', 'utf8')

    try {
      // Case 1: .megalens-ci is a symlink to an outside directory
      const repoDirSym = join(tmpBase, 'repo-dir-symlink')
      mkdirSync(repoDirSym, { recursive: true })
      symlinkSync(outsideDir, join(repoDirSym, '.megalens-ci'))
      await assert.rejects(
        () => writeResultArtifactSafely('.megalens-ci/review-result.json', '{"pwned":true}', repoDirSym),
        /symlink/i,
      )
      await assert.rejects(
        () => readResultArtifactSafely('.megalens-ci/review-result.json', repoDirSym),
        /symlink/i,
      )
      assert.equal(readFileSync(outsideResult, 'utf8'), 'DO_NOT_OVERWRITE_DIR_TARGET', 'outside file untouched via dir symlink')

      // Case 2: .megalens-ci/review-result.json is a symlink to an outside file
      const repoFileSym = join(tmpBase, 'repo-file-symlink')
      mkdirSync(join(repoFileSym, '.megalens-ci'), { recursive: true })
      symlinkSync(outsideVictim, join(repoFileSym, '.megalens-ci', 'review-result.json'))
      await assert.rejects(
        () => writeResultArtifactSafely('.megalens-ci/review-result.json', '{"pwned":true}', repoFileSym),
        /symlink/i,
      )
      await assert.rejects(
        () => readResultArtifactSafely('.megalens-ci/review-result.json', repoFileSym),
        /symlink/i,
      )
      assert.equal(readFileSync(outsideVictim, 'utf8'), 'DO_NOT_OVERWRITE_VICTIM', 'outside victim file untouched via file symlink')

      // Case 3: Path traversal outside workspace root
      const repoClean = join(tmpBase, 'repo-clean')
      mkdirSync(repoClean, { recursive: true })
      await assert.rejects(
        () => writeResultArtifactSafely('../outside/victim.txt', '{"pwned":true}', repoClean),
        /outside workspace root/i,
      )
      assert.equal(readFileSync(outsideVictim, 'utf8'), 'DO_NOT_OVERWRITE_VICTIM')

      // Case 4: Valid write, rerun overwrite of regular file, and safe read succeed
      await writeResultArtifactSafely('.megalens-ci/review-result.json', '{"ok":1}', repoClean)
      await writeResultArtifactSafely('.megalens-ci/review-result.json', '{"ok":2}', repoClean)
      assert.equal(await readResultArtifactSafely('.megalens-ci/review-result.json', repoClean), '{"ok":2}')

      // Case 5: Template skip-path safe-write snippet also refuses symlinks and leaves victim untouched
      const tpl = readFileSync(join(ROOT, 'templates', 'megalens-review.yml'), 'utf8')
      const skipNodeMatch = /if \[ "\$\{CI_COMMIT_REF_PROTECTED:-\}" = "false" \][\s\S]*?node -e '([\s\S]*?)'/.exec(tpl)
      assert.ok(skipNodeMatch, 'template skip path must use symlink-safe node helper')
      assert.throws(() => {
        execFileSync(process.execPath, ['-e', skipNodeMatch[1]], { cwd: repoDirSym, stdio: 'pipe' })
      })
      assert.throws(() => {
        execFileSync(process.execPath, ['-e', skipNodeMatch[1]], { cwd: repoFileSym, stdio: 'pipe' })
      })
      assert.equal(readFileSync(outsideResult, 'utf8'), 'DO_NOT_OVERWRITE_DIR_TARGET')
      assert.equal(readFileSync(outsideVictim, 'utf8'), 'DO_NOT_OVERWRITE_VICTIM')
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it('uses one gate calculation for the review checkpoint, queued duplicates, and publish', async () => {
    const persisted = new Map()
    let clock = 1_700_000_000_000
    let createCalls = 0
    let summaryNoteId = null
    let summaryNoteBody = null
    let createdNotesCount = 0
    let updatedNotesCount = 0
    const postedDiscussions = []

    const makeSharedGitLabApi = () => ({
      async getMergeRequest() {
        return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
      },
      async findSummaryNoteDetails() {
        return summaryNoteId ? { id: summaryNoteId, body: summaryNoteBody } : null
      },
      async findSummaryNote() {
        return summaryNoteId
      },
      async listMergeRequestDiffs() {
        return [{ old_path: 'src/auth.ts', new_path: 'src/auth.ts', deleted_file: false, diff: SAMPLE_DIFF }]
      },
      async getViewerUsername() { return 'project_4242_bot' },
      async listMergeRequestDiscussions() { return [] },
      async createMergeRequestDiscussion(_p, _i, body, pos) { postedDiscussions.push({ body, pos }); return 'd1' },
      async createMergeRequestNote(_p, _i, body) {
        createdNotesCount += 1
        summaryNoteId = 901
        summaryNoteBody = body
        return summaryNoteId
      },
      async updateMergeRequestNote(_p, _i, id, body) {
        assert.equal(id, summaryNoteId)
        updatedNotesCount += 1
        summaryNoteBody = body
      },
    })

    // 1. Pipeline 1 review runs (takes 10 minutes), persists artifact, and writes checkpoint BEFORE releasing resource_group
    const p1Review = await runGitLabReview({
      env: makeMrEnv({
        MEGALENS_MODE: 'review',
        MEGALENS_RESULT_PATH: '.megalens-ci/review-result.json',
        MEGALENS_FAIL_ON: 'strong',
      }),
      now: () => clock,
      log: () => {},
      readLocalDiff: async () => new Map([['src/auth.ts', new Set([10, 12])]]),
      writeResultImpl: async (p, content) => { persisted.set(p, content) },
      createReview: async () => {
        createCalls += 1
        return { reviewId: 'rv_p1', reviewKey: 'ml_rk_p1secret00000001' }
      },
      runEngine: async () => {
        clock += 10 * 60 * 1000
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          errorMessage: null,
          rawFindings: makeDoc([
            { id: 'f1', file: 'src/auth.ts', line_start: 12, title: 'Auth bug', claim: 'Uses ===', priority: 'P0', strength: 'strong' },
            { id: 'f2', file: 'src/auth.ts', line_start: 14, title: 'GitLab position only', priority: 'P1', strength: 'strong' },
          ]),
        }
      },
      createGitLabApi: makeSharedGitLabApi,
    })
    assert.equal(p1Review.exitCode, 0)
    assert.equal(createCalls, 1)
    assert.equal(createdNotesCount, 1, 'review reserves the summary note before calling the gateway')
    assert.equal(parseSummaryMeta(summaryNoteBody)?.strongCount, 1)

    // 2. Interleaved Pipeline 2 review starts BEFORE Pipeline 1 publish runs -> MUST hit burst guard at 0 credits & enforce fail_on: strong
    clock += 5_000
    const p2Review = await runGitLabReview({
      env: makeMrEnv({
        MEGALENS_MODE: 'review',
        MEGALENS_RESULT_PATH: '.megalens-ci/p2-result.json',
        MEGALENS_FAIL_ON: 'strong',
      }),
      now: () => clock,
      log: () => {},
      writeResultImpl: async (p, content) => { persisted.set(p, content) },
      createReview: async () => { createCalls += 1; throw new Error('P2 must not create a duplicate billable review') },
      createGitLabApi: makeSharedGitLabApi,
    })
    assert.equal(p2Review.exitCode, 1, 'P2 reapplies fail_on: strong from checkpoint strong=1')
    assert.equal(p2Review.reason, 'burst_guard')
    assert.equal(createCalls, 1, 'zero duplicate charges for interleaved P2')

    // 3. Pipeline 1 publish now runs -> posts inline discussion and updates the SAME summary note in place
    clock += 5_000
    const p1Publish = await runGitLabReview({
      env: makeMrEnv({
        MEGALENS_MODE: 'publish',
        MEGALENS_RESULT_PATH: '.megalens-ci/review-result.json',
        MEGALENS_FAIL_ON: 'strong',
        MEGALENS_TOKEN: '',
      }),
      now: () => clock,
      log: () => {},
      readResultImpl: async (p) => persisted.get(p),
      createGitLabApi: makeSharedGitLabApi,
    })
    assert.equal(p1Publish.exitCode, 1)
    assert.equal(postedDiscussions.length, 1)
    assert.equal(createdNotesCount, 1, 'still only ONE summary note created')
    assert.equal(updatedNotesCount, 2, 'the checkpoint and final publication update the reservation in place')
    assert.equal(parseSummaryMeta(summaryNoteBody)?.strongCount, 1)
    assert.match(summaryNoteBody, /1 inline on the diff/)
  })

  it('reserves before billing and blocks an interleaved pipeline when the checkpoint write fails', async () => {
    const warnings = []
    let body = null
    let result = null
    let createCalls = 0
    let failReservation = true
    let failUpdates = true
    const review = {
      env: makeMrEnv({
        MEGALENS_MODE: 'review',
        MEGALENS_RESULT_PATH: '.megalens-ci/review-result.json',
        MEGALENS_FAIL_ON: 'strong',
      }),
      now: 1_700_000_000_000,
      log: () => {},
      warn: (w) => warnings.push(w),
      readLocalDiff: async () => new Map(),
      writeResultImpl: async (_p, content) => { result = content },
      createReview: async () => {
        assert.equal(parseSummaryMeta(body)?.status, 'pending')
        createCalls += 1
        return { reviewId: 'rv_502', reviewKey: 'fixture-review-key' }
      },
      runEngine: async () => ({ exitCode: 0, stdout: '', stderr: '', errorMessage: null, rawFindings: makeDoc([]) }),
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() { return body === null ? null : { id: 1, body } },
        async findSummaryNote() { return body === null ? null : 1 },
        async createMergeRequestNote(_p, _i, nextBody) {
          if (failReservation) throw new Error('GitLab 502 during reservation')
          body = nextBody
          return 1
        },
        async updateMergeRequestNote(_p, _i, _id, nextBody) {
          if (failUpdates) throw new Error('GitLab 502 during update')
          body = nextBody
        },
        async listMergeRequestDiffs() { return [] },
      }),
    }
    assert.equal((await runGitLabReview(review)).exitCode, 1)
    assert.equal(createCalls, 0)
    failReservation = false
    assert.equal((await runGitLabReview(review)).exitCode, 0, 'publish remains available after a failed checkpoint')
    assert.ok(result)
    assert.ok(warnings.some((w) => /deferred to publish/i.test(w)))
    const duplicate = await runGitLabReview({ ...review, now: review.now + 35 * 60_000 })
    assert.equal(duplicate.reason, 'pending_review')
    assert.equal(duplicate.exitCode, 1)
    assert.equal(createCalls, 1)
    const publish = {
      ...review,
      env: { ...review.env, MEGALENS_MODE: 'publish', MEGALENS_TOKEN: '' },
      readResultImpl: async () => result,
    }
    await assert.rejects(runGitLabReview(publish), /502 during update/)
    failUpdates = false
    assert.equal((await runGitLabReview(publish)).exitCode, 0)
    assert.equal(parseSummaryMeta(body)?.status, 'complete')
    assert.equal((await runGitLabReview(review)).reason, 'burst_guard')
    assert.equal(createCalls, 1)
  })

  it('deduplicates own inline discussions on rerun and ignores spoofed markers', () => {
    const strong = [
      { file: 'src/auth.ts', line_start: 12, line_end: 14, title: 'Existing strong' },
      { file: 'src/auth.ts', line_start: 10, line_end: 10, title: 'Spoofed marker strong' },
    ]
    const existingDiscussions = [
      {
        notes: [
          {
            system: false,
            author: { username: 'project_4242_bot' },
            body: `**P0**\n${inlineMarker(strong[0])}`,
          },
        ],
      },
      {
        notes: [
          {
            system: false,
            author: { username: 'random_contributor' },
            body: `spoofed\n${inlineMarker(strong[1])}`,
          },
        ],
      },
    ]
    const { toPost, alreadyPostedCount } = selectNewGitLabInlineFindings(strong, existingDiscussions, {
      ownUsername: 'project_4242_bot',
    })
    assert.equal(alreadyPostedCount, 1)
    assert.equal(toPost.length, 1)
    assert.equal(toPost[0].title, 'Spoofed marker strong')
  })

  it('handles verified too_large refusal as a green skip even with MEGALENS_FAIL_ON=strong', async () => {
    const notes = []
    const fixture = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'too-large-refusal.json'), 'utf8'))
    fixture.target.base = BASE_SHA
    fixture.target.head = HEAD_SHA

    const res = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_FAIL_ON: 'strong' }),
      log: () => {},
      createReview: async () => ({ reviewId: 'rv_big', reviewKey: 'ml_rk_big0000000000001' }),
      runEngine: async () => ({
        exitCode: 3,
        stdout: '',
        stderr: '',
        errorMessage: null,
        rawFindings: JSON.stringify(fixture),
      }),
      createGitLabApi: () => ({
        async getMergeRequest() {
          return { open: true, headSha: HEAD_SHA, baseSha: BASE_SHA, startSha: BASE_SHA, sourceProjectId: '4242', targetProjectId: '4242', isFork: false }
        },
        async findSummaryNoteDetails() { return null },
        async findSummaryNote() { return null },
        async createMergeRequestNote(_p, _i, body) { notes.push(body); return 99 },
      }),
    })

    assert.equal(res.exitCode, 0)
    assert.equal(res.status, 'skipped')
    assert.equal(res.reason, 'too_large')
    assert.equal(notes.length, 1)
    assert.match(notes[0], /merge request: it is too large for one review \(412 files, about 61,300 lines\)/)
    assert.match(notes[0], /No credits were used\./)
  })

  it('refuses BYO OpenAI key, double tier, and partial missing tokens before touching APIs', async () => {
    const byo = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_OPENAI_API_KEY: 'sk-test1234567890abcdef' }),
      log: () => {},
    })
    assert.equal(byo.exitCode, 1)
    assert.equal(byo.error, BYO_DISABLED_MESSAGE)

    const dbl = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_TIER: 'double' }),
      log: () => {},
    })
    assert.equal(dbl.exitCode, 1)
    assert.equal(dbl.error, DOUBLE_DISABLED_MESSAGE)

    const noMl = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_TOKEN: '' }),
      log: () => {},
    })
    assert.equal(noMl.exitCode, 1)
    assert.match(noMl.error, /Missing MEGALENS_TOKEN/)

    const noGl = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_GITLAB_TOKEN: '' }),
      log: () => {},
    })
    assert.equal(noGl.exitCode, 1)
    assert.match(noGl.error, /Missing MEGALENS_GITLAB_TOKEN/)
  })

  it('falls back from /diffs (404) to /changes on older GitLab instances and redacts tokens in API errors', async () => {
    const api = createGitLabApi('glpat-superSecretErrorToken1234', {
      baseUrl: 'https://gitlab.example.com/api/v4',
      fetchImpl: async (url) => {
        if (url.includes('/diffs?')) return new Response('{}', { status: 404 })
        if (url.endsWith('/changes')) {
          return new Response(JSON.stringify({ changes: [{ old_path: 'a.js', new_path: 'a.js', diff: '@@ -1 +1 @@\n+x\n' }] }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ message: 'Auth failed for glpat-superSecretErrorToken1234' }),
          { status: 401 },
        )
      },
    })

    const diffs = await api.listMergeRequestDiffs('4242', '17')
    assert.equal(diffs.length, 1)
    assert.equal(diffs[0].new_path, 'a.js')

    await assert.rejects(
      () => api.createMergeRequestNote('4242', '17', 'hi'),
      (err) => {
        assert.equal(err.status, 401)
        assert.equal(err.message.includes('glpat-superSecretErrorToken1234'), false)
        return true
      },
    )
  })
})

describe('GitLab CI template, Dockerfile, docs, bundle integrity, and dry-run script', () => {
  it('replaces inherited before and after scripts and global YAML variables on all credential-bearing and helper jobs', () => {
    const tpl = readFileSync(join(ROOT, 'templates', 'megalens-review.yml'), 'utf8')
    for (const base of ['review', 'publish']) {
      const block = tpl.split(`.megalens-${base}-base:\n`)[1].split(/^\S/m)[0]
      assert.match(block, /^  before_script: \[\]$/m)
      assert.match(block, /^  after_script: \[\]$/m)
      assert.match(block, /^  inherit:\n    variables: false$/m)
    }
    for (const [jobSuffix, base] of [['', 'review'], ['-deep-run', 'review'], ['-publish', 'publish'], ['-deep-publish', 'publish']]) {
      const block = tpl.split(`$[[ inputs.job_name ]]${jobSuffix}:\n`)[1].split(/^\S/m)[0]
      assert.match(block, new RegExp(`^  extends: \\.megalens-${base}-base$`, 'm'))
      assert.doesNotMatch(block, /^  (before|after)_script:/m)
      assert.doesNotMatch(block, /\bwhen:\s*manual\b/, `credential-bearing job ${jobSuffix || 'review'} must never be when: manual`)
    }
    for (const jobSuffix of ['-gate', '-deep', '-fork-skip']) {
      const block = tpl.split(`$[[ inputs.job_name ]]${jobSuffix}:\n`)[1].split(/^\S/m)[0]
      assert.match(block, /^  before_script: \[\]$/m)
      assert.match(block, /^  after_script: \[\]$/m)
      assert.match(block, /^  inherit:\n    variables: false$/m)
      assert.doesNotMatch(block, /^\s+environment:/m, `unscoped job ${jobSuffix} must carry no environment scope`)
    }
  })

  it('templates/megalens-review.yml enforces all security, pinning, concurrency, deep-guard, and split-publish invariants', () => {
    const tpl = readFileSync(join(ROOT, 'templates', 'megalens-review.yml'), 'utf8')
    const bundle = readFileSync(join(ROOT, 'dist', 'gitlab.mjs'), 'utf8')
    const actualSha256 = createHash('sha256').update(bundle, 'utf8').digest('hex')
    const dockerfile = readFileSync(join(ROOT, 'docker', 'gitlab-runner.Dockerfile'), 'utf8')

    // Finding 1: never pretend YAML clears GitLab project variables
    assert.equal(tpl.includes("MEGALENS_TOKEN: ''"), false, 'must not claim YAML clears project secrets')
    assert.equal(tpl.includes("MEGALENS_GITLAB_TOKEN: ''"), false, 'must not claim YAML clears project secrets')

    // NEW #1: dotenv immunity — dependencies: [] on review & fork-skip, unset NODE_OPTIONS,
    // compile-time pinned runner_url & runner_sha256 passed via argv (never env vars or MEGALENS_GITLAB_RUNNER_PATH)
    const reviewBase = tpl.slice(tpl.indexOf('.megalens-review-base:'), tpl.indexOf('.megalens-publish-base:'))
    const publishBase = tpl.slice(tpl.indexOf('.megalens-publish-base:'), tpl.indexOf('$[[ inputs.job_name ]]:'))
    const forkSkipBlock = tpl.slice(tpl.indexOf('$[[ inputs.job_name ]]-fork-skip:'))
    assert.match(reviewBase, /^\s+dependencies:\s*\[\]/m, 'review job must set dependencies: [] to block earlier-stage dotenv')
    assert.match(forkSkipBlock, /^\s+dependencies:\s*\[\]/m, 'fork-skip job must set dependencies: []')
    assert.match(reviewBase, /unset NODE_OPTIONS NODE_DEBUG NODE_DEBUG_NATIVE/, 'review job unsets NODE_OPTIONS, NODE_DEBUG, and NODE_DEBUG_NATIVE')
    assert.match(publishBase, /unset NODE_OPTIONS NODE_DEBUG NODE_DEBUG_NATIVE/, 'publish job unsets NODE_OPTIONS, NODE_DEBUG, and NODE_DEBUG_NATIVE')
    assert.match(reviewBase, /export PATH="\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"/, 'review job resets PATH to trusted image directories')
    assert.match(publishBase, /export PATH="\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"/, 'publish job resets PATH to trusted image directories')
    assert.equal(tpl.includes('MEGALENS_GITLAB_RUNNER_PATH'), false, 'template must never read MEGALENS_GITLAB_RUNNER_PATH from env')
    assert.equal(tpl.includes('process.env.MEGALENS_RUNNER_SHA256'), false, 'template must never read runner sha256 from env')
    assert.equal(tpl.includes('process.env.MEGALENS_RUNNER_URL'), false, 'template must never read runner url from env')
    assert.ok(reviewBase.includes("'$[[ inputs.runner_sha256 ]]' '$[[ inputs.runner_url ]]'"), 'review passes compile-time runner pin via argv')
    assert.ok(publishBase.includes("'$[[ inputs.runner_sha256 ]]' '$[[ inputs.runner_url ]]'"), 'publish passes compile-time runner pin via argv')

    // Execute extracted runner-verification JS with poisoned env vars: must ignore env overrides completely
    const verifyMatch = /node -e '([\s\S]*?)' "\$\{MEGALENS_RUNNER_FILE\}" '\$\[\[ inputs\.runner_sha256 \]\]'/.exec(reviewBase)
    assert.ok(verifyMatch, 'extracted runner verification snippet')
    const poisonedDir = mkdtempSync(join(tmpdir(), 'megalens-dotenv-test-'))
    try {
      const evilRunner = join(poisonedDir, 'evil.mjs')
      writeFileSync(evilRunner, 'console.log("PWNED")', 'utf8')
      const evilSha = createHash('sha256').update('console.log("PWNED")', 'utf8').digest('hex')
      const outRunner = join(poisonedDir, 'out.mjs')
      // Passing invalid/unreachable URL in argv while poisoning env with evilRunner + evilSha MUST fail (proves env is ignored)
      assert.throws(() => {
        execFileSync(
          process.execPath,
          ['-e', verifyMatch[1], outRunner, actualSha256, 'http://not-https.example/evil.mjs'],
          {
            env: {
              PATH: process.env.PATH,
              MEGALENS_GITLAB_RUNNER_PATH: evilRunner,
              MEGALENS_RUNNER_SHA256: evilSha,
              MEGALENS_RUNNER_URL: 'https://evil.example/evil.mjs',
            },
            stdio: 'pipe',
          },
        )
      }, /runner_url must use HTTPS/)
    } finally {
      rmSync(poisonedDir, { recursive: true, force: true })
    }

    // NEW #2: environment scoping isolates MEGALENS_TOKEN to review jobs only; publish refuses MEGALENS_TOKEN
    assert.match(reviewBase, /environment:\s*\n\s+name:\s*\$\[\[ inputs\.review_environment \]\]\s*\n\s+action:\s*access/)
    assert.match(publishBase, /environment:\s*\n\s+name:\s*\$\[\[ inputs\.publish_environment \]\]\s*\n\s+action:\s*access/)
    assert.equal(publishBase.includes('review_environment'), true, 'publish error references review_environment')
    assert.equal(/name:\s*\$\[\[ inputs\.review_environment \]\]/.test(publishBase), false, 'publish must never use review_environment')
    assert.ok(publishBase.includes('if [ -n "${MEGALENS_TOKEN:-}" ]'), 'publish shell refuses MEGALENS_TOKEN')

    // NEW #3: non-downloadable handoff artifact
    assert.match(reviewBase, /artifacts:\s*\n[\s\S]*?access:\s*none/)

    // NEW #5: no protected_vars_unavailable skip path in template
    assert.equal(tpl.includes('protected_vars_unavailable'), false, 'template must never skip when CI_COMMIT_REF_PROTECTED=true')

    // Finding 5: require source, pipeline, and CI_MERGE_REQUEST_PROJECT_ID to be present and equal
    assert.ok(tpl.includes('$CI_MERGE_REQUEST_PROJECT_ID == $CI_PROJECT_ID'), 'checks CI_MERGE_REQUEST_PROJECT_ID in rules')
    assert.ok(tpl.includes('CI_MERGE_REQUEST_PROJECT_ID'), 'checks CI_MERGE_REQUEST_PROJECT_ID in script')

    // Finding 7: split review and publish jobs with persisted artifact
    assert.ok(tpl.includes('MEGALENS_MODE: review'))
    assert.ok(tpl.includes('MEGALENS_MODE: publish'))
    assert.ok(tpl.includes('$[[ inputs.job_name ]]-publish:'))
    assert.ok(tpl.includes('.megalens-ci/review-result.json'))

    // Finding 8: MR-and-tier resource_group
    assert.ok(tpl.includes('resource_group: megalens-$CI_MERGE_REQUEST_IID-$[[ inputs.tier ]]'))
    assert.ok(tpl.includes('resource_group: megalens-$CI_MERGE_REQUEST_IID-deep'))

    // Finding 11: manual deep job + publish
    assert.ok(tpl.includes('$[[ inputs.job_name ]]-deep:'))
    assert.ok(tpl.includes('when: manual'))
    assert.ok(tpl.includes('$[[ inputs.job_name ]]-deep-publish:'))

    // Finding 13: no release placeholder, runner_url is a required input (no default)
    assert.equal(tpl.includes('PIN_RELEASE_COMMIT_SHA'), false, 'no placeholder URL')
    const runnerUrlBlock = tpl.slice(tpl.indexOf('    runner_url:'), tpl.indexOf('    runner_sha256:'))
    assert.equal(/^\s+default:/m.test(runnerUrlBlock), false, 'runner_url must be a required input with no default')

    // Finding 14: no runtime apt-get install; image requires @sha256 digest; Dockerfile bakes deps & drops to node
    assert.equal(/apt-get/i.test(tpl), false, 'must never run apt-get at job runtime')
    assert.match(tpl, /node:24-bookworm-slim@sha256:[0-9a-f]{64}/, 'publish_image pinned by sha256 digest')
    const imageBlock = tpl.slice(tpl.indexOf('    image:'), tpl.indexOf('    publish_image:'))
    assert.equal(/^\s+default:/m.test(imageBlock), false, 'review image must be explicitly supplied with pre-baked sandbox')
    assert.ok(imageBlock.includes('@sha256:[0-9a-f]{64}'), 'review image enforces @sha256 digest pin')
    assert.match(dockerfile, /^FROM node:24-bookworm-slim@sha256:[0-9a-f]{64}$/m)
    assert.ok(dockerfile.includes('bubblewrap'))
    assert.ok(dockerfile.includes('ca-certificates'))
    assert.ok(dockerfile.includes('git'))
    assert.match(dockerfile, /^USER node$/m)

    // Integrity & safety
    assert.ok(tpl.includes(actualSha256), 'runner_sha256 in template matches dist/gitlab.mjs')
    const engineVersionBlock = tpl.slice(tpl.indexOf('    engine_version:'), tpl.indexOf('    review_environment:'))
    assert.ok(engineVersionBlock.includes(`default: '${PINNED_ENGINE_VERSION}'`))
    assert.ok(engineVersionBlock.includes(`options: ['${PINNED_ENGINE_VERSION}']`))
    assert.ok(tpl.includes('set +x'), 'set +x explicitly turns off command echoing')
    assert.equal(/\bset\s+-[a-zA-Z]*x/.test(tpl), false, 'never enables set -x')
    assert.ok(tpl.includes('GIT_STRATEGY: none'), 'fork-skip and publish jobs do not check out code')
  })

  it('resets PATH to trusted image directories before the first external command so MR executables cannot receive protected tokens', () => {
    const tpl = readFileSync(join(ROOT, 'templates', 'megalens-review.yml'), 'utf8')
    const trustedPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

    const reviewScriptMatch = /- &megalens_review_script \|\n([\s\S]*?)\n\.megalens-publish-base:/.exec(tpl)
    const publishScriptMatch = /- &megalens_publish_script \|\n([\s\S]*?)\n\$\[\[ inputs\.job_name \]\]:/.exec(tpl)
    assert.ok(reviewScriptMatch, 'extracted review script block')
    assert.ok(publishScriptMatch, 'extracted publish script block')

    const dedent = (s) => s.replace(/^      /gm, '')
    const reviewScript = dedent(reviewScriptMatch[1])
    const publishScript = dedent(publishScriptMatch[1])

    // Verify every rendered job script passes POSIX shell syntax validation (`sh -n`)
    const renderInputs = (s) => s
      .replaceAll('$[[ inputs.fail_on ]]', 'strong')
      .replaceAll('$[[ inputs.inline ]]', 'true')
      .replaceAll('$[[ inputs.timeout_minutes ]]', '25')
      .replaceAll('$[[ inputs.api_url ]]', 'https://megalens.ai')
      .replaceAll('$[[ inputs.gitlab_api_url ]]', 'https://gitlab.com/api/v4')
      .replaceAll('$[[ inputs.engine_version ]]', PINNED_ENGINE_VERSION)
      .replaceAll('$[[ inputs.review_environment ]]', 'megalens-review')
      .replaceAll('$[[ inputs.runner_sha256 ]]', 'a'.repeat(64))
      .replaceAll('$[[ inputs.runner_url ]]', 'https://example.test/gitlab.mjs')
      .replaceAll('$[[ inputs.tier ]]', 'standard')
    for (const script of [
      `export MEGALENS_TIER='standard' MEGALENS_JOB_MANUAL=false\n${renderInputs(reviewScript)}`,
      `export MEGALENS_TIER=deep MEGALENS_JOB_MANUAL=true\n${renderInputs(reviewScript)}`,
      `export MEGALENS_TIER='standard'\n${renderInputs(publishScript)}`,
      `export MEGALENS_TIER=deep\n${renderInputs(publishScript)}`,
    ]) {
      const check = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' })
      assert.equal(check.status, 0, `sh -n failed: ${check.stderr}`)
    }

    // Structural guarantee: only shell builtins run before `export PATH=...` in both review and publish scripts.
    for (const [label, script] of [['review', reviewScript], ['publish', publishScript]]) {
      const lines = script.split('\n')
      const pathIdx = lines.findIndex((l) => l.trim() === `export PATH="${trustedPath}"`)
      assert.ok(pathIdx >= 0, `${label} script must export trusted PATH`)
      const beforePath = lines.slice(0, pathIdx).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      for (const line of beforePath) {
        assert.match(line, /^(?:set\b|\(set\b|export\b|unset\b|if \[)/, `${label}: only shell builtins allowed before PATH reset, saw: ${line}`)
      }
      const firstExternalIdx = lines.findIndex((l) => /^\s*(?:node|git|bwrap|mktemp|id|mkdir|chown|setpriv|su)\b/.test(l))
      assert.ok(firstExternalIdx > pathIdx, `${label}: PATH must be reset before first external command`)
    }

    // Live execution test: prepend an MR-controlled checkout directory containing malicious `node`, `mktemp`, `git`, `bwrap`.
    // Executing the extracted bootstrap preambles must NEVER invoke the MR-controlled executables with protected tokens.
    const tmpBase = mkdtempSync(join(tmpdir(), 'megalens-path-hijack-'))
    const evilBin = join(tmpBase, 'mr-checkout-bin')
    const leakedFile = join(tmpBase, 'leaked.txt')
    mkdirSync(evilBin, { recursive: true })
    try {
      for (const cmd of ['node', 'mktemp', 'git', 'bwrap']) {
        const shim = join(evilBin, cmd)
        writeFileSync(
          shim,
          `#!/bin/sh\nprintf '%s:%s:%s\\n' "${cmd}" "\${MEGALENS_TOKEN:-}" "\${MEGALENS_GITLAB_TOKEN:-}" >> "${leakedFile}"\nexit 0\n`,
          'utf8',
        )
        chmodSync(shim, 0o755)
      }

      const reviewPreamble = renderInputs(reviewScript.split('# Belt-and-suspenders fork guard:')[0])
      const publishPreamble = renderInputs(publishScript.split('if [ -z "${CI_PROJECT_ID:-}" ]')[0])

      for (const [label, preamble] of [['review', reviewPreamble], ['publish', publishPreamble]]) {
        const res = spawnSync(
          'sh',
          ['-c', `${preamble}\ncommand -v node\nnode -e 'process.stdout.write(process.env.PATH || "")'`],
          {
            cwd: tmpBase,
            env: {
              PATH: `${evilBin}:${process.env.PATH}`,
              CI_JOB_MANUAL: 'true',
              MEGALENS_TOKEN: 'ml_tok_protected_review_secret_1234',
              MEGALENS_GITLAB_TOKEN: 'glpat-protected_gitlab_secret_123456',
            },
            encoding: 'utf8',
          },
        )
        assert.equal(res.status, 0, `${label} preamble failed: ${res.stderr}`)
        assert.equal(existsSync(leakedFile), false, `${label}: MR-supplied executable must NEVER run`)
        const [resolvedNode, seenPath] = res.stdout.trim().split('\n')
        assert.equal(resolvedNode.startsWith(evilBin), false, `${label}: node must not resolve from MR checkout`)
        assert.equal(seenPath, trustedPath, `${label}: Node must inherit only the trusted image PATH`)
      }
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it('unsets NODE_DEBUG before starting Node and refuses child_process diagnostics so live review keys are never logged to stderr', async () => {
    const tpl = readFileSync(join(ROOT, 'templates', 'megalens-review.yml'), 'utf8')
    const reviewScriptMatch = /- &megalens_review_script \|\n([\s\S]*?)\n\.megalens-publish-base:/.exec(tpl)
    const publishScriptMatch = /- &megalens_publish_script \|\n([\s\S]*?)\n\$\[\[ inputs\.job_name \]\]:/.exec(tpl)
    assert.ok(reviewScriptMatch && publishScriptMatch)

    const dedent = (s) => s.replace(/^      /gm, '')
    const renderInputs = (s) => s
      .replaceAll('$[[ inputs.fail_on ]]', 'none')
      .replaceAll('$[[ inputs.inline ]]', 'true')
      .replaceAll('$[[ inputs.timeout_minutes ]]', '25')
      .replaceAll('$[[ inputs.api_url ]]', 'https://megalens.ai')
      .replaceAll('$[[ inputs.gitlab_api_url ]]', 'https://gitlab.com/api/v4')
      .replaceAll('$[[ inputs.engine_version ]]', PINNED_ENGINE_VERSION)
      .replaceAll('$[[ inputs.review_environment ]]', 'megalens-review')
      .replaceAll('$[[ inputs.runner_sha256 ]]', 'a'.repeat(64))
      .replaceAll('$[[ inputs.runner_url ]]', 'https://example.test/gitlab.mjs')

    const reviewPreamble = renderInputs(dedent(reviewScriptMatch[1]).split('# Belt-and-suspenders fork guard:')[0])
    const publishPreamble = renderInputs(dedent(publishScriptMatch[1]).split('if [ -z "${CI_PROJECT_ID:-}" ]')[0])

    const secretReviewId = 'rv_diag_live_0001'
    const secretReviewKey = 'ml_rk_liveDiagnosticKeySecret987654321'
    const tmpBase = mkdtempSync(join(tmpdir(), 'megalens-node-debug-test-'))
    const fakeBin = join(tmpBase, 'fake-engine.mjs')
    const outPath = join(tmpBase, 'findings.json')
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'\nconst i = process.argv.indexOf('--out')\nwriteFileSync(process.argv[i + 1], '${makeDoc([])}', 'utf8')\n`,
      'utf8',
    )
    chmodSync(fakeBin, 0o755)

    try {
      // 1. Running through the template review & publish preambles under hostile NODE_DEBUG / NODE_DEBUG_NATIVE / NODE_OPTIONS
      //    must unset them BEFORE starting Node so real execFile spawns leak ZERO review credentials to stderr.
      const engineModuleUrl = new URL('../src/engine.js', import.meta.url).href
      const runViaReviewBootstrap = spawnSync(
        'sh',
        [
          '-c',
          `${reviewPreamble}
node --input-type=module -e '
  import { debuglog } from "node:util";
  import { runEngineCli } from ${JSON.stringify(engineModuleUrl)};
  if (debuglog("child_process").enabled) throw new Error("child_process debuglog still enabled");
  const res = await runEngineCli({
    tier: "standard",
    baseSha: ${JSON.stringify(BASE_SHA)},
    headSha: ${JSON.stringify(HEAD_SHA)},
    outPath: ${JSON.stringify(outPath)},
    timeoutMinutes: 5,
    apiUrl: "https://megalens.ai",
    authMode: "review-key",
    authEnv: { MEGALENS_REVIEW_ID: ${JSON.stringify(secretReviewId)}, MEGALENS_REVIEW_KEY: ${JSON.stringify(secretReviewKey)} },
    cliBin: ${JSON.stringify(fakeBin)},
    repoPath: ${JSON.stringify(tmpBase)},
  });
  process.stdout.write(String(res.exitCode));
'`,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: tmpBase,
            TMPDIR: tmpBase,
            NODE_DEBUG: 'child_process,http,*',
            NODE_DEBUG_NATIVE: 'http,environment',
            NODE_OPTIONS: '--inspect=0',
          },
          encoding: 'utf8',
        },
      )
      assert.equal(runViaReviewBootstrap.status, 0, `review bootstrap failed: ${runViaReviewBootstrap.stderr}`)
      assert.equal(runViaReviewBootstrap.stdout.trim(), '0')
      assert.equal(runViaReviewBootstrap.stderr.includes(secretReviewKey), false, 'stderr must never contain MEGALENS_REVIEW_KEY')
      assert.equal(runViaReviewBootstrap.stderr.includes(secretReviewId), false, 'stderr must never contain MEGALENS_REVIEW_ID')
      assert.equal(runViaReviewBootstrap.stderr.includes('CHILD_PROCESS'), false, 'stderr must not contain Node child_process debug logs')

      const runViaPublishBootstrap = spawnSync(
        'sh',
        [
          '-c',
          `${publishPreamble}\nnode -e 'const u = require("node:util"); process.stdout.write(JSON.stringify({ cp: u.debuglog("child_process").enabled, env: process.env.NODE_DEBUG || "", native: process.env.NODE_DEBUG_NATIVE || "", opts: process.env.NODE_OPTIONS || "" }))'`,
        ],
        {
          env: {
            PATH: process.env.PATH,
            NODE_DEBUG: 'child_process,http,*',
            NODE_DEBUG_NATIVE: 'http',
            NODE_OPTIONS: '--inspect=0',
          },
          encoding: 'utf8',
        },
      )
      assert.equal(runViaPublishBootstrap.status, 0, `publish bootstrap failed: ${runViaPublishBootstrap.stderr}`)
      assert.deepEqual(JSON.parse(runViaPublishBootstrap.stdout), { cp: false, env: '', native: '', opts: '' })

      // 2. Unit helper coverage for NODE_DEBUG pattern matching
      assert.equal(isChildProcessDebugEnabled({ NODE_DEBUG: 'child_process' }), true)
      assert.equal(isChildProcessDebugEnabled({ NODE_DEBUG: 'http,CHILD_PROCESS' }), true)
      assert.equal(isChildProcessDebugEnabled({ NODE_DEBUG: '*' }), true)
      assert.equal(isChildProcessDebugEnabled({ NODE_DEBUG: 'child*' }), true)
      assert.equal(isChildProcessDebugEnabled({ NODE_DEBUG: 'http,tls' }), false)
      assert.equal(isChildProcessDebugEnabled({}), false)

      // 3. Defense in depth: even if runGitLabReview or runEngineCli or dist/gitlab.mjs is invoked directly
      //    with NODE_DEBUG=child_process (bypassing the CI template), refuse BEFORE minting or spawning anything.
      let createCalled = false
      let engineCalled = false
      const directRunnerRes = await runGitLabReview({
        env: makeMrEnv({ NODE_DEBUG: 'child_process' }),
        log: () => {},
        createReview: async () => { createCalled = true; return { reviewId: 'x', reviewKey: 'y' } },
        runEngine: async () => { engineCalled = true; return { exitCode: 0 } },
      })
      assert.equal(directRunnerRes.exitCode, 1)
      assert.equal(directRunnerRes.error, NODE_DEBUG_CHILD_PROCESS_ERROR)
      assert.equal(createCalled, false, 'must fail before creating a billable review')
      assert.equal(engineCalled, false, 'must fail before launching the engine')

      for (const debugVal of ['child_process', '*']) {
        const directEngine = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
              import { runEngineCli } from ${JSON.stringify(engineModuleUrl)};
              try {
                await runEngineCli({
                  tier: "standard",
                  baseSha: ${JSON.stringify(BASE_SHA)},
                  headSha: ${JSON.stringify(HEAD_SHA)},
                  outPath: ${JSON.stringify(outPath)},
                  timeoutMinutes: 5,
                  apiUrl: "https://megalens.ai",
                  authMode: "review-key",
                  authEnv: { MEGALENS_REVIEW_ID: ${JSON.stringify(secretReviewId)}, MEGALENS_REVIEW_KEY: ${JSON.stringify(secretReviewKey)} },
                  cliBin: ${JSON.stringify(fakeBin)},
                  repoPath: ${JSON.stringify(tmpBase)},
                });
                process.exit(0);
              } catch (err) {
                process.stderr.write(err.message + "\\n");
                process.exit(2);
              }
            `,
          ],
          {
            env: { PATH: process.env.PATH, HOME: tmpBase, TMPDIR: tmpBase, NODE_DEBUG: debugVal },
            encoding: 'utf8',
          },
        )
        assert.equal(directEngine.status, 2, `direct runEngineCli with NODE_DEBUG=${debugVal} must refuse`)
        assert.ok(directEngine.stderr.includes(NODE_DEBUG_CHILD_PROCESS_ERROR))
        assert.equal(directEngine.stderr.includes(secretReviewKey), false, 'direct refusal must never leak MEGALENS_REVIEW_KEY')
        assert.equal(directEngine.stderr.includes(secretReviewId), false, 'direct refusal must never leak MEGALENS_REVIEW_ID')
      }

      const directBundle = spawnSync(process.execPath, [join(ROOT, 'dist', 'gitlab.mjs')], {
        env: {
          PATH: process.env.PATH,
          ...makeMrEnv({ MEGALENS_MODE: 'review', MEGALENS_RESULT_PATH: '.megalens-ci/review-result.json', NODE_DEBUG: 'child_process' }),
        },
        encoding: 'utf8',
      })
      assert.equal(directBundle.status, 1)
      assert.ok(directBundle.stderr.includes(NODE_DEBUG_CHILD_PROCESS_ERROR))
      assert.equal(directBundle.stderr.includes('ml_tok_'), false)
      assert.equal(directBundle.stderr.includes('glpat-'), false)
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it('documents token scoping, GitLab 18.1+ settings, container executors, and project access token permissions', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'gitlab.md'), 'utf8')

    // Earlier #1 & NEW #2: Masked+Protected + environment scope megalens-review; no false YAML-clearing claims
    assert.match(doc, /`MEGALENS_TOKEN`.*Masked.*Protected/i)
    assert.match(doc, /`MEGALENS_GITLAB_TOKEN`.*Masked.*Protected/i)
    assert.match(doc, /Environment scope.*`megalens-review`/i)
    assert.equal(/clears both `MEGALENS_TOKEN: ""`/i.test(doc), false, 'docs must not claim YAML clears project secrets')

    // Earlier #12: exact GitLab 18.1+ UI navigation path under Settings -> CI/CD -> Variables
    assert.match(doc, /Settings -> CI\/CD -> Variables/i)
    assert.match(doc, /Allow merge request pipelines to access protected variables and runners/i)
    assert.equal(/Settings -> CI\/CD -> General pipelines/i.test(doc), false, 'must not cite wrong General pipelines path')
    assert.match(doc, /both.*source.*target.*protected/is)
    assert.match(doc, /target[- ]branch.*permission/i)

    // Earlier #14: container executor required; explicit warning that shell runners ignore image:
    assert.match(doc, /container executor/i)
    assert.match(doc, /shell.*executor.*ignores.*`image:`/is)
    assert.equal(/for example a self-hosted shell\/VM runner/i.test(doc), false, 'must not recommend a shell runner')

    // Earlier #15: GitLab.com Premium/Ultimate + trial 1-token limit + self-managed all tiers + internal user reach
    assert.match(doc, /Premium.*Ultimate/i)
    assert.match(doc, /trial.*one.*project access token/is)
    assert.match(doc, /Self-Managed.*any tier/is)
    assert.match(doc, /Internal-visibility/i)
  })

  it('dist/gitlab.mjs runs standalone and skips fork-hosted MRs with exit 0 and zero network calls', () => {
    const out = execFileSync(process.execPath, [join(ROOT, 'dist', 'gitlab.mjs')], {
      env: {
        PATH: process.env.PATH,
        CI_PIPELINE_SOURCE: 'merge_request_event',
        CI_PROJECT_ID: '9999',
        CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '9999',
        CI_MERGE_REQUEST_PROJECT_ID: '4242',
        CI_MERGE_REQUEST_IID: '5',
      },
      encoding: 'utf8',
    })
    assert.equal(out.trim(), GITLAB_FORK_SKIP_NOTE)
  })

  it('scripts/gitlab-dry-run.mjs renders inline discussions and ONE collapsed summary note from saved engine results', () => {
    const md = execFileSync(process.execPath, [join(ROOT, 'scripts', 'gitlab-dry-run.mjs')], { encoding: 'utf8' })
    assert.match(md, /Inline discussions: 2 \| Summary-only findings: 3/)
    assert.match(md, /new_line=12 \(added\)/)
    assert.match(md, /new_line=10, old_line=10 \(context\)/)
    assert.equal((md.match(/<summary>3 summary findings<\/summary>/g) ?? []).length, 1)

    const jsonRaw = execFileSync(process.execPath, [join(ROOT, 'scripts', 'gitlab-dry-run.mjs'), '--json'], {
      encoding: 'utf8',
    })
    const parsed = JSON.parse(jsonRaw)
    assert.equal(parsed.status, 'complete')
    assert.equal(parsed.inline_discussions.length, 2)
    assert.ok(parsed.summary_note.includes('<summary>3 summary findings</summary>'))

    const tooLargeRaw = execFileSync(
      process.execPath,
      [
        join(ROOT, 'scripts', 'gitlab-dry-run.mjs'),
        '--findings',
        join(ROOT, 'test', 'fixtures', 'too-large-refusal.json'),
        '--json',
      ],
      { encoding: 'utf8' },
    )
    const tooLarge = JSON.parse(tooLargeRaw)
    assert.equal(tooLarge.status, 'skipped')
    assert.equal(tooLarge.reason, 'too_large')
    assert.equal(tooLarge.inline_discussions.length, 0)
    assert.match(tooLarge.summary_note, /No credits were used\./)
  })

  it('redacts all documented GitLab token prefixes, attached CLI flags, routable dot tokens, legacy runner tokens, session cookies, and JOB-TOKEN headers before writing artifacts', () => {
    const suffix = 'fixture'.repeat(4)
    const fixtures = [
      'glpat-', 'gldt-', 'glrt-', 'glrtr-', 'glcbt-', 'gloas-', 'gloa-',
      'glptt-', 'glft-', 'glimt-', 'glagent-', 'glsoat-', 'glffct-', 'glwt-',
    ].map((prefix) => `${prefix}${suffix}`)
    const routable = `glpat-${suffix}.01.0y0123456`
    const trailingHyphen = `glpat-${suffix}-`
    const legacyRunner = `GR1348941${suffix}`
    const jobTokenHeader = `JOB-TOKEN: ${suffix}`
    const sessionHex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    const sessionCookie = `_gitlab_session=${sessionHex}`
    const sessionCellCookie = `_gitlab_session=cell-1-${sessionHex}`
    const cookieJarLine = `#HttpOnly_gitlab.example.invalid\tFALSE\t/\tTRUE\t0\t_gitlab_session\t${sessionHex}`
    const cookieJarCellLine = `gitlab.example.invalid\tTRUE\t/\tTRUE\t1735689600\t_gitlab_session\tcell-1-${sessionHex}`
    const cookieJarAlphaVal = 'fixturefixturefixturefixture'
    const cookieJarAlphaLine = `gitlab.example.invalid\tFALSE\t/\tTRUE\t0\t_gitlab_session\t${cookieJarAlphaVal}`
    const cookieJarSpacedLine = `gitlab.example.invalid FALSE / TRUE 0 _gitlab_session ${sessionHex}`
    const signedCookieVal = `eyJzZXNzaW9uIjoiMTIzIn0==--${sessionHex}`
    const cookieJarSignedLine = `#HttpOnly_gitlab.example.invalid\tFALSE\t/\tTRUE\t0\t_gitlab_session\t${signedCookieVal}`

    for (const tok of [...fixtures, routable, trailingHyphen, legacyRunner]) {
      const cleaned = redactSecrets(`val="${tok}."`)
      assert.equal(cleaned.includes(tok), false, `redactSecrets must scrub ${tok.slice(0, 10)}`)
      assert.equal(cleaned, 'val="[redacted]."')
      const attached = redactSecrets(`docker login --username fixture -p${tok} registry.example.invalid`)
      assert.equal(attached.includes(tok), false, `redactSecrets must scrub attached CLI -p${tok.slice(0, 10)}`)
      assert.equal(attached, 'docker login --username fixture -p[redacted] registry.example.invalid')
    }
    assert.equal(redactSecrets(`curl -H "${jobTokenHeader}"`).includes(suffix), false)
    assert.equal(redactSecrets(`Cookie: ${sessionCookie}; theme=dark`), 'Cookie: [redacted]; theme=dark')
    assert.equal(redactSecrets(`Set-Cookie: ${sessionCellCookie}; Path=/; HttpOnly`), 'Set-Cookie: [redacted]; Path=/; HttpOnly')
    assert.equal(redactSecrets(`curl -b${sessionCookie} https://gitlab.example/`), 'curl -b[redacted] https://gitlab.example/')
    assert.equal(redactSecrets(`leaked ${sessionCookie}.`), 'leaked [redacted].')
    assert.equal(redactSecrets(`{"_gitlab_session": "${sessionHex}"}`).includes(sessionHex), false)
    assert.equal(redactSecrets(`cookies.set('_gitlab_session', '${sessionHex}')`).includes(sessionHex), false)
    assert.equal(redactSecrets(cookieJarLine), '#HttpOnly_gitlab.example.invalid\tFALSE\t/\tTRUE\t0\t[redacted]')
    assert.equal(redactSecrets(cookieJarCellLine), 'gitlab.example.invalid\tTRUE\t/\tTRUE\t1735689600\t[redacted]')
    assert.equal(redactSecrets(cookieJarAlphaLine), 'gitlab.example.invalid\tFALSE\t/\tTRUE\t0\t[redacted]')
    assert.equal(redactSecrets(cookieJarSpacedLine), 'gitlab.example.invalid FALSE / TRUE 0 [redacted]')
    assert.equal(redactSecrets(cookieJarSignedLine), '#HttpOnly_gitlab.example.invalid\tFALSE\t/\tTRUE\t0\t[redacted]')
    assert.equal(
      redactSecrets('The _gitlab_session authentication_handler checks SameSite'),
      'The _gitlab_session authentication_handler checks SameSite',
      'ordinary prose mentioning _gitlab_session must not be falsely redacted',
    )

    const doc = sanitizeFindingsDocumentForArtifact({
      schema: 'megalens.findings/v1',
      review_id: 'rv_gl_tokens',
      tier: 'standard',
      status: 'complete',
      target: { kind: 'range', base: BASE_SHA, head: HEAD_SHA, snapshot_sha256: 'a'.repeat(64) },
      passes: [{ name: 'pass-1', status: 'ok', detail: `Found ${fixtures[7]} and ${routable} and ${sessionCellCookie}` }],
      notes: [`Header ${jobTokenHeader}, ${legacyRunner}, Cookie: ${sessionCookie}`, cookieJarLine, cookieJarSignedLine],
      usage: { requests: 2, leaked: fixtures[0] },
      sandbox: { excluded_files: 1, leaked: fixtures[1] },
      findings: fixtures.map((tok, idx) => ({
        id: `f-${idx}`,
        file: idx === 0 ? `src/${tok}.ts` : 'src/app.ts',
        line_start: idx + 1,
        title: `Leaked -p${tok}`,
        claim: `Contains -p${tok}, ${routable}, ${trailingHyphen}, ${legacyRunner}, ${sessionCookie}, and ${cookieJarAlphaLine}`,
        failure_scenario: `Exposes ${tok}, ${sessionCellCookie}, and ${cookieJarCellLine}`,
        evidence_quote: `SECRET="${tok}"`,
        priority: 'P0',
        strength: 'strong',
      })),
    }, [])

    const serialized = JSON.stringify(doc)
    for (const secret of [
      ...fixtures, routable, trailingHyphen, legacyRunner, suffix,
      sessionHex, sessionCookie, sessionCellCookie, cookieJarAlphaVal, signedCookieVal,
    ]) {
      assert.equal(serialized.includes(secret), false, `artifact must never retain ${secret.slice(0, 12)}`)
    }
    assert.equal(doc.findings[0].file, '')
    assert.deepEqual(doc.usage, { requests: 2 })
    assert.deepEqual(doc.sandbox, { excluded_files: 1 })
  })

  it('redacts Playwright storage-state cookie values before persisting findings', () => {
    const state = {
      cookies: [
        { name: '_gitlab_session', domain: '.gitlab.example.invalid', value: 'fixture'.repeat(4), path: '/' },
        { value: 'escaped"brace}cookie\\fixture', httpOnly: true, name: '_gitlab_session' },
        { name: 'theme', value: 'dark' },
      ],
      origins: [],
    }
    const expected = {
      ...state,
      cookies: state.cookies.map((cookie) => (
        cookie.name === '_gitlab_session' ? { ...cookie, value: '[redacted]' } : cookie
      )),
    }
    const compact = JSON.stringify(state)
    const pretty = JSON.stringify(state, null, 2)
    const sanitized = sanitizeFindingsDocumentForArtifact({
      findings: [{ claim: `Saved state: ${compact}`, failure_scenario: pretty }],
    }).findings[0]

    assert.equal(sanitized.claim === `Saved state: ${JSON.stringify(expected)}`, true, 'must scrub compact cookie records')
    assert.equal(sanitized.failure_scenario === JSON.stringify(expected, null, 2), true, 'must scrub multiline cookie records')
    const unrelated = '{"cookies":[{"name":"_gitlab_session"},{"name":"theme","value":"dark"}]}'
    assert.equal(redactSecrets(unrelated), unrelated, 'must preserve values in neighboring objects')
  })

  it('redacts Playwright Python cookie dictionaries before persisting findings', () => {
    const single = String.raw`fixture\'s{cookie}\\value`
    const mixed = String.raw`fixture's\"cookie`
    const cookies = `[
      {'value': '${single}', 'httpOnly': True, 'name': '_gitlab_session'},
      {"name": '_gitlab_session', 'value': "${mixed}"},
      {'name': 'theme', 'value': "'name': '_gitlab_session'"},
    ]`
    const sanitized = sanitizeFindingsDocumentForArtifact({ findings: [{ claim: cookies }] })
    const expected = cookies.replace(single, '[redacted]').replace(mixed, '[redacted]')
    assert.equal(sanitized.findings[0].claim === expected, true, 'must scrub both Python cookies and keep the neighboring value')
  })

  it('redacts bare Playwright cookie fields before persisting findings', () => {
    const firstValue = String.raw`fixture\'s{cookie}\\value`
    const secondValue = 'fixture-cookie'
    const state = `{
      cookies: [
        { name: '_gitlab_session', domain: 'gitlab.example.invalid', value: '${firstValue}' },
        { "value": "${secondValue}", httpOnly: true, name: "_gitlab_session" },
        { name: 'theme', value: "name: '_gitlab_session'" },
        { username: '_gitlab_session', value: 'keep this too' },
      ],
      origins: [],
    }`
    const expected = state.replace(firstValue, '[redacted]').replace(secondValue, '[redacted]')
    const sanitized = sanitizeFindingsDocumentForArtifact({ findings: [{ claim: state }] })
    assert.equal(sanitized.findings[0].claim, expected)
  })

  it('locks PATH readonly in docker/gitlab-runner.Dockerfile before GitLab Runner writeExports and SourceEnv (mkdir/touch) run', () => {
    const dockerfile = readFileSync(join(ROOT, 'docker', 'gitlab-runner.Dockerfile'), 'utf8')
    const tpl = readFileSync(join(ROOT, 'templates', 'megalens-review.yml'), 'utf8')
    const trustedPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

    // Structural checks on Dockerfile & template enforcement
    assert.ok(dockerfile.includes('/usr/local/lib/megalens-bash-env.sh'))
    assert.ok(dockerfile.includes('/etc/profile.d/zz-megalens-lock-path.sh'))
    assert.ok(dockerfile.includes('/usr/local/bin/bash'))
    assert.ok(dockerfile.includes('/usr/local/bin/megalens-entrypoint'))
    assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/local\/bin\/megalens-entrypoint"\]$/m)
    assert.ok(dockerfile.includes('readonly PATH'))
    assert.ok(dockerfile.includes('readonly BASH_ENV ENV LD_PRELOAD'))
    assert.ok(tpl.includes('/usr/local/lib/megalens-bash-env.sh'))
    assert.ok(tpl.includes('(PATH="${PATH}") 2>/dev/null'))

    // Separate Docker helper image & scoped-variable fail-closed protections:
    // 1) artifacts: when: on_success (never when: always, so failed build never launches upload_artifacts_on_failure in helper container)
    // 2) ALL four credential-bearing jobs (review, publish, deep-run, deep-publish) are non-manual (when: on_success)
    //    so manual/retry job variables can NEVER enter their helper containers before writeExports/SourceEnv/writeGitSSLConfig
    // 3) Manual <job_name>-deep trigger carries NO environment: (zero secrets), GIT_STRATEGY: none, dependencies: [], and validates env/tokens
    // 4) Unscoped <job_name>-gate non-optionally needs <job_name>-publish so ANY global or environment-scoped
    //    (megalens-review / megalens-publish / megalens-*) PATH/BASH_ENV/ENV/LD_PRELOAD fails pipeline creation immediately
    //    instead of silently omitting publish and bypassing fail_on: strong
    // 5) hooks: pre_get_sources_script overrides default hooks and validates PATH/BASH_ENV/ENV/LD_PRELOAD with POSIX builtins
    // 6) docker/gitlab-runner-helper.Dockerfile + docs requiring MEGALENS_GITLAB_TOKEN scope megalens-* & no_one_allowed
    const reviewBaseBlock = tpl.slice(tpl.indexOf('.megalens-review-base:'), tpl.indexOf('.megalens-publish-base:'))
    const publishBaseBlock = tpl.slice(tpl.indexOf('.megalens-publish-base:'), tpl.indexOf('$[[ inputs.job_name ]]:'))
    const gateBlock = tpl.slice(tpl.indexOf('$[[ inputs.job_name ]]-gate:'), tpl.indexOf('$[[ inputs.job_name ]]-deep:'))
    const deepTriggerBlock = tpl.slice(tpl.indexOf('$[[ inputs.job_name ]]-deep:'), tpl.indexOf('$[[ inputs.job_name ]]-deep-run:'))
    const deepRunBlock = tpl.slice(tpl.indexOf('$[[ inputs.job_name ]]-deep-run:'), tpl.indexOf('$[[ inputs.job_name ]]-deep-publish:'))
    const deepPublishBlock = tpl.slice(tpl.indexOf('$[[ inputs.job_name ]]-deep-publish:'), tpl.indexOf('$[[ inputs.job_name ]]-fork-skip:'))
    const forkSkipBlock = tpl.slice(tpl.indexOf('$[[ inputs.job_name ]]-fork-skip:'))
    assert.match(reviewBaseBlock, /artifacts:\s*\n(?:\s*#.*\n)*\s*when:\s*on_success/)
    assert.doesNotMatch(reviewBaseBlock, /when:\s*always/)
    assert.match(publishBaseBlock, /hooks:\s*\n\s+pre_get_sources_script:\s*\[\]/)
    assert.match(gateBlock, /hooks:\s*\n\s+pre_get_sources_script:\s*\[\]/)
    assert.match(deepTriggerBlock, /hooks:\s*\n\s+pre_get_sources_script:\s*\[\]/)
    assert.match(forkSkipBlock, /hooks:\s*\n\s+pre_get_sources_script:\s*\[\]/)
    assert.doesNotMatch(gateBlock, /^\s+environment:/m, 'gate must carry no environment scope so scoped variables cannot hide it and scoped tokens are never injected')
    assert.match(gateBlock, /GIT_STRATEGY:\s*none/)
    assert.match(gateBlock, /needs:\s*\n\s+- job:\s*\$\[\[ inputs\.job_name \]\]-publish\s*\n\s+artifacts:\s*false/)
    assert.doesNotMatch(gateBlock, /optional:\s*true/, 'gate need on publish must be non-optional so omitted publish fails pipeline creation')
    assert.doesNotMatch(deepTriggerBlock, /^\s+environment:/m, 'manual deep trigger must carry no environment scope so neither token is injected')
    assert.match(deepTriggerBlock, /GIT_STRATEGY:\s*none/)
    assert.match(deepTriggerBlock, /dependencies:\s*\[\]/)
    assert.match(deepTriggerBlock, /when:\s*manual/)
    assert.match(deepRunBlock, /needs:\s*\n\s+- job:\s*\$\[\[ inputs\.job_name \]\]-deep\s*\n\s+artifacts:\s*false/)
    assert.match(deepRunBlock, /when:\s*on_success/)
    assert.doesNotMatch(deepRunBlock, /when:\s*manual/)
    assert.match(deepPublishBlock, /needs:\s*\n\s+- job:\s*\$\[\[ inputs\.job_name \]\]-deep-run\s*\n\s+artifacts:\s*true/)
    assert.doesNotMatch(deepPublishBlock, /when:\s*manual/)

    for (const jobSuffix of ['', '-publish', '-deep', '-deep-run', '-deep-publish']) {
      const block = tpl.split(`$[[ inputs.job_name ]]${jobSuffix}:\n`)[1].split(/^\S/m)[0]
      for (const varName of ['PATH', 'BASH_ENV', 'ENV', 'LD_PRELOAD']) {
        assert.match(
          block,
          new RegExp(`- if: '\\$${varName} != null && \\$${varName} != ""'\\n\\s+when: never`),
          `${jobSuffix || 'review'} job must block CI/CD ${varName} in rules before any helper/build container starts`,
        )
      }
    }

    // Parse actual job definitions from templates/megalens-review.yml and simulate GitLab's
    // Build::Context::Build per-job environment-scoped variable resolution + Seed::Build#needs_errors
    // across global (*), megalens-review, megalens-publish, and megalens-* scopes.
    const extractJobBlock = (name) => {
      const marker = `${name}:\n`
      const idx = tpl.indexOf(marker)
      assert.notEqual(idx, -1, `missing template block ${name}`)
      return tpl.slice(idx + marker.length).split(/^\S/m)[0]
    }
    const baseEnvFor = (block) => {
      const ext = /^  extends:\s*(\.\S+)$/m.exec(block)
      const searchIn = ext ? `${extractJobBlock(ext[1])}\n${block}` : block
      const envMatch = /environment:\s*\n\s+name:\s*([^\n]+)/.exec(searchIn)
      if (!envMatch) return null
      return envMatch[1]
        .trim()
        .replace('$[[ inputs.review_environment ]]', 'megalens-review')
        .replace('$[[ inputs.publish_environment ]]', 'megalens-publish')
    }
    const parsedJobs = [
      '$[[ inputs.job_name ]]',
      '$[[ inputs.job_name ]]-publish',
      '$[[ inputs.job_name ]]-gate',
      '$[[ inputs.job_name ]]-deep',
      '$[[ inputs.job_name ]]-deep-run',
      '$[[ inputs.job_name ]]-deep-publish',
      '$[[ inputs.job_name ]]-fork-skip',
    ].map((rawName) => {
      const block = extractJobBlock(rawName)
      const name = rawName.replace('$[[ inputs.job_name ]]', 'megalens-review')
      const env = baseEnvFor(block)
      const needs = [...block.matchAll(/- job:\s*([^\n]+)/g)].map((m) =>
        m[1].trim().replace('$[[ inputs.job_name ]]', 'megalens-review'),
      )
      const blockedVars = [...block.matchAll(/- if: '\$(PATH|BASH_ENV|ENV|LD_PRELOAD) != null && \$\1 != ""'\n\s+when: never/g)]
        .map((m) => m[1])
      return { name, env, needs, blockedVars, isForkSkip: name.endsWith('-fork-skip') }
    })

    const simulatePipelineSeed = ({ sameProject, scopedVars = [] }) => {
      const envMatch = (scope, jobEnv) => {
        if (scope === '*') return true
        if (!jobEnv) return false
        if (scope.endsWith('*')) return jobEnv.startsWith(scope.slice(0, -1))
        return jobEnv === scope
      }
      const included = new Set()
      for (const job of parsedJobs) {
        if (job.isForkSkip) {
          if (!sameProject) included.add(job.name)
          continue
        }
        if (!sameProject) continue
        const jobVars = {}
        for (const { key, value, scope } of scopedVars) {
          if (envMatch(scope, job.env)) jobVars[key] = value
        }
        if (job.blockedVars.some((k) => jobVars[k] != null && jobVars[k] !== '')) {
          continue
        }
        included.add(job.name)
      }
      const needsErrors = []
      for (const job of parsedJobs) {
        if (!included.has(job.name)) continue
        for (const need of job.needs) {
          if (!included.has(need)) {
            needsErrors.push(`'${job.name}' job needs '${need}' job, but '${need}' does not exist in the pipeline.`)
          }
        }
      }
      return { included, needsErrors }
    }

    // 1. Clean same-project MR: all jobs included, zero needs errors
    const cleanSeed = simulatePipelineSeed({ sameProject: true })
    assert.deepEqual(cleanSeed.needsErrors, [])
    assert.ok(cleanSeed.included.has('megalens-review'))
    assert.ok(cleanSeed.included.has('megalens-review-publish'))
    assert.ok(cleanSeed.included.has('megalens-review-gate'))
    assert.equal(cleanSeed.included.has('megalens-review-fork-skip'), false)

    // 2. Publish-scoped ENV (LOOP-CONFIRM2 NEW High): publish omitted -> gate fails pipeline creation!
    const publishScopedEnv = simulatePipelineSeed({
      sameProject: true,
      scopedVars: [{ key: 'ENV', value: 'production', scope: 'megalens-publish' }],
    })
    assert.equal(publishScopedEnv.included.has('megalens-review-publish'), false)
    assert.ok(publishScopedEnv.included.has('megalens-review-gate'))
    assert.ok(
      publishScopedEnv.needsErrors.some((e) => e.includes('megalens-review-gate') && e.includes('megalens-review-publish')),
      'publish-scoped ENV must fail pipeline creation instead of silently omitting publish and bypassing fail_on: strong',
    )

    // 3. Review-scoped ENV: review omitted -> publish fails pipeline creation!
    const reviewScopedEnv = simulatePipelineSeed({
      sameProject: true,
      scopedVars: [{ key: 'ENV', value: 'staging', scope: 'megalens-review' }],
    })
    assert.equal(reviewScopedEnv.included.has('megalens-review'), false)
    assert.ok(reviewScopedEnv.needsErrors.some((e) => e.includes('megalens-review-publish') && e.includes('megalens-review')))

    // 4. Wildcard megalens-* scoped ENV: both review & publish omitted -> gate fails pipeline creation!
    const wildcardScopedEnv = simulatePipelineSeed({
      sameProject: true,
      scopedVars: [{ key: 'ENV', value: 'ci', scope: 'megalens-*' }],
    })
    assert.equal(wildcardScopedEnv.included.has('megalens-review'), false)
    assert.equal(wildcardScopedEnv.included.has('megalens-review-publish'), false)
    assert.ok(wildcardScopedEnv.needsErrors.some((e) => e.includes('megalens-review-gate') && e.includes('megalens-review-publish')))

    // 5. Global (*) PATH: review & publish omitted -> gate fails pipeline creation (zero jobs run)!
    const globalPathSeed = simulatePipelineSeed({
      sameProject: true,
      scopedVars: [{ key: 'PATH', value: '/builds/org/repo/bin:/usr/bin:/bin', scope: '*' }],
    })
    assert.equal(globalPathSeed.included.has('megalens-review'), false)
    assert.equal(globalPathSeed.included.has('megalens-review-publish'), false)
    assert.ok(globalPathSeed.needsErrors.some((e) => e.includes('megalens-review-gate') && e.includes('megalens-review-publish')))

    // 6. Fork MR (even with publish-scoped ENV): only fork-skip included, zero needs errors
    const forkSeed = simulatePipelineSeed({
      sameProject: false,
      scopedVars: [{ key: 'ENV', value: 'production', scope: 'megalens-publish' }],
    })
    assert.deepEqual(forkSeed.needsErrors, [])
    assert.deepEqual([...forkSeed.included], ['megalens-review-fork-skip'])

    const preGetSourcesMatch = /pre_get_sources_script:\n\s+- \|\n([\s\S]*?)\n  # Block inheriting/.exec(reviewBaseBlock)
    assert.ok(preGetSourcesMatch, 'extracted hooks:pre_get_sources_script block')
    const preGetSourcesScript = preGetSourcesMatch[1].replace(/^        /gm, '')
    const gateScriptMatch = /script:\n\s+- \|\n([\s\S]*)$/.exec(gateBlock)
    assert.ok(gateScriptMatch, 'extracted gate script block')
    const gateScript = gateScriptMatch[1].replace(/^      /gm, '').replaceAll('$[[ inputs.review_environment ]]', 'megalens-review')
    const deepTriggerScriptMatch = /script:\n\s+- \|\n([\s\S]*)$/.exec(deepTriggerBlock)
    assert.ok(deepTriggerScriptMatch, 'extracted deep trigger script block')
    const deepTriggerScript = deepTriggerScriptMatch[1]
      .replace(/^      /gm, '')
      .replaceAll('$[[ inputs.review_environment ]]', 'megalens-review')
      .replaceAll('$[[ inputs.job_name ]]', 'megalens-review')

    for (const shellBin of ['/bin/sh', '/bin/bash']) {
      for (const [label, script] of [
        ['pre_get_sources_script', preGetSourcesScript],
        ['gate', gateScript],
        ['deep-trigger', deepTriggerScript],
      ]) {
        const syntax = spawnSync(shellBin, ['-n'], { input: script, encoding: 'utf8' })
        assert.equal(syntax.status, 0, `${shellBin} -n failed on ${label}: ${syntax.stderr}`)
      }
      // gate passes when token-free, fails closed if either token leaked unscoped
      assert.equal(spawnSync(shellBin, ['-c', gateScript], { env: { PATH: trustedPath }, encoding: 'utf8' }).status, 0)
      assert.equal(spawnSync(shellBin, ['-c', gateScript], { env: { PATH: trustedPath, MEGALENS_TOKEN: 'ml_tok_leaked' }, encoding: 'utf8' }).status, 1)
      assert.equal(spawnSync(shellBin, ['-c', gateScript], { env: { PATH: trustedPath, MEGALENS_GITLAB_TOKEN: 'glpat-leaked1234567890' }, encoding: 'utf8' }).status, 1)

      // deep trigger passes when clean & token-free, fails closed on any token or poisoned PATH/BASH_ENV/ENV/LD_PRELOAD
      assert.equal(spawnSync(shellBin, ['-c', deepTriggerScript], { env: { PATH: trustedPath }, encoding: 'utf8' }).status, 0)
      assert.equal(spawnSync(shellBin, ['-c', deepTriggerScript], { env: { PATH: trustedPath, MEGALENS_TOKEN: 'ml_tok_leaked' }, encoding: 'utf8' }).status, 1)
      assert.equal(spawnSync(shellBin, ['-c', deepTriggerScript], { env: { PATH: trustedPath, MEGALENS_GITLAB_TOKEN: 'glpat-leaked1234567890' }, encoding: 'utf8' }).status, 1)

      const okDefault = spawnSync(shellBin, ['-c', preGetSourcesScript], {
        env: { PATH: trustedPath },
        encoding: 'utf8',
      })
      assert.equal(okDefault.status, 0, `${shellBin} pre_get_sources_script rejected default helper PATH: ${okDefault.stderr}`)
      const okSubset = spawnSync(shellBin, ['-c', preGetSourcesScript], {
        env: { PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
      })
      assert.equal(okSubset.status, 0, `${shellBin} pre_get_sources_script rejected trusted subset PATH`)

      for (const badEnv of [
        { PATH: `./bin:${trustedPath}` },
        { PATH: `/builds/org/repo/bin:${trustedPath}` },
        { PATH: `:${trustedPath}` },
        { PATH: `${trustedPath}:` },
        { PATH: '/usr/bin::/bin' },
        { PATH: '/*' },
        { PATH: '' },
        { PATH: trustedPath, BASH_ENV: '/builds/org/repo/evil.sh' },
        { PATH: trustedPath, ENV: '/builds/org/repo/evil.sh' },
        { PATH: trustedPath, LD_PRELOAD: '/builds/org/repo/evil.so' },
      ]) {
        const blocked = spawnSync(shellBin, ['-c', preGetSourcesScript], { env: badEnv, encoding: 'utf8' })
        assert.equal(blocked.error, undefined, `${shellBin} failed to spawn`)
        assert.equal(blocked.status, 1, `${shellBin} pre_get_sources_script must fail closed on ${JSON.stringify(badEnv)}`)
        const deepBlocked = spawnSync(shellBin, ['-c', deepTriggerScript], { env: badEnv, encoding: 'utf8' })
        assert.equal(deepBlocked.status, 1, `${shellBin} deep trigger must fail closed on ${JSON.stringify(badEnv)}`)
      }
    }

    const helperDockerfile = readFileSync(join(ROOT, 'docker', 'gitlab-runner-helper.Dockerfile'), 'utf8')
    assert.ok(helperDockerfile.includes('ARG HELPER_BASE_IMAGE'))
    assert.ok(helperDockerfile.includes('readonly PATH'))
    assert.ok(helperDockerfile.includes('readonly BASH_ENV ENV LD_PRELOAD'))
    assert.ok(helperDockerfile.includes('/usr/local/bin/bash'))

    const docs = readFileSync(join(ROOT, 'docs', 'gitlab.md'), 'utf8')
    assert.ok(docs.includes('no_one_allowed'), 'docs must require ci_pipeline_variables_minimum_override_role = no_one_allowed')
    assert.ok(docs.includes('gitlab-runner-helper.Dockerfile'), 'docs must reference hardened helper image option')

    // Live simulation of GitLab Runner BashDetectShellScript -> entrypoint -> bash wrapper ->
    // writeExports (poisoned PATH & BASH_ENV + protected tokens) -> cd $CI_PROJECT_DIR -> SourceEnv (mkdir/touch)
    const tmpBase = mkdtempSync(join(tmpdir(), 'megalens-runner-pre-script-'))
    const mrDir = join(tmpBase, 'mr-checkout')
    const evilBin = join(mrDir, 'bin')
    const shimDir = join(tmpBase, 'image-usr-local')
    const leakedFile = join(tmpBase, 'leaked.txt')
    const runnerTmp = join(tmpBase, 'runner-tmp')
    mkdirSync(evilBin, { recursive: true })
    mkdirSync(shimDir, { recursive: true })

    try {
      const bashEnvFile = join(shimDir, 'megalens-bash-env.sh')
      const bashWrapper = join(shimDir, 'bash')
      const entrypoint = join(shimDir, 'megalens-entrypoint')
      const evilBashEnv = join(mrDir, 'evil-env.sh')

      writeFileSync(
        bashEnvFile,
        [
          `PATH="${trustedPath}"`,
          'export PATH',
          'readonly PATH',
          'unset BASH_ENV ENV',
          'readonly BASH_ENV ENV',
        ].join('\n') + '\n',
        'utf8',
      )
      writeFileSync(
        bashWrapper,
        [
          '#!/bin/sh',
          `export PATH="${trustedPath}"`,
          `export BASH_ENV="${bashEnvFile}"`,
          'unset ENV NODE_OPTIONS NODE_DEBUG NODE_DEBUG_NATIVE',
          'exec /bin/bash "$@"',
        ].join('\n') + '\n',
        'utf8',
      )
      writeFileSync(
        entrypoint,
        [
          '#!/bin/sh',
          `export PATH="${trustedPath}"`,
          `export BASH_ENV="${bashEnvFile}"`,
          'unset ENV NODE_OPTIONS NODE_DEBUG NODE_DEBUG_NATIVE',
          'exec "$@"',
        ].join('\n') + '\n',
        'utf8',
      )
      chmodSync(bashWrapper, 0o755)
      chmodSync(entrypoint, 0o755)

      writeFileSync(evilBashEnv, `printf 'BASH_ENV:%s\\n' "\${MEGALENS_TOKEN:-}" >> "${leakedFile}"\n`, 'utf8')
      for (const cmd of ['mkdir', 'touch', 'sh', 'node', 'git', 'bwrap']) {
        const shim = join(evilBin, cmd)
        writeFileSync(
          shim,
          `#!/bin/sh\nprintf '%s:%s:%s\\n' "${cmd}" "\${MEGALENS_TOKEN:-}" "\${MEGALENS_GITLAB_TOKEN:-}" >> "${leakedFile}"\nexit 0\n`,
          'utf8',
        )
        chmodSync(shim, 0o755)
      }

      // Case 1: Attack with poisoned PATH & BASH_ENV in both Docker Env AND GitLab Runner writeExports (shells/bash.go)
      const attackStdin = [
        'set -eo pipefail',
        "export MEGALENS_TOKEN='ml_tok_protected_review_secret_1234'",
        "export MEGALENS_GITLAB_TOKEN='glpat-protected_gitlab_secret_123456'",
        `export PATH='${evilBin}:${trustedPath}'`,
        `cd ${JSON.stringify(mrDir)}`,
        `mkdir -p ${JSON.stringify(runnerTmp)}`,
        `touch ${JSON.stringify(join(runnerTmp, 'gitlab_runner_env'))}`,
        `while read -r line; do export "$line"; done < ${JSON.stringify(join(runnerTmp, 'gitlab_runner_env'))}`,
      ].join('\n') + '\n'

      const attackRes = spawnSync(
        entrypoint,
        ['sh', '-c', `if [ -x ${JSON.stringify(bashWrapper)} ]; then exec ${JSON.stringify(bashWrapper)}; else exit 99; fi`],
        {
          input: attackStdin,
          env: {
            PATH: `${evilBin}:${trustedPath}`,
            BASH_ENV: evilBashEnv,
            ENV: evilBashEnv,
            NODE_DEBUG: 'child_process',
            MEGALENS_TOKEN: 'ml_tok_protected_review_secret_1234',
            MEGALENS_GITLAB_TOKEN: 'glpat-protected_gitlab_secret_123456',
          },
          encoding: 'utf8',
        },
      )
      assert.notEqual(attackRes.status, 0, 'poisoned export PATH must fail closed on readonly PATH')
      assert.match(attackRes.stderr, /PATH: readonly variable/)
      assert.equal(existsSync(leakedFile), false, 'MR-supplied mkdir/touch/sh/BASH_ENV must NEVER run before script:')

      // Case 2: Even without set -e, PATH remains immutably locked so SourceEnv mkdir/touch still use system binaries
      const noErrexitStdin = [
        "export MEGALENS_TOKEN='ml_tok_protected_review_secret_1234'",
        `export PATH='${evilBin}:${trustedPath}'`,
        `cd ${JSON.stringify(mrDir)}`,
        `mkdir -p ${JSON.stringify(runnerTmp)}`,
        `touch ${JSON.stringify(join(runnerTmp, 'gitlab_runner_env'))}`,
        'printf "%s" "$PATH"',
      ].join('\n') + '\n'

      const noErrexitRes = spawnSync(
        entrypoint,
        ['sh', '-c', `exec ${JSON.stringify(bashWrapper)}`],
        {
          input: noErrexitStdin,
          env: { PATH: `${evilBin}:${trustedPath}`, BASH_ENV: evilBashEnv },
          encoding: 'utf8',
        },
      )
      assert.equal(existsSync(leakedFile), false, 'MR-supplied mkdir/touch must never execute even without set -e')
      assert.equal(noErrexitRes.stdout, trustedPath)

      // Case 3: Normal job (no custom PATH override) runs writeExports + SourceEnv + review preamble cleanly
      const reviewScriptMatch = /- &megalens_review_script \|\n([\s\S]*?)\n\.megalens-publish-base:/.exec(tpl)
      assert.ok(reviewScriptMatch)
      const reviewPreamble = reviewScriptMatch[1]
        .replace(/^      /gm, '')
        .split('# Belt-and-suspenders fork guard:')[0]
        .replaceAll('$[[ inputs.fail_on ]]', 'none')
        .replaceAll('$[[ inputs.inline ]]', 'true')
        .replaceAll('$[[ inputs.timeout_minutes ]]', '25')
        .replaceAll('$[[ inputs.api_url ]]', 'https://megalens.ai')
        .replaceAll('$[[ inputs.gitlab_api_url ]]', 'https://gitlab.com/api/v4')
        .replaceAll('$[[ inputs.engine_version ]]', PINNED_ENGINE_VERSION)
      const normalStdin = [
        'set -eo pipefail',
        "export MEGALENS_TOKEN='ml_tok_protected_review_secret_1234'",
        `cd ${JSON.stringify(mrDir)}`,
        `mkdir -p ${JSON.stringify(runnerTmp)}`,
        `touch ${JSON.stringify(join(runnerTmp, 'gitlab_runner_env'))}`,
        `while read -r line; do export "$line"; done < ${JSON.stringify(join(runnerTmp, 'gitlab_runner_env'))}`,
        reviewPreamble,
        'if (PATH="${PATH}") 2>/dev/null; then echo WRITABLE; else echo LOCKED; fi',
      ].join('\n') + '\n'

      const normalRes = spawnSync(
        entrypoint,
        ['sh', '-c', `exec ${JSON.stringify(bashWrapper)}`],
        {
          input: normalStdin,
          env: { PATH: trustedPath },
          encoding: 'utf8',
        },
      )
      assert.equal(normalRes.status, 0, `normal job under readonly PATH failed: ${normalRes.stderr}`)
      assert.equal(normalRes.stdout.trim(), 'LOCKED')
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it('rejects a legacy engine override before calling GitLab or creating a review', async () => {
    const result = await runGitLabReview({
      env: makeMrEnv({ MEGALENS_ENGINE_VERSION: '0.1.3' }),
      log: () => {},
      createGitLabApi: () => assert.fail('must reject the legacy engine before accessing GitLab'),
      createReview: () => assert.fail('must reject the legacy engine before creating a review'),
      runEngine: () => assert.fail('must not run a legacy engine'),
    })
    assert.equal(result.exitCode, 1)
    assert.ok(result.error.includes(PINNED_ENGINE_VERSION))
  })
})
