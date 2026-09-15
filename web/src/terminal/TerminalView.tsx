import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Session } from '@switchboard/shared'
import { terminalSocket, type ConsumerOptions } from '../socket.js'
import '@xterm/xterm/css/xterm.css'

/**
 * Must match the server's mirror scrollback (SWB_MIRROR_SCROLLBACK). xterm's
 * reflow is deterministic, so identical content plus identical scrollback keeps
 * this terminal and the mirror in step through a resize.
 */
const MIRROR_SCROLLBACK = 5000

/**
 * The terminal font.
 *
 * Menlo named first, then the generic. This is the font the user's own VS Code
 * terminal renders in: it sets no `terminal.integrated.fontFamily`, so it falls
 * through to the browser's `monospace`, which on macOS is Menlo. Naming it
 * makes that explicit instead of depending on a per-platform default, and the
 * generic still catches any machine without it.
 *
 * Deliberately NOT a stack of fonts that may or may not be installed -- the
 * earlier `"JetBrains Mono", "Fira Code", ...` meant this app and the terminal
 * beside it rendered in different faces on any machine where one happened to
 * be present.
 *
 * Exported because the overview derives its minimum tile width from this font's
 * character width, measured at runtime -- so the 80-column floor stays correct
 * on whatever this resolves to, machine to machine.
 */
export const TERMINAL_FONT_FAMILY = 'Menlo, monospace'

/**
 * Type size for every terminal.
 *
 * It is not only a readability choice: the overview derives its minimum tile
 * width from this font's character width, so this number also decides how many
 * windows a screen divides into.
 *
 * It decides that through the *cell* rather than the type size, because xterm
 * rasterises into an atlas and lays out whole pixels -- `measureMonoCharWidth`
 * floors for exactly that reason. At Menlo's 0.602 advance, 14px measures 8.43
 * and lays out 8, 13px measures 7.83 and lays out 7. Eighty columns is 640px
 * against 560, so the size steps in plateaus and one point is most of a tile.
 *
 * 13 was tried and rejected: it does buy a third window on a 1920 screen, at 84
 * columns against 80, and a window at every other common width too -- and it
 * reads too small for a row of agents you watch all day, which is what this
 * size is for. The layout is not the only thing it answers to. Do not reach for
 * it again to fit another window in; nothing about the arithmetic changed.
 *
 * The arithmetic is worth keeping, though, for whoever asks the same question
 * next. The other two candidates cannot reach it: `PANE_CHROME_WIDTH` is 18px
 * of the 658 a pane needs, so zeroing the padding outright still leaves 1920 at
 * two and a half windows, and doing it on columns means dropping
 * MIN_PANE_COLUMNS to 75, which is the promise the layout exists to keep.
 */
export const TERMINAL_FONT_SIZE = 14

export interface TerminalViewProps {
  session: Session
  /**
   * Size authority. The focused detail view is primary and drives the pty size;
   * overview tiles are not, and instead shrink the font to fit.
   */
  primary: boolean
  /** Fixed font size for tiles. When omitted the terminal fits its container. */
  fontSize?: number
  /**
   * Take the keyboard when this changes, and when it is already set at mount.
   *
   * A number rather than a flag because the same terminal may be asked for
   * twice running -- navigating back to a worktree you were just on -- and
   * because a terminal is often not mounted at the moment it is asked for: it
   * is built when its tile comes near the scrollport, which is after the scroll
   * that asked for it. Reading the request on mount is what closes that gap.
   */
  focus?: number | null
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
  focus = null,
  className,
  onFocusCapture,
}: TerminalViewProps): React.ReactElement => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: primary,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: fontSize ?? TERMINAL_FONT_SIZE,
      /*
       * 1, not 1.2, for the same reason VS Code's terminal uses 1: the cell
       * height is fontSize * lineHeight, and 14 * 1.2 = 16.8 is fractional.
       * The WebGL renderer rasterises glyphs into an atlas and blits them per
       * cell, so a fractional cell lands glyphs on half-pixels -- and at
       * devicePixelRatio 2 that is what reads as soft next to a terminal whose
       * cells are a whole number of pixels.
       */
      lineHeight: 1,
      theme: THEME,
      // Needed by the unicode11 addon and for wide-glyph handling generally --
      // Claude Code's TUI is full of box drawing and emoji-width characters.
      allowProposedApi: true,
      // Provisional: corrected from the element's real size below, before we
      // attach. Starting from the session record would use a value that is
      // often stale, and being wrong here is expensive -- see the note on
      // sizing below.
      cols: 80,
      rows: 24,
      // Match the server-side mirror, so a reflow on one side produces the same
      // result as on the other.
      scrollback: MIRROR_SCROLLBACK,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'

    termRef.current = term
    term.open(host)

    /*
     * Size to the element BEFORE attaching.
     *
     * The server serializes its mirror at the geometry we ask for, so asking
     * with the size we are actually going to use means the first paint lands in
     * a terminal of matching dimensions and needs no follow-up resize. Getting
     * this wrong is not a cosmetic glitch: a TUI on the alternate screen has no
     * reflow, so painting a snapshot taken at one size into a terminal of
     * another size loses content permanently, and the app -- which only sends
     * incremental updates -- never repaints the difference.
     */
    const initial = fit.proposeDimensions()
    if (initial && initial.cols >= 2 && initial.rows >= 2) {
      term.resize(initial.cols, initial.rows)
    }

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

    /*
     * Hovering is not input. Nothing in a row of windows reports it.
     *
     * A row of windows breaks the assumption every terminal emulator makes,
     * that the pointer is over the terminal you are typing into: here it
     * crosses two or three agents on its way anywhere, and rests on one while
     * you read. Claude asks for `1003` -- report any mouse event -- so xterm
     * reported every movement, and nothing in Claude's interface needs to know
     * where the pointer is. It was also the traffic that made this stack's
     * mouse bugs visible: one sweep across a pane put 17 reports into the agent
     * behind it.
     *
     * `buttons === 0` is the rule -- a bare move. A drag still reports, which
     * keeps xterm's selection and an app's own drag working, and so does a
     * click: `pointerdown` claims the keyboard before `mousedown` is
     * dispatched, so by the time xterm reports the press the pane is already
     * yours. Stopped in the capture phase, before xterm's listener on its own
     * element ever sees it.
     *
     * Only where an app is actually reporting, though. With no tracking mode
     * xterm's own mousemove is what underlines a link under the pointer and
     * shapes the cursor, and a pane that reports nothing was never the problem
     * -- a plain shell keeps both.
     */
    const hover = (event: MouseEvent): void => {
      if (event.buttons === 0 && term.modes.mouseTrackingMode !== 'none') {
        event.stopPropagation()
      }
    }
    host.addEventListener('mousemove', hover, true)

    /*
     * The wheel must never become keystrokes.
     *
     * On the alternate screen -- where Claude's TUI and vim live -- xterm.js
     * translates a wheel notch into an Up or Down arrow and sends it as input,
     * the way iTerm and friends do. In a terminal that fills a window that is
     * a reasonable trade; in a row of tiles you scroll with the same wheel it
     * is not. Measured against a stand-in agent that logs its stdin: one wheel
     * gesture with the pointer merely resting over a tile -- never clicked,
     * with the keyboard in a different tile -- delivered `ESC [ A` to that
     * tile's session. In Claude that recalls the previous prompt, which is
     * text appearing that nobody typed.
     *
     * Only that translation is cancelled, and only in that state: with a
     * tracking mode on, xterm binds its own wheel listener that reports to the
     * app and never consults this hook, so this is about a wheel over an app
     * that has NOT asked for the mouse -- vim without it, or Claude before it
     * sets its modes and after it exits. Returning false leaves the event
     * unconsumed, so the wheel goes back to scrolling the row it was aimed at.
     */
    term.attachCustomWheelEventHandler(
      () => !(term.buffer.active.type === 'alternate' && term.modes.mouseTrackingMode === 'none'),
    )

    /*
     * A legacy mouse report never goes on the wire.
     *
     * `ESC [ M` plus three bytes is xterm's default encoding, and in this stack
     * it is always a mistake: every app here asks for SGR (Claude sets `?1006h`
     * at startup; htop and vim do the same), and the mirror now carries that
     * encoding through a repaint, so the default can only appear if some new
     * desync has crept back in. It must not reach an agent if it does, for two
     * reasons measured on this stack. One, a byte above 127 -- any column past
     * 95 -- cannot survive `input`: the payload is a string of latin-1 code
     * units, `JSON.parse(raw.toString())` on the server hands it on, and
     * node-pty re-encodes it as two UTF-8 bytes, after which tmux consumes the
     * wrong three bytes of the report and passes the rest on as text. The pty
     * received a bare `9999...8888` -- the row byte of each report, printed
     * into the prompt. Two, `looksTyped` counts those leftovers as the user
     * typing, so a hover looked like activity.
     */
    const send = (data: string): void => {
      if (data.startsWith('\x1b[M')) return
      terminalSocket.input(session.id, data)
    }
    term.onData(send)
    term.onBinary(send)

    /*
     * A finger dragged up or down scrolls the app, because nothing else can.
     *
     * On the alternate screen there is no scrollback for the browser to move --
     * the app owns its own history -- and a phone has no wheel and no Page Up
     * key. Claude scrolls on Page Up and Page Down (measured: its "Jump to
     * bottom (ctrl+End)" hint appears on the first one), so a vertical drag
     * becomes those, half a pane's worth of drag to the page. Horizontal drags
     * are left alone: they belong to the row of windows.
     *
     * This is not the wheel rule in reverse. A wheel over a tile means "scroll
     * the row", so turning it into keystrokes was wrong; a finger dragged
     * inside a pane has no other meaning here, and a key is the only way to
     * scroll what the app is holding.
     */
    const PAGE_UP = '\x1b[5~'
    const PAGE_DOWN = '\x1b[6~'
    /*
     * The finger this gesture belongs to.
     *
     * By identifier, not `touches[0]`: a second finger landing mid-drag
     * reorders that list, and reading the wrong one moves the anchor to an
     * unrelated Y -- which came out as a burst of page keys at once, because
     * the leftover distance is spent in a `while`.
     */
    let finger: number | null = null
    let touchY = 0
    let touchX = 0
    let carried = 0
    let axis: 'vertical' | 'horizontal' | null = null

    const onTouchStart = (event: TouchEvent): void => {
      const touch = event.touches[0]
      if (event.touches.length !== 1 || !touch) return
      finger = touch.identifier
      touchY = touch.clientY
      touchX = touch.clientX
      carried = 0
      axis = null
    }

    /** Any change to which fingers are down ends the gesture. */
    const onTouchEnd = (): void => {
      finger = null
      carried = 0
      axis = null
    }

    const onTouchMove = (event: TouchEvent): void => {
      if (finger === null) return
      const touch = [...event.touches].find((t) => t.identifier === finger)
      // Its own finger has gone, or another has joined: stop rather than
      // measure against an anchor that no longer means anything.
      if (!touch || event.touches.length !== 1) {
        onTouchEnd()
        return
      }
      // Decided once per gesture, so a drifting finger does not change its
      // mind half way through.
      if (axis === null && Math.abs(touch.clientY - touchY) + Math.abs(touch.clientX - touchX) > 8) {
        axis =
          Math.abs(touch.clientY - touchY) > Math.abs(touch.clientX - touchX)
            ? 'vertical'
            : 'horizontal'
      }
      if (axis !== 'vertical') return
      event.preventDefault()
      carried += touch.clientY - touchY
      touchY = touch.clientY

      /*
       * Always the keys, because this terminal never has anything to scroll.
       *
       * The pty runs `tmux attach-session`, and tmux itself lives on the
       * alternate screen -- so every session here is an alternate-screen
       * terminal whatever runs inside it, and xterm holds exactly one screenful
       * and no scrollback. Measured: a shell that had just printed 300 lines
       * reported `type: 'alternate'`, `baseY: 0`, `length: 42` for 42 rows.
       * The history is tmux's, and the only way to reach it is to send keys.
       *
       * Claude answers Page Up and Page Down. A plain shell does not, and its
       * scrollback stays out of reach on a phone -- that wants a tmux copy-mode
       * binding, which `tmux.conf` deliberately does not have (`prefix None`,
       * every key unbound so the app gets them all). Worth doing, separately.
       */
      /*
       * An eighth of the pane's height per page, not half of it.
       *
       * Half the height was more than a drag: a finger on a phone travels
       * comfortably about 300px, and at 341px per page -- measured on a 400x800
       * screen -- a 300px pull sent **nothing at all** and the whole gesture
       * read as broken. A full-height 640px pull bought exactly one screenful.
       * Reading back through a long turn that way is a dozen full-screen drags.
       *
       * So the finger buys about four times the distance: 85px per page on that
       * screen, which is 3 pages for the comfortable drag and 7 for the full
       * one. It stays linear and so stays reversible -- drag back exactly as
       * far and you are where you started -- rather than growing a velocity
       * curve, which would make the same gesture mean different amounts
       * depending on how hard you flicked.
       *
       * The floor is what a short pane needs: without it a 200px terminal would
       * page on 25px of drag, which is inside the noise of holding a phone.
       */
      const page = Math.max(48, host.clientHeight / 8)
      while (carried >= page) {
        send(PAGE_UP)
        carried -= page
      }
      while (carried <= -page) {
        send(PAGE_DOWN)
        carried += page
      }
    }

    host.addEventListener('touchstart', onTouchStart, { passive: true })
    host.addEventListener('touchmove', onTouchMove, { passive: false })
    host.addEventListener('touchend', onTouchEnd, { passive: true })
    host.addEventListener('touchcancel', onTouchEnd, { passive: true })

    const consumer: ConsumerOptions = {
      primary,
      cols: term.cols,
      rows: term.rows,
      onData: (payload) => term.write(payload),
      onSnapshot: (snapshot, cols, rows) => {
        // Always adopt the server's geometry, primary or not. This terminal has
        // to be an exact replica of the mirror the snapshot came from; if it is
        // not, every later incremental update from the app lands on different
        // cells here than the app believes it is writing.
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows)
        // A repaint replaces the screen wholesale; clearing first stops old
        // contents showing through where the snapshot is shorter.
        term.reset()
        term.write(snapshot)
      },
      onGone: (message) => {
        // Said on the terminal itself, because this pane will never paint: the
        // session is gone and the socket has dropped us.
        term.write(`\r\n\x1b[2m${message} — this terminal is no longer running.\x1b[0m\r\n`)
      },
      onSize: (cols, rows) => {
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows)
      },
    }
    const unsubscribe = terminalSocket.subscribe(session.id, consumer)

    // Only a primary terminal negotiates geometry, from its own element size;
    // tiles keep the server's geometry and scale their font instead.
    let observer: ResizeObserver | null = null
    let frame = 0
    if (primary) {
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
      // Disconnecting stops future callbacks but not one already scheduled,
      // which would then measure and resize a terminal that has been disposed.
      cancelAnimationFrame(frame)
      // The host outlives the terminal -- it is the persistent ref -- so a
      // listener left on it would still be here after this term is disposed,
      // stopping events for a terminal that no longer exists.
      host.removeEventListener('mousemove', hover, true)
      // Same reason, and the same host: left behind, these keep answering
      // drags for a disposed terminal and send its page keys to the session
      // this view used to be showing.
      host.removeEventListener('touchstart', onTouchStart)
      host.removeEventListener('touchmove', onTouchMove)
      host.removeEventListener('touchend', onTouchEnd)
      host.removeEventListener('touchcancel', onTouchEnd)
      unsubscribe()
      termRef.current = null
      term.dispose()
    }
    // session.cols/rows are intentionally excluded: a primary terminal drives
    // them, so reacting to them here would tear the terminal down on every
    // resize it caused itself.
  }, [session.id, primary, fontSize])

  /*
   * Declared after the effect that builds the terminal, so on a fresh mount
   * that one has already run and there is something to focus.
   */
  /*
   * The request each nonce stands for is answered once.
   *
   * `scrollTo` is never cleared, so the last worktree navigated to keeps a
   * non-null nonce for good -- and this effect also runs on mount. A terminal
   * that remounts (scrolled back inside the near-viewport margin, or rebuilt
   * because Claude was respawned) therefore took the keyboard again, mid
   * sentence, out of whatever window you had moved on to.
   */
  const answered = useRef<number | null>(null)
  useEffect(() => {
    if (focus === null || answered.current === focus) return
    answered.current = focus
    termRef.current?.focus()
  }, [focus])

  return (
    <div
      // The host must fill its parent. Without an explicit size it collapses to
      // its content height, and the fit addon then measures that instead of the
      // pane -- which silently pins the terminal to whatever size it happened to
      // start at and leaves the rest of the pane empty.
      className={className ? `term-host ${className}` : 'term-host'}
      ref={hostRef}
      /*
       * Whoever has the keyboard has the input authority, however they came by
       * it. Claiming it on focus rather than only on pointer-down means a
       * terminal handed the keyboard by navigating is as usable as one clicked
       * into -- and React's onFocus follows focusin, so it hears the focus that
       * lands on xterm's own hidden textarea.
       */
      onFocus={() => {
        terminalSocket.focus(session.id)
        onFocusCapture?.()
      }}
      onPointerDown={() => {
        terminalSocket.focus(session.id)
        onFocusCapture?.()
      }}
    />
  )
}
