import { decodeOutputFrame, type ClientMsg, type ServerMsg } from '@switchboard/shared'
import { api } from './api.js'

export interface ConsumerOptions {
  /** Size authority. True for the focused detail view, false for overview tiles. */
  primary: boolean
  cols: number
  rows: number
  onData(payload: Uint8Array): void
  /** Called with a full repaint whenever this consumer needs to (re)paint. */
  onSnapshot(snapshot: string, cols: number, rows: number): void
  onSize?(cols: number, rows: number): void
  /**
   * The server refused this session: it is gone, and no snapshot is coming.
   *
   * Without it the pane sat blank for the life of the page and the only trace
   * was a console warning -- the consumer had been dropped from the socket, so
   * nothing would ever paint it and nothing would say why.
   */
  onGone?(message: string): void
}

interface Consumer extends ConsumerOptions {
  /** Whether this consumer has already been painted from a snapshot. */
  painted: boolean
}

type StateListener = (msg: Extract<ServerMsg, { t: 'session-state' }>) => void

/**
 * One WebSocket for every terminal on the page.
 *
 * Subscriptions are reference-counted per session. That matters because React
 * can mount the detail view's terminal before unmounting the overview tile for
 * the same session; without refcounting, the tile's unmount would detach the
 * session out from under the view that just took over, and the new view would
 * go dead. Attach happens on the first consumer, detach on the last.
 */
class TerminalSocket {
  private ws: WebSocket | null = null
  private readonly consumers = new Map<string, Set<Consumer>>()
  private readonly streamToSession = new Map<number, string>()
  private readonly stateListeners = new Set<StateListener>()
  private readonly invalidateListeners = new Set<() => void>()
  private reconnectTimer: number | null = null
  private reconnectDelay = 500
  private connecting = false
  private readonly authListeners = new Set<() => void>()

  /** Told when the session is gone, so the app can show a login rather than a dead row. */
  onUnauthorized(listener: () => void): () => void {
    this.authListeners.add(listener)
    return () => this.authListeners.delete(listener)
  }

  private unauthorized(): void {
    for (const listener of this.authListeners) listener()
  }

  connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    if (this.connecting) return
    this.connecting = true
    void this.open()
  }

  /**
   * A ticket first, then the socket.
   *
   * The session cookie is deliberately not what opens this. Cookies ignore the
   * port, so a page on a sibling port of this hostname is same-site and the
   * browser would hand it our cookie on a socket it opened -- and a WebSocket
   * is exempt from CORS. A ticket is fetched over `/api`, where the origin is
   * checked, so that page cannot get one.
   *
   * It travels in the subprotocol because that is the only thing a browser can
   * put on an upgrade; a query string would be written to every access log.
   */
  private async open(): Promise<void> {
    let ticket: string
    try {
      ticket = await api.wsTicket()
    } catch {
      this.connecting = false
      // A ticket needs a session, so failing to get one means signed out. Say
      // so rather than retrying forever behind a row that never paints.
      this.unauthorized()
      return
    }
    this.connecting = false
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/ws`, [ticket])
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.reconnectDelay = 500
      // Re-attach everything: after a drop, every consumer needs a fresh repaint
      // because output produced while we were away never reached this page.
      for (const set of this.consumers.values()) {
        for (const consumer of set) consumer.painted = false
      }
      for (const sessionId of this.consumers.keys()) this.sendAttach(sessionId)
    }

    ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data !== 'string') {
        this.handleBinary(new Uint8Array(event.data))
        return
      }
      this.handleJson(JSON.parse(event.data) as ServerMsg)
    }

    ws.onclose = (event) => {
      // Only react if this is still the live socket. Without the check, a close
      // event arriving for an already-replaced socket cleared `this.ws` and
      // scheduled another connect, leaving two open sockets attached to the same
      // sessions -- and a stale one competing for terminal geometry.
      if (this.ws !== ws) return
      this.ws = null
      /*
       * 4401 is "not signed in" and 1008 is "origin not allowed". Before these
       * were told apart, both were an invisible forever-retry: a signed-out tab
       * and a misconfigured `--host` looked identical from here, and neither
       * said anything. A signed-out tab must stop and show a login; a
       * misconfigured host must keep retrying, because the row will paint the
       * moment somebody fixes it.
       */
      if (event.code === 4401) {
        this.unauthorized()
        return
      }
      this.scheduleReconnect()
    }
    ws.onerror = () => ws.close()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000)
  }

  private handleBinary(frame: Uint8Array): void {
    const decoded = decodeOutputFrame(frame)
    if (!decoded) return
    const sessionId = this.streamToSession.get(decoded.streamId)
    if (sessionId === undefined) return
    const set = this.consumers.get(sessionId)
    if (!set) return
    for (const consumer of set) {
      // Output that arrives before a consumer's snapshot is already included in
      // that snapshot, so delivering it too would duplicate it on screen.
      if (consumer.painted) consumer.onData(decoded.payload)
    }
  }

  private handleJson(msg: ServerMsg): void {
    switch (msg.t) {
      case 'attached': {
        /*
         * A second `attached` for a session we already have is a *re*-attach:
         * the server has re-claimed it on our behalf and given it a new stream
         * number. That happens when a remote worktree's machine restarts --
         * the gateway re-attaches for us, and this socket never closed, so
         * nothing else would ever reset `painted`. Without a repaint the pane
         * kept showing the screen from before the restart, silently, and
         * everything the agent printed in the gap was dropped -- on the
         * alternate screen, where replayed history is meaningless and only a
         * serialized repaint is worth anything.
         */
        for (const [streamId, sessionId] of this.streamToSession) {
          if (sessionId !== msg.sessionId || streamId === msg.streamId) continue
          // The old number will never carry anything again; leaving it mapped
          // is one stale entry per restart.
          this.streamToSession.delete(streamId)
          for (const consumer of this.consumers.get(msg.sessionId) ?? []) {
            consumer.painted = false
          }
        }
        this.streamToSession.set(msg.streamId, msg.sessionId)
        const set = this.consumers.get(msg.sessionId)
        if (!set) return
        for (const consumer of set) {
          if (consumer.painted) continue
          consumer.painted = true
          consumer.onSnapshot(msg.snapshot, msg.cols, msg.rows)
        }
        return
      }
      case 'size': {
        const set = this.consumers.get(msg.sessionId)
        if (!set) return
        for (const consumer of set) consumer.onSize?.(msg.cols, msg.rows)
        return
      }
      case 'session-state':
        for (const listener of this.stateListeners) listener(msg)
        return
      case 'invalidate':
        for (const listener of this.invalidateListeners) listener()
        return
      case 'error':
        console.warn('[terminal socket]', msg.message, msg.sessionId ?? '')
        /*
         * A session we asked for is gone -- killed by sleeping a worktree, or
         * by anything else while we were disconnected.
         *
         * Its consumers have to be dropped rather than left waiting. A consumer
         * only starts painting once it has had a snapshot, and no snapshot is
         * ever coming, so it would sit discarding output for a session that no
         * longer exists and its tile would be frozen for the life of the page.
         * Reconnecting re-asks for every subscribed id, so without this a
         * single vanished session poisons its tile permanently.
         */
        if (msg.sessionId !== undefined) {
          for (const consumer of this.consumers.get(msg.sessionId) ?? []) {
            consumer.onGone?.(msg.message)
          }
          this.consumers.delete(msg.sessionId)
        }
        return
    }
  }

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  /**
   * Attach with the union of what this page's consumers want: primary if any
   * consumer is primary, sized to that primary consumer.
   */
  private sendAttach(sessionId: string): void {
    const set = this.consumers.get(sessionId)
    if (!set || set.size === 0) return
    const primary = [...set].find((c) => c.primary)
    const source = primary ?? [...set][0]!
    this.send({
      t: 'attach',
      sessionId,
      cols: source.cols,
      rows: source.rows,
      primary: primary !== undefined,
    })
  }

  subscribe(sessionId: string, options: ConsumerOptions): () => void {
    const consumer: Consumer = { ...options, painted: false }
    let set = this.consumers.get(sessionId)
    if (!set) {
      set = new Set()
      this.consumers.set(sessionId, set)
    }
    set.add(consumer)
    this.connect()
    this.sendAttach(sessionId)

    return () => {
      const current = this.consumers.get(sessionId)
      if (!current) return
      current.delete(consumer)
      if (current.size === 0) {
        this.consumers.delete(sessionId)
        this.send({ t: 'detach', sessionId })
      } else {
        // A remaining consumer may have different size authority now.
        this.sendAttach(sessionId)
      }
    }
  }

  /** Update a consumer's geometry after a layout change. */
  resize(sessionId: string, consumerRef: ConsumerOptions, cols: number, rows: number): void {
    const set = this.consumers.get(sessionId)
    if (!set) return
    for (const consumer of set) {
      if (consumer.onData === consumerRef.onData) {
        consumer.cols = cols
        consumer.rows = rows
        if (consumer.primary) this.send({ t: 'resize', sessionId, cols, rows })
      }
    }
  }

  input(sessionId: string, data: string): void {
    this.send({ t: 'input', sessionId, data })
  }

  /** Claim sole input authority; see FocusMsg in the shared protocol. */
  focus(sessionId: string): void {
    this.send({ t: 'focus', sessionId })
  }

  onSessionState(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onInvalidate(listener: () => void): () => void {
    this.invalidateListeners.add(listener)
    return () => this.invalidateListeners.delete(listener)
  }
}

export const terminalSocket = new TerminalSocket()
