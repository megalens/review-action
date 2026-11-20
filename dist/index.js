import { main } from '../src/index.js'

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`::error::${msg}\n`)
  process.exitCode = 1
})
