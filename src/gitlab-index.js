import { runGitLabReview } from './gitlab-runner.js'
import { errorText } from './redact.js'

export async function main() {
  const result = await runGitLabReview({
    env: process.env,
  })
  if (result.exitCode && result.exitCode !== 0) {
    if (result.error) {
      process.stderr.write(`MegaLens error: ${errorText(result.error)}\n`)
    }
    process.exitCode = result.exitCode
  }
}
