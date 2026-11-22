import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runAction } from '../src/action.js'
import { WALKTHROUGH_MARKER } from '../src/format.js'

const fixture = new URL('../test/fixtures/engine-docs/complete-with-route.json', import.meta.url)
const rawResult = await readFile(fixture, 'utf8')
const { target } = JSON.parse(rawResult)
const output = new URL('../dry-run/', import.meta.url)
const pullFiles = [
  { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 },
  { filename: 'test/a.test.ts', status: 'added', additions: 16, deletions: 0 },
  { filename: 'README.md', previous_filename: 'SETUP.md', status: 'renamed', additions: 0, deletions: 0 },
]

async function publish(files) {
  const bodies = new Map()
  const result = await runAction({
    env: { GITHUB_EVENT_NAME: 'pull_request', INPUT_MODE: 'publish', INPUT_GITHUB_TOKEN: 'dry-run-placeholder' },
    payload: {
      action: 'synchronize', repository: { owner: { login: 'example' }, name: 'repo' },
      pull_request: { number: 1, base: { sha: target.base }, head: { sha: target.head } },
    },
    outPath: fileURLToPath(fixture),
    readFindingsImpl: async () => rawResult,
    createGitHubApi: () => ({
      getPull: async () => ({ headSha: target.head }),
      listPullFiles: async () => files,
      listPullReviewComments: async () => [],
      createPullReview: async (_owner, _repo, _pr, _sha, comments) => {
        bodies.set('inline-comment.md', comments[0].body)
      },
      findSummaryComment: async () => null,
      createIssueComment: async (_owner, _repo, _pr, body) => {
        const name = body.startsWith(WALKTHROUGH_MARKER) ? 'pr-walkthrough.md' : 'findings-summary.md'
        bodies.set(name, body)
        return bodies.size
      },
    }),
    now: Date.UTC(2026, 8, 24),
  })
  if (result.status !== 'complete') throw new Error(`Dry run ended with status ${result.status}`)
  return bodies
}

const anchored = await publish([
  { ...pullFiles[0], patch: '@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n' },
  ...pullFiles.slice(1),
])
const unanchored = await publish(pullFiles)
const files = new Map([
  ['inline-comment.md', anchored.get('inline-comment.md')],
  ['pr-walkthrough.md', anchored.get('pr-walkthrough.md')],
  ['findings-summary.md', unanchored.get('findings-summary.md')],
])
await mkdir(output, { recursive: true })
for (const [name, body] of files) {
  if (!body) throw new Error(`Dry run did not generate ${name}`)
  await writeFile(new URL(name, output), `${body}\n`)
}
