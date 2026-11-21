import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Review mode only. Makes the runner able to start the engine's nested sandbox, then leaves everything else to the engine,
// whose own pre-check refuses at 0 credits if the sandbox still cannot start.
// Every command below has a fixed argv. Nothing from inputs, the event payload or the repository is ever put in one.

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const SUDO = '/usr/bin/sudo'
const APT_GET = '/usr/bin/apt-get'
const SYSCTL = '/usr/sbin/sysctl'
const APPARMOR_PARSER = '/usr/sbin/apparmor_parser'
const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']
const APPARMOR_PROFILES = ['/etc/apparmor.d/bwrap-userns-restrict', '/etc/apparmor.d/unprivileged_userns']

// Same lists as the engine (packages/engine-v2/src/isolation.mjs), so the probe has the same shape as a real engine run.
const SYSTEM_RO = ['/usr', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl', '/etc/ca-certificates', '/etc/ld.so.cache', '/etc/passwd', '/etc/group', '/etc/alternatives', '/etc/localtime']
const MERGED = ['/bin', '/sbin', '/lib', '/lib32', '/lib64']

function defaultRun(bin, args, env) {
  return spawnSync(bin, args, { stdio: 'ignore', env, timeout: 30_000 }).status
}

/** The outer bwrap argv exactly as the engine builds it for the probe (network none, codexBin "bwrap"). */
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
 * The engine's own nested check, replicated (megalens-review has no probe command): the outer bwrap as the engine builds it,
 * then `bwrap --unshare-user --ro-bind / / -- true` inside. True when the nested sandbox starts.
 */
export function nestedSandboxWorks(bwrapBin, deps = {}) {
  const run = deps.run ?? defaultRun
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

/**
 * @param {{ log?: (line: string) => void }} [opts]
 * @param {{ run?: Function, exists?: Function, platform?: string, probe?: Function }} [deps] injectable for tests
 * @returns {{ ok: boolean, step: string }} never throws
 */
export function prepareSandbox(opts = {}, deps = {}) {
  const log = opts.log ?? ((line) => process.stdout.write(`${line}\n`))
  const run = deps.run ?? defaultRun
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform
  if (platform !== 'linux') return { ok: false, step: 'not-linux' }

  const envFor = (extra = {}) => ({ PATH: SAFE_PATH, ...extra })
  const findBwrap = () => BWRAP_CANDIDATES.find((p) => exists(p)) ?? null
  const sudoWorks = () => { try { return run(SUDO, ['-n', 'true'], envFor()) === 0 } catch { return false } }
  const attempt = (bin, args, extra) => { try { run(bin, args, envFor(extra)) } catch { /* each step is best effort */ } }
  const probe = (bwrap) => {
    try { return deps.probe ? Boolean(deps.probe(bwrap)) : nestedSandboxWorks(bwrap, deps) } catch { return false }
  }

  let canSudo = null
  const hasSudo = () => (canSudo === null ? (canSudo = sudoWorks()) : canSudo)

  let bwrap = findBwrap()
  if (!bwrap) {
    if (!hasSudo()) {
      log('MegaLens: bubblewrap (bwrap) is not installed and this runner has no passwordless sudo. Install bubblewrap on the runner; the engine will stop the review at 0 credits otherwise.')
      return { ok: false, step: 'no-bwrap-no-sudo' }
    }
    log('MegaLens: installing bubblewrap (bwrap) for the engine sandbox.')
    attempt(SUDO, ['-n', APT_GET, 'update'], { DEBIAN_FRONTEND: 'noninteractive' })
    attempt(SUDO, ['-n', APT_GET, 'install', '-y', 'bubblewrap'], { DEBIAN_FRONTEND: 'noninteractive' })
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

  if (!hasSudo()) {
    log('MegaLens: the nested sandbox is blocked on this runner and there is no passwordless sudo to change it. The engine will stop the review at 0 credits.')
    return { ok: false, step: 'blocked-no-sudo' }
  }

  log('MegaLens: the runner blocks the nested sandbox (Ubuntu AppArmor). Relaxing the user namespace restriction for this job.')
  attempt(SUDO, ['-n', SYSCTL, '-w', 'kernel.apparmor_restrict_unprivileged_userns=0'])
  for (const p of APPARMOR_PROFILES) {
    if (exists(p)) attempt(SUDO, ['-n', APPARMOR_PARSER, '-R', p])
  }
  if (probe(bwrap)) {
    log('MegaLens: the nested sandbox works now.')
    return { ok: true, step: 'fixed' }
  }
  log('MegaLens: the nested sandbox is still blocked. The engine will stop the review at 0 credits.')
  return { ok: false, step: 'still-blocked' }
}
