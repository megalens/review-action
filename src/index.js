import { appendFile, readFile } from 'node:fs/promises'
import { runAction } from './action.js'
import { errorText } from './redact.js'

export async function main() {
  const result = await runAction({
    env: process.env,
    async readEventPayload() {
      const eventPath = process.env.GITHUB_EVENT_PATH
      if (!eventPath) {
        throw new Error('GITHUB_EVENT_PATH is not set.')
      }
      const raw = await readFile(eventPath, 'utf8')
      return JSON.parse(raw)
    },
    async writeSummary(markdown) {
      const summaryPath = process.env.GITHUB_STEP_SUMMARY
      if (summaryPath) {
        await appendFile(summaryPath, `${markdown}\n`, 'utf8')
      } else {
        process.stdout.write(`${markdown}\n`)
      }
    },
    async setOutput(name, value) {
      const outputPath = process.env.GITHUB_OUTPUT
      if (outputPath) {
        const clean = String(value).replace(/[\r\n]+/g, ' ')
        await appendFile(outputPath, `${name}=${clean}\n`, 'utf8')
      }
    },
    maskSecret(secret) {
      if (secret) {
        process.stdout.write(`::add-mask::${secret}\n`)
      }
    },
    warn(message) {
      if (message) {
        process.stdout.write(`::warning::${errorText(message)}\n`)
      }
    },
  })

  if (result.exitCode && result.exitCode !== 0) {
    if (result.error) {
      process.stderr.write(`::error::${errorText(result.error)}\n`)
    }
    process.exitCode = result.exitCode
  }
}
