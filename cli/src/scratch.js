/**
 * Throwaway instances, for developing the IDE with the IDE.
 *
 * One per checkout, with its own state directory, tmux socket, scratch
 * repositories and port -- all derived from the checkout's path, so several
 * worktrees can run one at once without reaching each other, and so an agent
 * that forgets the port can ask again and get the same answer.
 *
 * A second, named one is how a linked machine is tested: one is the gateway,
 * the other the machine whose projects it reads.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  assertScratchPaths,
  checkTools,
  deriveScratch,
  isOurServer,
  portCandidates,
  psArgsFor,
  repoRoot,
  scratchEnv,
  serverScript,
} from './instance.js'

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))

/** @param {number} port */
const portFree = (port) =>
  new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })

/** @param {import('./instance.js').Scratch} instance */
const storedPort = (instance) => {
  try {
    return Number(readFileSync(instance.portFile, 'utf8').trim())
  } catch {
    return undefined
  }
}

/** @param {import('./instance.js').Scratch} instance */
const storedToken = (instance) => {
  try {
    return readFileSync(instance.tokenFile, 'utf8').trim()
  } catch {
    return undefined
  }
}

/**
 * `run.json`, or the bare `server.pid` an older instance left behind. The
 * legacy read exists only so `stop` can clean those up; without an identity
 * recorded beside it, such a pid is never killed on the strength of the file.
 * @param {import('./instance.js').Scratch} instance
 * @returns {{pid: number, script?: string, port?: number} | undefined}
 */
const readRun = (instance) => {
  try {
    return JSON.parse(readFileSync(instance.runFile, 'utf8'))
  } catch {
    // fall through to the legacy file
  }
  const legacy = join(instance.root, 'server.pid')
  try {
    const pid = Number(readFileSync(legacy, 'utf8').trim())
    return Number.isFinite(pid) ? { pid } : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {import('./instance.js').Scratch} instance
 * @param {number} port
 * @param {string[]} path
 * @param {unknown} [body]
 */
const api = async (instance, port, path, body) => {
  const token = storedToken(instance)
  /** @type {Record<string,string>} */
  const headers = { 'sec-fetch-site': 'same-origin' }
  if (token !== undefined) headers['x-swb-token'] = token
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`http://127.0.0.1:${port}${path.join('')}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`${path.join('')} answered ${res.status}`)
  return res
}

/**
 * A scratch repository with one commit and some branches.
 *
 * The identity flags mirror `server/test/helpers/repo.ts`, which needs them for
 * the same reason: a user's own git config must not decide what this sees.
 * `commit.gpgsign=false` in particular -- without it, somebody who signs every
 * commit gets a scratch instance that fails at `git commit`.
 *
 * @param {import('./instance.js').Scratch} instance
 * @param {number} port
 * @param {string} dir
 * @param {string[]} branches
 */
const makeProject = async (instance, port, dir, branches) => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', ['-c', 'user.name=scratch', '-c', 'user.email=scratch@local',
      '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
  git(['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])

  const project = /** @type {any} */ (
    await (await api(instance, port, ['/api/projects'], { path: dir })).json()
  )
  for (const branch of branches) {
    await api(instance, port, ['/api/worktrees'], {
      projectId: project.id,
      branch,
      startClaude: true,
    })
  }
}

/** @param {{name?: string, force?: boolean, skipBuild?: boolean, quiet?: boolean}} opts */
export const start = async (opts = {}) => {
  const instance = deriveScratch(repoRoot, opts.name ?? '')
  if (!opts.skipBuild) {
    console.log('building...')
    try {
      execFileSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit' })
    } catch {
      console.error('swb: build failed')
      process.exit(1)
    }
  }
  if (!existsSync(serverScript)) {
    console.error('swb: server/dist is missing -- run `pnpm build` first')
    process.exit(1)
  }
  // Same reason as the service half: a missing tmux surfaces twenty retries
  // deep, in a log file, as something that does not mention tmux being absent.
  const { missing } = checkTools()
  if (missing.length > 0) {
    console.error(`swb: ${missing.join(' and ')} not on your PATH -- a scratch instance needs both`)
    process.exit(1)
  }

  await stop({ name: opts.name, quiet: true })
  mkdirSync(instance.stateDir, { recursive: true })

  const pinned = process.env.SWB_SCRATCH_PORT
  let port
  if (pinned !== undefined) {
    port = Number(pinned)
    // Probed even when pinned: a taken port should fail here and say so, rather
    // than as an EADDRINUSE in a log file nobody is reading.
    if (!(await portFree(port))) {
      console.error(`swb: SWB_SCRATCH_PORT=${port} is already in use`)
      process.exit(1)
    }
  } else {
    for (const candidate of portCandidates(instance.hash)) {
      if (await portFree(candidate)) {
        port = candidate
        break
      }
    }
    if (port === undefined) {
      console.error('swb: no free port in 8200-8499')
      process.exit(1)
    }
  }
  writeFileSync(instance.portFile, `${port}\n`)

  // A named instance is somebody's peer, so it gets the token that makes it
  // answer one. The unnamed instance stays as it was: no token, no gate.
  let token
  if (instance.name !== '') {
    token = randomBytes(32).toString('base64').replace(/[=/+]/g, '')
    writeFileSync(instance.tokenFile, token, { mode: 0o600 })
  }

  const log = openSync(instance.logFile, 'a', 0o600)
  const child = spawn(process.execPath, [serverScript], {
    cwd: join(repoRoot, 'server'),
    env: scratchEnv(process.env, instance, port, token),
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  closeSync(log)
  writeFileSync(
    instance.runFile,
    `${JSON.stringify({ pid: child.pid, port, script: serverScript }, null, 2)}\n`,
    { mode: 0o600 },
  )

  let up = false
  for (let i = 0; i < 80; i++) {
    // A server that died on startup should cost one poll, not ten seconds.
    if (psArgsFor(/** @type {number} */ (child.pid)) === undefined) break
    try {
      await api(instance, port, ['/api/health'])
      up = true
      break
    } catch {
      await sleep(250)
    }
  }
  if (!up) {
    try {
      console.error(execFileSync('tail', ['-n', '20', instance.logFile], { encoding: 'utf8' }))
    } catch {
      // no log to show
    }
    console.error(`swb: the server did not come up -- see ${instance.logFile}`)
    process.exit(1)
  }

  await makeProject(instance, port, join(instance.root, 'one'), ['feature-x', 'fourth', 'two-terms'])
  await makeProject(instance, port, join(instance.root, 'two'), ['alpha'])

  if (opts.quiet) return
  console.log(`up on http://127.0.0.1:${port}${instance.name ? `  (${instance.name})` : ''}`)
  console.log(`  checkout: ${repoRoot}`)
  if (token !== undefined) console.log(`  token:    ${token}`)
  console.log('  projects: one (main + 3 worktrees), two (main + 1)')
  console.log(`  log:      ${instance.logFile}`)
  console.log(`  tmux:     tmux -S ${instance.tmuxSocket} ls`)
}

/** @param {{name?: string, quiet?: boolean}} opts */
export const stop = async (opts = {}) => {
  const instance = deriveScratch(repoRoot, opts.name ?? '')
  // Before anything is killed or removed. Nothing here is read from the
  // environment: it is all derived from the checkout and the name.
  assertScratchPaths(instance)

  const port = storedPort(instance)
  const run = readRun(instance)
  if (run !== undefined) {
    const args = psArgsFor(run.pid)
    if (args === undefined) {
      // already gone
    } else if (run.script !== undefined && !isOurServer(args, run.script)) {
      console.error(`swb: pid ${run.pid} is not this instance's server -- not killed`)
      console.error(`  found: ${args}`)
    } else if (run.script === undefined && !isOurServer(args, serverScript)) {
      // A legacy record with no identity in it: only kill what still looks like
      // this checkout's server.
      console.error(`swb: pid ${run.pid} has no recorded identity and does not look like ours -- not killed`)
    } else {
      process.kill(run.pid, 'SIGTERM')
      for (let i = 0; i < 20; i++) {
        if (psArgsFor(run.pid) === undefined) break
        await sleep(250)
      }
    }
  }

  // Only this instance's socket, and `assertScratchPaths` has already refused
  // anything that is not it. The real instance's tmux server holds live agents.
  if (existsSync(instance.tmuxSocket)) {
    try {
      execFileSync('tmux', ['-S', instance.tmuxSocket, 'kill-server'], { stdio: 'ignore' })
    } catch {
      // no server on that socket
    }
    rmSync(instance.tmuxSocket, { force: true })
  }
  rmSync(instance.root, { recursive: true, force: true })
  if (!opts.quiet) console.log(`down and cleaned${port !== undefined ? ` (was :${port})` : ''}`)
}

/** @param {{name?: string, skipBuild?: boolean}} opts */
export const restart = async (opts = {}) => {
  await stop({ name: opts.name, quiet: true })
  await start(opts)
}

/** @param {{name?: string, url?: boolean}} opts */
export const status = async (opts = {}) => {
  const instance = deriveScratch(repoRoot, opts.name ?? '')
  const port = storedPort(instance)
  const run = readRun(instance)
  const live = run !== undefined && psArgsFor(run.pid) !== undefined

  if (opts.url) {
    if (port === undefined) {
      console.error('swb: no scratch instance for this checkout -- run `pnpm scratch start`')
      process.exit(1)
    }
    console.log(`http://127.0.0.1:${port}`)
    return
  }

  if (port === undefined) {
    console.log('no scratch instance for this checkout')
    console.log(`  start one with: pnpm scratch start${opts.name ? ` ${opts.name}` : ''}`)
  } else {
    console.log(`http://127.0.0.1:${port}${live ? '' : '   (not running)'}`)
    console.log(`  checkout: ${repoRoot}`)
    const token = storedToken(instance)
    if (token !== undefined) console.log(`  token:    ${token}`)
    console.log(`  state:    ${instance.stateDir}`)
    console.log(`  log:      ${instance.logFile}`)
    console.log(`  tmux:     tmux -S ${instance.tmuxSocket} ls`)
  }

  // Everything else on the machine, which is what tells you a worktree you have
  // forgotten about is still holding a port and a tmux server.
  const others = listAll().filter((row) => row.root !== instance.root)
  if (others.length > 0) {
    console.log('')
    console.log('other scratch instances on this machine:')
    for (const row of others) {
      console.log(`  ${basename(row.root).padEnd(44)} ${String(row.port ?? '?').padEnd(6)} ${row.state}`)
    }
  }
}

/** Every scratch root under the temp directory, and whether it is alive. */
const listAll = () => {
  /** @type {{root: string, port: number | undefined, state: string}[]} */
  const rows = []
  const tmp = tmpdir()
  let entries
  try {
    entries = readdirSync(tmp)
  } catch {
    return rows
  }
  for (const entry of entries) {
    if (!/^swb-scratch-[A-Za-z0-9._-]+-[0-9a-f]{6}$/.test(entry)) continue
    const root = join(tmp, entry)
    let port
    try {
      port = Number(readFileSync(join(root, 'port'), 'utf8').trim())
    } catch {
      port = undefined
    }
    /** @type {{pid: number} | undefined} */
    let run
    try {
      run = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8'))
    } catch {
      try {
        run = { pid: Number(readFileSync(join(root, 'server.pid'), 'utf8').trim()) }
      } catch {
        run = undefined
      }
    }
    const state = run !== undefined && psArgsFor(run.pid) !== undefined ? 'running' : 'stale'
    rows.push({ root, port, state })
  }
  return rows
}
