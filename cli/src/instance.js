/**
 * Where everything this CLI touches lives, and the guards that keep the
 * throwaway instances away from the real one.
 *
 * Everything here is pure or read-only: no spawning, no killing, no writing.
 * That is deliberate -- these are the derivations a mistake in would point
 * `rm -rf` or a `kill` at the wrong place, so they are the part with tests.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The checkout this CLI was loaded from: `cli/src/instance.js` -> `../..`. */
export const repoRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')

/** The server this CLI starts. Absolute, and that is load-bearing -- see `isOurServer`. */
export const serverScript = join(repoRoot, 'server', 'dist', 'index.js')

// ---------------------------------------------------------------------------
// The machine's one instance
// ---------------------------------------------------------------------------

/**
 * The state directory, matching `server/src/config.ts` exactly so that the CLI
 * and the server it starts never disagree about where state lives.
 * @returns {string}
 */
export const stateDir = () => process.env.SWB_STATE_DIR ?? join(homedir(), '.config', 'switchboard')

/** Settings: port, public host, peer token. 0600, because of the last one. */
export const configPath = () => join(stateDir(), 'config.json')
/** What `start` wrote about the process it started, so `stop` can identify it. */
export const runPath = () => join(stateDir(), 'run.json')
/** Replaces /tmp/swb-prod.log: one directory holds everything about one instance. */
export const logPath = () => join(stateDir(), 'server.log')

/**
 * @typedef {object} Config
 * @property {number} [port]
 * @property {string} [host]   Public name a browser types; becomes the --host flag.
 * @property {string} [bind]   Address to listen on; becomes the --bind flag.
 * @property {string} [token]  Shared secret making this instance readable as a peer.
 */

/**
 * Read `config.json`, or return an empty config.
 *
 * Every key is optional and a missing file is not an error: with no config at
 * all this serves loopback on 8084 with no token, which is exactly what
 * `server/src/config.ts` defaults to and exactly what the old `deploy.sh` did
 * with no `deploy.env`.
 * @returns {Config}
 */
export const readConfig = () => {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object')
    }
    return /** @type {Config} */ (parsed)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(`${path} is not readable as config: ${why}`)
  }
}

// ---------------------------------------------------------------------------
// Scratch instances
// ---------------------------------------------------------------------------

/** 8200-8499, clear of the live instance on 8084 and of Vite on 5240. */
export const PORT_FLOOR = 8200
export const PORT_SPAN = 300

/**
 * An instance name may not reach outside its own directory.
 *
 * The name is concatenated into a path that `stop` later removes recursively,
 * so this is the guard, not a nicety.
 * @param {string} name
 */
export const validateName = (name) => {
  if (name === '') return
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('an instance name may only hold letters, digits, . _ -')
  }
  /*
   * The character class above allows a dot, and therefore allowed `..` -- which
   * the shell version accepted too. It is not a traversal, because the name is
   * concatenated into the middle of one path segment rather than used as a
   * segment of its own, but nothing good comes of a directory called
   * `swb-scratch-ide-..-abc123` and the guard should not have to be read twice
   * to know that. Caught by the test, not by review.
   */
  if (/(^|[^A-Za-z0-9_-])\.\.?([^A-Za-z0-9_-]|$)/.test(name) || /\.\./.test(name)) {
    throw new Error('an instance name may not be or contain "." or ".."')
  }
}

/**
 * @typedef {object} Scratch
 * @property {string} name
 * @property {string} slug
 * @property {string} hash
 * @property {string} root
 * @property {string} stateDir
 * @property {string} tmuxSocket
 * @property {string} runFile
 * @property {string} portFile
 * @property {string} tokenFile
 * @property {string} logFile
 */

/**
 * Everything about one throwaway instance, derived from the checkout and an
 * optional name. Nothing here is stored, so two commands always agree.
 *
 * The hash is `sha1(repo + name)`, appended to the slug with no separator, and
 * both of those reproduce `scratch.sh` byte for byte -- it used
 * `printf '%s'`, so there is no trailing newline in the hashed input. That
 * matters because the hash decides the port, the state directory and the tmux
 * socket: changing it orphans a running instance, leaving a stray server and a
 * stray tmux with no handle left to reach them.
 *
 * @param {string} repo
 * @param {string} [name]
 * @param {string} [tmp]
 * @returns {Scratch}
 */
export const deriveScratch = (repo, name = '', tmp = tmpdir()) => {
  validateName(name)
  const slug = (basename(repo) + (name ? `-${name}` : '')).replace(/[^A-Za-z0-9._-]/g, '-')
  const hash = createHash('sha1').update(repo + name).digest('hex').slice(0, 6)
  const root = join(tmp, `swb-scratch-${slug}-${hash}`)
  return {
    name,
    slug,
    hash,
    root,
    stateDir: join(root, 'state'),
    /*
     * Outside `root`, and short, for two reasons that point the same way.
     * `sun_path` is 108 bytes on Linux but **104 on macOS**, where $TMPDIR is a
     * per-user path some 48 characters long before anything of ours -- measured,
     * `$TMPDIR/swb-scratch-<slug>-<hash>/state/tmux.sock` reaches 104 for a name
     * this repository actually uses, and tmux's failure there is an opaque bind
     * error after the server has already started and answered /api/health. It
     * also makes the path structurally impossible to confuse with the real
     * instance's socket, which is what `assertScratchPaths` checks.
     */
    tmuxSocket: join(tmp, `swb-${hash}.sock`),
    runFile: join(root, 'run.json'),
    portFile: join(root, 'port'),
    tokenFile: join(root, 'token'),
    logFile: join(root, 'server.log'),
  }
}

/**
 * Every port this instance would accept, best first.
 *
 * Derived first so a checkout keeps its port across restarts -- an agent that
 * forgets it can ask again and get the same answer -- and probed second by the
 * caller, because the derivation cannot know what else is listening.
 * @param {string} hash
 * @returns {number[]}
 */
export const portCandidates = (hash) => {
  const base = parseInt(hash, 16)
  return Array.from({ length: PORT_SPAN }, (_, i) => PORT_FLOOR + ((base + i) % PORT_SPAN))
}

/**
 * The environment a scratch server runs in.
 *
 * **Every inherited `SWB_*` is dropped.** A shell that exported `SWB_STATE_DIR`
 * or `SWB_TOKEN` -- an agent's pane, or a future service manager -- would
 * otherwise have a "scratch" server attach itself to the real instance's state
 * directory and tmux socket, which is live agents in a process this CLI treats
 * as disposable. The old shell version set its own values and never cleared the
 * parent's, and was safe only by luck.
 *
 * @param {NodeJS.ProcessEnv} parent
 * @param {Scratch} instance
 * @param {number} port
 * @param {string} [token]
 * @returns {NodeJS.ProcessEnv}
 */
export const scratchEnv = (parent, instance, port, token) => {
  /** @type {NodeJS.ProcessEnv} */
  const env = {}
  for (const [key, value] of Object.entries(parent)) {
    if (!key.startsWith('SWB_')) env[key] = value
  }
  env.SWB_STATE_DIR = instance.stateDir
  env.SWB_TMUX_SOCKET = instance.tmuxSocket
  env.SWB_PORT = String(port)
  env.NODE_ENV = 'production'
  // The stand-in for the agent. `vim` is the useful one for anything about
  // attention or resizing: silent at rest, full redraw on SIGWINCH.
  env.SWB_CLAUDE_CMD = parent.CLAUDE_CMD ?? 'bash'
  if (token !== undefined) {
    env.SWB_TOKEN = token
    env.SWB_SERVER_NAME = instance.name
  }
  return env
}

/**
 * Refuse to operate on anything that is not a scratch path.
 *
 * Called before every kill and every remove. The real instance's directory is
 * `~/.config/switchboard` and its socket is inside it; a scratch root is under
 * the temp directory with a shape nothing else has, and its socket is a sibling
 * named for the same hash. Nothing in this CLI ever reads `SWB_STATE_DIR` to
 * decide what to destroy -- it is all derived from the checkout and the name.
 * @param {Scratch} instance
 */
export const assertScratchPaths = (instance) => {
  const tmp = resolve(tmpdir())
  const root = resolve(instance.root)
  const shaped = /^swb-scratch-[A-Za-z0-9._-]+-[0-9a-f]{6}$/.test(basename(root))
  if (!root.startsWith(`${tmp}/`) || !shaped) {
    throw new Error(`refusing to touch ${instance.root}: not a scratch directory`)
  }
  if (resolve(instance.tmuxSocket) !== join(tmp, `swb-${instance.hash}.sock`)) {
    throw new Error(`refusing to touch ${instance.tmuxSocket}: not a scratch socket`)
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Is the process behind this `ps` line the server we started?
 *
 * The question exists because a pid can be recycled, and the old shell version
 * killed whatever the pid file named. It is answerable only because this CLI
 * spawns the server by its **absolute** path: the instance running on this
 * machine today shows `node dist/index.js --host ...`, a relative path naming no
 * checkout, so two servers from two checkouts print the same line.
 *
 * `includes` rather than splitting on whitespace: a macOS checkout under
 * `/Users/me/My Projects/...` makes tokenising ambiguous, and the path ends in
 * `/server/dist/index.js`, so `.../remote` cannot match `.../remote-as-embed`.
 *
 * @param {string} psArgs  the `ps -o args=` line for that pid
 * @param {string} script  the absolute server entry point we would have run
 */
export const isOurServer = (psArgs, script) => psArgs.includes(script)

/**
 * The `ps` line for a pid, or undefined if there is no such process.
 * `-o args=` and not `comm=`: on Linux `comm` is the *thread* name, and node
 * renames its main thread, so `ps -o comm=` answers `MainThread`.
 * @param {number} pid
 * @returns {string | undefined}
 */
export const psArgsFor = (pid) => {
  try {
    return execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined // no such process; ps exits non-zero
  }
}

/**
 * Is this checkout a linked worktree rather than the main one?
 *
 * `--path-format=absolute` because without it `--git-dir` answers the literal
 * `.git` in a main checkout and an absolute path in a worktree, so the two are
 * not comparable as written. Do not test whether `.git` is a file: that is also
 * true of a submodule.
 * @param {string} [cwd]
 */
export const inLinkedWorktree = (cwd = repoRoot) => {
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')
  try {
    const [gitDir, commonDir] = git(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
    if (gitDir === undefined || commonDir === undefined) return false
    return resolve(gitDir) !== resolve(commonDir)
  } catch {
    // git older than 2.31 has no --path-format; resolve the relative answers
    // against cwd instead of guessing.
    try {
      const [gitDir, commonDir] = git(['rev-parse', '--git-dir', '--git-common-dir'])
      if (gitDir === undefined || commonDir === undefined) return false
      return resolve(cwd, gitDir) !== resolve(cwd, commonDir)
    } catch {
      return false // not a git repository at all
    }
  }
}
