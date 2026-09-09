import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config, tmuxSocketPath } from '../config.js'

const exec = promisify(execFile)

/** Args that address our private tmux server, prepended to every invocation. */
const socketArgs = (): string[] => ['-S', tmuxSocketPath, '-f', config.tmuxConf]

/**
 * Environment for tmux and for the sessions it hosts.
 *
 * Two families of inherited variables actively break things and must be dropped:
 *
 * - `TMUX`/`TMUX_PANE`: if the IDE server was itself started from inside tmux,
 *   `tmux attach` refuses to run ("sessions should be nested with care").
 * - `CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_PID`: if the server was started from
 *   inside a Claude Code session (entirely likely, given what this IDE is for),
 *   these mark the child as a nested Claude session, hand it a messaging socket
 *   and session id belonging to the parent, and point `CLAUDE_CODE_SSE_PORT` at
 *   whatever IDE the parent was attached to. A `claude` we spawn must start clean.
 */
export const childEnv = (extra: Record<string, string> = {}): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key === 'TMUX' || key === 'TMUX_PANE') continue
    if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE') continue
    if (key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT') continue
    out[key] = value
  }
  return { ...out, ...extra }
}

export interface TmuxResult {
  stdout: string
  stderr: string
}

/**
 * Run a tmux command against the private socket. Arguments are passed as an
 * array (never a shell string), so session names, paths and JSON metadata need
 * no quoting and cannot inject.
 */
export const tmux = async (...args: string[]): Promise<TmuxResult> => {
  const { stdout, stderr } = await exec('tmux', [...socketArgs(), ...args], {
    maxBuffer: 16 * 1024 * 1024,
    env: childEnv(),
  })
  return { stdout, stderr }
}

/**
 * Make sure the tmux server is up before anything else talks to it.
 *
 * Creating a session on a cold socket immediately after a `kill-server` races
 * and fails with "server exited unexpectedly", so the server is started
 * explicitly and then confirmed responsive with a trivial command.
 */
export const startServer = async (): Promise<void> => {
  await mkdir(dirname(tmuxSocketPath), { recursive: true })
  try {
    await tmux('start-server')
  } catch {
    // start-server is a no-op when the server is already up.
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await tmux('display-message', '-p', 'ok')
      return
    } catch {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  throw new Error(`tmux server did not become ready on ${tmuxSocketPath}`)
}

/** tmux exits non-zero for "no such session", which is a normal answer here. */
export const hasSession = async (name: string): Promise<boolean> => {
  try {
    await tmux('has-session', '-t', exactTarget(name))
    return true
  } catch {
    return false
  }
}

/**
 * `=` anchors the target to an exact session name, guarding against tmux's
 * fnmatch matching on target specs. Verified accepted by has-session,
 * kill-session, attach-session and resize-window on tmux 3.3a.
 */
export const exactTarget = (name: string): string => `=${name}`

/**
 * Target for commands that take a *target-pane* rather than a target-session:
 * set-option, show-options and respawn-pane.
 *
 * These reject the `=name` form outright ("no such session: =idn-x" /
 * "can't find pane: =idn-x") even though every session-targeting command
 * accepts it. Verified on tmux 3.3a. Hence the bare name here.
 */
export const paneTarget = (name: string): string => name

/** tmux forbids `.` and `:` in session names (they are target separators). */
export const isValidSessionName = (name: string): boolean =>
  name.length > 0 && !name.startsWith('-') && !/[.:\s]/.test(name)

export interface CreateSessionOptions {
  name: string
  cwd: string
  /** Command and args to run as the session's only pane. */
  command: string
  args?: string[]
  cols: number
  rows: number
  env?: Record<string, string>
}

/**
 * Create the session detached if it does not already exist. Detached creation
 * keeps session lifetime independent of our attaching pty, which is what lets
 * sessions survive an IDE restart.
 */
export const createSession = async (opts: CreateSessionOptions): Promise<void> => {
  if (!isValidSessionName(opts.name)) {
    throw new Error(`invalid tmux session name: ${opts.name}`)
  }
  if (await hasSession(opts.name)) return

  const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  await tmux(
    'new-session',
    '-d',
    '-s',
    opts.name,
    '-c',
    opts.cwd,
    // Without -x/-y a session with no client defaults to 80x24 and the TUI
    // paints itself at that size until something resizes it.
    '-x',
    String(opts.cols),
    '-y',
    String(opts.rows),
    ...envArgs,
    '--',
    opts.command,
    ...(opts.args ?? []),
  )
}

export const killSession = async (name: string): Promise<void> => {
  try {
    await tmux('kill-session', '-t', exactTarget(name))
  } catch {
    // Already gone is the desired end state.
  }
}

/** Resize a session's window directly; used when no pty client is attached. */
export const resizeSession = async (name: string, cols: number, rows: number): Promise<void> => {
  try {
    await tmux('resize-window', '-t', exactTarget(name), '-x', String(cols), '-y', String(rows))
  } catch {
    // Non-fatal: the attaching client's size wins anyway.
  }
}

const META_OPTION = '@idn_meta'

/**
 * Metadata is stored in tmux itself, not only in our state file, so the server
 * can rebuild its whole model from `tmux list-sessions` if the state file is
 * lost or stale. It lives exactly as long as the session does.
 */
export interface SessionMeta {
  sessionId: string
  worktreeId: string
  projectId: string
  kind: 'claude' | 'shell'
  title: string
  cwd: string
  createdAt: number
}

export const writeMeta = async (name: string, meta: SessionMeta): Promise<void> => {
  await tmux('set-option', '-t', paneTarget(name), META_OPTION, JSON.stringify(meta))
}

/** Read one session's metadata. Missing option yields '' and exit 0 under -qv. */
export const readMeta = async (name: string): Promise<SessionMeta | null> => {
  try {
    const { stdout } = await tmux('show-options', '-t', paneTarget(name), '-qv', META_OPTION)
    return parseMeta(stdout.trim())
  } catch {
    return null
  }
}

const parseMeta = (raw: string): SessionMeta | null => {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const m = parsed as Partial<SessionMeta>
    if (!m.sessionId || !m.worktreeId || !m.cwd) return null
    return m as SessionMeta
  } catch {
    return null
  }
}

export interface TmuxSessionInfo {
  name: string
  meta: SessionMeta | null
  cwd: string
  cols: number
  rows: number
}

/**
 * List every session on our socket with its metadata in one call. The unit
 * separator is used as the field delimiter because paths and titles may contain
 * anything a filesystem allows, including tabs.
 */
export const listSessions = async (): Promise<TmuxSessionInfo[]> => {
  let stdout: string
  try {
    ;({ stdout } = await tmux(
      'list-sessions',
      '-F',
      ['#{session_name}', `#{${META_OPTION}}`, '#{pane_current_path}', '#{window_width}', '#{window_height}'].join('\x1f'),
    ))
  } catch {
    // No server running yet means no sessions, which is not an error.
    return []
  }
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [name = '', meta = '', cwd = '', cols = '0', rows = '0'] = line.split('\x1f')
      return {
        name,
        meta: parseMeta(meta),
        cwd,
        cols: Number(cols) || 0,
        rows: Number(rows) || 0,
      }
    })
}

/**
 * The escape hatch we show in the UI so the user can take a session over from a
 * real terminal.
 *
 * `-f ignore-size` is essential: without it a joining client resizes the window
 * to ITS size (measured: a 60x20 terminal shrank a 120x40 window to 60x19, and
 * the size was not restored on detach), which would reflow the session for
 * everyone. The guest sees our geometry, possibly cropped, and leaves it alone.
 * Detach by closing the terminal - `prefix None` means there is no prefix key.
 */
export const attachCommandFor = (name: string): string =>
  `tmux -S ${tmuxSocketPath} attach -t ${name} -f ignore-size`

/**
 * Live pane facts for every session, in one tmux call (~2-3ms).
 *
 * This is how liveness is detected: `remain-on-exit on` means a session does NOT
 * disappear when its command exits, so the attaching pty stays open and gives us
 * no signal. `pane_dead` is the signal, and it comes with the exit status, which
 * is the whole reason we keep dead panes around.
 *
 * `refresh-client -B` format subscriptions would be the event-driven
 * alternative, but they silently never fire on 3.3a, so this is polled.
 */
export interface PaneInfo {
  sessionName: string
  cwd: string
  command: string
  cols: number
  rows: number
  dead: boolean
  deadStatus: number | null
  activity: number
}

export const listPanes = async (): Promise<PaneInfo[]> => {
  let stdout: string
  try {
    ;({ stdout } = await tmux(
      'list-panes',
      '-a',
      '-F',
      [
        '#{session_name}',
        '#{pane_current_path}',
        '#{pane_current_command}',
        '#{window_width}',
        '#{window_height}',
        '#{pane_dead}',
        '#{pane_dead_status}',
        '#{session_activity}',
      ].join('\x1f'),
    ))
  } catch {
    return []
  }
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const f = line.split('\x1f')
      return {
        sessionName: f[0] ?? '',
        cwd: f[1] ?? '',
        command: f[2] ?? '',
        cols: Number(f[3]) || 0,
        rows: Number(f[4]) || 0,
        dead: f[5] === '1',
        deadStatus: f[6] === '' || f[6] === undefined ? null : Number(f[6]),
        activity: Number(f[7]) || 0,
      }
    })
}

/**
 * tmux writes this line into a dead pane itself, from `remain-on-exit-format`.
 * The interface says the same thing in its own words, so in a tail it is noise.
 */
const DEAD_PANE_NOTE = /^Pane is dead \(/

/**
 * What a pane has printed lately, oldest line first, blanks removed.
 *
 * `-S -<n>` reaches back into the scrollback rather than capturing the visible
 * screen, because the line that explains an exit is usually no longer on it: a
 * pane whose only command has died keeps scrolling as it is respawned, and the
 * message that matters ends up above the fold. Measured on the real failure --
 * `claude --continue` refusing -- where a plain capture returned blank lines.
 */
export const capturePane = async (name: string, lines: number): Promise<string[]> => {
  let stdout: string
  try {
    ;({ stdout } = await tmux('capture-pane', '-p', '-S', `-${lines}`, '-t', paneTarget(name)))
  } catch {
    // A session that has gone away has nothing to say.
    return []
  }
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '' && !DEAD_PANE_NOTE.test(line))
}

/**
 * Bring a dead pane back to life in place, keeping the session (and its window
 * history) rather than making a new one.
 */
export const respawnSession = async (
  name: string,
  command: string,
  args: string[] = [],
): Promise<void> => {
  // A pane target, so the bare name -- see paneTarget.
  await tmux('respawn-pane', '-k', '-t', paneTarget(name), '--', command, ...args)
}

/** Args for a node-pty spawn of `tmux` that attaches to one session. */
export const attachArgs = (name: string): string[] => [
  ...socketArgs(),
  'attach-session',
  '-t',
  exactTarget(name),
]
