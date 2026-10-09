import { createRequire } from 'node:module'
import { customAlphabet } from 'nanoid'
import type {
  AttentionState,
  Session,
  SessionKind,
  SessionLiveness,
  ServerMsg,
} from '@switchboard/shared'
import { encodeOutputFrame } from '@switchboard/shared'
import { config } from '../config.js'
import { TerminalMirror } from './mirror.js'
import { classify, REPAINT_QUIET_MS, WORKING_WINDOW_MS } from './attention.js'
import { turnState, type TurnState } from './claude.js'
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
  refreshClients,
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
/**
 * Enough rows to be the whole visible screen.
 *
 * `classify` looks for a dialog, and a dialog is not where you would guess: the
 * option list of a plan approval sat 5 rows above the bottom and a question
 * dialog's sat 11, each option carrying a paragraph of its own. The old 12-row
 * window caught both by a row or two. `tailText` strips trailing blanks and
 * clamps to the screen, so asking for more rows than exist simply gets all of
 * them.
 */
const SCREEN_ROWS = 200

const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10)

/**
 * The command line a kind gets when nothing asks for anything else. Shared by
 * create and respawn, which used to hardcode it separately and disagree.
 */
const defaultArgs = (kind: SessionKind): string[] => (kind === 'claude' ? [] : ['-l'])

/**
 * Whether a chunk from a browser is someone typing, as opposed to xterm.js
 * answering the app.
 *
 * Terminal apps ask their terminal questions -- device attributes, cursor
 * position -- and xterm.js replies on its own, through the same socket a
 * keystroke takes. Measured with a tab merely open on a Claude session: those
 * replies arrive steadily, and taking them for a human at the keyboard held the
 * todo queue off for as long as the tab was open.
 *
 * So: strip the escape sequences and see whether anything is left. What remains
 * is text, Return or backspace -- the things a person actually produces while
 * drafting a prompt.
 */
const looksTyped = (data: string): boolean =>
  data
    // CSI (with its private-mode and intermediate bytes), then OSC, then SS3.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bO[A-Za-z]/g, '')
    // DCS, which is how xterm answers a DECRQSS: the reply rides the same
    // socket as a keystroke, and counted as one it holds the queue off for as
    // long as a tab is open -- the very thing this function exists to prevent.
    .replace(/\x1bP[\s\S]*?(?:\x1b\\|\x07)/g, '')
    .replace(/\x1b/g, '') !== ''

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
  /** Not readonly: `revive()` replaces it, because `markDead` disposes it. */
  mirror: TerminalMirror
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
   * When a browser last sent this session a keystroke.
   *
   * Only the human's path sets it -- `SessionEngine.input` does, `write` does
   * not -- because it exists to answer "is someone at this keyboard right now",
   * and the queue typing into the session is not someone.
   */
  lastUserInputAt = 0
  /** Set once the mirror has been disposed with the session; see markDead. */
  private mirrorGone = false
  /** Where the pane is, from tmux, so its transcript can be found. */
  cwd = ''
  /**
   * What Claude's transcript last said about the turn.
   *
   * Refreshed only when a session would otherwise be called idle -- see
   * refreshAttention. A session that is plainly producing output never pays for
   * the read.
   */
  turn: TurnState = 'unknown'
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
    /*
     * The screen goes with it.
     *
     * A dead session keeps its record -- the tile says "exited (1)" and offers
     * to start it again, which is the whole point of tmux's remain-on-exit --
     * but nothing reads its mirror: the pane renders the placeholder instead of
     * a terminal, so no browser ever attaches. Left alone, every session that
     * died on its own held 5000 lines of scrollback for the life of the
     * process.
     */
    this.mirror.dispose()
    this.mirrorGone = true
    this.onStateChange(this)
  }

  /**
   * Undo `markDead` for a session that is being started again in place.
   *
   * Everything markDead tore down has to come back, or the record outlives the
   * process it described: a disposed mirror answers the empty string to every
   * reader of the screen, and the 'idle' it set is what the todo queue types
   * into. The clocks are reset rather than kept -- the new process has said
   * nothing yet, and the old one's last word is not its.
   */
  revive(): void {
    if (this.mirrorGone) {
      this.mirror = new TerminalMirror(this.record.cols, this.record.rows)
      this.mirrorGone = false
    }
    this.attention = 'working'
    this.lastOutputAt = 0
    this.turn = 'unknown'
    this.reattachAttempts = 0
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
    if (!this.mirrorGone) this.mirror.write(chunk)

    const bytes = Buffer.from(chunk, 'utf8')
    this.pendingOut.push(bytes)
    // Coalesce: a busy TUI emits many small writes, and one WebSocket frame per
    // write would swamp the client (and every tile watching it).
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushOutput(), 12)
    }

    if (!provoked && this.attention !== 'working') {
      /*
       * Output means work, except while a dialog is up.
       *
       * This is the fast path -- an agent that starts producing should say so
       * before the next poll -- but a dialog redraws too, and flipping a
       * waiting worktree to "working" for the second until the idle check
       * catches up is exactly the wrong answer about the one state that needs
       * you. So a session already known to be waiting is re-read from the
       * screen instead of assumed.
       */
      const next =
        this.attention === 'needs-you'
          ? classify({
              kind: this.record.kind,
              lastOutputAt: this.lastOutputAt,
              dead: this.dead,
              tailText: () => this.mirror.tailText(SCREEN_ROWS),
              turn: this.turn,
            })
          : 'working'
      if (next !== this.attention) {
        this.attention = next
        this.onStateChange(this)
      }
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
      void this.refreshAttention()
    }, WORKING_WINDOW_MS + 50)
  }

  /**
   * Reclassify, consulting the transcript only if it could change the answer.
   *
   * The screen and the clock are free; the transcript is a file read, per
   * session, and this runs every two seconds. So the cheap classification comes
   * first, and the disk is touched only when it says `idle` -- which is exactly
   * the answer that was wrong when a turn was quietly still running.
   */
  async refreshAttention(): Promise<void> {
    /*
     * Read the turn record whenever the session is quiet, which is exactly when
     * the answer can depend on it: while output is arriving the state is
     * "working" whatever the transcript says, and the read would be wasted.
     *
     * It was previously fetched only when the rest of the evidence already said
     * "idle" -- which broke the moment ambiguity started answering "working"
     * instead, because then nothing ever asked for it and a session could sit
     * grey for good. `turnState` keeps its own mtime cache, so a quiet agent
     * whose transcript has not moved costs a directory listing, not a read.
     */
    const quiet = Date.now() - this.lastOutputAt >= WORKING_WINDOW_MS
    if (quiet && this.record.kind === 'claude' && this.cwd !== '' && !this.dead) {
      this.turn = await turnState(this.cwd)
    }
    const next = classify({
      kind: this.record.kind,
      lastOutputAt: this.lastOutputAt,
      dead: this.dead,
      tailText: () => this.mirror.tailText(SCREEN_ROWS),
      turn: this.turn,
    })
    if (next !== this.attention) {
      this.attention = next
      this.onStateChange(this)
    }
  }

  /**
   * Count the next moment of output as a redraw rather than as activity.
   *
   * For repaints we asked for: a resize, or the refresh after adopting a
   * session. Without it, a session that has been resting for an hour flashes
   * "working" the instant the server comes back.
   */
  expectRepaint(): void {
    this.repaintQuietUntil = Date.now() + REPAINT_QUIET_MS
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  /** Whether there is a pty to write to at all; null through a reattach. */
  get attached(): boolean {
    return this.pty !== null
  }

  /**
   * Write, and say whether there was anywhere for it to go.
   *
   * `write` swallows a null pty, which is right for a keystroke -- the human
   * will press it again -- and wrong for a queued prompt, where "we sent it" and
   * "it went nowhere" must not look the same.
   */
  tryWrite(data: string): boolean {
    if (!this.pty) return false
    this.pty.write(data)
    return true
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
    if (process.env.SWB_DEBUG_SIZE) {
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
    if (process.env.SWB_DEBUG_SIZE) {
      console.log(`[size] ${this.record.tmuxName} -> applied ${cols}x${rows}`)
    }
    for (const attachment of this.attachments.values()) {
      if (attachment.sink.open) {
        attachment.sink.sendJson({ t: 'size', sessionId: this.record.id, cols, rows })
      }
    }
  }

  async snapshot(): Promise<string> {
    // A dead session has no screen to repaint: the tile shows the placeholder
    // and offers to start it again, so nothing attaches here.
    return this.mirrorGone ? '' : this.mirror.snapshot()
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
  private readonly goneListeners = new Set<(sessionId: string) => void>()

  onSessionChange(listener: (session: Session) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * A session removed itself. Distinct from `onSessionChange`, which says a
   * session changed: this one is no longer in `list()`, so the snapshot is what
   * has to be refetched, not a field patched.
   */
  onSessionGone(listener: (sessionId: string) => void): () => void {
    this.goneListeners.add(listener)
    return () => this.goneListeners.delete(listener)
  }

  private emit(live: LiveSession): void {
    const record = live.toRecord()
    for (const listener of this.listeners) listener(record)
    if (record.kind === 'shell' && record.liveness === 'dead') void this.reap(record.id)
  }

  /**
   * A terminal that has exited closes itself.
   *
   * `remain-on-exit on` keeps a dead pane so a *Claude* that stopped can be
   * read and respawned in place -- that is the whole reason it is on, and it
   * stays on. A terminal has nothing to read: you typed `exit`, and what is
   * left is tmux's own "Pane is dead" line over a screen you are finished with,
   * plus a tab you now have to close by hand.
   *
   * Every dead terminal, not only one that exited zero. `exit` with no argument
   * returns the status of the last command, so Ctrl-D after a failing command
   * exits non-zero -- the status cannot tell a deliberate exit from a crash
   * here, and "the last command failed" is the common case, not the rare one.
   *
   * Here rather than in the browser because a terminal exits whether or not
   * anyone is watching, and a tmux session no interface can reach should not
   * outlive the tab being closed.
   */
  private async reap(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) return
    await this.kill(sessionId)
    for (const listener of this.goneListeners) listener(sessionId)
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
        /*
         * These two are shape, not fact: `toRecord()` reports the instance's
         * own `attention` and `lastOutputAt`, so whatever is written here is
         * replaced before anyone sees it. They match the instance's defaults so
         * reading this does not suggest otherwise -- and zero is right for an
         * adopted session, which has no idea when it last spoke.
         */
        attention: 'idle',
        lastOutputAt: 0,
        createdAt: meta.createdAt,
        attachCommand: attachCommandFor(info.name),
      }
      const live = new LiveSession(record, meta, (s) => this.emit(s))
      this.sessions.set(record.id, live)
      live.spawnPty()
      /*
       * Ask tmux to paint the screen once, so the mirror knows what is on it.
       *
       * An adopted session starts with an empty mirror and tmux sends nothing
       * until the app writes something of its own. Everything that reads the
       * mirror -- the attention label, the readiness gate, a browser's first
       * repaint -- was therefore blind to an agent sitting on a static screen,
       * and a dialog waiting for an answer is exactly that. It read as idle.
       *
       * Marked as a repaint we provoked, so the output it causes does not count
       * as the agent doing something; see `onOutput`.
       */
      /*
       * The quiet window starts when the repaint is actually asked for, not
       * before two process spawns and a tmux round trip: REPAINT_QUIET_MS is
       * 500ms, and a repaint that lands after it expires is counted as the
       * agent doing something -- a session resting for an hour flashing
       * "working" the instant the server comes back.
       */
      void refreshClients(info.name).then((asked) => {
        if (asked) live.expectRepaint()
      })
    }
  }

  /** One tmux call refreshes liveness for every session. */
  /** One poll at a time; a slow tmux must not have two of these interleaving. */
  private polling = false

  private async pollPanes(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      await this.pollPanesOnce()
    } finally {
      this.polling = false
    }
  }

  private async pollPanesOnce(): Promise<void> {
    const panes = await listPanes()
    // tmux could not be asked. Saying nothing is right: the alternative is to
    // read a failed call as "every pane is gone" and kill the model of four
    // healthy agents over one EAGAIN.
    if (panes === null) return
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
      if (pane.cwd !== '') live.cwd = pane.cwd
      await live.refreshAttention()
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
    // Decorative. `reconcile()` adopts whatever on our socket carries the
    // metadata option, and reads the name back off tmux, so the prefix is for
    // a human running `tmux ls` and nothing reads it.
    const tmuxName = `swb-${id}`
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
    /*
     * A session that has just been started is working: something is painting
     * its first screen. This has to be said on the instance, because
     * `toRecord()` reports the instance and not the literal above -- set only
     * there, a brand-new Claude window read as idle until its first byte
     * arrived, and idle is what the todo queue types into.
     */
    live.attention = 'working'
    live.lastOutputAt = Date.now()
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
    /*
     * A respawn is a new process on a screen we have never seen: the mirror was
     * disposed when the session died (markDead), so without a new one every
     * reader of the screen -- the attention label, the readiness gate, a
     * browser's repaint -- sees the empty string forever, and `attention` is
     * still the 'idle' markDead left behind. The backoff counter is reset too,
     * or a session that died after exhausting its reattach attempts can never
     * pick up its pty again.
     */
    live.revive()
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
      const panes = await listPanes()
      // tmux unreachable: no evidence either way, so keep waiting rather than
      // report a failure that would restart something the user did not lose.
      if (panes === null) continue
      const pane = panes.find((p) => p.sessionName === live.name)
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
    if (looksTyped(data)) live.lastUserInputAt = Date.now()
    live.write(data)
  }

  /**
   * Type into a session from the server itself.
   *
   * Deliberately not `input()`: that one requires the caller to be the session's
   * input owner, and there is no owner -- no Sink at all -- when this runs with
   * every browser closed, which is the case the todo queue exists for. The
   * safety this bypasses is "two viewers must not both answer the app's terminal
   * queries", which is about duplicate auto-replies from xterm.js and has
   * nothing to say about the server writing on purpose.
   *
   * Returns false when there was no pty to write to, so the caller can tell a
   * prompt that went nowhere from one that was delivered.
   */
  typeInto(sessionId: string, data: string): boolean {
    const live = this.sessions.get(sessionId)
    if (!live) return false
    return live.tryWrite(data)
  }

  /** Everything the dispatcher needs to decide whether it may type here. */
  async inspect(sessionId: string): Promise<
    | undefined
    | {
        kind: SessionKind
        dead: boolean
        hasPty: boolean
        lastOutputAt: number
        lastUserInputAt: number
        tail: string
        brightTail: string
      }
  > {
    const live = this.sessions.get(sessionId)
    if (!live) return undefined
    // The emulator parses asynchronously, so a synchronous read can miss the
    // repaint that would have changed the answer.
    if (live.dead) return undefined
    await live.mirror.flush()
    return {
      kind: live.record.kind,
      dead: live.liveness === 'dead',
      hasPty: live.attached,
      lastOutputAt: live.lastOutputAt,
      lastUserInputAt: live.lastUserInputAt,
      // The whole screen for the dialog and busy checks; the input box is at
      // the bottom either way, and its own read wants dim cells blanked.
      tail: live.mirror.tailText(SCREEN_ROWS),
      brightTail: live.mirror.tailText(SCREEN_ROWS, { skipDim: true }),
    }
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
