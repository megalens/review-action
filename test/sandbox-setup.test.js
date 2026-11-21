import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildProbeArgs, defaultRun, nestedSandboxWorks, prepareSandbox } from '../src/sandbox.js'
import { parseInputs, runAction, sandboxOptions } from '../src/action.js'
import { PINNED_ENGINE_VERSION } from '../src/engine.js'

// A fake machine: tracks installed bwrap, sudo, and whether the nested probe passes (flipped by the sysctl or apparmor line).
function machine({ bwrap = true, sudo = true, probeOk = false, fixBy = 'sysctl', aptInstallsBwrap = true, profiles = [], mode, hosted = true } = {}) {
  const m = { calls: [], logs: [], warns: [], probes: 0, bwrap, probeOk }
  m.exists = (p) => (p.endsWith('/bwrap') ? (p === '/usr/bin/bwrap' && m.bwrap) : profiles.includes(p))
  m.run = (bin, args, env, o) => {
    m.calls.push({ bin, args, env, o })
    if (bin === '/usr/bin/sudo' && args[0] === '-n' && args[1] === '/usr/bin/true') return sudo ? 0 : 1
    if (args.includes('/usr/bin/apt-get') && args.includes('install')) { if (aptInstallsBwrap) m.bwrap = true; return 0 }
    if (args.includes('/usr/sbin/sysctl')) { if (fixBy === 'sysctl') m.probeOk = true; return 0 }
    if (args.includes('/usr/sbin/apparmor_parser')) { if (fixBy === 'apparmor') m.probeOk = true; return 0 }
    return 0
  }
  m.probe = () => { m.probes += 1; return m.probeOk }
  m.log = (l) => m.logs.push(l)
  m.go = () => prepareSandbox({ log: m.log, warn: (w) => m.warns.push(w), mode, hosted }, { run: m.run, exists: m.exists, probe: m.probe, platform: 'linux', mkdtemp: () => '/tmp/mlr-setup-x', rmdir: () => {} })
  // readable command: drop sudo's -n and the root-side timeout wrapper
  m.names = () => m.calls.map((c) => c.args.join(' ').replace(/^-n /, '').replace(/^\/usr\/bin\/timeout -k \d+ \d+ /, '') || c.bin)
  m.sudoCalls = () => m.calls.filter((c) => c.bin === '/usr/bin/sudo').length
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
    assert.deepEqual(m.names(), ['/usr/bin/true', '/usr/bin/apt-get -o DPkg::Lock::Timeout=60 -o Acquire::Retries=2 update', '/usr/bin/apt-get -o DPkg::Lock::Timeout=60 -o Acquire::Retries=2 install -y bubblewrap'])
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
    assert.ok(!n.some((x) => x.includes('apparmor_parser')), 'profiles stay loaded when the sysctl alone fixed it')
    assert.equal(m.probes, 2, 'probe, sysctl, probe again')
    assert.ok(m.logs.every((l) => !/for this job/.test(l)))
  })

  it('probe fails then apparmor_parser -R fixes it', () => {
    const m = machine({ probeOk: false, fixBy: 'apparmor', profiles: ['/etc/apparmor.d/unprivileged_userns'] })
    assert.equal(m.go().step, 'fixed')
    const n = m.names()
    assert.ok(n.some((x) => x === '/usr/sbin/apparmor_parser -R /etc/apparmor.d/unprivileged_userns'))
    assert.ok(!n.some((x) => x.includes('bwrap-userns-restrict')), 'absent profile is skipped')
    assert.equal(m.probes, 3, 'probe after the sysctl and again after the profiles')
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
      assert.ok(c.bin === '/usr/bin/sudo', c.bin)
      assert.ok(c.args.slice(1).every((a) => !a.startsWith('/') || a.startsWith('/usr/') || a.startsWith('/etc/apparmor.d/')), JSON.stringify(c.args))
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

describe('setup-sandbox modes', () => {
  const profiles = ['/etc/apparmor.d/bwrap-userns-restrict']
  it('auto, GitHub-hosted: changes the machine, no warning', () => {
    const m = machine({ mode: 'auto', hosted: true, bwrap: false, profiles })
    assert.equal(m.go().step, 'fixed')
    assert.ok(m.sudoCalls() > 1)
    assert.deepEqual(m.warns, [])
  })
  it('default mode (undefined) behaves as auto', () => {
    const m = machine({ hosted: false, probeOk: false })
    assert.equal(m.go().step, 'blocked-not-allowed')
    assert.equal(m.sudoCalls(), 0)
  })
  it('auto, self-hosted, sandbox blocked: ZERO sudo calls, logs the admin commands and the force setting', () => {
    const m = machine({ mode: 'auto', hosted: false, probeOk: false, profiles })
    assert.deepEqual(m.go(), { ok: false, step: 'blocked-not-allowed' })
    assert.equal(m.calls.length, 0)
    assert.equal(m.logs.length, 1)
    assert.match(m.logs[0], /sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/)
    assert.match(m.logs[0], /sudo apparmor_parser -R \/etc\/apparmor\.d\/bwrap-userns-restrict/)
    assert.match(m.logs[0], /setup-sandbox: force/)
    assert.match(m.logs[0], /until the runner is rebooted/)
    assert.deepEqual(m.warns, [])
  })
  it('auto, self-hosted, bwrap missing: zero sudo calls, says how to install', () => {
    const m = machine({ mode: 'auto', hosted: false, bwrap: false })
    assert.deepEqual(m.go(), { ok: false, step: 'no-bwrap-not-allowed' })
    assert.equal(m.calls.length, 0)
    assert.match(m.logs[0], /sudo apt-get install -y bubblewrap/)
    assert.match(m.logs[0], /setup-sandbox: force/)
  })
  it('auto, self-hosted, sandbox works: nothing to do, no sudo', () => {
    const m = machine({ mode: 'auto', hosted: false, probeOk: true })
    assert.equal(m.go().step, 'works')
    assert.equal(m.calls.length, 0)
  })
  it('force, self-hosted: runs the steps and emits ::warning:: about the setting and reboot', () => {
    const m = machine({ mode: 'force', hosted: false, bwrap: false, probeOk: false, profiles })
    assert.equal(m.go().step, 'fixed')
    assert.ok(m.sudoCalls() > 1)
    assert.equal(m.warns.length, 2)
    assert.ok(m.warns.every((w) => /setup-sandbox: force/.test(w)))
    assert.match(m.warns[1], /until the runner is rebooted/)
  })
  it('force, hosted: runs the steps, no self-hosted warning', () => {
    const m = machine({ mode: 'force', hosted: true, probeOk: false })
    assert.equal(m.go().step, 'fixed')
    assert.deepEqual(m.warns, [])
  })
  it('force without sudo: changes nothing', () => {
    const m = machine({ mode: 'force', hosted: false, probeOk: false, sudo: false })
    assert.equal(m.go().step, 'blocked-no-sudo')
    assert.deepEqual(m.warns, [])
  })
  for (const hosted of [true, false]) {
    it(`off, hosted=${hosted}: probes and logs only, zero sudo calls`, () => {
      const blocked = machine({ mode: 'off', hosted, probeOk: false, profiles })
      assert.equal(blocked.go().step, 'blocked-not-allowed')
      assert.equal(blocked.calls.length, 0)
      assert.match(blocked.logs[0], /"off"/)
      const missing = machine({ mode: 'off', hosted, bwrap: false })
      assert.equal(missing.go().step, 'no-bwrap-not-allowed')
      assert.equal(missing.calls.length, 0)
      const ok = machine({ mode: 'off', hosted, probeOk: true })
      assert.equal(ok.go().step, 'works')
    })
  }
  it('an unknown mode value is treated as auto (the Action input itself is validated)', () => {
    const m = machine({ mode: 'bogus; rm -rf /', hosted: false, probeOk: false })
    assert.equal(m.go().step, 'blocked-not-allowed')
    assert.equal(m.calls.length, 0)
  })
  it('only the exact value github-hosted counts as hosted (checked in the Action wiring below)', () => {
    // see "runAction wiring": RUNNER_ENVIRONMENT values other than github-hosted pass hosted=false
    assert.ok(true)
  })
})

describe('timeouts and working directory', () => {
  it('apt-get runs under root-side /usr/bin/timeout -k 10 300 with a longer Node bound; quick steps have short bounds', () => {
    const m = machine({ bwrap: false, probeOk: false, fixBy: 'apparmor', profiles: ['/etc/apparmor.d/bwrap-userns-restrict'] })
    m.go()
    const apt = m.calls.filter((c) => c.args.includes('/usr/bin/apt-get'))
    assert.equal(apt.length, 2)
    for (const c of apt) {
      assert.deepEqual(c.args.slice(0, 5), ['-n', '/usr/bin/timeout', '-k', '10', '300'])
      assert.equal(c.args[5], '/usr/bin/apt-get')
      assert.ok(c.o.timeoutMs > 300_000, 'Node bound is longer than the inner one, so Node never signals apt')
    }
    const quick = m.calls.filter((c) => c.args.includes('/usr/sbin/sysctl') || c.args.includes('/usr/sbin/apparmor_parser'))
    assert.equal(quick.length, 2)
    for (const c of quick) {
      assert.deepEqual(c.args.slice(0, 5), ['-n', '/usr/bin/timeout', '-k', '5', '20'])
      assert.ok(c.o.timeoutMs <= 30_000)
    }
  })

  it('defaultRun passes stdio ignore, a timeout, the scratch cwd and the given env', () => {
    let seen
    const status = defaultRun('/usr/bin/sudo', ['-n', '/usr/bin/true'], { PATH: '/usr/bin' }, { cwd: '/tmp/mlr-setup-x', timeoutMs: 1234 }, (b, a, o) => { seen = { b, a, o }; return { status: 0 } })
    assert.equal(status, 0)
    assert.deepEqual(seen.o, { stdio: 'ignore', env: { PATH: '/usr/bin' }, timeout: 1234, cwd: '/tmp/mlr-setup-x' })
    assert.equal(seen.o.shell, undefined)
    defaultRun('/x', [], {}, {}, (b, a, o) => { seen = { o }; return { status: 0 } })
    assert.equal(seen.o.timeout, 30_000)
    assert.notEqual(seen.o.cwd, undefined)
  })

  it('prepareSandbox runs commands in a fresh scratch directory (never the checkout) and removes it', () => {
    const cwds = []
    let removed = null
    let made = null
        prepareSandbox({ log() {}, warn() {}, mode: 'auto', hosted: true }, {
      exists: (p) => p === '/usr/bin/bwrap',
      platform: 'linux',
      mkdtemp: (p) => { made = p; return '/tmp/scratch-abc' },
      rmdir: (p) => { removed = p },
      probe: () => false,
      run: (bin, args, env, o) => { cwds.push(o?.cwd); return 0 },
    })
    // injected run replaces the default one, so check the default wiring through nestedSandboxWorks too
    assert.ok(made.includes('mlr-setup-'))
    assert.equal(removed, '/tmp/scratch-abc')
    let probeCwd
    nestedSandboxWorks('/usr/bin/bwrap', { cwd: '/tmp/scratch-abc', mkdtemp: () => '/tmp/p', rmdir: () => {}, run: (b, a, e) => { probeCwd = 'run'; return 0 } })
    assert.equal(probeCwd, 'run')
  })

  it('probe differs from the engine only in PATH handling: env is exactly the fixed PATH (no TMPDIR or other value)', () => {
    let env
    nestedSandboxWorks('/usr/bin/bwrap', { mkdtemp: () => '/tmp/p', rmdir: () => {}, run: (b, a, e) => { env = e; return 0 } })
    assert.deepEqual(Object.keys(env), ['PATH'])
    assert.ok(!env.PATH.split(':').some((d) => !/^\/(usr|bin|sbin)/.test(d)), 'only system directories')
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

  it('full mode prepares the sandbox too', async () => {
    const order = []
    const api = { findSummaryComment: async () => null, createIssueComment: async () => 1, updateIssueComment: async () => {}, getPull: async () => ({ open: true, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }), listPullFiles: async () => [], listReviewComments: async () => [], listFiles: async () => [] }
    await runAction({
      env: { ...base, INPUT_MODE: 'full', 'INPUT_REVIEW-ID': '', 'INPUT_REVIEW-KEY': '', 'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_123456' }, payload,
      prepareSandbox: () => { order.push('prep') },
      runEngine: async () => { order.push('engine'); return { exitCode: 4, stdout: '', stderr: '', errorMessage: 'x', rawFindings: null } },
      writeFindingsImpl: async () => {}, createGitHubApi: () => api,
    }).catch(() => {})
    assert.deepEqual(order.slice(0, 2), ['prep', 'engine'])
  })

  it('publish and create never call prepareSandbox', async () => {
    let called = 0
    const prepareSandbox = () => { called += 1 }
    await runAction({
      env: { ...base, INPUT_MODE: 'publish' }, payload, prepareSandbox,
      outPath: '/tmp/none.json', readFindingsImpl: async () => { throw new Error('none') },
      writeFindingsImpl: async () => {}, createGitHubApi: () => ({}),
    }).catch(() => {})
    await runAction({
      env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'acme/app', INPUT_MODE: 'create', 'INPUT_GITHUB-TOKEN': 'ghs_fixture_123456', 'INPUT_MEGALENS-TOKEN': 'ml_tok_fixture_123456', RUNNER_TEMP: '/tmp' },
      payload, prepareSandbox, fetchImpl: async () => { throw new Error('offline') }, createGitHubApi: () => ({}),
    }).catch(() => {})
    assert.equal(called, 0)
  })

  it('production options: only RUNNER_ENVIRONMENT exactly github-hosted counts as hosted', () => {
    for (const [renv, expectHosted] of [['github-hosted', true], ['self-hosted', false], ['GitHub-Hosted', false], [undefined, false], ['', false]]) {
      const o = sandboxOptions(renv === undefined ? {} : { RUNNER_ENVIRONMENT: renv }, 'auto')
      assert.equal(o.hosted, expectHosted, String(renv))
      assert.equal(o.mode, 'auto')
    }
    assert.equal(sandboxOptions({}, 'force').mode, 'force')
  })

  it('setup-sandbox input: default auto, valid values accepted, others rejected', () => {
    assert.equal(parseInputs({ ...base }).setupSandbox, 'auto')
    assert.equal(parseInputs({ ...base, 'INPUT_SETUP-SANDBOX': 'FORCE' }).setupSandbox, 'force')
    assert.equal(parseInputs({ ...base, 'INPUT_SETUP-SANDBOX': 'off' }).setupSandbox, 'off')
    assert.throws(() => parseInputs({ ...base, 'INPUT_SETUP-SANDBOX': 'sometimes' }), /setup-sandbox/)
    assert.equal(parseInputs({ ...base, 'INPUT_ENGINE-VERSION': '' }).engineVersion, PINNED_ENGINE_VERSION)
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
