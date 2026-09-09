import { createRequire } from 'node:module'
import { customAlphabet } from 'nanoid'
import type {
  AttentionState,
  Session,
  SessionKind,
  SessionLiveness,
  ServerMsg,
} from '@ide-n-dream/shared'
import { encodeOutputFrame } from '@ide-n-dream/shared'
import { config } from '../config.js'
import { TerminalMirror } from './mirror.js'
import { classify, REPAINT_QUIET_MS, WORKING_WINDOW_MS } from './attention.js'
import {
  attachArgs,
  attachCommandFor,
  childEnv,
  capturePane,
  createSession,
  hasSession,
  killSession,
  listPanes,
  listSessions,
  readMeta,
  respawnSession,
  startServer,
  writeMeta,
  type SessionMeta,
} from './tmux.js'

/** node-pty is CommonJS; see the note in mirror.ts about this interop. */
const require = createRequire(import.meta.url)
const nodePty = require('node-pty') as typeof import('node-pty')

/**
 * tmux rewrites `.` and `:` in session names to `_` *silently*, which would let
 * two different logical sessions collide on one tmux session. This alphabet
 * cannot produce either character, nor a leading `-` that tmux would read as a
 * flag.
 */
const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10)

/**
 * The command line a kind gets when nothing asks for anything else. Shared by
 * create and respawn, which used to hardcode it separately and disagree.
 */
const defaultArgs = (kind: SessionKind): string[] => (kind === 'claude' ? [] : ['-l'])

/** How far back a tail looks for something worth showing. */
const SCROLLBACK_SEARCHED = 200

export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 34

/** Where terminal bytes go. Implemented by the WebSocket layer. */
export interface Sink {
  readonly open: boolean
  sendBinary(data: Uint8Array): void
  sendJson(msg: ServerMsg): void
}

interface Attachment {
  streamId: number
  sink: Sink
  /** Size authority: only the focused detail view sets the pty size. */
  primary: boolean
  cols: number
  rows: number
}

export interface CreateSessionRequest {
  worktreeId: string
  projectId: string
  kind: SessionKind
  cwd: string
  title?: string
  cols?: number
  rows?: number
  /** Extra environment for the hosted command, e.g. IDE integration ports. */
  env?: Record<string, string>
  /**
   * Arguments for the hosted command, replacing the default for its kind.
   *
   * The one caller that needs this is waking a worktree, which starts Claude
   * with `--continue` so the conversation that was stopped comes back rather
   * than a blank one.
   */
  args?: string[]
}

let nextStreamId = 1

/**
 * One live terminal: its tmux session, the pty attached to it, the server-side
 * mirror of its screen, and everyone currently watching.
 */
class LiveSession {
  readonly mirror: TerminalMirror
  readonly attachments = new Map<Sink, Attachment>()

  pty: import('node-pty').IPty | null = null
  liveness: SessionLiveness = 'live'
  attention: AttentionState = 'idle'
  /**
   * When output last arrived, and zero until it does.
   *
   * Not `Date.now()`: a session adopted at startup has no idea when it last
   * spoke, and claiming "just now" made every one of them read as working for
   * the first second after a restart.
   */
  lastOutputAt = 0
  /**
   * Output arriving before this is a repaint we provoked, not activity.
   * See the note in onOutput().
   */
  private repaintQuietUntil = 0
  dead = false
  deadStatus: number | null = null
  /** What the pane is running, refreshed by the poller. */
  command: string | null = null

  /** Sole input authority; see FocusMsg in the shared protocol. */
  inputOwner: Sink | null = null

  /**
   * The attachment whose geometry the pty follows: the most recent view to
   * attach or resize as primary.
   *
   * Picking "the first primary attachment" instead was a real bug: a leaked or
   * lingering socket kept its stale geometry at the front of the map and
   * overrode the view actually on screen, so the browser shrank its terminal
   * while the pty stayed large. On the alternate screen there is no reflow to
   * paper over that, so the mismatch showed as permanent corruption.
   */
  sizeOwner: Sink | null = null

  private pendingOut: Uint8Array[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private reattachAttempts = 0
  private disposed = false

  constructor(
    public record: Session,
    private readonly meta: SessionMeta,
    private readonly onStateChange: (s: LiveSession) => void,
  ) {
    this.mirror = new TerminalMirror(record.cols, record.rows)
  }

  /**
   * The project this session belongs to.
   *
   * It lives in the tmux metadata rather than on the `Session` record, because
   * a client identifies a session by its worktree and never needs the project.
   * Closing a project does, and it needs it from the session rather than from
   * the worktree list -- a session whose worktree has since gone is still that
   * project's process to stop.
   */
  get projectId(): string {
    return this.meta.projectId
  }

  get name(): string {
    return this.record.tmuxName
  }

  /**
   * Attach a pty client to the tmux session.
   *
   * Exactly one tmux client exists per session, and it lives here in the server.
   * Browsers are never tmux clients, which is what removes the whole class of
   * "tmux resizes the window to the smallest attached client" problems.
   */
  spawnPty(): void {
    if (this.disposed || this.pty) return
    const pty = nodePty.spawn('tmux', attachArgs(this.name), {
      // TERM as presented to tmux by the *outer* terminal, which is xterm.js.
      // tmux's `terminal-features` entries key off this, including RGB.
      name: 'xterm-256color',
      cols: this.record.cols,
      rows: this.record.rows,
      cwd: this.meta.cwd,
      env: childEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }),
    })
    this.pty = pty

    pty.onData((chunk) => this.onOutput(chunk))
    pty.onExit(() => {
      this.pty = null
      if (this.disposed) return
      void this.handlePtyExit()
    })
  }

  /**
   * The pty ended. That does NOT necessarily mean the session ended: it also
   * happens if the client is detached externally. Only a missing tmux session
   * means death, so re-attach when the session is still there.
   */
  private async handlePtyExit(): Promise<void> {
    if (await hasSession(this.name)) {
      if (this.reattachAttempts >= 5) {
        this.markDead(null)
        return
      }
      const delay = 100 * 2 ** this.reattachAttempts
      this.reattachAttempts++
      setTimeout(() => {
        if (!this.disposed) this.spawnPty()
      }, delay)
      return
    }
    this.markDead(null)
  }

  markDead(status: number | null): void {
    if (this.liveness === 'dead') return
    this.liveness = 'dead'
    this.dead = true
    this.deadStatus = status
    this.attention = 'idle'
    this.onStateChange(this)
  }

  private onOutput(chunk: string): void {
    this.reattachAttempts = 0
    /*
     * Output we asked for does not mean the agent is doing anything.
     *
     * Resizing a pane makes the TUI repaint its whole screen, so a tile merely
     * appearing -- which resizes the pty to its new pane's geometry -- used to
     * flash "working" for the length of the window and then settle back to
     * idle, on a session that had been resting the entire time. The bytes still
     * reach the mirror and every watcher; they just do not count as activity.
     */
    const provoked = Date.now() < this.repaintQuietUntil
    if (!provoked) this.lastOutputAt = Date.now()
    this.mirror.write(chunk)

    const bytes = Buffer.from(chunk, 'utf8')
    this.pendingOut.push(bytes)
    // Coalesce: a busy TUI emits many small writes, and one WebSocket frame per
    // write would swamp the client (and every tile watching it).
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushOutput(), 12)
    }

    if (!provoked && this.attention !== 'working') {
      this.attention = 'working'
      this.onStateChange(this)
    }
    // Scheduled either way, so a session that was working when the resize hit
    // still gets reclassified once the repaint has gone quiet.
    this.scheduleIdleCheck()
  }

  private flushOutput(): void {
    this.flushTimer = null
    if (this.pendingOut.length === 0) return
    const payload = Buffer.concat(this.pendingOut)
    this.pendingOut = []
    for (const attachment of this.attachments.values()) {
      if (attachment.sink.open) {
        attachment.sink.sendBinary(encodeOutputFrame(attachment.streamId, payload))
      }
    }
  }

  private scheduleIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.refreshAttention()
    }, WORKING_WINDOW_MS + 50)
  }

  refreshAttention(): void {
    const next = classify({
      kind: this.record.kind,
      lastOutputAt: this.lastOutputAt,
      dead: this.dead,
      tailText: () => this.mirror.tailText(),
    })
    if (next !== this.attention) {
      this.attention = next
      this.onStateChange(this)
    }
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  /**
   * Resize to whatever the size-authoritative attachment wants.
   *
   * With no primary attached the size is left alone: an overview tile must never
   * reflow a running TUI just by being looked at.
   */
  /** Drop attachments whose socket has gone away. */
  private pruneClosed(): void {
    for (const [sink] of this.attachments) {
      if (!sink.open) {
        this.attachments.delete(sink)
        if (this.sizeOwner === sink) this.sizeOwner = null
        if (this.inputOwner === sink) this.inputOwner = null
      }
    }
  }

  applySize(): void {
    this.pruneClosed()
    const owned = this.sizeOwner ? this.attachments.get(this.sizeOwner) : undefined
    // Fall back to the most recently added primary, not the first.
    const primary =
      owned?.primary === true
        ? owned
        : [...this.attachments.values()].filter((a) => a.primary).at(-1)
    if (process.env.IDN_DEBUG_SIZE) {
      console.log(
        `[size] ${this.record.tmuxName} attachments=${this.attachments.size}` +
          ` primary=${primary ? `${primary.cols}x${primary.rows}` : 'none'}` +
          ` owner=${owned ? 'yes' : 'no'}` +
          ` record=${this.record.cols}x${this.record.rows} pty=${this.pty ? 'yes' : 'NULL'}`,
      )
    }
    if (!primary) return
    const { cols, rows } = primary
    if (cols < 2 || rows < 2) return
    if (cols === this.record.cols && rows === this.record.rows) return
    this.record.cols = cols
    this.record.rows = rows
    this.mirror.resize(cols, rows)
    this.pty?.resize(cols, rows)
    // Whatever comes back from this is the TUI redrawing at the new size.
    this.repaintQuietUntil = Date.now() + REPAINT_QUIET_MS
    if (process.env.IDN_DEBUG_SIZE) {
      console.log(`[size] ${this.record.tmuxName} -> applied ${cols}x${rows}`)
    }
    for (const attachment of this.attachments.values()) {
      if (attachment.sink.open) {
        attachment.sink.sendJson({ t: 'size', sessionId: this.record.id, cols, rows })
      }
    }
  }

  async snapshot(): Promise<string> {
    return this.mirror.snapshot()
  }

  toRecord(): Session {
    return {
      ...this.record,
      liveness: this.liveness,
      exitStatus: this.deadStatus,
      ...(this.command === null ? {} : { command: this.command }),
      attention: this.attention,
      lastOutputAt: this.lastOutputAt,
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.pty?.kill()
    this.pty = null
    this.mirror.dispose()
    this.attachments.clear()
  }
}

/**
 * Owns every terminal in the IDE.
 *
 * Lifecycle: tmux sessions are created detached and outlive this process, so a
 * server restart reconnects to running Claude sessions rather than killing them.
 * `reconcile()` rebuilds the in-memory model from tmux itself, using metadata
 * stored in tmux user options, so the model survives loss of the state file.
 */
export class SessionEngine {
  private readonly sessions = new Map<string, LiveSession>()
  private poller: NodeJS.Timeout | null = null
  private readonly listeners = new Set<(session: Session) => void>()

  onSessionChange(listener: (session: Session) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(live: LiveSession): void {
    const record = live.toRecord()
    for (const listener of this.listeners) listener(record)
  }

  async start(): Promise<void> {
    await startServer()
    await this.reconcile()
    // Polled because `remain-on-exit on` means an exited command leaves the
    // session (and our pty) alive, so death has no push notification; and
    // because refresh-client -B format subscriptions never fire on tmux 3.3a.
    this.poller = setInterval(() => void this.pollPanes(), 2000)
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller)
    this.poller = null
    for (const live of this.sessions.values()) live.dispose()
    this.sessions.clear()
  }

  /** Adopt every tmux session on our socket that carries our metadata. */
  async reconcile(): Promise<void> {
    const existing = await listSessions()
    for (const info of existing) {
      const meta = info.meta ?? (await readMeta(info.name))
      if (!meta) continue
      if (this.sessions.has(meta.sessionId)) continue
      const record: Session = {
        id: meta.sessionId,
        worktreeId: meta.worktreeId,
        kind: meta.kind,
        tmuxName: info.name,
        title: meta.title,
        cols: info.cols || DEFAULT_COLS,
        rows: info.rows || DEFAULT_ROWS,
        liveness: 'live',
        attention: 'idle',
        lastOutputAt: Date.now(),
        createdAt: meta.createdAt,
        attachCommand: attachCommandFor(info.name),
      }
      const live = new LiveSession(record, meta, (s) => this.emit(s))
      this.sessions.set(record.id, live)
      live.spawnPty()
    }
  }

  /** One tmux call refreshes liveness for every session. */
  private async pollPanes(): Promise<void> {
    const panes = await listPanes()
    const byName = new Map(panes.map((p) => [p.sessionName, p]))
    for (const live of this.sessions.values()) {
      const pane = byName.get(live.name)
      if (!pane) {
        live.markDead(null)
        continue
      }
      if (pane.dead && live.liveness === 'live') live.markDead(pane.deadStatus)
      if (pane.command !== '' && pane.command !== live.command) {
        live.command = pane.command
        // The label changed, so the UI needs to hear about it.
        this.emit(live)
      }
      live.refreshAttention()
    }
  }

  list(): Session[] {
    return [...this.sessions.values()].map((live) => live.toRecord())
  }

  listForWorktree(worktreeId: string): Session[] {
    return this.list().filter((s) => s.worktreeId === worktreeId)
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)?.toRecord()
  }

  async create(req: CreateSessionRequest): Promise<Session> {
    const id = newId()
    const tmuxName = `idn-${id}`
    const cols = req.cols ?? DEFAULT_COLS
    const rows = req.rows ?? DEFAULT_ROWS
    const title = req.title ?? (req.kind === 'claude' ? 'claude' : 'shell')

    const command = req.kind === 'claude' ? config.claudeCommand : config.shellCommand
    // A login shell so the user's PATH and profile apply, exactly as it would if
    // they had opened a terminal themselves.
    const args = req.args ?? defaultArgs(req.kind)

    await createSession({
      name: tmuxName,
      cwd: req.cwd,
      command,
      args,
      cols,
      rows,
      env: { COLORTERM: 'truecolor', ...req.env },
    })

    const meta: SessionMeta = {
      sessionId: id,
      worktreeId: req.worktreeId,
      projectId: req.projectId,
      kind: req.kind,
      title,
      cwd: req.cwd,
      createdAt: Date.now(),
    }
    await writeMeta(tmuxName, meta)

    const record: Session = {
      id,
      worktreeId: req.worktreeId,
      kind: req.kind,
      tmuxName,
      title,
      cols,
      rows,
      liveness: 'live',
      attention: 'working',
      lastOutputAt: Date.now(),
      createdAt: meta.createdAt,
      attachCommand: attachCommandFor(tmuxName),
    }
    const live = new LiveSession(record, meta, (s) => this.emit(s))
    this.sessions.set(id, live)
    live.spawnPty()
    return live.toRecord()
  }

  /** Restart the command in a dead session's pane, keeping the session. */
  /**
   * Restart a dead session in place, keeping its tmux session and history.
   *
   * `args` matter here: without them this re-derived the command line from the
   * session's kind alone, so reviving a Claude session always started a fresh
   * conversation -- which is precisely what waking a worktree must not do.
   */
  async respawn(sessionId: string, args?: string[]): Promise<Session | undefined> {
    const live = this.sessions.get(sessionId)
    if (!live) return undefined
    const command = live.record.kind === 'claude' ? config.claudeCommand : config.shellCommand
    const spawnArgs = args ?? defaultArgs(live.record.kind)
    await respawnSession(live.name, command, spawnArgs)
    live.liveness = 'live'
    live.dead = false
    live.deadStatus = null
    live.spawnPty()
    this.emit(live)
    return live.toRecord()
  }

  /**
   * Whether a session's command died with a non-zero status within `withinMs`.
   *
   * Polled on its own clock rather than waiting for `pollPanes`: two seconds is
   * fine for painting a label, but this decides whether to restart a command,
   * and the point of doing it is to have done it before anyone looks.
   *
   * A dead pane whose status tmux did not report is not a failure here. The
   * only thing that could act on it is a guess, and guessing wrong restarts
   * something the user stopped on purpose.
   */
  async failedWithin(sessionId: string, withinMs: number): Promise<boolean> {
    const deadline = Date.now() + withinMs
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const live = this.sessions.get(sessionId)
      // Killed while we waited -- sleeping a worktree does exactly this.
      if (!live) return false
      const pane = (await listPanes()).find((p) => p.sessionName === live.name)
      if (!pane) return false
      if (pane.dead) return (pane.deadStatus ?? 0) !== 0
    }
    return false
  }

  /**
   * The last lines a session printed.
   *
   * Read from tmux, not from the mirror: the mirror holds only what has arrived
   * since this process attached, so a session adopted after a server restart
   * has an empty one, and it is exactly the sessions that died before anyone
   * was watching that need explaining.
   */
  async tail(sessionId: string, lines: number): Promise<string[]> {
    const live = this.sessions.get(sessionId)
    if (!live) return []
    const captured = await capturePane(live.name, SCROLLBACK_SEARCHED)
    return captured.slice(-lines)
  }

  async kill(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId)
    if (!live) return
    this.sessions.delete(sessionId)
    await killSession(live.name)
    live.dispose()
  }

  /**
   * Kill a worktree's sessions, optionally only some kinds.
   *
   * Sleeping a worktree stops its processes to give the machine back, and the
   * two opt-outs let you keep either half: Claude because you want it to carry
   * on thinking, terminals because their scrollback is not recoverable the way
   * a conversation is.
   */
  async killForWorktree(worktreeId: string, kinds?: SessionKind[]): Promise<void> {
    const doomed = [...this.sessions.values()].filter(
      (l) => l.record.worktreeId === worktreeId && (!kinds || kinds.includes(l.record.kind)),
    )
    await Promise.all(doomed.map((l) => this.kill(l.record.id)))
  }

  /** Sessions belonging to a project, whatever worktree they are in. */
  listForProject(projectId: string): Session[] {
    return [...this.sessions.values()]
      .filter((l) => l.projectId === projectId)
      .map((l) => l.toRecord())
  }

  /**
   * Stop everything a project is running.
   *
   * By the project recorded in each session rather than by walking the
   * project's worktrees, so a session whose worktree has been removed -- or
   * whose project directory has moved, and no longer lists it -- is still
   * stopped rather than left running with nothing on screen owning it.
   */
  async killForProject(projectId: string): Promise<void> {
    const doomed = [...this.sessions.values()].filter((l) => l.projectId === projectId)
    await Promise.all(doomed.map((l) => this.kill(l.record.id)))
  }

  // --- attachment plumbing, driven by the WebSocket layer -------------------

  async attach(
    sink: Sink,
    sessionId: string,
    cols: number,
    rows: number,
    primary: boolean,
  ): Promise<void> {
    const live = this.sessions.get(sessionId)
    if (!live) {
      sink.sendJson({ t: 'error', sessionId, message: 'no such session' })
      return
    }
    const existing = live.attachments.get(sink)
    const attachment: Attachment = existing ?? {
      streamId: nextStreamId++,
      sink,
      primary,
      cols,
      rows,
    }
    attachment.primary = primary
    attachment.cols = cols
    attachment.rows = rows
    live.attachments.set(sink, attachment)

    if (primary) {
      live.sizeOwner = sink
      live.applySize()
    }
    // First attachment gets input authority so a single open view just works.
    if (live.inputOwner === null) live.inputOwner = sink

    const snapshot = await live.snapshot()
    sink.sendJson({
      t: 'attached',
      sessionId,
      streamId: attachment.streamId,
      cols: live.record.cols,
      rows: live.record.rows,
      snapshot,
    })
    sink.sendJson({
      t: 'session-state',
      sessionId,
      liveness: live.liveness,
      exitStatus: live.deadStatus,
      attention: live.attention,
      lastOutputAt: live.lastOutputAt,
    })
  }

  detach(sink: Sink, sessionId: string): void {
    const live = this.sessions.get(sessionId)
    if (!live) return
    this.dropAttachment(live, sink)
  }

  detachAll(sink: Sink): void {
    for (const live of this.sessions.values()) this.dropAttachment(live, sink)
  }

  private dropAttachment(live: LiveSession, sink: Sink): void {
    live.attachments.delete(sink)
    if (live.inputOwner === sink) {
      live.inputOwner = live.attachments.keys().next().value ?? null
    }
    // Deliberately no resize here: the geometry the departing view set stays
    // until another view claims ownership, so closing a tab does not reflow a
    // running TUI.
    if (live.sizeOwner === sink) live.sizeOwner = null
  }

  focus(sink: Sink, sessionId: string): void {
    const live = this.sessions.get(sessionId)
    if (!live || !live.attachments.has(sink)) return
    live.inputOwner = sink
  }

  /**
   * Input is accepted from the input owner only. Besides keeping two people from
   * fighting over a keyboard, this is what stops two attached browsers from both
   * auto-answering the app's terminal queries and corrupting its stdin.
   */
  input(sink: Sink, sessionId: string, data: string): void {
    const live = this.sessions.get(sessionId)
    if (!live) return
    if (live.inputOwner !== sink) return
    live.write(data)
  }

  resize(sink: Sink, sessionId: string, cols: number, rows: number): void {
    const live = this.sessions.get(sessionId)
    if (!live) return
    const attachment = live.attachments.get(sink)
    if (!attachment) return
    attachment.cols = cols
    attachment.rows = rows
    if (attachment.primary) {
      live.sizeOwner = sink
      live.applySize()
    }
  }
}
