// Checks from the round-6 test 2 that round 8 rewrote away (coordinator, 21 Nov): engine notes, sandbox counts and
// isolation are parsed, notes are printed, and "No findings" is never printed when files were excluded or skipped.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'node:test'
import { parseFindingsDocument } from '../src/findings.js'
import { formatSummaryComment } from '../src/format.js'

const SHA_BASE = '1111111111111111111111111111111111111111'
const SHA_HEAD = '2222222222222222222222222222222222222222'

const doc = (extra = {}) => ({
  schema: 'megalens.findings/v1',
  review_id: 'rv_eng_1',
  tier: 'standard',
  status: 'complete',
  target: { kind: 'range', base: SHA_BASE, head: SHA_HEAD, snapshot_sha256: 'a'.repeat(64) },
  passes: [{ name: 'codex-standard', model: 'gpt-6.2-sol', effort: 'medium', status: 'ok', minutes: 1.2 }],
  findings: [],
  dropped_by_quiet_mode: 0,
  dropped_findings: [],
  usage: { requests: 2, input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
  notes: ['1 changed file(s) were not sent for review (agent config or credential-shaped)', 'the reviewed diff is empty'],
  sandbox: { excluded_files: 1, skipped_files: 0 },
  isolation: 'bwrap',
  ...extra,
})

it('engine notes, sandbox and isolation are parsed and notes are printed; no "No findings" when files were excluded', () => {
  const d = doc()
  const parsed = parseFindingsDocument(d)
  assert.deepEqual(parsed.notes, d.notes)
  assert.deepEqual(parsed.sandbox, { excluded_files: 1, skipped_files: 0 })
  assert.equal(parsed.isolation, 'bwrap')
  const summary = formatSummaryComment({ headSha: SHA_HEAD, doc: { ...parsed, findings: [] }, strongFindings: [], normalFindings: [] })
  assert.match(summary, /> Note: 1 changed file\(s\) were not sent for review/)
  assert.match(summary, /> Note: the reviewed diff is empty/)
  assert.equal(summary.includes('No findings on the changed diff hunks.'), false)
  assert.match(summary, /excluded or skipped/)
})

it('the committed excluded-empty engine fixture parses, keeps its notes and never reads as a clean review', async () => {
  const raw = JSON.parse(await readFile(join(import.meta.dirname, 'fixtures', 'engine-docs', 'excluded-empty.json'), 'utf8'))
  const parsed = parseFindingsDocument(raw)
  assert.deepEqual(parsed.notes, raw.notes)
  assert.equal(parsed.isolation, 'none')
  const summary = formatSummaryComment({ headSha: raw.target.head, doc: { ...parsed, findings: [] }, strongFindings: [], normalFindings: [] })
  assert.equal(summary.includes('No findings on the changed diff hunks.'), false)
  assert.match(summary, /no OS-level isolation was used/)
})
