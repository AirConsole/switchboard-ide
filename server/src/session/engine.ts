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
import { classify, WORKING_WINDOW_MS } from './attention.js'
import {
  attachArgs,
  attachCommandFor,
  childEnv,
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
  lastOutputAt = Date.now()
  dead = false
  deadStatus: number | null = null

  /** Sole input authority; see FocusMsg in the shared protocol. */
  inputOwner: Sink | null = null

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
    this.lastOutputAt = Date.now()
    this.mirror.write(chunk)

    const bytes = Buffer.from(chunk, 'utf8')
    this.pendingOut.push(bytes)
    // Coalesce: a busy TUI emits many small writes, and one WebSocket frame per
    // write would swamp the client (and every tile watching it).
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushOutput(), 12)
    }

    if (this.attention !== 'working') {
      this.attention = 'working'
      this.onStateChange(this)
    }
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
  applySize(): void {
    const primary = [...this.attachments.values()].find((a) => a.primary)
    if (!primary) return
    const { cols, rows } = primary
    if (cols < 2 || rows < 2) return
    if (cols === this.record.cols && rows === this.record.rows) return
    this.record.cols = cols
    this.record.rows = rows
    this.mirror.resize(cols, rows)
    this.pty?.resize(cols, rows)
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
    const args = req.kind === 'claude' ? [] : ['-l']

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
  async respawn(sessionId: string): Promise<Session | undefined> {
    const live = this.sessions.get(sessionId)
    if (!live) return undefined
    const command = live.record.kind === 'claude' ? config.claudeCommand : config.shellCommand
    const args = live.record.kind === 'claude' ? [] : ['-l']
    await respawnSession(live.name, command, args)
    live.liveness = 'live'
    live.dead = false
    live.deadStatus = null
    live.spawnPty()
    this.emit(live)
    return live.toRecord()
  }

  async kill(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId)
    if (!live) return
    this.sessions.delete(sessionId)
    await killSession(live.name)
    live.dispose()
  }

  async killForWorktree(worktreeId: string): Promise<void> {
    const doomed = [...this.sessions.values()].filter((l) => l.record.worktreeId === worktreeId)
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

    if (primary) live.applySize()
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
      attention: live.attention,
      lastOutputAt: live.lastOutputAt,
    })
  }

  detach(sink: Sink, sessionId: string): void {
    const live = this.sessions.get(sessionId)
    if (!live) return
    live.attachments.delete(sink)
    if (live.inputOwner === sink) {
      live.inputOwner = live.attachments.keys().next().value ?? null
    }
  }

  detachAll(sink: Sink): void {
    for (const live of this.sessions.values()) {
      live.attachments.delete(sink)
      if (live.inputOwner === sink) {
        live.inputOwner = live.attachments.keys().next().value ?? null
      }
    }
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
    if (attachment.primary) live.applySize()
  }
}
