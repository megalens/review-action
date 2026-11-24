#!/usr/bin/env node
/**
 * Dry-run renderer for MegaLens GitLab MR notes.
 * Makes ZERO GitLab or MegaLens network calls: reads a saved megalens.findings/v1 JSON file
 * (plus an optional MR diffs JSON file or unified diff patch) and prints the exact inline MR
 * discussions and ONE collapsed summary note that would be posted.
 *
 * Usage:
 *   node scripts/gitlab-dry-run.mjs [options]
 *
 * Options:
 *   --findings <path>   Path to saved findings.json (default: test/fixtures/gitlab-sample-findings.json)
 *   --mr-diffs <path>   Path to JSON array of GitLab MR diff entries ({ old_path, new_path, diff, deleted_file })
 *   --head-sha <sha>    Override MR head SHA (default: doc.target.head)
 *   --base-sha <sha>    Override MR base SHA (default: doc.target.base)
 *   --inline <bool>     true or false (default: true)
 *   --json              Output structured JSON plan instead of formatted markdown preview
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFindingsDocument } from '../src/findings.js'
import { buildGitLabReviewPlan } from '../src/gitlab-runner.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const opts = {
    findings: join(root, 'test', 'fixtures', 'gitlab-sample-findings.json'),
    mrDiffs: null,
    headSha: '',
    baseSha: '',
    inline: true,
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--findings' && argv[i + 1]) {
      opts.findings = resolve(argv[++i])
    } else if (arg === '--mr-diffs' && argv[i + 1]) {
      opts.mrDiffs = resolve(argv[++i])
    } else if (arg === '--head-sha' && argv[i + 1]) {
      opts.headSha = argv[++i]
    } else if (arg === '--base-sha' && argv[i + 1]) {
      opts.baseSha = argv[++i]
    } else if (arg === '--inline' && argv[i + 1]) {
      opts.inline = argv[++i].toLowerCase() !== 'false'
    } else if (arg === '--json') {
      opts.json = true
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: node scripts/gitlab-dry-run.mjs [--findings <path>] [--mr-diffs <path>] [--head-sha <sha>] [--base-sha <sha>] [--inline true|false] [--json]\n',
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return opts
}

function defaultDiffsFor(doc) {
  // Synthesize minimal diff hunks covering each finding's file+line_start only when using the default
  // fixture or when no --mr-diffs file was provided, so the dry-run clearly demonstrates inline vs summary.
  const defaultDiffsPath = join(root, 'test', 'fixtures', 'gitlab-sample-mr-diffs.json')
  try {
    const parsed = JSON.parse(readFileSync(defaultDiffsPath, 'utf8'))
    if (Array.isArray(parsed)) return parsed
  } catch {
    // Fall back to empty diffs if sample file is absent.
  }
  return doc.findings
    .filter((f) => f.file && typeof f.line_start === 'number')
    .map((f) => ({
      old_path: f.file,
      new_path: f.file,
      deleted_file: false,
      diff: `@@ -${Math.max(1, f.line_start - 1)},1 +${f.line_start},1 @@\n+line`,
    }))
}

export function renderDryRun(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  const rawFindings = readFileSync(opts.findings, 'utf8')
  const doc = parseFindingsDocument(rawFindings)
  const mrDiffs = opts.mrDiffs
    ? JSON.parse(readFileSync(opts.mrDiffs, 'utf8'))
    : defaultDiffsFor(doc)
  const headSha = opts.headSha || doc.target?.head || '0'.repeat(40)
  const baseSha = opts.baseSha || doc.target?.base || '0'.repeat(40)

  const plan = buildGitLabReviewPlan({
    doc,
    mrDiffs,
    diffRefs: { baseSha, startSha: baseSha, headSha },
    inline: opts.inline,
    now: 1700000000000,
  })

  if (opts.json) {
    return JSON.stringify(
      {
        status: plan.status,
        reason: plan.reason,
        tier: plan.tier,
        inline_discussions: plan.inlineDiscussions.map((d) => ({
          position: d.position,
          body: d.body,
        })),
        summary_note: plan.summaryNote,
      },
      null,
      2,
    )
  }

  const out = []
  out.push('================================================================================')
  out.push(`MegaLens GitLab MR Dry-Run (${plan.status}, tier: ${plan.tier})`)
  out.push(`Inline discussions: ${plan.inlineDiscussions.length} | Summary-only findings: ${plan.normalFindings.length}`)
  out.push('================================================================================')
  out.push('')

  if (plan.inlineDiscussions.length === 0) {
    out.push('(No inline discussions would be posted.)')
    out.push('')
  } else {
    plan.inlineDiscussions.forEach((d, idx) => {
      const pos = d.position
      const lineDesc = pos.old_line ? `new_line=${pos.new_line}, old_line=${pos.old_line} (context)` : `new_line=${pos.new_line} (added)`
      out.push(`--- INLINE DISCUSSION #${idx + 1}: ${pos.new_path} [${lineDesc}] ---`)
      out.push(d.body)
      out.push('')
    })
  }

  out.push('--- SUMMARY MR NOTE (1 note, created or updated in place) ---')
  out.push(plan.summaryNote)
  out.push('')
  return out.join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${renderDryRun()}\n`)
  } catch (err) {
    process.stderr.write(`Dry-run failed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
}
