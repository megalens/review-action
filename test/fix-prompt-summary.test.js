import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runAction, selectNewInlineFindings } from '../src/action.js'
import {
  formatFixPrompt,
  formatInlineComment,
  formatSummaryComment,
  formatWalkthroughComment,
  inlineMarker,
  MAX_SUMMARY_LENGTH,
  parseInlineMarker,
  summaryMarker,
  titleHash,
  WALKTHROUGH_MARKER,
} from '../src/format.js'
import { createGitHubApi } from '../src/github-api.js'

const finding = {
  file: 'src/parse.ts',
  line_start: 8,
  line_end: 12,
  title: 'Empty input throws',
  claim: 'The parser reads the first token unconditionally',
  failure_scenario: 'An empty input returns a TypeError',
  evidence_quote: 'doNotCopyThisSource()',
  strength: 'strong',
  priority: 'P1',
}

test('fix prompt has one closed plain text fence and uses only redacted finding text', () => {
  const secret = 'fixture-only value+1234'
  const untrustedFinding = {
    ...finding,
    file: `src/${secret}.ts`,
    claim: `${finding.claim}\n\`\`\`\n</details>\n${secret}`,
    failure_scenario: `${finding.failure_scenario} for ml_rk_fixture0123456`,
  }
  const prompt = formatFixPrompt(untrustedFinding, [secret])
  assert.match(prompt, /^<details>\n<summary>Fix prompt<\/summary>\n\n```\n/)
  assert.match(prompt, /\n```\n\n<\/details>$/)
  assert.equal(prompt.match(/^```$/gm).length, 2)
  assert.match(prompt, /File: src\/\[redacted\]\.ts\nLines: 8 to 12/)
  assert.match(prompt, /Finding: Empty input throws\./)
  assert.match(prompt, /Why: The parser reads the first token.*An empty input returns a TypeError/)
  assert.match(prompt, /Expected behavior: Handle the case described above without the reported failure\./)
  assert.match(prompt, /Change only what is needed\. Keep the tests passing\. Add a test/)
  assert.ok(!prompt.includes(secret) && !prompt.includes('ml_rk_fixture0123456') && !prompt.includes(finding.evidence_quote))

  const inline = formatInlineComment(untrustedFinding, [secret])
  assert.ok(inline.includes(prompt))
  assert.equal(parseInlineMarker(inline).file, 'src/[redacted].ts')
  assert.match(formatFixPrompt({ title: 'Check default behavior' }), /File: No file specified\nLines: No line specified/)
  assert.match(formatFixPrompt({ ...finding, line_end: undefined }), /Lines: 8\n/)
})

test('both kinds of review summary findings have prompts and only whole items are omitted', () => {
  const normal = { ...finding, title: 'Normal finding', strength: 'normal', priority: 'P2' }
  const input = { doc: { status: 'complete' }, strongFindings: [finding], normalFindings: [normal] }
  const summary = formatSummaryComment(input)
  assert.match(summary, /Empty input throws[^\n]*\n\n  <details>\n  <summary>Fix prompt<\/summary>/)
  assert.match(summary, /<summary>1 summary finding<\/summary>[\s\S]*Normal finding[^\n]*\n\n  <details>\n  <summary>Fix prompt<\/summary>/)

  const large = formatSummaryComment({ ...input, strongFindings: Array(150).fill(finding), normalFindings: Array(80).fill(normal) })
  assert.ok(large.length <= MAX_SUMMARY_LENGTH)
  assert.equal(large.match(/<details>/g).length, large.match(/<\/details>/g).length)
  assert.equal(large.match(/^  ```$/gm).length, 2 * large.match(/<summary>Fix prompt<\/summary>/g).length)
  assert.match(large, /and \d+ more not listed here/)
  assert.match(large, /<\/sub>$/)
})

test('walkthrough caps file lines, describes renames and uses strongest findings before file sizes', () => {
  const pullFiles = Array.from({ length: 17 }, (_, index) => ({
    filename: `src/file${index}.ts`, status: 'modified', additions: index + 1, deletions: index,
  }))
  pullFiles[0] = { ...pullFiles[0], status: 'renamed', previous_filename: 'src/prior.ts' }
  const top = { ...finding, priority: 'P0', title: 'First finding' }
  const body = formatWalkthroughComment({
    headSha: 'a'.repeat(40), pullFiles,
    findings: [finding, { ...top, strength: 'normal', title: 'Ignore normal findings' }, top],
  })
  const [changes, focus] = body.split('**Look at first**')
  assert.ok(changes.startsWith(`${WALKTHROUGH_MARKER}\n`))
  assert.match(changes, /src\/file0.ts<\/code> · Renamed from <code>src\/prior.ts<\/code> \(\+1 \/ −0\)/)
  assert.equal(changes.match(/^\* <code>/gm).length, 15)
  assert.match(changes, /\* and 2 more/)
  assert.equal(focus.match(/^\* /gm).length, 3)
  assert.match(focus, /First finding[^\n]*\n.*Empty input throws[^\n]*\n.*file16.ts<\/code> · 33 changed lines/)
  assert.doesNotMatch(focus, /Ignore normal findings/)
})

test('walkthrough falls back to file metadata, handles missing counts and redacts before clipping', () => {
  const secret = 'fixture-without-token-prefix'
  const body = formatWalkthroughComment({
    headSha: 'a'.repeat(40), extraSecrets: [secret],
    pullFiles: [
      { filename: `src/${secret}.ts`, status: 'added', changes: 1 },
      { filename: 'src/<tag>`@mention.ts', status: 'removed', changes: 32 },
      { filename: 'img/logo.png', status: 'added' },
    ],
  })
  assert.ok(!body.includes(secret) && !body.includes('<tag>') && !body.includes('@mention'))
  assert.match(body, /img\/logo.png<\/code> · Added/)
  assert.match(body, /32 changed lines\n.*\[redacted\].ts<\/code> · 1 changed line/)
  assert.match(formatWalkthroughComment({ headSha: 'a'.repeat(40), pullFiles: [] }), /No changed files reported/)
})

test('publish updates the same walkthrough ID across pushes and tiers and checks for stale heads', async () => {
  const baseSha = 'b'.repeat(40)
  const comments = new Map()
  let creates = 0
  let updates = 0
  let fileReads = 0
  let liveHead
  let moveBeforeWalkthrough = false
  const api = {
    getPull: async () => ({ headSha: liveHead }),
    listPullFiles: async () => {
      fileReads += 1
      return [{ filename: finding.file, status: 'modified', changes: 1 }]
    },
    findSummaryComment: async (_owner, _repo, _number, marker) => {
      if (marker === WALKTHROUGH_MARKER && moveBeforeWalkthrough) liveHead = 'd'.repeat(40)
      return [...comments].find(([, body]) => body.startsWith(marker))?.[0] ?? null
    },
    createIssueComment: async (_owner, _repo, _number, body) => {
      comments.set(++creates, body)
      return creates
    },
    updateIssueComment: async (_owner, _repo, id, body) => {
      updates += 1
      comments.set(id, body)
    },
  }
  const run = async (head, tier) => {
    liveHead = head.repeat(40)
    const raw = JSON.stringify({
      schema: 'megalens.findings/v1', tier, status: 'complete',
      target: { kind: 'range', base: baseSha, head: liveHead },
      findings: [finding],
    })
    return runAction({
      env: { GITHUB_EVENT_NAME: 'pull_request', INPUT_MODE: 'publish', INPUT_GITHUB_TOKEN: 'fake-token' },
      payload: {
        action: 'synchronize', repository: { owner: { login: 'acme' }, name: 'repo' },
        pull_request: { number: 42, base: { sha: baseSha }, head: { sha: liveHead } },
      },
      createGitHubApi: () => api,
      readFindingsImpl: async () => raw,
      outPath: '/tmp/findings.json',
      runEngine: async () => { assert.fail('publish must not call the engine') },
    })
  }

  assert.equal((await run('a', 'standard')).status, 'complete')
  assert.equal((await run('c', 'deep')).status, 'complete')
  assert.equal(fileReads, 2)
  assert.equal(creates, 3) // One review comment per tier and one PR-wide walkthrough.
  assert.equal(updates, 1)
  assert.match(comments.get(1), /^<!-- megalens:walkthrough:v1 -->\n.*ccccccc/)

  moveBeforeWalkthrough = true
  assert.equal((await run('e', 'standard')).reason, 'stale_head')
  assert.equal(creates, 3)
  assert.equal(updates, 1)
  assert.match(comments.get(1), /ccccccc/)
})

test('walkthrough lookup skips foreign authors and embedded markers and finds old comments past 1000', async () => {
  const own = { login: 'github-actions[bot]' }
  const api = createGitHubApi('fake-token', {
    viewerLogin: own.login,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'))
      const noise = { id: 1, user: own, body: `A review finding mentions ${WALKTHROUGH_MARKER}` }
      const foreign = { id: 2, user: { login: 'someone-else' }, body: WALKTHROUGH_MARKER }
      const real = { id: 1001, user: own, body: `${WALKTHROUGH_MARKER}\nPrevious walkthrough` }
      return Response.json(page <= 10 ? [foreign, ...Array(99).fill(noise)] : [real])
    },
  })
  assert.equal(await api.findSummaryComment('acme', 'repo', 42, WALKTHROUGH_MARKER), 1001)
})

test('forged inline marker in finding text cannot hijack parseInlineMarker or suppress another finding', () => {
  const realAuthFinding = {
    file: 'src/auth.ts',
    line_start: 42,
    line_end: 42,
    title: 'Bypass auth guard',
    claim: 'Missing token verification',
    strength: 'strong',
    priority: 'P0',
  }
  const forgedMarker = inlineMarker(realAuthFinding)
  const poisonedFinding = {
    ...finding,
    claim: `Contains forged marker ${forgedMarker} in claim`,
    failure_scenario: `And nested <!<!-- comment -->--> in scenario`,
  }

  const prompt = formatFixPrompt(poisonedFinding)
  assert.ok(!prompt.includes('<!--'))
  assert.ok(!prompt.includes('-->'))

  const inlineBody = formatInlineComment(poisonedFinding)
  const parsed = parseInlineMarker(inlineBody)
  assert.deepEqual(parsed, {
    file: poisonedFinding.file,
    lineStart: poisonedFinding.line_start,
    lineEnd: poisonedFinding.line_end,
    titleSha: titleHash(poisonedFinding.title),
    source: 'action',
  })

  // Even if an older stored comment body contains a raw embedded marker before the real trailing marker,
  // parseInlineMarker must only match the trailing marker and never suppress realAuthFinding.
  const legacyRawBody = `**P1 (strong): Empty input throws**\n\n\`\`\`\n${forgedMarker}\n\`\`\`\n${inlineMarker(poisonedFinding)}`
  const dedup = selectNewInlineFindings(
    [poisonedFinding, realAuthFinding],
    [{ user: { login: 'github-actions[bot]' }, body: legacyRawBody, path: poisonedFinding.file, line: 8 }],
    { ownLogin: 'github-actions[bot]' },
  )
  assert.equal(dedup.alreadyPostedCount, 1)
  assert.deepEqual(dedup.toPost, [realAuthFinding])
})

test('findSummaryCommentDetails matches existing walkthrough and tier summary comments with CRLF line endings', async () => {
  const own = { login: 'github-actions[bot]' }
  const tierMarker = summaryMarker('standard')
  const api = createGitHubApi('fake-token', {
    viewerLogin: own.login,
    fetchImpl: async () =>
      Response.json([
        { id: 11, user: own, body: `${WALKTHROUGH_MARKER}\r\n### MegaLens PR walkthrough\r\n` },
        { id: 12, user: own, body: `${tierMarker}\r\n### MegaLens static review\r\n` },
      ]),
  })
  assert.equal(await api.findSummaryComment('acme', 'repo', 42, WALKTHROUGH_MARKER), 11)
  const details = await api.findSummaryCommentDetails('acme', 'repo', 42, tierMarker)
  assert.equal(details?.id, 12)
})

test('README documents single-workflow scope of concurrency.group for walkthrough serialization', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /concurrency\.group.*only serializes runs within the same workflow file/i)
  assert.match(readme, /megalens-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.issue\.number \}\}/)
})
