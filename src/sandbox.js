import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Review and full mode only. Makes the runner able to start the engine's nested sandbox, then leaves everything else to the
// engine, whose own pre-check refuses at 0 credits if the sandbox still cannot start.
// Every command below has a fixed argv. Nothing from inputs, the event payload or the repository is ever put in one.
// The input `setup-sandbox` decides whether the Action may change the machine:
//   auto  (default) change it only on a GitHub-hosted runner; on a self-hosted runner never call sudo, print the commands instead
//   force change it anywhere (self-hosted opt-in; a ::warning:: says what lasts)
//   off   probe and log only, never sudo

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const SUDO = '/usr/bin/sudo'
const TRUE_BIN = '/usr/bin/true'
const TIMEOUT_BIN = '/usr/bin/timeout'
const APT_GET = '/usr/bin/apt-get'
const SYSCTL = '/usr/sbin/sysctl'
const APPARMOR_PARSER = '/usr/sbin/apparmor_parser'
const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']
const APPARMOR_PROFILES = ['/etc/apparmor.d/bwrap-userns-restrict', '/etc/apparmor.d/unprivileged_userns']

// Same lists as the engine (packages/engine-v2/src/isolation.mjs), so the probe has the same shape as a real engine run.
const SYSTEM_RO = ['/usr', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl', '/etc/ca-certificates', '/etc/ld.so.cache', '/etc/passwd', '/etc/group', '/etc/alternatives', '/etc/localtime']
const MERGED = ['/bin', '/sbin', '/lib', '/lib32', '/lib64']

export const SETUP_MODES = Object.freeze(['auto', 'force', 'off'])
// Node's own bound. Node cannot signal a root child, so every privileged command is also bounded on the root side by
// /usr/bin/timeout inside sudo. The Node bound is always longer than the inner one, so Node never kills apt-get itself.
const QUICK_MS = 30_000
const APT_INNER_S = 300
const APT_NODE_MS = (APT_INNER_S + 30) * 1000
const QUICK_INNER_S = 20

/** Runs one fixed command. `cwd` is a scratch directory, never the checkout. Returns the exit status (null on spawn failure or kill). */
export function defaultRun(bin, args, env, opts = {}, spawn = spawnSync) {
  return spawn(bin, args, { stdio: 'ignore', env, timeout: opts.timeoutMs ?? QUICK_MS, cwd: opts.cwd ?? '/' }).status
}

const aptArgs = (...rest) => ['-n', TIMEOUT_BIN, '-k', '10', String(APT_INNER_S), APT_GET, '-o', 'DPkg::Lock::Timeout=60', '-o', 'Acquire::Retries=2', ...rest]
const quickArgs = (...rest) => ['-n', TIMEOUT_BIN, '-k', '5', String(QUICK_INNER_S), ...rest]

/**
 * The outer bwrap argv built the way the engine builds it for its probe (network none, codexBin "bwrap").
 * Known differences from the engine, both on purpose and both fail safe (the engine pre-check has the last word):
 * the Action runs an absolute bwrap with a fixed system PATH (so no extra read-only binds for runner PATH entries),
 * and it does not run the engine's separate bwrapWorks / refuse-root checks.
 */
export function buildProbeArgs(dir, pathVar, fsDeps = {}) {
  const exists = fsDeps.exists ?? existsSync
  const lstat = fsDeps.lstat ?? lstatSync
  const readlink = fsDeps.readlink ?? readlinkSync
  const realpath = fsDeps.realpath ?? realpathSync
  const a = ['--die-with-parent', '--new-session', '--unshare-all', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']
  const bound = new Set()
  const ro = (p) => { if (p && exists(p) && !bound.has(p)) { bound.add(p); a.push('--ro-bind', p, p) } }
  for (const p of SYSTEM_RO) ro(p)
  for (const p of MERGED) {
    if (!exists(p)) continue
    let st
    try { st = lstat(p) } catch { continue }
    if (st.isSymbolicLink()) a.push('--symlink', readlink(p), p)
    else ro(p)
  }
  const roots = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64']
  const under = (p) => roots.some((r) => p === r || p.startsWith(`${r}/`))
  const extra = new Set()
  for (const d of String(pathVar ?? '').split(':').filter(Boolean)) {
    try { const rp = realpath(d); if (!under(rp)) extra.add(rp) } catch { /* not there */ }
  }
  for (const p of extra) ro(p)
  a.push('--ro-bind', dir, dir, '--bind', dir, dir, '--bind', dir, dir, '--chdir', dir)
  return a
}

/**
 * The engine's own nested check, replicated (megalens-review has no probe command): the outer bwrap built as the engine builds it,
 * then `bwrap --unshare-user --ro-bind / / -- true` inside. True when the nested sandbox starts.
 */
export function nestedSandboxWorks(bwrapBin, deps = {}) {
  const run = deps.run ?? ((b, a, e) => defaultRun(b, a, e, { cwd: deps.cwd }))
  const mk = deps.mkdtemp ?? ((p) => mkdtempSync(p))
  const rm = deps.rmdir ?? ((p) => rmSync(p, { recursive: true, force: true }))
  const pathVar = deps.pathVar ?? SAFE_PATH
  const dir = mk(join(deps.tmp ?? tmpdir(), 'mlr-preflight-'))
  try {
    const args = [...buildProbeArgs(dir, pathVar, deps), '--', 'bwrap', '--unshare-user', '--ro-bind', '/', '/', '--', 'true']
    return run(bwrapBin, args, { PATH: pathVar }) === 0
  } catch {
    return false
  } finally {
    try { rm(dir) } catch { /* ignore */ }
  }
}

const ADMIN_COMMANDS = 'sudo apt-get install -y bubblewrap; sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0; sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict (and /etc/apparmor.d/unprivileged_userns if that file exists)'

/**
 * @param {{ log?: (line: string) => void, warn?: (line: string) => void, mode?: string, hosted?: boolean }} [opts]
 *   mode: auto | force | off (default auto). hosted: true only when RUNNER_ENVIRONMENT is exactly github-hosted.
 * @param {{ run?: Function, exists?: Function, platform?: string, probe?: Function, mkdtemp?: Function, rmdir?: Function }} [deps] injectable for tests
 * @returns {{ ok: boolean, step: string }} never throws
 */
export function prepareSandbox(opts = {}, deps = {}) {
  const log = opts.log ?? ((line) => process.stdout.write(`${line}\n`))
  const warn = opts.warn ?? ((line) => process.stdout.write(`::warning::${line}\n`))
  const mode = SETUP_MODES.includes(opts.mode) ? opts.mode : 'auto'
  const hosted = opts.hosted === true
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform
  if (platform !== 'linux') return { ok: false, step: 'not-linux' }

  // May this Action change the machine? Never on `off`; on `auto` only on a GitHub-hosted runner; always on `force`.
  const mayChange = mode === 'force' || (mode === 'auto' && hosted)
  const selfHostedChange = mayChange && !hosted

  const mk = deps.mkdtemp ?? ((p) => mkdtempSync(p))
  const rm = deps.rmdir ?? ((p) => rmSync(p, { recursive: true, force: true }))
  let scratch = '/'
  try { scratch = mk(join(deps.tmp ?? tmpdir(), 'mlr-setup-')) } catch { /* fall back to / */ }
  try {
    return runSteps({ log, warn, mode, mayChange, selfHostedChange, exists, deps, scratch })
  } catch {
    return { ok: false, step: 'error' }
  } finally {
    if (scratch !== '/') { try { rm(scratch) } catch { /* ignore */ } }
  }
}

function runSteps({ log, warn, mode, mayChange, selfHostedChange, exists, deps, scratch }) {
  const run = deps.run ?? ((bin, args, env, o) => defaultRun(bin, args, env, { cwd: scratch, ...o }))
  const envFor = (extra = {}) => ({ PATH: SAFE_PATH, ...extra })
  const findBwrap = () => BWRAP_CANDIDATES.find((p) => exists(p)) ?? null
  const sudoWorks = () => { try { return run(SUDO, ['-n', TRUE_BIN], envFor()) === 0 } catch { return false } }
  const attempt = (args, extra, timeoutMs) => { try { run(SUDO, args, envFor(extra), { timeoutMs }) } catch { /* each step is best effort */ } }
  const probe = (bwrap) => {
    try { return deps.probe ? Boolean(deps.probe(bwrap)) : nestedSandboxWorks(bwrap, { ...deps, cwd: scratch }) } catch { return false }
  }

  let canSudo = null
  const hasSudo = () => (canSudo === null ? (canSudo = sudoWorks()) : canSudo)

  // Why nothing is changed, said truthfully for each setting.
  const notAllowed = (what) => {
    if (mode === 'off') log(`MegaLens: ${what} The Action's setup-sandbox setting is "off", so it changes nothing. The engine will stop the review at 0 credits. On the runner: ${ADMIN_COMMANDS}.`)
    else log(`MegaLens: ${what} This is a self-hosted runner, so the Action changes nothing (setup-sandbox: auto). The engine will stop the review at 0 credits. An admin can run on the runner: ${ADMIN_COMMANDS}. Or set setup-sandbox: force to let the Action do it (the kernel and AppArmor change lasts until the runner is rebooted).`)
  }

  let bwrap = findBwrap()
  if (!bwrap) {
    if (!mayChange) {
      notAllowed('bubblewrap (bwrap) is not installed.')
      return { ok: false, step: 'no-bwrap-not-allowed' }
    }
    if (!hasSudo()) {
      log('MegaLens: bubblewrap (bwrap) is not installed and this runner has no passwordless sudo. Install bubblewrap on the runner; the engine will stop the review at 0 credits otherwise.')
      return { ok: false, step: 'no-bwrap-no-sudo' }
    }
    if (selfHostedChange) warn('MegaLens setup-sandbox: force is installing the bubblewrap package on this self-hosted runner. It stays installed after this job.')
    log('MegaLens: installing bubblewrap (bwrap) for the engine sandbox.')
    attempt(aptArgs('update'), { DEBIAN_FRONTEND: 'noninteractive' }, APT_NODE_MS)
    attempt(aptArgs('install', '-y', 'bubblewrap'), { DEBIAN_FRONTEND: 'noninteractive' }, APT_NODE_MS)
    bwrap = findBwrap()
    if (!bwrap) {
      log('MegaLens: bubblewrap could not be installed. The engine will stop the review at 0 credits.')
      return { ok: false, step: 'install-failed' }
    }
  }

  if (probe(bwrap)) {
    log('MegaLens: the nested sandbox works on this runner.')
    return { ok: true, step: 'works' }
  }

  if (!mayChange) {
    notAllowed('the nested sandbox is blocked on this runner.')
    return { ok: false, step: 'blocked-not-allowed' }
  }
  if (!hasSudo()) {
    log('MegaLens: the nested sandbox is blocked on this runner and there is no passwordless sudo to change it. The engine will stop the review at 0 credits.')
    return { ok: false, step: 'blocked-no-sudo' }
  }

  if (selfHostedChange) warn('MegaLens setup-sandbox: force is relaxing the AppArmor user namespace restriction on this self-hosted runner. The change applies to the whole machine, not only this job, and lasts until the runner is rebooted (or AppArmor is reloaded).')
  log('MegaLens: the runner blocks the nested sandbox (Ubuntu AppArmor). Relaxing the user namespace restriction on this runner.')
  attempt(quickArgs(SYSCTL, '-w', 'kernel.apparmor_restrict_unprivileged_userns=0'), {}, QUICK_MS)
  if (probe(bwrap)) {
    log('MegaLens: the nested sandbox works now.')
    return { ok: true, step: 'fixed' }
  }
  // Only if the sysctl alone did not fix it: unload the two profiles that exist.
  for (const p of APPARMOR_PROFILES) {
    if (exists(p)) attempt(quickArgs(APPARMOR_PARSER, '-R', p), {}, QUICK_MS)
  }
  if (probe(bwrap)) {
    log('MegaLens: the nested sandbox works now.')
    return { ok: true, step: 'fixed' }
  }
  log('MegaLens: the nested sandbox is still blocked. The engine will stop the review at 0 credits.')
  return { ok: false, step: 'still-blocked' }
}
