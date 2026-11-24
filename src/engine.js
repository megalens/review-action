import { execFile } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { redactSecrets } from './redact.js'

const SAFE_VERSION_RE = /^[A-Za-z0-9._-]+$/
const ALLOWED_CHILD_ENV_KEYS = ['PATH', 'HOME', 'RUNNER_TEMP', 'TMPDIR']

export const ENGINE_PACKAGE_NAME = 'megalens-review'

export const BYO_KEY_ENABLED = false
export const BYO_DISABLED_MESSAGE = 'BYO OpenAI key mode is not available yet; use megalens-token.'

export const DOUBLE_TIER_ENABLED = false
export const DOUBLE_DISABLED_MESSAGE = 'The Double tier is not available yet; use standard or deep.'

export const PINNED_ENGINE_VERSION = '0.1.8'
// dist.integrity of megalens-review@0.1.0 as published on npm (21 Nov 2026). A tarball that does not match is refused.
export const PINNED_ENGINE_INTEGRITY = Object.freeze({
  '0.1.0': 'sha512-u96ufJHpgP/AYbaA3pgMtS/q+WAvTJ0wCK+GZ5CvTHDUa+WFyEyVnGeYm82VJ5lv+jTSt2etW08280OXFOhQHg==',
  // 0.1.1: nested-sandbox preflight (a blocked runner stops before any model call, 0 credits). Found in the production E2E.
  '0.1.1': 'sha512-NaUeFRTjxSnrcPQQ2ePwMD0IzrvO3x1N7nBc57638u3g4oo4DMQbCRg0ZI/GylDxt5HhCXtBDiiPbg0NfjO5Jw==',
  '0.1.2': 'sha512-zC5W3zmErpSU9GXNngUSGp77fVaqDh4hQDZgPAcxnt7v/37osclGQz8/ApR0ROBu6clN19xRDnCZd2GTDivQ0g==',
  '0.1.3': 'sha512-bgdgfD/atIa8A19BoAxL1UtzHCm2+oDHhrGhgywxjwguBDgACOEzyoBGDR8euyh1VqO4UjrkYtEMAUPvsqBhFw==',
  '0.1.5': 'sha512-Yvx6D6UzmfspHm4mGKpueFhu/G5bmSnLRG9NgnJHnZvlfF0yd0evwUmqIcQaPD3IKHRmVWXKU6qVPRWMOOJ67w==',
  // 0.1.8: follow-up review mode, PR chat answer polish, suggested-fix writer, GitLab token redaction (published 24 Nov 2026).
  '0.1.8': 'sha512-yvlqmemmvFZyr6aE9EwXojLFwiMJq1dVkkIAYL4TS0YIj5Imqpns7EyrswzCt/0szLbE4pvM0NFoUyziL0eLBg==',
})

/**
 * Determine the engine auth mode and environment variables (never passed via CLI flags).
 * Supports review-key (MEGALENS_REVIEW_ID + MEGALENS_REVIEW_KEY), gateway (MEGALENS_TOKEN),
 * or byo-key (OPENAI_API_KEY + MEGALENS_BYO=1) when BYO key mode is enabled.
 * @param {{ megalensToken?: string, openaiApiKey?: string, reviewId?: string, reviewKey?: string }} creds
 * @param {{ byoKeyEnabled?: boolean }} [opts]
 * @returns {{ mode: 'review-key' | 'gateway' | 'byo-key', env: Record<string, string> } | null}
 */
export function resolveAuthEnv({ megalensToken, openaiApiKey, reviewId, reviewKey }, opts = {}) {
  const byoKeyEnabled = typeof opts?.byoKeyEnabled === 'boolean' ? opts.byoKeyEnabled : BYO_KEY_ENABLED
  const rId = typeof reviewId === 'string' ? reviewId.trim() : ''
  const rKey = typeof reviewKey === 'string' ? reviewKey.trim() : ''
  if (rId && rKey) {
    return {
      mode: 'review-key',
      env: { MEGALENS_REVIEW_ID: rId, MEGALENS_REVIEW_KEY: rKey },
    }
  }
  const ml = typeof megalensToken === 'string' ? megalensToken.trim() : ''
  const oai = typeof openaiApiKey === 'string' ? openaiApiKey.trim() : ''
  if (ml) {
    return { mode: 'gateway', env: { MEGALENS_TOKEN: ml } }
  }
  if (oai && byoKeyEnabled) {
    return { mode: 'byo-key', env: { OPENAI_API_KEY: oai, MEGALENS_BYO: '1' } }
  }
  return null
}

/**
 * Build a minimal allowlisted environment for child processes.
 * Prevents leaking INPUT_*, ACTIONS_RUNTIME_TOKEN, GITHUB_TOKEN, or unrelated secrets.
 * @param {Record<string, string | undefined>} baseEnv
 * @param {'review-key' | 'gateway' | 'byo-key' | null | undefined} authMode
 * @param {Record<string, string> | null | undefined} authEnv
 * @param {{ byoKeyEnabled?: boolean }} [opts]
 * @returns {Record<string, string>}
 */
export function buildChildEnv(baseEnv = {}, authMode = null, authEnv = null, opts = {}) {
  const byoKeyEnabled = typeof opts?.byoKeyEnabled === 'boolean' ? opts.byoKeyEnabled : BYO_KEY_ENABLED
  /** @type {Record<string, string>} */
  const clean = {}
  for (const key of ALLOWED_CHILD_ENV_KEYS) {
    const val = baseEnv?.[key]
    if (typeof val === 'string' && val.length > 0) {
      clean[key] = val
    }
  }
  if (
    authMode === 'review-key'
    && typeof authEnv?.MEGALENS_REVIEW_ID === 'string'
    && authEnv.MEGALENS_REVIEW_ID
    && typeof authEnv?.MEGALENS_REVIEW_KEY === 'string'
    && authEnv.MEGALENS_REVIEW_KEY
  ) {
    clean.MEGALENS_REVIEW_ID = authEnv.MEGALENS_REVIEW_ID
    clean.MEGALENS_REVIEW_KEY = authEnv.MEGALENS_REVIEW_KEY
  } else if (authMode === 'gateway' && typeof authEnv?.MEGALENS_TOKEN === 'string' && authEnv.MEGALENS_TOKEN) {
    clean.MEGALENS_TOKEN = authEnv.MEGALENS_TOKEN
  } else if (
    byoKeyEnabled
    && authMode === 'byo-key'
    && typeof authEnv?.OPENAI_API_KEY === 'string'
    && authEnv.OPENAI_API_KEY
  ) {
    clean.OPENAI_API_KEY = authEnv.OPENAI_API_KEY
    clean.MEGALENS_BYO = '1'
  }
  return clean
}

/**
 * Compute SRI sha512 string for a buffer.
 * @param {Buffer | Uint8Array} bytes
 * @returns {string}
 */
export function computeSha512Integrity(bytes) {
  const digest = createHash('sha512').update(bytes).digest('base64')
  return `sha512-${digest}`
}

/**
 * Verify downloaded package tarball bytes against a pinned sha512 SRI integrity string.
 * @param {Buffer | Uint8Array} bytes
 * @param {string} expectedIntegrity
 */
export function verifyTarballIntegrity(bytes, expectedIntegrity) {
  if (typeof expectedIntegrity !== 'string' || !expectedIntegrity.startsWith('sha512-')) {
    throw new Error(`Missing or invalid pinned sha512 integrity constant for ${ENGINE_PACKAGE_NAME}.`)
  }
  const actual = computeSha512Integrity(bytes)
  const aBuf = Buffer.from(actual, 'utf8')
  const bBuf = Buffer.from(expectedIntegrity, 'utf8')
  if (aBuf.length !== bBuf.length || !timingSafeEqual(aBuf, bBuf)) {
    throw new Error(
      `Integrity verification failed for ${ENGINE_PACKAGE_NAME} tarball (expected ${expectedIntegrity}, got ${actual}).`,
    )
  }
}

/**
 * Build the CLI command and args to run megalens-review.
 * The caller runs the binary with cwd set to the repository directory (opts.repoPath);
 * megalens-review run reads the repo from process.cwd() and has no --repo flag.
 * @param {{
 *   tier: string,
 *   baseSha: string,
 *   headSha: string,
 *   outPath: string,
 *   timeoutMinutes: number,
 *   cliBin: string,
 * }} opts
 * @returns {{ command: string, args: string[] }}
 */
export function buildCliInvocation(opts) {
  if (!opts.cliBin || typeof opts.cliBin !== 'string') {
    throw new Error('cliBin is required to invoke megalens-review.')
  }
  const cliArgs = [
    'run',
    '--tier',
    opts.tier,
    '--target',
    'range',
    '--base',
    opts.baseSha,
    '--head',
    opts.headSha,
    '--out',
    opts.outPath,
    '--timeout-min',
    String(opts.timeoutMinutes),
  ]
  return { command: opts.cliBin, args: cliArgs }
}

function defaultExecFile(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      const exitCode = error && typeof error.code === 'number'
        ? error.code
        : error
          ? 4
          : 0
      resolve({
        exitCode,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        errorMessage: error ? error.message : null,
      })
    })
  })
}

/**
 * Install the pinned megalens-review package into an isolated empty directory under RUNNER_TEMP:
 * - own --prefix
 * - own --userconfig pointing at an empty file (ignores PR .npmrc)
 * - --ignore-scripts
 * - sha512 tarball integrity verification against the pinned constant
 */
export async function installPinnedEngine(opts, deps = {}) {
  const execFn = deps.execFileImpl ?? defaultExecFile
  const mkdtempFn = deps.mkdtempImpl ?? mkdtemp
  const writeFileFn = deps.writeFileImpl ?? writeFile
  const readFileFn = deps.readFileImpl ?? readFile

  const version = String(opts.version || PINNED_ENGINE_VERSION).trim()
  if (!SAFE_VERSION_RE.test(version)) {
    throw new Error(`Invalid engine-version: ${version}`)
  }

  const expectedIntegrity = opts.expectedIntegrity ?? PINNED_ENGINE_INTEGRITY[version]
  if (!expectedIntegrity) {
    throw new Error(`Unpinned engine-version "${version}": no pinned sha512 integrity constant configured.`)
  }

  const installDir = await mkdtempFn(join(opts.runnerTemp, 'megalens-engine-'))
  const userConfigPath = join(installDir, '.npmrc')
  await writeFileFn(userConfigPath, '', 'utf8')

  const npmEnv = buildChildEnv(opts.baseEnv, null, null)
  const packRes = await execFn(
    'npm',
    [
      'pack',
      '--silent',
      '--userconfig',
      userConfigPath,
      '--ignore-scripts',
      '--pack-destination',
      installDir,
      `${ENGINE_PACKAGE_NAME}@${version}`,
    ],
    {
      cwd: installDir,
      env: npmEnv,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  if (packRes.exitCode !== 0) {
    throw new Error(
      `Failed to fetch ${ENGINE_PACKAGE_NAME}@${version}: ${redactSecrets(packRes.stderr || packRes.errorMessage || `exit ${packRes.exitCode}`)}`,
    )
  }

  const rawLine = packRes.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || ''
  const tarballName = basename(rawLine)
  if (!tarballName || tarballName !== rawLine || tarballName.includes('..') || !tarballName.endsWith('.tgz')) {
    throw new Error(`Unexpected npm pack output for ${ENGINE_PACKAGE_NAME}@${version}: "${rawLine}"`)
  }
  const tarballPath = join(installDir, tarballName)
  const tarballBytes = await readFileFn(tarballPath)
  verifyTarballIntegrity(tarballBytes, expectedIntegrity)

  const installRes = await execFn(
    'npm',
    [
      'install',
      '--prefix',
      installDir,
      '--userconfig',
      userConfigPath,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-save',
      '--package-lock=false',
      tarballPath,
    ],
    {
      cwd: installDir,
      env: npmEnv,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  if (installRes.exitCode !== 0) {
    throw new Error(
      `Failed to install ${ENGINE_PACKAGE_NAME}@${version}: ${redactSecrets(installRes.stderr || installRes.errorMessage || `exit ${installRes.exitCode}`)}`,
    )
  }

  const binPath = join(installDir, 'node_modules', '.bin', 'megalens-review')
  if (!isAbsolute(binPath)) {
    throw new Error(`Resolved engine binary path is not absolute: ${binPath}`)
  }

  return { installDir, binPath, userConfigPath }
}

/**
 * Run the MegaLens engine CLI with cwd set to the PR repository directory and an allowlisted env.
 * Installs the pinned codex-cli via `<bin> install` in the isolated install dir before running.
 * Exit codes from ENGINE-V2-CONTRACT.md:
 *   0 = complete, 2 = partial, 3 = gateway refused, 4 = local error.
 */
export async function runEngineCli(opts, deps = {}) {
  const byoKeyEnabled = typeof deps.byoKeyEnabled === 'boolean' ? deps.byoKeyEnabled : BYO_KEY_ENABLED
  const doubleTierEnabled = typeof deps.doubleTierEnabled === 'boolean' ? deps.doubleTierEnabled : DOUBLE_TIER_ENABLED
  if (opts.tier === 'double' && !doubleTierEnabled) {
    throw new Error(DOUBLE_DISABLED_MESSAGE)
  }
  if (opts.authMode === 'byo-key' && !byoKeyEnabled) {
    throw new Error(BYO_DISABLED_MESSAGE)
  }
  if (opts.isFork && opts.authMode === 'byo-key') {
    throw new Error('BYO key is not used on fork PRs; use a MegaLens token.')
  }

  const execFn = deps.execFileImpl ?? defaultExecFile
  const readFileFn = deps.readFileImpl ?? ((p) => readFile(p, 'utf8'))
  const rmFn = deps.rmImpl ?? rm
  const statFn = deps.statImpl ?? stat
  const baseEnv = deps.baseEnv ?? process.env
  const runnerTemp = opts.runnerTemp || baseEnv.RUNNER_TEMP || tmpdir()
  const secretValues = [
    opts.authEnv?.MEGALENS_REVIEW_KEY,
    opts.authEnv?.MEGALENS_TOKEN,
    opts.authEnv?.OPENAI_API_KEY,
    baseEnv.MEGALENS_REVIEW_KEY,
    baseEnv.MEGALENS_TOKEN,
    baseEnv.OPENAI_API_KEY,
  ].filter(Boolean)

  let createdInstallDir = null
  let binPath = opts.cliBin || null
  let installCwd = opts.installDir || runnerTemp
  const repoCwd = opts.repoPath || baseEnv.GITHUB_WORKSPACE || process.cwd()

  try {
    if (!binPath) {
      const installed = await installPinnedEngine(
        {
          version: opts.engineVersion || PINNED_ENGINE_VERSION,
          expectedIntegrity: opts.engineIntegrity,
          runnerTemp,
          baseEnv,
        },
        deps,
      )
      createdInstallDir = installed.installDir
      binPath = installed.binPath
      installCwd = installed.installDir
    }

    if (!isAbsolute(binPath)) {
      throw new Error(`Engine binary must be an absolute path: ${binPath}`)
    }

    if (!opts.cliBin || opts.installCodex === true) {
      const installEnv = buildChildEnv(baseEnv, null, null)
      const codexInstallRes = await execFn(binPath, ['install'], {
        cwd: installCwd,
        env: installEnv,
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      if (codexInstallRes.exitCode !== 0) {
        const detail = redactSecrets(
          codexInstallRes.stderr || codexInstallRes.errorMessage || `exit ${codexInstallRes.exitCode}`,
          secretValues,
        )
        throw new Error(`Failed to install pinned codex-cli via ${basename(binPath)} install: ${detail}`)
      }
    }

    const { command, args } = buildCliInvocation({
      ...opts,
      cliBin: binPath,
    })

    const childEnv = buildChildEnv(baseEnv, opts.authMode, opts.authEnv, { byoKeyEnabled })
    const timeoutMs = Math.max(1, Number(opts.timeoutMinutes) || 25) * 60_000 + 30_000

    // Fresh output file for every invocation: a leftover document must never be read as this run's result.
    // If the old file cannot be removed (or is still there), use a unique path for this run instead.
    let runOutPath = opts.outPath
    let removed = true
    try { await rmFn(opts.outPath, { force: true }) } catch { removed = false }
    if (removed) {
      try { await statFn(opts.outPath); removed = false } catch { /* gone: good */ }
    }
    if (!removed) {
      runOutPath = `${opts.outPath}.run-${randomBytes(8).toString('hex')}`
    }
    const runArgs = runOutPath === opts.outPath ? args : args.map((a) => (a === opts.outPath ? runOutPath : a))

    const result = await execFn(command, runArgs, {
      cwd: repoCwd,
      env: childEnv,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    })

    let rawFindings = null
    try {
      rawFindings = await readFileFn(runOutPath)
    } catch {
      rawFindings = null
    }

    return {
      exitCode: result.exitCode,
      stdout: redactSecrets(result.stdout, secretValues),
      stderr: redactSecrets(result.stderr, secretValues),
      errorMessage: result.errorMessage ? redactSecrets(result.errorMessage, secretValues) : null,
      rawFindings,
      outPath: runOutPath,
    }
  } finally {
    if (createdInstallDir) {
      await rmFn(createdInstallDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
