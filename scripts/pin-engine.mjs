#!/usr/bin/env node
// Usage: node scripts/pin-engine.mjs <version> <sha512-integrity>
// Updates the engine pin in one go: PINNED_ENGINE_VERSION and the integrity table in src/engine.js,
// and the version named in README.md. action.yml needs no change (its default is empty).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [version, integrity] = process.argv.slice(2)
if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !integrity || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
  console.error('Usage: node scripts/pin-engine.mjs <version e.g. 0.1.2> <sha512-...== (npm dist.integrity)>')
  process.exit(2)
}

const enginePath = join(root, 'src', 'engine.js')
let src = readFileSync(enginePath, 'utf8')
if (!/export const PINNED_ENGINE_VERSION = '[^']+'/.test(src)) {
  console.error('PINNED_ENGINE_VERSION not found in src/engine.js')
  process.exit(1)
}
src = src.replace(/(export const PINNED_ENGINE_VERSION = ')[^']+(')/, `$1${version}$2`)
const entry = new RegExp(`(\\n\\s*'${version.replace(/\./g, '\\.')}': )'[^']*'`)
if (entry.test(src)) {
  src = src.replace(entry, `$1'${integrity}'`)
} else {
  src = src.replace(/(PINNED_ENGINE_INTEGRITY = Object\.freeze\(\{[^}]*?)(\n\}\))/s, `$1\n  '${version}': '${integrity}',$2`)
  if (!src.includes(`'${version}': '${integrity}'`)) {
    console.error('Could not add the integrity entry in src/engine.js')
    process.exit(1)
  }
}
writeFileSync(enginePath, src)

const readmePath = join(root, 'README.md')
const readme = readFileSync(readmePath, 'utf8')
writeFileSync(readmePath, readme.replace(/(\(`PINNED_ENGINE_VERSION`, now )\d+\.\d+\.\d+(\))/, `$1${version}$2`))

console.log(`Pinned megalens-review ${version}. Run: npm test`)
