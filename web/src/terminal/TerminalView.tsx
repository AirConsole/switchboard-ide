import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Session } from '@ide-n-dream/shared'
import { terminalSocket, type ConsumerOptions } from '../socket.js'
import '@xterm/xterm/css/xterm.css'

export interface TerminalViewProps {
  session: Session
  /**
   * Size authority. The focused detail view is primary and drives the pty size;
   * overview tiles are not, and instead shrink the font to fit.
   */
  primary: boolean
  /** Fixed font size for tiles. When omitted the terminal fits its container. */
  fontSize?: number
  className?: string
  onFocusCapture?: () => void
}

const THEME = {
  background: '#0e1116',
  foreground: '#d7dce3',
  cursor: '#8ab4f8',
  selectionBackground: '#2d4f76',
  black: '#0e1116',
  red: '#ff6b6b',
  green: '#6bd968',
  yellow: '#e6c07b',
  blue: '#7aa2f7',
  magenta: '#c792ea',
  cyan: '#56d4dd',
  white: '#d7dce3',
  brightBlack: '#5b6472',
} as const

export const TerminalView = ({
  session,
  primary,
  fontSize,
  className,
  onFocusCapture,
}: TerminalViewProps): React.ReactElement => {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: primary,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: fontSize ?? 13,
      lineHeight: 1.2,
      theme: THEME,
      scrollback: 10000,
      // Needed by the unicode11 addon and for wide-glyph handling generally --
      // Claude Code's TUI is full of box drawing and emoji-width characters.
      allowProposedApi: true,
      // The server decides geometry; a tile must never renegotiate it.
      cols: session.cols,
      rows: session.rows,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'

    term.open(host)

    // WebGL only for the terminal actually being read. A grid of live WebGL
    // contexts exhausts the browser's context limit and drops them all.
    if (primary) {
      try {
        term.loadAddon(new WebglAddon())
      } catch {
        // Falls back to the DOM renderer, which is fine.
      }
    }

    /**
     * OSC 52 (clipboard write). xterm.js 6 registers handlers for OSC
     * 0/1/2/4/8/10-12/104/110-112 but NOT 52, so without this an app's copy
     * request is silently dropped. tmux forwards it to us as `ESC ]52;;<base64>`.
     */
    term.parser.registerOscHandler(52, (data) => {
      const payload = data.slice(data.indexOf(';') + 1)
      try {
        const text = new TextDecoder().decode(
          Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)),
        )
        void navigator.clipboard?.writeText(text)
      } catch {
        // Malformed base64 from a misbehaving app: ignore rather than throw
        // inside the parser, which would break the whole output stream.
      }
      return true
    })

    /**
     * Shift+Enter and Ctrl+Enter as CSI-u.
     *
     * xterm.js does not implement CSI-u output at all, and its default for
     * Shift+Enter is a plain CR -- which in Claude Code submits the prompt
     * instead of inserting a newline. Claude requests modifyOtherKeys level 2
     * at startup and tmux (with `extended-keys on`) passes these through, so
     * emitting the sequence ourselves is what makes multi-line input work.
     * Modifier encoding is 1 + shift(1) + alt(2) + ctrl(4).
     *
     * preventDefault() is essential and easy to miss: returning false only stops
     * xterm's own keydown handling, it does NOT stop the browser's default text
     * input. Without it the keypress still inserts a newline into xterm's helper
     * textarea, whose input handler forwards it as a second, plain CR -- so the
     * prompt gets submitted anyway and Shift+Enter appears not to work at all.
     */
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (event.key === 'Enter' && !event.altKey && !event.metaKey) {
        if (event.shiftKey || event.ctrlKey) {
          const modifier = 1 + (event.shiftKey ? 1 : 0) + (event.ctrlKey ? 4 : 0)
          terminalSocket.input(session.id, `\x1b[13;${modifier}u`)
          event.preventDefault()
          event.stopPropagation()
          return false
        }
      }
      return true
    })

    term.onData((data) => terminalSocket.input(session.id, data))
    term.onBinary((data) => terminalSocket.input(session.id, data))

    const consumer: ConsumerOptions = {
      primary,
      cols: session.cols,
      rows: session.rows,
      onData: (payload) => term.write(payload),
      onSnapshot: (snapshot, cols, rows) => {
        // A repaint replaces the screen wholesale; clearing first stops old
        // contents showing through where the snapshot is shorter.
        term.reset()
        if (!primary) term.resize(cols, rows)
        term.write(snapshot)
      },
      onSize: (cols, rows) => {
        if (!primary) term.resize(cols, rows)
      },
    }
    const unsubscribe = terminalSocket.subscribe(session.id, consumer)

    // Only a primary terminal negotiates geometry, from its own element size;
    // tiles keep the server's geometry and scale their font instead.
    let observer: ResizeObserver | null = null
    if (primary) {
      let frame = 0
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          const dims = fit.proposeDimensions()
          if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
          if (dims.cols < 2 || dims.rows < 2) return
          if (dims.cols === term.cols && dims.rows === term.rows) return
          term.resize(dims.cols, dims.rows)
          terminalSocket.resize(session.id, consumer, dims.cols, dims.rows)
        })
      })
      observer.observe(host)
    }

    return () => {
      observer?.disconnect()
      unsubscribe()
      term.dispose()
    }
    // session.cols/rows are intentionally excluded: a primary terminal drives
    // them, so reacting to them here would tear the terminal down on every
    // resize it caused itself.
  }, [session.id, primary, fontSize])

  return (
    <div
      // The host must fill its parent. Without an explicit size it collapses to
      // its content height, and the fit addon then measures that instead of the
      // pane -- which silently pins the terminal to whatever size it happened to
      // start at and leaves the rest of the pane empty.
      className={className ? `term-host ${className}` : 'term-host'}
      ref={hostRef}
      // Claiming input authority on pointer-down means clicking a tile in the
      // overview lets you answer a prompt right there.
      onPointerDown={() => {
        terminalSocket.focus(session.id)
        onFocusCapture?.()
      }}
    />
  )
}
