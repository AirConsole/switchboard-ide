import { execFile, spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { UpdateCommit, UpdateStatus } from '@switchboard/shared'
import { config } from './config.js'
import { HttpError } from './http-error.js'

const exec = promisify(execFile)

/**
 * The checkout this server was built from: `server/dist/..`, or `server/src/..`
 * under the tests, which is the same directory.
 */
export const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')

/**
 * How long a fetch stays good.
 *
 * Every open tab asks on its own clock and a fetch is a round trip to GitHub,
 * so the answer is shared the way `/usage` shares its reading. Nothing runs on
 * a timer: no browser asking means no fetch, which is the rule the git polling
 * follows too. Ten minutes is how long a merge can go unnoticed, which for
 * "there is a newer version" is soon enough.
 */
const TTL_MS = 10 * 60 * 1000

/** Longer than a fetch over a slow link; short enough that a hung ssh clears. */
const FETCH_TIMEOUT_MS = 30 * 1000

/** A banner lists a few subjects; the count says the rest. */
const MAX_COMMITS = 20

/** Lines of `pnpm pull`'s output a failure is shown with. */
const FAILURE_LINES = 12

/*
 * Never a prompt. The server has no terminal, and a fetch that wants a
 * password would otherwise wait for one until the timeout -- the ssh half is
 * covered by stdin being closed, which makes ssh fail rather than ask.
 */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }

const git = async (cwd: string, args: string[], timeout = 10_000): Promise<string> => {
  const { stdout } = await exec('git', args, { cwd, env: GIT_ENV, timeout, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

const gitOk = async (cwd: string, args: string[]): Promise<boolean> => {
  try {
    await git(cwd, args)
    return true
  } catch {
    return false
  }
}

/**
 * The commit `server/dist` was built from, read once: `swb restart` writes it
 * beside the build, and a later build overwrites it while this process is
 * still the old one. Read at start, it is what *this* process is running.
 */
const readStamp = (root: string): string | null => {
  try {
    return readFileSync(join(root, 'server', 'dist', '.swb-commit'), 'utf8').trim() || null
  } catch {
    return null
  }
}

const runningCommit = readStamp(repoRoot)

/**
 * Is this the process `pnpm pull` would restart?
 *
 * `run.json` is what `swb start` writes for the machine's instance, and its
 * pid being ours is the whole question: a scratch instance, `pnpm dev` and a
 * server started by hand are not it, and a pull from here would restart
 * somebody else -- or, from a scratch instance's environment, point `swb` at
 * its state directory instead of the machine's.
 */
const isMachineInstance = (): { host?: string } | undefined => {
  try {
    const run = JSON.parse(readFileSync(join(config.stateDir, 'run.json'), 'utf8')) as {
      pid?: unknown
      repo?: unknown
      host?: unknown
    }
    if (run.pid !== process.pid || run.repo !== repoRoot) return undefined
    return typeof run.host === 'string' && run.host !== '' ? { host: run.host } : {}
  } catch {
    return undefined
  }
}

/** `origin/HEAD` first, then `main` and `master` -- the order `swb pull` tries. */
const defaultBranch = async (cwd: string): Promise<string | null> => {
  try {
    return (await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '')
  } catch {
    for (const name of ['main', 'master']) {
      if (await gitOk(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`])) return name
    }
    return null
  }
}

export interface Behind {
  branch: string | null
  commits: UpdateCommit[]
  behind: number
  blocked: string | null
}

/**
 * What origin has that `running` does not, and whether `pnpm pull` could take
 * it -- against the refs as they are, without fetching.
 *
 * Measured from the *build*, not from HEAD. After a `git pull` by hand the
 * checkout is current and the process is not, and that is exactly the case
 * `pnpm pull` restarts for; comparing HEAD would have said there was nothing
 * to do. An unstamped build falls back to HEAD, which is the best it knows.
 *
 * The refusals are `swb pull`'s own (`cli/src/pull.js`), asked here so the
 * banner can say one before the click instead of failing after it. They are
 * repeated rather than shared because that file is plain JavaScript with no
 * build, run before anything here exists.
 */
export const behindOrigin = async (cwd: string, running: string | null): Promise<Behind> => {
  const branch = await defaultBranch(cwd)
  if (branch === null) return { branch, commits: [], behind: 0, blocked: 'origin has no default branch' }
  const upstream = `origin/${branch}`
  const base = running ?? (await git(cwd, ['rev-parse', 'HEAD']))
  // A stamp naming a commit this clone does not have is not "behind"; it is
  // nothing we can reason about, and pull will rebuild whatever it finds.
  const known = await gitOk(cwd, ['cat-file', '-e', `${base}^{commit}`])
  const log = known ? await git(cwd, ['log', '--format=%H%x09%s', `${base}..${upstream}`]) : ''
  const lines = log === '' ? [] : log.split('\n')
  const commits = lines.slice(0, MAX_COMMITS).map((line) => {
    const tab = line.indexOf('\t')
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) }
  })

  let blocked: string | null = null
  const current = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current !== branch) {
    blocked = `${cwd} is on "${current}", not "${branch}"`
  } else if ((await git(cwd, ['status', '--porcelain', '--untracked-files=no'])) !== '') {
    blocked = `${cwd} has uncommitted changes`
  } else if (!(await gitOk(cwd, ['merge-base', '--is-ancestor', 'HEAD', upstream]))) {
    blocked = `${cwd} has commits that ${upstream} does not`
  }
  return { branch, commits, behind: lines.length, blocked }
}

let checked: (Behind & { at: number }) | null = null
let checking: Promise<void> | null = null
let fetchError: string | undefined
let state: UpdateStatus['state'] = 'idle'
let failure: string | null = null

const check = async (): Promise<void> => {
  try {
    await git(repoRoot, ['fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS)
    fetchError = undefined
  } catch (err) {
    // Still answered from the refs we have: they are only older, not wrong.
    const stderr = (err as { stderr?: unknown }).stderr
    fetchError = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : 'git fetch failed'
  }
  checked = { ...(await behindOrigin(repoRoot, runningCommit)), at: Date.now() }
}

export const updateStatus = async (): Promise<UpdateStatus> => {
  const base = { instance: config.instanceId, running: runningCommit }
  if (isMachineInstance() === undefined) {
    return {
      ...base,
      updatable: false,
      branch: null,
      commits: [],
      behind: 0,
      blocked: null,
      state: 'idle',
      failure: null,
      checkedAt: null,
    }
  }
  if (state !== 'updating' && (checked === null || Date.now() - checked.at > TTL_MS)) {
    // One fetch for every tab that asks while it runs.
    checking ??= check()
      .catch((err: unknown) => {
        fetchError = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        checking = null
      })
    await checking
  }
  return {
    ...base,
    updatable: true,
    branch: checked?.branch ?? null,
    commits: checked?.commits ?? [],
    behind: checked?.behind ?? 0,
    blocked: checked?.blocked ?? null,
    state,
    failure,
    checkedAt: checked?.at ?? null,
    ...(fetchError === undefined ? {} : { error: fetchError }),
  }
}

/**
 * Run `pnpm pull`, which ends by stopping this process and starting its
 * successor.
 *
 * **Detached, so it outlives us.** It is going to SIGTERM this server halfway
 * through, and a child in our process group or session would go with it -- and
 * with it the start of the new server. `detached` is setsid(2), the same thing
 * `swb start` does for the server itself.
 *
 * `swb.js` under this node rather than `pnpm pull`: the script is all pnpm
 * would run, and pnpm's own environment is the one thing a pull must not pick
 * up -- `npm_command=restart`, inherited from the `pnpm restart` that started
 * us, is how `swb` tells its lifecycle wrappers apart.
 *
 * Its output goes to a file beside `server.log`, because the pull's own lines
 * -- which commits, the build, a refusal -- are what a failure is shown with.
 */
export const startUpdate = async (): Promise<void> => {
  const machine = isMachineInstance()
  if (machine === undefined) throw new HttpError(409, 'this server is not the machine instance `pnpm pull` restarts')
  if (state === 'updating') throw new HttpError(409, 'an update is already running')
  /*
   * The banner never offers a blocked pull, but a linked machine asking for one
   * has not seen this machine's banner -- and a refusal said in the reply is
   * one the asker can show, where a pull failing here afterwards is not.
   */
  const { blocked } = await updateStatus()
  if (blocked !== null) throw new HttpError(409, `pnpm pull would refuse: ${blocked}`)
  // Asked again: two clicks can both have been waiting on that fetch.
  if ((state as UpdateStatus['state']) === 'updating') throw new HttpError(409, 'an update is already running')

  const logFile = join(config.stateDir, 'update.log')
  const log = openSync(logFile, 'w', 0o600)
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('npm_')) env[key] = value
  const args = [join(repoRoot, 'cli', 'bin', 'swb.js'), 'pull']
  // What this server was started with, which may have been a flag and not the
  // config file -- `restart` would otherwise fall back to the file and lose it.
  if (machine.host !== undefined) args.push('--host', machine.host)
  const child = spawn(process.execPath, args, { cwd: repoRoot, env, detached: true, stdio: ['ignore', log, log] })
  closeSync(log)
  child.unref()
  state = 'updating'
  failure = null

  /*
   * A pull that restarts us never reports back: we are gone before it exits.
   * So an exit we *do* see is either a refusal or failure -- the server is still
   * the old one and the page has to be told why -- or a pull that found nothing
   * to do, which is `idle` and a fresh fetch.
   */
  child.on('exit', (code) => {
    checked = null
    if (code === 0) {
      state = 'idle'
      return
    }
    state = 'failed'
    let tail = ''
    try {
      tail = readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-FAILURE_LINES).join('\n')
    } catch {
      // the log is gone; the code is all there is
    }
    failure = tail === '' ? `pnpm pull exited with ${String(code)}` : tail
  })
  child.on('error', (err) => {
    state = 'failed'
    failure = err.message
  })
}
