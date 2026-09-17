/**
 * The machine's one instance: start it, stop it, restart it, say what it is.
 *
 * This replaces `scripts/deploy.sh`. Everything Linux-only in that script is
 * gone -- `ss -ltnp | grep -oP` to find the process, `setsid --fork` to detach
 * it, `python3` to read the summary -- and what replaces each is noted where it
 * happens.
 */
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import {
  configPath,
  inLinkedWorktree,
  isOurServer,
  checkTools,
  logPath,
  psArgsFor,
  readConfig,
  repoRoot,
  runPath,
  serverScript,
  stateDir,
} from './instance.js'

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The session token the server writes for local tooling.
 *
 * `status` and the readiness poll both ask `/api/server`, which is behind the
 * password now -- so without this, turning the gate on would break `pnpm
 * restart` and the symptom would be a restart that hangs and then says the
 * server never came back. Reading it requires being the user, who can already
 * attach to the tmux socket.
 */
const localToken = () => {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'local.json'), 'utf8')).token
  } catch {
    return undefined
  }
}

/**
 * @typedef {object} Run
 * @property {number} pid
 * @property {number} port
 * @property {string} node
 * @property {string} repo
 * @property {string} script
 * @property {string} [host]
 * @property {string} [instanceId]
 * @property {string} [commit] what was checked out when it started, so `pull` can tell whether it is behind
 * @property {string} startedAt
 */

/** @returns {Run | undefined} */
const readRun = () => {
  if (!existsSync(runPath())) return undefined
  try {
    return JSON.parse(readFileSync(runPath(), 'utf8'))
  } catch {
    return undefined
  }
}

/** @param {Run} run */
const writeRun = (run) => {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(runPath(), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 })
}

const clearRun = () => rmSync(runPath(), { force: true })

/**
 * Is anything listening?
 *
 * Binding is the portable question. `ss` is Linux-only and `lsof` is not
 * installed on every box, so the old `ss -ltnp` lookup has no replacement --
 * and it was answering the wrong question anyway, since a port tells you
 * nothing about whose process holds it.
 * @param {number} port
 * @param {string} [bind]
 */
const portInUse = (port, bind = '127.0.0.1') =>
  new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(true))
    probe.once('listening', () => probe.close(() => resolve(false)))
    probe.listen(port, bind)
  })

/**
 * A loopback GET, with the headers we actually mean.
 *
 * `node:http` and not `fetch`: `Host` is a forbidden header name in the Fetch
 * standard, and undici silently rewrites it to the address it dialled. The
 * whole point of the check below is to send a `Host` this server may not answer
 * to, so `fetch` would have reported every name as correct -- measured, a
 * deliberately bogus name passed. `curl -H` is what the shell version used, for
 * the same reason.
 *
 * @param {number} port
 * @param {string} path
 * @param {Record<string,string>} [headers]
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, text: string}>}
 */
const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers, timeout: 5000 },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
      },
    )
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })

/**
 * Ask the instance who it is.
 *
 * `sec-fetch-site: same-origin` on every call: with a token set, `gate.ts`
 * requires `isLoopback && isOwnPage`, and `isOwnPage` is that header. It costs
 * nothing when no token is set.
 *
 * **No `x-swb-token`, ever.** `allowRequest` and `allowSocket` both return early
 * on a valid token, *before* the `Host` and `Origin` checks -- so a
 * token-bearing probe would pass whatever `--host` says, which is exactly the
 * thing `verifyHost` exists to test.
 *
 * @param {number} port
 * @param {string} [hostHeader]
 * @returns {Promise<{status: number, protocol: string | undefined, body: any}>}
 */
const askServer = async (port, hostHeader) => {
  /** @type {Record<string,string>} */
  const headers = { 'sec-fetch-site': 'same-origin' }
  if (hostHeader !== undefined) headers.Host = hostHeader
  /*
   * The token is sent for `status`, and deliberately **not** when a Host is
   * being probed: a token short-circuits the gate before it ever looks at the
   * name, so a token-bearing probe would pass whatever `--host` says -- which
   * is the one thing `verifyHost` exists to test.
   */
  if (hostHeader === undefined) {
    const token = localToken()
    if (token !== undefined) headers['x-swb-token'] = token
  }
  const res = await get(port, '/api/server', headers)
  const protocol = res.headers['x-swb-protocol']
  let body
  if (res.status === 200) {
    try {
      body = JSON.parse(res.text)
    } catch {
      body = undefined
    }
  }
  return {
    status: res.status,
    protocol: Array.isArray(protocol) ? protocol[0] : protocol,
    body,
  }
}

/** The last lines of the log, for when a start did not come back. */
const logTail = (/** @type {number} */ n) => {
  try {
    return execFileSync('tail', ['-n', String(n), logPath()], { encoding: 'utf8' })
  } catch {
    return ''
  }
}

/**
 * Wait until a *different* instance answers.
 *
 * The old script polled `/api/health`, which the outgoing process keeps
 * answering until `app.close()` returns -- so a restart whose new process never
 * started could poll green against the corpse it was replacing. `instanceId` is
 * minted per start (`server/src/config.ts`), so comparing it is the readiness
 * question actually being asked.
 *
 * @param {number} port
 * @param {string} [previous]
 * @returns {Promise<string | undefined>} the new instance id
 */
const waitForInstance = async (port, previous) => {
  for (let i = 0; i < 80; i++) {
    try {
      const { status, body } = await askServer(port)
      if (status === 200 && body?.instanceId !== undefined && body.instanceId !== previous) {
        return body.instanceId
      }
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  return undefined
}

/**
 * Prove the public name is right rather than assume it.
 *
 * `/ws` refuses a page from an origin it does not know and `/api` refuses a
 * `Host` it does not answer to, so a wrong `--host` does not fail loudly: it
 * serves a page where every REST call works and only the row never paints.
 * Checked here, where it is still one edit away from fixed.
 *
 * @param {number} port
 * @param {string} host  comma-separated, as the flag accepts
 * @returns {Promise<string[]>} problems, empty when the name is right
 */
export const verifyHost = async (port, host) => {
  /** @type {string[]} */
  const problems = []
  for (const raw of host.split(',')) {
    const name = raw.trim()
    if (name === '') continue
    const bare = name.replace(/^[a-z]+:\/\//i, '')

    const { status, protocol } = await askServer(port, bare).catch(() => ({
      status: 0,
      protocol: null,
      body: undefined,
    }))
    /*
     * 401, not 200, is the good answer now. This probe carries no credential on
     * purpose -- a token short-circuits the gate before it looks at the name,
     * so it would pass whatever `--host` says -- and without one the gate
     * answers 401 for a name it serves and 404 for one it does not. Expecting
     * 200 here reported the first deploy behind the password as a wrong host,
     * after the server had come up correctly.
     */
    if (status !== 401 && status !== 200) {
      problems.push(`--host looks wrong: /api answered ${status} for Host: ${bare}`)
      continue
    }
    if (protocol === null) problems.push(`no x-swb-protocol header for Host: ${bare}`)

    // A bare name is allowed under both schemes, so checking https is enough.
    const origin = name.includes('://') ? name : `https://${name}`
    const verdict = await probeSocket(port, origin)
    if (verdict === 'refused') {
      problems.push(`--host looks wrong: /ws refused a page from ${origin}`)
    } else if (verdict === 'skip') {
      console.log(`  ws probe skipped: ws is not resolvable from server/`)
    }
  }
  return problems
}

/**
 * Open `/ws` with an origin and see whether the gate takes it.
 *
 * `ws` is resolved through the **server** package, because that is where it is
 * a dependency: under pnpm's isolated layout it is not at the workspace root,
 * and the old script's `require("ws")` from the repo root threw
 * MODULE_NOT_FOUND in any clean shell -- so it printed `skip` and this half of
 * the check had never actually run. Same trick `ensure-node-pty` uses.
 *
 * @param {number} port
 * @param {string} origin
 * @returns {Promise<'ok' | 'refused' | 'skip'>}
 */
const probeSocket = async (port, origin) => {
  /** @type {any} */
  let WebSocketImpl
  try {
    const require = createRequire(join(repoRoot, 'server', 'index.js'))
    WebSocketImpl = require('ws').WebSocket
  } catch {
    // A missing module is not evidence the name is wrong, and blocking on it
    // would be. It should be unreachable now; say so when it is not.
    return 'skip'
  }
  return new Promise((resolve) => {
    /*
     * With a ticket that was never issued. The server spends a ticket only for
     * an origin it serves, so it answers 4401 ("not signed in") for a page it
     * would admit and 1008 ("origin not allowed") for one it would not -- which
     * is the question being asked, without needing a real session.
     */
    const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws`, ['verify-host-probe'], { origin })
    let done = false
    /** @param {'ok' | 'refused'} verdict */
    const say = (verdict) => {
      if (done) return
      done = true
      try {
        socket.close()
      } catch {
        // already closing
      }
      resolve(verdict)
    }
    /*
     * `open` is deliberately not a verdict. The gate runs after the upgrade has
     * completed, so a refused socket opens and is *then* closed with 1008 --
     * measured: treating `open` as success reported a deliberately bogus origin
     * as accepted. Staying open is the evidence; opening is not.
     */
    // 1008 is "policy violation" -- the gate saying no, rather than a network fault.
    socket.on('close', (/** @type {number} */ code) => say(code === 1008 ? 'refused' : 'ok'))
    // 4401 arrives as a close, above, and means the origin was accepted.
    socket.on('error', () => say('refused'))
    setTimeout(() => say(socket.readyState === 1 ? 'ok' : 'refused'), 700)
  })
}

// ---------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------

/** @param {string} message */
const fail = (message) => {
  console.error(`swb: ${message}`)
  process.exit(1)
}

/**
 * Worktrees develop, master deploys.
 *
 * The convention is older than this tool, but the reason to *enforce* it is
 * sharper than the convention: a worktree has no settings of its own, so
 * starting here would point at the machine's state directory and tmux socket --
 * and `engine.start()` runs before `app.listen()`, adopting every live session
 * on that socket before the port collision is ever noticed. By then every one
 * of somebody's agents has a second tmux client.
 *
 * @param {string} verb
 * @param {boolean} [force]
 */
const guard = (verb, force) => {
  if (force || !inLinkedWorktree()) return
  const run = readRun()
  const owner = run?.repo ?? 'the main checkout'
  console.error(`swb ${verb}: this is a worktree. Worktrees develop, master deploys.`)
  console.error(`  the instance serves ${owner}`)
  console.error(`  finish on your branch and let the merge into master be what ships it`)
  console.error(`  (--force overrides, and you should know why you are doing it)`)
  process.exit(1)
}

/** What the child will run and with what. One place, so `start` and `restart` agree. */
const invocation = (/** @type {{host?: string}} */ opts) => {
  const cfg = readConfig()
  const port = Number(process.env.SWB_PORT ?? cfg.port ?? 8083)
  const host = opts.host ?? cfg.host
  const argv = [serverScript]
  /*
   * Flags rather than variables, because `config.ts` made them flags and says
   * why: these are the two values a *deployment* has to get right, so they
   * belong where `ps` shows them and where they cannot be inherited by accident
   * from whichever shell ran this. `--bind` is the one that decides whether
   * this machine is reachable from the network at all.
   */
  if (host !== undefined && host !== '') argv.push('--host', host)
  if (cfg.bind !== undefined && cfg.bind !== '') argv.push('--bind', cfg.bind)
  const env = { ...process.env }
  // Forced, not inherited. `config.isDev` is `NODE_ENV !== 'production'`, and a
  // dev instance trusts Vite's origin on /ws -- not something to pick up by
  // accident from whichever shell happened to run this.
  env.NODE_ENV = 'production'
  env.SWB_PORT = String(port)
  if (cfg.token !== undefined && env.SWB_TOKEN === undefined) env.SWB_TOKEN = cfg.token
  return { port, host, argv, env }
}

/** `pnpm build`, and a failure here restarts nothing. */
const build = () => {
  console.log('building...')
  try {
    execFileSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit' })
  } catch {
    fail('build failed -- nothing was restarted, and what is running is still the last thing that built')
  }
}

/**
 * Refuse to restart a working instance into a node that cannot load the pty.
 * An ABI-stale node-pty is a startup crash into a log file nobody is watching.
 */
const nodePtyGate = () => {
  try {
    execFileSync(process.execPath, ['-e', 'require("node-pty")'], {
      cwd: join(repoRoot, 'server'),
      stdio: 'ignore',
    })
  } catch {
    fail('node-pty does not load for this node -- run `pnpm ensure-native` first')
  }
}

/**
 * Refuse before spawning if the server could not possibly work.
 *
 * The server resolves `tmux`, `git` and the agent by bare name, so a missing
 * one fails deep inside startup: a machine without tmux got "tmux server did
 * not become ready", twenty retries and a log file away from the word `brew`.
 * Checked here, where the answer fits on one line.
 */
const WHY = {
  tmux: 'every session lives in a tmux session, which is what lets agents survive a restart',
  git: 'every project and its worktrees are read with git',
}

const preflight = () => {
  if (!existsSync(join(stateDir(), 'auth.json'))) {
    fail(
      'no password is set, and the server will not start without one.\n' +
        '  set one:  pnpm password\n' +
        '  it is asked for once per browser, and is what a linked machine logs in with.',
    )
  }
  const { missing, agent, agentMissing } = checkTools()
  if (missing.length > 0) {
    const lines = [`${missing.join(' and ')} not on your PATH.`]
    for (const tool of missing) lines.push(`  ${tool}: ${WHY[/** @type {'tmux'|'git'} */ (tool)]}`)
    lines.push(
      process.platform === 'darwin'
        ? `  install: brew install ${missing.join(' ')}`
        : `  install ${missing.length > 1 ? 'them' : 'it'} with your package manager`,
    )
    fail(lines.join('\n'))
  }
  if (agentMissing) {
    console.log(`note: "${agent}" is not on your PATH, so terminals will work and agents will not.`)
  }
}

/** @param {number} port */
const sessionSummary = async (port) => {
  try {
    const token = localToken()
    const res = await get(port, '/api/snapshot', {
      'sec-fetch-site': 'same-origin',
      ...(token === undefined ? {} : { 'x-swb-token': token }),
    })
    if (res.status !== 200) return undefined
    const snap = /** @type {any} */ (JSON.parse(res.text))
    const live = snap.sessions.filter((/** @type {any} */ s) => s.liveness === 'live').length
    return `${live} of ${snap.sessions.length} sessions live, ${snap.worktrees.length} worktrees`
  } catch {
    return undefined
  }
}

/** The checkout's HEAD, or undefined outside a git checkout. */
const headCommit = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

/**
 * Is the machine's instance up, and on which commit. For `pull`, which
 * restarts only when what is running is not what is checked out.
 * @returns {{ running: boolean, commit?: string }}
 */
export const running = () => {
  const run = readRun()
  if (run === undefined) return { running: false }
  const args = psArgsFor(run.pid)
  return { running: args !== undefined && isOurServer(args, run.script), commit: run.commit }
}

/** @param {{host?: string, force?: boolean, quiet?: boolean}} opts */
export const start = async (opts = {}) => {
  guard('start', opts.force)
  if (!existsSync(serverScript)) fail('server/dist is missing -- run `pnpm build` first')
  preflight()

  const run = readRun()
  if (run !== undefined) {
    const args = psArgsFor(run.pid)
    if (args !== undefined && isOurServer(args, run.script)) {
      console.log(`already running: pid ${run.pid} on :${run.port}`)
      return
    }
    clearRun() // the recorded process is gone; the record is not evidence
  }

  const { port, host, argv, env } = invocation(opts)
  if (await portInUse(port)) {
    fail(`something is already listening on :${port} and it is not ours -- \`pnpm status\` for what it says it is`)
  }

  mkdirSync(stateDir(), { recursive: true })
  // 0600 on creation: this log carries the absolute path of every project on the
  // machine and every prompt the dispatcher types. Appends keep the mode.
  const log = openSync(logPath(), 'a', 0o600)
  /*
   * `detached` makes libuv call setsid(2) in the child, which is precisely what
   * `setsid --fork` bought the old script -- without the GNU-only flag, and
   * without its trap (plain setsid execs in place when the caller is already a
   * group leader, so node stayed a child and the deploy never returned). stdin
   * is /dev/null rather than inherited: a backgrounded terminal would otherwise
   * hand the agents SIGTTIN, and a closed one EIO.
   */
  const child = spawn(process.execPath, argv, {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  closeSync(log)
  if (child.pid === undefined) fail('could not spawn the server')

  writeRun({
    pid: /** @type {number} */ (child.pid),
    port,
    node: process.execPath,
    repo: repoRoot,
    script: serverScript,
    host,
    commit: headCommit(),
    startedAt: new Date().toISOString(),
  })

  const instanceId = await waitForInstance(port)
  if (instanceId === undefined) {
    console.error(logTail(40))
    fail(`did not come back -- see ${logPath()}`)
  }
  const current = readRun()
  if (current !== undefined) writeRun({ ...current, instanceId })

  if (host !== undefined && host !== '') {
    const problems = await verifyHost(port, host)
    for (const problem of problems) console.error(`swb: ${problem}`)
    if (problems.length > 0) process.exit(1)
  }

  if (opts.quiet) return
  let where = `live on :${port}`
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
    where += ` at ${sha}`
  } catch {
    // not a git checkout; the port is still the useful half
  }
  console.log(host !== undefined && host !== '' ? `${where}, for ${host}` : `${where}, this machine only`)
  if (host === undefined || host === '') {
    console.log(`  (set "host" in ${configPath()} to serve it through a proxy)`)
  }
  const sessions = await sessionSummary(port)
  if (sessions !== undefined) console.log(`  ${sessions}`)
}

/** @param {{force?: boolean, quiet?: boolean}} opts */
export const stop = async (opts = {}) => {
  guard('stop', opts.force)
  const run = readRun()
  if (run === undefined) {
    if (!opts.quiet) console.log('not running (no record of one)')
    return
  }

  const args = psArgsFor(run.pid)
  if (args === undefined) {
    clearRun()
    if (!opts.quiet) console.log('not running (the recorded process is gone)')
    return
  }
  /*
   * The check the shell version only ever described. Its comment said the
   * fallback "must never kill a process that merely inherited the port after
   * ours died" -- but the branch that actually ran killed whatever the pid file
   * named. A pid is recycled; an absolute script path in argv is not.
   */
  if (!isOurServer(args, run.script)) {
    console.error(`swb stop: pid ${run.pid} is not ours and will not be killed.`)
    console.error(`  expected argv containing: ${run.script}`)
    console.error(`  found:                    ${args}`)
    console.error(`  if the server is really gone, remove ${runPath()}`)
    process.exit(1)
  }

  // The pid, never the process group. tmux daemonises into its own session and
  // process group, so it is not reachable this way -- and that is the whole
  // design: the sessions outlive the server.
  process.kill(run.pid, 'SIGTERM')
  for (let i = 0; i < 80; i++) {
    if (psArgsFor(run.pid) === undefined) {
      clearRun()
      if (!opts.quiet) console.log(`stopped ${run.pid} (was :${run.port})`)
      return
    }
    await sleep(250)
  }
  // Costs an unflushed state.json, which is already lossy by design, and
  // nothing else: the tmux server is a different process entirely.
  process.kill(run.pid, 'SIGKILL')
  await sleep(500)
  clearRun()
  if (!opts.quiet) console.log(`killed ${run.pid} after it ignored SIGTERM (was :${run.port})`)
}

/** @param {{host?: string, force?: boolean, skipBuild?: boolean}} opts */
export const restart = async (opts = {}) => {
  guard('restart', opts.force)
  if (!opts.skipBuild) {
    build()
    nodePtyGate()
  }
  /*
   * Everything that could make the new process refuse to start is checked
   * *before* the old one is stopped.
   *
   * `start` runs these too, but it runs them after `stop` has already happened
   * -- so a missing password took a running IDE down and then declined to
   * bring it back. Caught before it shipped: the live machine had no password
   * set, and `pnpm restart` would have left it dark. It is the same rule the
   * build above already follows: what is running stays running unless the thing
   * replacing it is known to be able to start.
   */
  if (!existsSync(serverScript)) fail('server/dist is missing -- run `pnpm build` first')
  preflight()
  const before = readRun()?.instanceId
  await stop({ ...opts, quiet: true })
  // force: the worktree guard above has already run, and running it again here
  // would be the only thing standing between `--force` and a restart.
  await start({ ...opts, force: true })
  const after = readRun()?.instanceId
  if (before !== undefined && after === before) {
    fail('the instance id did not change -- the old process may still be serving')
  }
}

/**
 * Whether a password is set, and when -- never the hash, never a length.
 * `status` output gets pasted into issues.
 */
const passwordState = () => {
  try {
    const rec = JSON.parse(readFileSync(join(stateDir(), 'auth.json'), 'utf8'))
    const when = typeof rec.updatedAt === 'number' ? new Date(rec.updatedAt).toISOString().slice(0, 10) : 'at an unknown time'
    return `set ${when}`
  } catch {
    return 'NOT SET -- the server will not start; run `pnpm password`'
  }
}

export const status = async () => {
  const run = readRun()
  const cfg = readConfig()
  const port = Number(process.env.SWB_PORT ?? cfg.port ?? 8083)

  if (existsSync(join(repoRoot, 'scripts', 'deploy.env'))) {
    console.log(`note: scripts/deploy.env is no longer read; its settings belong in ${configPath()}`)
  }

  /*
   * Exit 0 for "not running": that is an answer, not a failure, and `git status`
   * on a clean tree exits 0 too. A non-zero code here reaches the terminal as
   * pnpm's "Command failed", which reads like a malfunction when nothing is
   * wrong. A genuine fault -- running but not answering -- still sets one below.
   */
  if (run === undefined) {
    console.log('switchboard   not running (no record of one)')
    console.log(`  password   ${passwordState()}`)
    const taken = await portInUse(port)
    if (taken) {
      console.log(`  but something is listening on :${port}`)
      console.log('  (started outside swb, or by an older checkout)')
    }
    return
  }

  const args = psArgsFor(run.pid)
  const ours = args !== undefined && isOurServer(args, run.script)
  if (!ours) {
    console.log(`switchboard   not running (pid ${run.pid} is gone or is not ours)`)
    return
  }

  console.log(`switchboard   running   pid ${run.pid}   since ${run.startedAt}`)
  console.log(`  checkout   ${run.repo}`)
  console.log(`  node       ${run.node}${run.node === process.execPath ? '' : '   (differs from this shell)'}`)
  console.log(`  url        http://127.0.0.1:${run.port}${run.host ? `   for ${run.host}` : '   this machine only'}`)
  try {
    const { status: code, protocol, body } = await askServer(run.port)
    if (code === 200) {
      console.log(`  answering  "${body.name}", protocol ${protocol}, instance ${body.instanceId}`)
    } else {
      console.log(`  answering  no: /api/server said ${code}`)
    }
  } catch {
    console.log('  answering  no')
    process.exitCode = 2
  }
  console.log(`  password   ${passwordState()}`)
  console.log(`  config     ${configPath()}${existsSync(configPath()) ? '' : '   (none yet)'}`)
  console.log(`  log        ${logPath()}`)
  const sessions = await sessionSummary(run.port)
  if (sessions !== undefined) console.log(`  sessions   ${sessions}`)
}
