import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildProbeArgs, nestedSandboxWorks, prepareSandbox } from '../src/sandbox.js'
import { runAction } from '../src/action.js'

// A fake machine: tracks installed bwrap, sudo, and whether the nested probe passes (flipped by the sysctl or apparmor line).
function machine({ bwrap = true, sudo = true, probeOk = false, fixBy = 'sysctl', aptInstallsBwrap = true, profiles = [] } = {}) {
  const m = { calls: [], logs: [], bwrap, probeOk }
  m.exists = (p) => (p.endsWith('/bwrap') ? (p === '/usr/bin/bwrap' && m.bwrap) : profiles.includes(p))
  m.run = (bin, args, env) => {
    m.calls.push({ bin, args, env })
    if (bin === '/usr/bin/sudo' && args[0] === '-n' && args[1] === 'true') return sudo ? 0 : 1
    if (args.includes('/usr/bin/apt-get') && args.includes('install')) { if (aptInstallsBwrap) m.bwrap = true; return 0 }
    if (args.includes('/usr/sbin/sysctl')) { if (fixBy === 'sysctl') m.probeOk = true; return 0 }
    if (args.includes('/usr/sbin/apparmor_parser')) { if (fixBy === 'apparmor') m.probeOk = true; return 0 }
    return 0
  }
  m.probe = () => m.probeOk
  m.log = (l) => m.logs.push(l)
  m.go = () => prepareSandbox({ log: m.log }, { run: m.run, exists: m.exists, probe: m.probe, platform: 'linux' })
  m.names = () => m.calls.map((c) => c.args.filter((a) => a !== '-n').join(' ') || c.bin)
  return m
}

describe('prepareSandbox', () => {
  it('bwrap present and probe passes: no sudo, no changes', () => {
    const m = machine({ probeOk: true })
    assert.deepEqual(m.go(), { ok: true, step: 'works' })
    assert.equal(m.calls.length, 0)
    assert.equal(m.logs.length, 1)
  })

  it('old workflow step already ran (bwrap present, probe passes): same, nothing touched', () => {
    const m = machine({ probeOk: true, sudo: true })
    assert.equal(m.go().step, 'works')
    assert.equal(m.calls.length, 0)
  })

  it('bwrap missing with sudo: apt-get update then install, then probe passes', () => {
    const m = machine({ bwrap: false, probeOk: true })
    // probe passes once installed
    assert.deepEqual(m.go(), { ok: true, step: 'works' })
    assert.deepEqual(m.names(), ['true', '/usr/bin/apt-get update', '/usr/bin/apt-get install -y bubblewrap'])
    assert.equal(m.calls[1].env.DEBIAN_FRONTEND, 'noninteractive')
  })

  it('bwrap missing without sudo: does nothing, one plain line', () => {
    const m = machine({ bwrap: false, sudo: false })
    assert.deepEqual(m.go(), { ok: false, step: 'no-bwrap-no-sudo' })
    assert.equal(m.calls.length, 1) // only the sudo -n true check
    assert.equal(m.logs.length, 1)
  })

  it('bwrap missing, sudo works, install does not produce bwrap: stops', () => {
    const m = machine({ bwrap: false, aptInstallsBwrap: false })
    assert.equal(m.go().step, 'install-failed')
  })

  it('probe fails then sysctl fixes it', () => {
    const m = machine({ probeOk: false, fixBy: 'sysctl', profiles: ['/etc/apparmor.d/bwrap-userns-restrict'] })
    assert.deepEqual(m.go(), { ok: true, step: 'fixed' })
    const n = m.names()
    assert.ok(n.includes('/usr/sbin/sysctl -w kernel.apparmor_restrict_unprivileged_userns=0'))
    assert.ok(n.includes('/usr/sbin/apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict'))
    assert.ok(!n.some((x) => x.includes('unprivileged_userns') && x.includes('apparmor_parser')), 'absent profile is skipped')
  })

  it('probe fails then apparmor_parser -R fixes it', () => {
    const m = machine({ probeOk: false, fixBy: 'apparmor', profiles: ['/etc/apparmor.d/unprivileged_userns'] })
    assert.equal(m.go().step, 'fixed')
  })

  it('probe fails and no sudo: nothing changed', () => {
    const m = machine({ probeOk: false, sudo: false })
    assert.deepEqual(m.go(), { ok: false, step: 'blocked-no-sudo' })
    assert.equal(m.calls.length, 1)
  })

  it('probe fails, fix attempts do not help: reports still blocked, never throws', () => {
    const m = machine({ probeOk: false, fixBy: 'none' })
    assert.deepEqual(m.go(), { ok: false, step: 'still-blocked' })
  })

  it('a throwing runner never throws out of prepareSandbox', () => {
    const r = prepareSandbox({ log() {} }, { run() { throw new Error('boom') }, exists: () => false, platform: 'linux' })
    assert.equal(r.ok, false)
  })

  it('commands never get user input: fixed absolute argv, minimal env, nothing from process.env', () => {
    process.env.INPUT_MODE = 'review; touch /tmp/pwned'
    process.env['INPUT_MEGALENS-TOKEN'] = 'ml_tok_secret_value'
    const m = machine({ bwrap: false, probeOk: false, fixBy: 'sysctl', profiles: ['/etc/apparmor.d/bwrap-userns-restrict'] })
    m.go()
    for (const c of m.calls) {
      assert.ok(c.bin.startsWith('/usr/bin/'), c.bin)
      assert.deepEqual(Object.keys(c.env).filter((k) => k !== 'PATH' && k !== 'DEBIAN_FRONTEND'), [])
      const joined = JSON.stringify(c)
      assert.ok(!joined.includes('pwned') && !joined.includes('secret_value'))
      assert.ok(!c.args.some((a) => /[;&|$`]/.test(a)))
    }
    delete process.env.INPUT_MODE
    delete process.env['INPUT_MEGALENS-TOKEN']
  })

  it('does nothing off Linux', () => {
    assert.equal(prepareSandbox({ log() {} }, { platform: 'darwin' }).step, 'not-linux')
  })
})

describe('nested probe replicates the engine probe', () => {
  it('runs outer bwrap in the engine shape, inner bwrap --unshare-user --ro-bind / / -- true, with PATH only', () => {
    let seen
    const ok = nestedSandboxWorks('/usr/bin/bwrap', {
      run: (bin, args, env) => { seen = { bin, args, env }; return 0 },
      mkdtemp: () => '/tmp/mlr-preflight-x',
      rmdir: () => {},
      pathVar: '/usr/bin',
      exists: (p) => p === '/usr' || p === '/etc/hosts',
      lstat: () => ({ isSymbolicLink: () => false }),
      readlink: () => '',
      realpath: (p) => p,
    })
    assert.equal(ok, true)
    assert.equal(seen.bin, '/usr/bin/bwrap')
    assert.deepEqual(seen.env, { PATH: '/usr/bin' })
    assert.deepEqual(seen.args.slice(0, 9), ['--die-with-parent', '--new-session', '--unshare-all', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'])
    assert.ok(!seen.args.includes('--share-net'))
    assert.deepEqual(seen.args.slice(-8), ['--', 'bwrap', '--unshare-user', '--ro-bind', '/', '/', '--', 'true'])
  })

  it('non-zero exit is a failed probe', () => {
    assert.equal(nestedSandboxWorks('/usr/bin/bwrap', { run: () => 1, mkdtemp: () => '/tmp/x', rmdir: () => {} }), false)
  })

  it('buildProbeArgs binds the directory and symlinks merged-usr dirs', () => {
    const a = buildProbeArgs('/d', '', { exists: (p) => p === '/bin' || p === '/usr', lstat: () => ({ isSymbolicLink: () => true }), readlink: () => 'usr/bin' })
    assert.ok(a.join(' ').includes('--symlink usr/bin /bin'))
    assert.ok(a.join(' ').endsWith('--chdir /d'))
  })
})

describe('runAction wiring', () => {
  const base = {
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'acme/app',
    'INPUT_GITHUB-TOKEN': 'ghs_fixture_123456',
    INPUT_MODE: 'review', 'INPUT_REVIEW-ID': 'rv_1', 'INPUT_REVIEW-KEY': 'rk_fixture_123',
    'INPUT_HEAD-SHA': 'a'.repeat(40), 'INPUT_BASE-SHA': 'b'.repeat(40),
    RUNNER_TEMP: '/tmp',
  }
  const payload = { action: 'opened', repository: { owner: { login: 'acme' }, name: 'app' }, pull_request: { number: 1, state: 'open', base: { sha: 'b'.repeat(40), repo: { full_name: 'acme/app' } }, head: { sha: 'a'.repeat(40), repo: { full_name: 'acme/app', fork: false } } } }
  const run = async (env, order) => runAction({
    env, payload,
    prepareSandbox: () => { order.push('prep') },
    runEngine: async () => { order.push('engine'); return { exitCode: 4, stdout: '', stderr: '', errorMessage: 'x', rawFindings: null } },
    writeFindingsImpl: async () => {},
    createGitHubApi: () => ({}),
  })

  it('review mode prepares the sandbox before the engine runs', async () => {
    const order = []
    await run(base, order)
    assert.deepEqual(order, ['prep', 'engine'])
  })

  it('a throwing prepare does not stop the engine', async () => {
    const order = []
    await runAction({
      env: base, payload,
      prepareSandbox: () => { throw new Error('x') },
      runEngine: async () => { order.push('engine'); return { exitCode: 4, stdout: '', stderr: '', errorMessage: 'x', rawFindings: null } },
      writeFindingsImpl: async () => {}, createGitHubApi: () => ({}),
    })
    assert.deepEqual(order, ['engine'])
  })
})
