import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type {
  FilesMode,
  PanelName,
  Project,
  Session,
  Worktree,
  WorktreeTodo,
} from '@switchboard/shared'
import {
  TerminalView,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from '../terminal/TerminalView.js'
import type { ProjectGroup } from '../App.js'
import { api } from '../api.js'
import {
  claudeSession,
  isRunning,
  terminalSessions,
  worktreeTodos,
  type TodoView,
} from '../selectors.js'
import { TodoBar, TodoPane, type MoveGroup } from './TodoPane.js'
import { TerminalsScreen, TerminalsTabs } from './TerminalsPane.js'
import { useChangesState } from './ChangesPane.js'
import { FilesBar, FilesPane, useFilesState } from './FilesPane.js'
import { ForkIcon } from '../components/ForkIcon.js'
import { MIN_PANE_COLUMNS, PANE_CHROME_WIDTH, measureMonoCharWidth } from './overviewLayout.js'
import { useTileMotion, type Slot } from './tileMotion.js'
import { ProjectPane } from '../components/ProjectPane.js'
import { useNearViewport } from './useNearViewport.js'

/**
 * Space between tiles and around the row, in px.
 *
 * It lives here rather than in the stylesheet because tile widths are computed
 * from a measured scrollport: the arithmetic and the rendered spacing have to be
 * the same number or the row does not add up to the window.
 */
const GAP = 12

/** How the add tile is identified in the layout. */

/*
 * One shared empty list for worktrees with nothing expanded. A fresh `[]` each
 * render would be a new identity, and the files hook re-reads its directories
 * whenever that changes.
 */
const EMPTY_DIRS: string[] = []

/** Likewise for a worktree with no file open; see EMPTY_DIRS. */
const EMPTY_FILES: string[] = []

/**
 * Is the whole of a tile on screen already?
 *
 * A tile begins one gap into its own run of the row -- the leading inset, which
 * `scroll-padding-left` matches -- and ends at the far edge of the last unit it
 * covers: it swallows the gaps between the units it spans and leaves only the
 * trailing one outside itself, so `(at + units) * pitch` is its right edge.
 *
 * A pixel of slack at each end, because `pitch` is fractional and `scrollLeft`
 * is not: a tile flush against an edge must not read as one pixel over it.
 */
const wholeOnScreen = (
  tile: { at: number; units: number },
  scrollLeft: number,
  pitch: number,
  width: number,
): boolean =>
  GAP + tile.at * pitch >= scrollLeft - 1 &&
  (tile.at + tile.units) * pitch <= scrollLeft + width + 1

/**
 * Which offset to scroll to so a tile is wholly on screen, moving as little as
 * possible.
 *
 * A tile of u units at `at` is whole on screen for every offset from
 * `at + u - capacity` -- its right edge against the right edge of the window --
 * to `at`, its left edge against the left. The nearest of those to where the
 * row already sits is the answer: going to the worktree just off the right edge
 * moves as little as it can and keeps the one you were on beside it, rather
 * than pulling the new one to the front and taking everything else off the
 * screen with it.
 *
 * `stops` is where the row is allowed to come to rest -- every pane's leading
 * edge, plus the far end -- and the answer has to be one of them or the browser
 * would snap it somewhere else the moment it arrived, mandatory snapping being
 * a rule about programmatic scrolls too. The clamped position is what the
 * nearest is measured from rather than `from` itself, so a tile off the right
 * edge is brought to the right edge and not dragged to the front.
 *
 * The range is never empty, because a tile is never wider than the window --
 * see `panesOf` -- so it always holds `at`, which is a pane's leading edge by
 * construction. The clamp is the fallback anyway, for a row with no stops at
 * all: before the first measured render there are none.
 */
const nearestOffset = (
  tile: { at: number; units: number },
  from: number,
  capacity: number,
  stops: readonly number[],
): number => {
  const lo = tile.at + tile.units - capacity
  const want = Math.min(Math.max(from, lo), tile.at)
  let best: number | null = null
  for (const stop of stops) {
    if (stop < lo || stop > tile.at) continue
    if (best === null || Math.abs(stop - want) < Math.abs(best - want)) best = stop
  }
  return best ?? want
}

/**
 * Every panel, in the order they sit beside Claude.
 *
 * The order is fixed rather than the order they were opened, so a worktree's
 * panes do not shuffle underneath you: opening files puts it in the same place
 * relative to the terminals every time.
 *
 * Files sits first, next to Claude. Claude says it changed something, and the
 * thing it changed is the pane immediately beside it; the terminals and the
 * review of what was committed belong further out, at the tile's edge.
 */
export const PANELS: readonly PanelName[] = ['todo', 'files', 'terminals']

/**
 * The toggles, left to right in the bar.
 *
 * Its own order rather than PANELS', which now only says which names are real:
 * one panel shows at a time, so there is no longer a row of panes for PANELS to
 * order. This is the order they are reached in.
 */
const TOGGLES: readonly PanelName[] = ['terminals', 'todo', 'files']

/**
 * The key that opens each panel, with Cmd held.
 *
 * Mnemonics, not positions, and every one of them a letter inside the word the
 * toggle already shows. Todos are Cmd+O and files Cmd+F.
 *
 * Terminals are Cmd+I, and are on their third letter. T is what the word wants
 * and the browser will not give up Cmd+T; E was next and did not survive
 * contact -- Claude's own browser extension takes Cmd+E, and a shortcut another
 * tool holds is a shortcut that does nothing here. I is the next letter in
 * TERMINAL that nothing else is using.
 *
 * Cmd alone, never Ctrl, and Cmd+I is the sharpest case for that rule on the
 * list: Ctrl+I *is* Tab -- the same byte, 0x09 -- so binding it would have
 * taken completion away from every shell and every prompt in the row. Ctrl+E is
 * end-of-line and Ctrl+F forward-character for the same reason.
 */
const PANEL_KEYS: Record<PanelName, string> = { terminals: 'i', todo: 'o', files: 'f' }

/** The same table read the way a keystroke arrives. */
const PANEL_FOR_KEY = new Map<string, PanelName>(
  Object.entries(PANEL_KEYS).map(([panel, key]) => [key, panel as PanelName]),
)

/**
 * The mnemonic letter, lit in a toggle's label while Cmd is down.
 *
 * The shortcut is only worth having if you can find it, and a printed list of
 * three is a list nobody reads. Holding Cmd is the question -- "what can I do
 * from here" -- so the answer is written on the controls themselves, in the
 * letter you are about to press, and disappears when you let go. In the window
 * you are in and nowhere else: "from here" is one worktree, and the key does
 * nothing to the other three.
 *
 * Greyscale, and it has to be: the two colours in this interface are states you
 * scan a row of agents for, and a legend is not a state. So the letter is
 * --bone and the word it sits in steps down to --graphite while Cmd is held --
 * the same rung the label already uses, and the same 1.92:1 step the interface
 * puts between a title and its metadata.
 *
 * The word is dimmed rather than the letter merely brightened because of the
 * toggle whose panel is open: its label is already --bone, so a --bone letter
 * in it would be no letter at all. Dimming makes one rule that works in every
 * state -- open, hovered, plain -- and the underline still says which panel is
 * on screen.
 *
 * One label has no letter to light: a queue reads "3 QUEUED", with no O in it,
 * and that is the moment the todos matter most. The whole label goes green
 * there rather than nothing at all.
 */
const mark = (text: string, panel: PanelName, lit: boolean): React.ReactNode => {
  const at = lit ? text.toLowerCase().indexOf(PANEL_KEYS[panel]) : -1
  /*
   * One element around the whole label, in both states, and it is load-bearing.
   * The toggle is a flex row with a 4px gap -- for the fork glyph after the
   * word -- so every text node in it is a flex item: splitting "TERMINAL" into
   * three to colour the E put two of those gaps inside the word and grew the
   * button by 8px the moment Cmd went down. Measured: 86.98px to 95. Wrapped,
   * the button has the one child it had before and nothing in the bar moves.
   */
  return (
    <span className={lit ? (at === -1 ? 'tile__key' : 'tile__marked') : undefined}>
      {at === -1 ? (
        text
      ) : (
        <>
          {text.slice(0, at)}
          <span className="tile__key">{text[at]}</span>
          {text.slice(at + 1)}
        </>
      )}
    </span>
  )
}

/** What a panel is called in prose, for the toggle's tooltip. */
const PANEL_NOUN: Record<PanelName, string> = {
  todo: 'todos',
  files: 'files and changes',
  terminals: 'terminals',
}

/** The counts a panel's label can be built from. */
interface PanelCounts {
  todos: number
  /** Todos waiting to be typed into Claude. */
  queued: number
  terminals: number
  changes: number
  /** Commits the default branch does not have, for the fork glyph. */
  unmerged: number
}

/**
 * The toggle's label.
 *
 * Terminals count themselves rather than repeating the panel's name: the number
 * is the useful part at a glance. The count is of the terminals the panel would
 * show, exited ones included, so the label never disagrees with the tab strip
 * under it.
 *
 * With none open the label is the bare noun, not "Add Terminal". Every toggle
 * here opens its panel, and opening the terminals panel on a worktree with no
 * terminal makes one -- so the verb was true but it was also the only one in a
 * row of nouns, and it made the two widest labels in the bar the two that had
 * the least to say. The bar carries the worktree's name, its prompt, its state,
 * three toggles, sleep and remove in one segment; four characters of "Add " on
 * each of two of them is width the name and the prompt want more.
 *
 * Exhaustive on purpose: adding a panel to PanelName will not compile until it
 * says what it is called.
 */
const panelLabel = (panel: PanelName, counts: PanelCounts, lit: boolean): React.ReactNode => {
  const text = (label: string): React.ReactNode => mark(label, panel, lit)
  switch (panel) {
    case 'todo':
      // What is queued outranks what is merely written down: one is about to
      // happen to this worktree and the other is a list. With nothing queued it
      // counts itself like the terminals do.
      if (counts.queued > 0) return text(counts.queued === 1 ? '1 Queued' : `${counts.queued} Queued`)
      if (counts.todos === 0) return text('Todo')
      return text(counts.todos === 1 ? '1 Todo' : `${counts.todos} Todos`)
    case 'terminals':
      if (counts.terminals === 0) return text('Terminal')
      return text(counts.terminals === 1 ? '1 Terminal' : `${counts.terminals} Terminals`)
    case 'files':
      /*
       * The count is uncommitted files, and it belongs on this toggle now that
       * the panel opens on them: a number on a control promises that clicking
       * shows you those N things, which is exactly what Changes mode does.
       */
      if (counts.changes > 0) return text(counts.changes === 1 ? 'Files 1±' : `Files ${counts.changes}±`)
      /*
       * With nothing uncommitted, the same glyph the worktree's tab shows: this
       * branch has commits the default branch has not. One slot, the count when
       * there is one and the fork otherwise, in both places -- the toggle and
       * the tab answer the same question and clicking the toggle is where you
       * go to look at the answer.
       */
      if (counts.unmerged > 0) {
        return (
          <>
            {text('Files')}
            <ForkIcon className="tile__fork" size={12} />
          </>
        )
      }
      return text('Files')
  }
}

/**
 * How much of the row each pane asks for, in units of half a spot.
 *
 * The row used to be laid out in whole spots, one per pane, and that suited a
 * pane that is nothing but a terminal: 80 columns and no chrome. The files
 * panel is not that -- it spends a quarter of its width on the tree beside the
 * editor -- so at one spot its editor came to 56 to 63 columns, under the 80
 * the whole layout exists to guarantee. Measured, and worse the wider the
 * monitor: at 3440px it was 57.
 *
 * Halving the atom fixes it without changing any of the arithmetic. Everything
 * below still counts whole units; there are simply twice as many, so a pane can
 * ask for three of them -- a spot and a half -- and a worktree can be two and a
 * half spots wide. Nothing you read code in may ask for one: a single unit is
 * half a pane, and the 80-column floor is a promise about panes. The two that
 * do are chrome -- the files tree by itself, and the placeholder below.
 */
const PANE_UNITS: Record<'claude' | 'project' | PanelName, number> = {
  claude: 2,
  /*
   * The new-worktree placeholder is one unit, not two.
   *
   * It holds a +, a line of label and a sentence of hint -- nothing that has to
   * be 80 columns wide, and nothing that gets better for being wider. At two it
   * was a whole empty pane at the end of the row, taking the space a real
   * worktree could have used, on a row you scroll precisely because there is
   * never enough of it.
   */
  project: 1,
  todo: 2,
  terminals: 2,
  files: 3,
}

/**
 * The files panel with nothing open: the tree by itself.
 *
 * The one pane that may ask for a single unit, and the exception is deliberate.
 * The floor of two exists to keep the 80-column promise, and that promise is
 * about panes you read code in -- a terminal, a diff, the editor. A tree is
 * chrome: it holds names at a few levels of indent, its own floor is 158px, and
 * a unit is more than twice that at every width this row has. Giving it a whole
 * pane to list files in is the space this panel was spending for nothing.
 *
 * So a worktree browsing its files is three units and one reading a file is
 * five, and opening the editor is what buys the second pane.
 */
const FILES_TREE_UNITS = 1

/** How a pane is identified in the layout. */
/**
 * A pane of a worktree's tile: Claude, or whichever panel is open beside it.
 *
 * These are the stops a Cmd+arrow step walks -- the row runs through panes, not
 * only worktrees, so that stepping right can take you into the thing you were
 * about to type in rather than past it.
 */
export type PaneKind = 'claude' | PanelName | 'project'

export const paneKey = (worktreeId: string, pane: PaneKind): string => `${worktreeId}:${pane}`

/**
 * The row id of a project's own pane.
 *
 * Every cell in the row is keyed by something `scrollTo`, `active` and the
 * Cmd+arrow walk can name, and those used to be worktree ids alone. A project's
 * pane is a stop too, so it needs one -- prefixed, because a project id and a
 * worktree id come from the same hash and must not collide.
 */
export const projectKey = (projectId: string): string => `project:${projectId}`

/**
 * Whether Cmd is down right now.
 *
 * What it is for: while it is held, every shortcut the row has says where it
 * goes -- the three toggles light their letter, and the two windows a Cmd+arrow
 * step would land in show the arrow that lands there. Nothing is armed by this;
 * it is a legend, and the keys work whether it is on screen or not.
 *
 * Released is the state that must never be wrong, so it is read from three
 * things rather than from Meta's own keyup: any key event that reports no Cmd
 * clears it, and so does the window losing focus -- Cmd+Tab away is exactly the
 * gesture that would otherwise leave the legend lit over a page nobody is
 * typing into, because the keyup lands in the application you switched to.
 */
const useMetaHeld = (): boolean => {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const read = (event: KeyboardEvent): void => setHeld(event.metaKey)
    const clear = (): void => setHeld(false)
    // Capture, so a pane that stops a key from propagating -- the panel
    // shortcuts above do exactly that -- cannot also stop the legend from
    // seeing it.
    window.addEventListener('keydown', read, true)
    window.addEventListener('keyup', read, true)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', read, true)
      window.removeEventListener('keyup', read, true)
      window.removeEventListener('blur', clear)
    }
  }, [])
  return held
}

type Pane =
  | { kind: 'claude'; key: string; worktree: Worktree; units: number }
  | { kind: PanelName; key: string; worktree: Worktree; units: number }
  | { kind: 'project'; key: string; units: number }

const useElementSize = (ref: RefObject<HTMLElement | null>): { width: number; height: number } => {
  const [size, setSize] = useState({ width: 0, height: 0 })
  // A layout effect, so the first measurement lands before the browser paints
  // and no terminal is built at a size we are about to replace.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      setSize((previous) =>
        Math.round(previous.width) === Math.round(rect.width) &&
        Math.round(previous.height) === Math.round(rect.height)
          ? previous
          : { width: rect.width, height: rect.height },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/**
 * What a session said before it stopped, or nothing if it stopped cleanly.
 *
 * Only a failure gets one. A status of zero is someone typing /exit, where the
 * tail is whatever happened to be on screen beforehand and explains nothing --
 * whereas a non-zero exit is precisely the case where the pane held the only
 * account of what went wrong and the interface used to throw it away. A dead
 * pane says nothing further, so this is asked once per exit and not polled.
 */
const useExitOutput = (session: Session | undefined): string[] => {
  const failed = session !== undefined && session.liveness === 'dead' && session.exitStatus !== 0
  const sessionId = failed ? session.id : null
  const [lines, setLines] = useState<string[]>([])
  useEffect(() => {
    if (sessionId === null) {
      setLines([])
      return
    }
    let cancelled = false
    void api
      .sessionTail(sessionId)
      .then(({ lines: tail }) => {
        if (!cancelled) setLines(tail)
      })
      // A session that has gone away in the meantime simply has nothing to show.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [sessionId])
  return lines
}

/** Why Claude is not on screen, in the interface's own voice. */
const idleReason = (session: Session | undefined): string => {
  if (!session) return 'Claude is not running in this worktree.'
  if (session.exitStatus === 0) return 'Claude exited.'
  // No number from tmux, so do not invent one.
  if (!session.exitStatus) return 'Claude is no longer running.'
  return `Claude exited with status ${session.exitStatus}.`
}

/**
 * Claude's pane when it is not running: why it stopped, and how to start it.
 *
 * Its own component so the Start button can take the keyboard. A step that
 * lands here has to land *somewhere*: the walk now reads which pane holds the
 * keyboard rather than trusting React state, so a pane that quietly refuses
 * focus is a pane the walk can never leave -- press Cmd+Left again and it is
 * still asking for the same one. Measured before this existed: stepping out of
 * a panel into a stopped Claude left the keyboard in the panel, and the next
 * press skipped the worktree entirely.
 */
const IdleClaude = ({
  session,
  output,
  onStart,
  focus,
}: {
  session: Session | undefined
  output: string[]
  onStart: () => void
  focus: number | null
}): React.ReactElement => {
  const startRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (focus === null) return
    startRef.current?.focus()
  }, [focus])

  return (
    <div className="tile__idle">
      <p className="tile__idle-text">{idleReason(session)}</p>
      {output.length > 0 && (
        <pre
          className="tile__idle-output"
          /*
           * Opened at the bottom, like a terminal: the last thing a failing
           * command says is the part that says why, and a long one starts
           * scrolled past it otherwise.
           */
          ref={(element) => {
            if (element) element.scrollTop = element.scrollHeight
          }}
        >
          {output.join('\n')}
        </pre>
      )}
      <button className="btn" ref={startRef} onClick={onStart}>
        Start Claude
      </button>
    </div>
  )
}

interface WorktreeTileProps {
  worktree: Worktree
  /**
   * The project it belongs to.
   *
   * Named in the bar because the row runs across every open project at once,
   * and two projects can hold worktrees with the same name -- a `ui` beside
   * another `ui` says nothing about which repository you are about to type
   * into.
   */
  project: Project | undefined
  /** This worktree's todos, in list order, each with its queue position. */
  todos: TodoView[]
  /** Where one of them can be moved to; the pane drops this worktree itself. */
  moveTo: MoveGroup[]
  /** Claude's pane and one for each open panel, in display order. */
  panes: Pane[]
  /**
   * Hand Claude the keyboard when this changes. Null for every worktree but
   * the one just navigated to.
   *
   * Nothing happens when Claude has no pane here -- dropped because the window
   * is too narrow for it, or not running at all -- which is the whole of "focus
   * it if it is visible": the terminal that would take the keyboard does not
   * exist, so nothing takes it.
   */
  focus: number | null
  /** Which pane that focus request is for. */
  focusPane: PaneKind | null
  session: Session | undefined
  /**
   * The worktree you are in, which is the one whose tab is the light one.
   *
   * Not the same as `focus`: that is a request to hand the keyboard over and
   * fires once, while this is a standing fact about where you are, and it
   * survives clicking into a window without navigating to it.
   */
  current: boolean
  terminals: Session[]
  activeTerminalId: string | null
  /** The file this worktree has open, and the directories it has expanded. */
  openPath: string
  /** Its open files, as tabs above the editor. Files mode only. */
  openFiles: string[]
  expandedDirs: string[]
  /** Which face its files panel is showing. */
  filesMode: FilesMode
  /**
   * Cmd is down, so the panel toggles may show the letter that opens them.
   *
   * "May", because only the window you are in does: the shortcut acts on one
   * worktree, and lighting the same three letters in every window on screen
   * says a key does something here that it does not do. It is also a row of
   * agents, and four copies of a legend is four things the eye has to dismiss
   * to find the one that is blocked on you.
   */
  keysLit: boolean
  /**
   * The Cmd+arrow step that lands in this worktree, drawn in front of its name
   * while Cmd is held. Null for the windows neither step reaches.
   *
   * At most one of the two, always: a step goes to the pane next door, and the
   * panes of one worktree are contiguous in the row -- so the window you would
   * arrive in going left cannot also be the one you would arrive in going
   * right unless you are already inside it, and then only one side of it is.
   */
  step: 'left' | 'right' | null
  /** The commit whose patch is showing, in Commits mode. Null for none. */
  commit: string | null
  /** The scroller, so the tile can tell whether it is worth mounting. */
  scroller: RefObject<HTMLElement | null>
  onStart: () => void
  /** Bring this worktree wholly into view. */
  onReveal: () => void
  onTogglePanel: (panel: PanelName) => void
  /** This worktree's queue ran itself out; the pane has nothing left to do. */
  onQueueDrained: () => void
  onSelectTerminal: (sessionId: string) => void
  onNewTerminal: () => void
  onCloseTerminal: (sessionId: string) => void
  onOpenPath: (path: string) => void
  onCloseFile: (path: string) => void
  /** Null closes the pane; the hook calls it that way when a hash goes stale. */
  onSelectCommit: (hash: string | null) => void
  onToggleDir: (dir: string) => void
  /** Open a directory and its ancestors: a search hit that is a place. */
  onExpandDir: (dir: string) => void
  onFilesMode: (mode: FilesMode) => void
}

/**
 * One worktree, one tile, however many columns wide.
 *
 * The bar and the body are grids over the same columns, so each panel's
 * controls sit exactly above the pane they drive and the whole thing reads as
 * one tile with internal divisions rather than as tiles pushed together. The
 * worktree's own identity goes in the first segment and its controls in the
 * last, because they act on the tile as a whole and its edges are where they
 * belong.
 */
const WorktreeTile = ({
  worktree,
  project,
  todos,
  moveTo,
  panes,
  focus,
  focusPane,
  session,
  current,
  terminals,
  activeTerminalId,
  openPath,
  openFiles,
  expandedDirs,
  filesMode,
  keysLit,
  step,
  commit,
  scroller,
  onStart,
  onReveal,
  onTogglePanel,
  onQueueDrained,
  onSelectTerminal,
  onNewTerminal,
  onCloseTerminal,
  onOpenPath,
  onCloseFile,
  onSelectCommit,
  onToggleDir,
  onExpandDir,
  onFilesMode,
}: WorktreeTileProps): React.ReactElement => {
  // An exited session is offered as something to restart rather than left as a
  // frozen terminal -- but with what it printed on its way out, which is often
  // the only account of why it stopped. It was dropped here once, and a Claude
  // that could not start looked like a button that did nothing.
  const running = isRunning(session)
  const exitOutput = useExitOutput(session)
  /*
   * `done` is a running Claude that has come to rest, and it is the only one of
   * these that goes green. A worktree with no agent, or one that has exited,
   * stays `idle` and stays grey: nothing is running there, so nothing has been
   * finished -- the green is a claim about work, not about quiet.
   */
  const state = !session
    ? 'idle'
    : session.liveness === 'dead'
      // A deliberate /exit is not a failure, so it does not get the alarm rail.
      ? session.exitStatus
        ? 'dead'
        : 'idle'
      : session.attention === 'needs-you'
        ? 'waiting'
        : session.attention === 'working'
          ? 'working'
          : 'done'

  const tileRef = useRef<HTMLDivElement | null>(null)
  /*
   * Whether to build this tile's terminals at all. The tile is always here --
   * its bar, name and state are what the row is for -- but a terminal off the
   * side of the scrollport is a WebGL context and a render loop spent on
   * nothing. See the note on useNearViewport.
   */
  const near = useNearViewport(tileRef, scroller)

  const shownPanes = new Set(panes.map((pane) => pane.kind))
  /*
   * The bar and the body are grids over these same columns, so each panel's
   * controls sit exactly above the pane they drive. Weighted by units rather
   * than equal, which is what lets the files panel be half a spot wider than
   * Claude beside it.
   */
  const columns = panes.map((pane) => `minmax(0, ${pane.units}fr)`).join(' ')
  /*
   * The worktree's controls stay with its Claude pane rather than moving to the
   * last one, so opening a panel does not slide the button you just pressed out
   * from under the pointer -- and every panel toggle keeps one address whether
   * one panel is open or three. When Claude itself has been pushed out, on a
   * phone showing only the terminals, they fall back to the one segment there
   * is.
   */
  /*
   * What the server already knows has moved in this worktree, and the one
   * string both panels re-read on. Both are needed: an edit moves the dirty
   * count, and a commit from a clean tree moves only HEAD.
   */
  const revision = `${worktree.dirty ?? 0}:${worktree.head ?? ''}`
  /*
   * Both hooks are called for every tile, and at most one of them works.
   *
   * The panel shows one face at a time and the other two need nothing: Changes
   * builds its rows from git's own list and never reads a directory, while
   * Files never asks what changed. So an open panel polls for what you are
   * looking at rather than for everything it could show.
   */
  const filesOpen = shownPanes.has('files')
  const changes = useChangesState({
    worktreeId: worktree.id,
    revision,
    enabled: filesOpen && filesMode !== 'files',
    path: openPath,
    mode: filesMode,
    commit,
    onSelectCommit,
  })
  const files = useFilesState({
    worktreeId: worktree.id,
    revision,
    enabled: filesOpen && filesMode === 'files',
    path: openPath,
    expanded: expandedDirs,
    onOpen: onOpenPath,
    onToggleDir,
    onExpandDir,
  })
  const counts: PanelCounts = {
    todos: todos.length,
    queued: todos.filter((view) => view.position !== null).length,
    terminals: terminals.length,
    changes: worktree.dirty ?? 0,
    unmerged: worktree.unmerged ?? 0,
  }

  const claudeIndex = panes.findIndex((pane) => pane.kind === 'claude')
  const controlsIndex = claudeIndex === -1 ? 0 : claudeIndex
  const revealHint = `Click to bring ${worktree.name}'s window into view`

  /*
   * Where a Cmd+arrow step would land, said in the window it would land in.
   *
   * In front of the name because that is the window's own title -- the step is
   * about arriving in this worktree, not about any one of its panes -- and
   * because a legend that appears while you hold a key must not move the thing
   * it annotates: it is laid over the label's left padding rather than pushed
   * into the line, so no title shifts when Cmd goes down.
   *
   * The glyphs are the keys: the arrow you are about to press, not a triangle
   * that means "play".
   */
  const stepHint =
    step === null ? null : (
      <span className="tile__step" aria-hidden="true">
        {step === 'left' ? '\u2190' : '\u2192'}
      </span>
    )

  const identity = (
    <span className="tile__label">
      {stepHint}
      {/* Dropped when the worktree already carries the project's name, since
          saying it twice tells you nothing the once did not. */}
      {project && project.name !== worktree.name && (
        <>
          <span className="tile__project" title={project.root}>
            {project.name}
          </span>
          {/* The slash is its own element rather than punctuation glued to the
              project's name, so a long project name ellipsizing does not take
              the separator with it. */}
          <span className="tile__slash" aria-hidden="true">
            /
          </span>
        </>
      )}
      <span className="tile__name">{worktree.name}</span>
      {worktree.branch && worktree.branch !== worktree.name && (
        <span className="tile__branch">{worktree.branch}</span>
      )}
      {worktree.dirty ? <span className="tile__branch">{worktree.dirty}&plusmn;</span> : null}
    </span>
  )

  /*
   * What this worktree is about, in the words you asked for it in.
   *
   * A row of windows all look alike -- same chrome, same terminal -- and the
   * name only says which branch it is. This is the line that answers "which one
   * is doing what" without reading four terminals. Quiet, because the state and
   * the name still outrank it, and one line however long the prompt was; the
   * whole of it is in the tooltip.
   */
  const prompt = worktree.prompt ? (
    <span className="tile__prompt" title={worktree.prompt}>
      {worktree.prompt}
    </span>
  ) : null

  /*
   * What the worktree can show, and nothing else.
   *
   * Two controls left this row and neither is missed: the state, because the
   * rail down the tile's edge already carries it -- amber for blocked on you,
   * green for come to rest -- and a word repeating a colour you scan for is a
   * word spent twice; and sleep, which is what the × on the worktree's tab in
   * the top bar asks, the same place the delete lives. That was the trashcan's
   * road too. So the bar is the panel toggles, at the end where the panel they
   * open begins.
   */
  const controls = (
    <div className="tile__controls">
      {TOGGLES.map((panel) => {
        // Lit when this panel's pane is the one on screen, which is the only
        // thing the toggle ever claims -- and with one panel at a time, the lit
        // one is also the only one.
        const on = shownPanes.has(panel)
        return (
          <button
            key={panel}
            className={on ? 'tile__toggle tile__toggle--on' : 'tile__toggle'}
            onClick={() => onTogglePanel(panel)}
            title={on ? `Close ${PANEL_NOUN[panel]}` : `Show ${PANEL_NOUN[panel]}`}
          >
            {panelLabel(panel, counts, keysLit && current)}
          </button>
        )
      })}
    </div>
  )

  return (
    <div className={`tile tile--${state}${current ? ' tile--current' : ''}`} ref={tileRef}>
      <div
        className="tile__bar"
        style={{ gridTemplateColumns: columns }}
        title={
          session
            ? `${worktree.path}\n${session.attachCommand}\n${revealHint}`
            : `${worktree.path}\n${revealHint}`
        }
        onClick={(event) => {
          /*
           * Clicking the bar brings the worktree's window to the front, which
           * is how you get to one you can only see part of. Never through
           * something that already does its own job -- a panel toggle, sleep,
           * remove, or a panel's own controls in the bar.
           */
          if (
            (event.target as HTMLElement).closest(
              'button, .termtabs, .todo__bar, .files__bar',
            )
          ) {
            return
          }
          onReveal()
        }}
      >
        {panes.map((pane, index) => (
          // `data-pane` so focus landing on a panel's own controls -- a terminal
          // tab, Save -- reports that panel rather than the tile at large.
          <div className="tile__seg" key={pane.key} data-pane={pane.key}>
            {index === 0 && identity}
            {index === 0 && prompt}
            {pane.kind === 'terminals' && (
              <TerminalsTabs
                terminals={terminals}
                activeTerminalId={activeTerminalId}
                onSelect={onSelectTerminal}
                onNew={onNewTerminal}
                onClose={onCloseTerminal}
              />
            )}
            {pane.kind === 'todo' && <TodoBar todos={todos} claudeRunning={running} />}
            {pane.kind === 'files' && (
              <FilesBar
                mode={filesMode}
                files={files}
                changes={changes}
                openFiles={openFiles}
                onCloseFile={onCloseFile}
                onCollapse={() =>
                  filesMode === 'commits' ? onSelectCommit(null) : onOpenPath('')
                }
              />
            )}
            {index === controlsIndex && controls}
          </div>
        ))}
      </div>

      <div className="tile__body" style={{ gridTemplateColumns: columns }}>
        {panes.map((pane) => (
          <div
            /*
             * The files pane insets per row and inside the editor's own gutter
             * instead of through the pane's padding, so a column divider runs
             * the whole height and meets the tile's border.
             */
            className={pane.kind === 'files' ? 'tile__pane tile__pane--files' : 'tile__pane'}
            key={pane.key}
            data-pane={pane.key}
          >
            {pane.kind === 'claude' &&
              (running && session ? (
                near && (
                  <TerminalView
                    session={session}
                    primary={true}
                    fontSize={TERMINAL_FONT_SIZE}
                    focus={focusPane === 'claude' ? focus : null}
                  />
                )
              ) : (
                <IdleClaude
                  session={session}
                  output={exitOutput}
                  onStart={onStart}
                  focus={focusPane === 'claude' ? focus : null}
                />
              ))}
            {pane.kind === 'terminals' && near && (
              <TerminalsScreen
                terminals={terminals}
                activeTerminalId={activeTerminalId}
                fontSize={TERMINAL_FONT_SIZE}
                focus={focusPane === 'terminals' ? focus : null}
              />
            )}
            {pane.kind === 'todo' && (
              <TodoPane
                worktreeId={worktree.id}
                todos={todos}
                claudeRunning={running}
                moveTo={moveTo}
                focus={focusPane === 'todo' ? focus : null}
                /*
                 * Closed the way the layout closes a panel it could not keep,
                 * rather than through the toggle: the toggle also scrolls to
                 * the worktree, and a queue draining in a window you are not
                 * looking at must not drag the row over to it.
                 */
                onQueueDrained={onQueueDrained}
              />
            )}
            {pane.kind === 'files' && (
              <FilesPane
                mode={filesMode}
                onMode={onFilesMode}
                files={files}
                changes={changes}
                openFiles={openFiles}
                branch={worktree.branch}
                near={near}
                focus={focusPane === 'files' ? focus : null}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}



/**
 * Whether anything between `from` and the row would rather have this wheel.
 *
 * Standard scroll chaining, done by hand because the row has to know when the
 * gesture is spare. Something with more to show sideways scrolls itself -- a
 * strip of file tabs, a diff wider than its pane -- and one already at its end
 * passes it on, which is what the browser would do if the row were its parent
 * scroller.
 */
const inner = (from: EventTarget | null, stop: Element, delta: number): boolean => {
  for (let el = from as HTMLElement | null; el && el !== stop; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth) continue
    const overflow = getComputedStyle(el).overflowX
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    const room =
      delta < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    if (room) return true
  }
  return false
}

/**
 * How much gesture makes one pane: a notch, and nothing smaller.
 *
 * A mouse notch is exactly 100px in Chrome, so one notch is one pane. It has
 * to be a whole notch in one event, though, rather than a total accumulated
 * over a gesture. A trackpad -- and a Magic Mouse -- reports a scroll as a
 * stream of small deltas with momentum after it, so accumulating meant an
 * incidental graze while reading moved the row a pane and a flick walked it
 * several: measured over a tile's bar, ten trackpad-sized deltas of 12px took
 * the row 0 -> 794, and a forty-event flick 0 -> 1588. Nobody asked for that,
 * and it read as the row moving on its own.
 *
 * Firefox reports lines rather than pixels; 40 is the usual line for a wheel,
 * so its three-line notch clears the same bar.
 */
const WHEEL_STEP = 100
const WHEEL_LINE = 40

/** A gesture is over once the wheel has been quiet this long. */
const WHEEL_IDLE_MS = 300

export interface OverviewProps {
  /** Awake worktrees, in the order the row shows them. */
  worktrees: Worktree[]
  /** Every open project, so a tile can name the one it belongs to. */
  projects: Project[]
  /** Every todo, across every worktree; each tile takes its own. */
  todos: WorktreeTodo[]
  /** Every worktree a todo could be moved to, grouped by project. */
  moveTo: MoveGroup[]
  sessions: Session[]
  panels: Record<string, PanelName[]>
  activeTerminalByWorktree: Record<string, string>
  /** Where each worktree's files panel is standing. */
  openPathByWorktree: Record<string, string>
  /** Directories each worktree has expanded in its file tree. */
  expandedByWorktree: Record<string, string[]>
  /**
   * The files each worktree has open as tabs in Files mode.
   *
   * The row needs this and not only the panel: an empty list means the panel is
   * the tree alone, which is half a spot narrower.
   */
  openFilesByWorktree: Record<string, string[]>
  /** Which face each worktree's files panel is showing. */
  filesModeByWorktree: Record<string, FilesMode>
  /**
   * The project a new worktree would go to, when there is only one open.
   *
   * Null with several open, because the add tile would have to guess which one
   * it added to -- the top bar's per-project `+` is unambiguous and is there
   * either way.
   */
  /**
   * A request to bring a worktree's tile into view: its id, plus a counter so
   * that asking twice for the same one is two requests. Set when you click a
   * worktree in the top bar, step to one, wake one, or open one of its panels.
   */
  scrollTo: { id: string; pane: PaneKind; nonce: number } | null
  /**
   * The pane you are in, which is where a Cmd+arrow step counts from. It
   * follows focus, not only navigation, so clicking into a window makes the
   * next step continue from there.
   *
   * To the pane rather than the worktree, because the walk now runs through
   * panes: knowing which window you are in no longer says what is next.
   */
  active: { id: string; pane: PaneKind } | null
  /** Anything in this pane took focus, so this is where you are now. */
  onActivate: (worktreeId: string, pane: PaneKind) => void
  /** A worktree was just made in one of the row's project panes. */
  onCreated: (worktreeId: string) => void
  /** This project's worktrees, awake and asleep, for its own pane. */
  groups: ProjectGroup[]
  onWake: (worktreeId: string) => void
  onSleep: (worktreeId: string) => void
  onCloseProject: (projectId: string) => void
  onStart: (worktreeId: string) => void
  /** Bring that worktree wholly into view, and hand one of its panes the keyboard. */
  onReveal: (worktreeId: string, pane?: PaneKind) => void
  onTogglePanel: (worktreeId: string, panel: PanelName) => void
  /** A worktree's queue emptied itself into Claude; close its todo panel. */
  onQueueDrained: (worktreeId: string) => void
  onSelectTerminal: (worktreeId: string, sessionId: string) => void
  onNewTerminal: (worktreeId: string) => void
  /** Closing the last one closes the panel too, so it needs the worktree. */
  onCloseTerminal: (worktreeId: string, sessionId: string) => void
  onOpenPath: (worktreeId: string, path: string) => void
  /** Drop one of a worktree's open files; the last one takes the editor with it. */
  onCloseFile: (worktreeId: string, path: string) => void
  onToggleDir: (worktreeId: string, dir: string) => void
  onExpandDir: (worktreeId: string, dir: string) => void
  onFilesMode: (worktreeId: string, mode: FilesMode) => void
}

/**
 * The row: every awake worktree, always, side by side.
 *
 * Nothing is hidden to make room. A tile's place comes from its project and its
 * name, so it is where you last saw it, and when there are more worktrees than
 * the window can hold the row simply runs off the right and scrolls -- the top
 * bar is how you get to the far end of it. That replaces a capacity walk, a
 * reserved anchor, panels that collapsed when the width ran out, and tiles that
 * fell off an edge and had to be asked back.
 *
 * What is left is one width rule and a scroller.
 */
export const Overview = ({
  worktrees,
  projects,
  todos,
  moveTo,
  sessions,
  panels,
  activeTerminalByWorktree,
  openPathByWorktree,
  openFilesByWorktree,
  expandedByWorktree,
  filesModeByWorktree,
  scrollTo,
  active,
  onActivate,
  onCreated,
  groups,
  onWake,
  onSleep,
  onCloseProject,
  onStart,
  onReveal,
  onTogglePanel,
  onQueueDrained,
  onSelectTerminal,
  onNewTerminal,
  onCloseTerminal,
  onOpenPath,
  onCloseFile,
  onToggleDir,
  onExpandDir,
  onFilesMode,
}: OverviewProps): React.ReactElement => {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const { width } = useElementSize(gridRef)
  const projectById = new Map(projects.map((project) => [project.id, project]))
  /**
   * The commit each worktree has open, by id. Absent means none.
   *
   * Here rather than in `UiState`, and deliberately not persisted: a rebase, an
   * amend or a squash -- all routine in these worktrees -- makes a stored hash
   * name nothing at all, and a restored one would open an empty pane on load.
   * It is out of `useChangesState`, where it used to live, because the row
   * measures its tiles against it: a worktree with a commit open is two panes
   * wide, and only this component lays out the row.
   */
  const [commitByWorktree, setCommitByWorktree] = useState<Record<string, string>>({})
  /*
   * Stable, because it is handed to every tile and reaches the changes hook's
   * dependency arrays.
   */
  const selectCommit = useCallback((worktreeId: string, hash: string | null): void => {
    setCommitByWorktree((was) => {
      if (hash === null) {
        if (was[worktreeId] === undefined) return was
        const { [worktreeId]: _gone, ...rest } = was
        return rest
      }
      return was[worktreeId] === hash ? was : { ...was, [worktreeId]: hash }
    })
  }, [])

  /*
   * A tile's panes, and how much of the row each takes.
   *
   * Claude and every open panel, in PANELS order -- fixed, so opening one does
   * not shuffle the others. A tile is as many spots wide as it has panes, and
   * being wider than what is beside it is fine: the row is a strip you scroll
   * along, and seeing the front of the next tile is how you know it is there.
   *
   * What a tile may not be is wider than the *window*, because that is a tile
   * you could never see whole. So when Claude and the open panels come to more
   * spots than the window has, Claude's pane is dropped first -- you asked for
   * the panel and its toggle says it is open, while Claude is one click away
   * again by closing one. If the panels alone still will not fit, the oldest
   * are closed for real rather than hidden, which is reported below: the one
   * you just clicked is the newest, so it is the one that survives, and a lit
   * toggle never claims a pane that is not on screen.
   *
   * At one spot this comes out as the phone rule -- a single pane, showing the
   * panel you last opened -- without being a special case.
   */
  /*
   * At most one panel at a time, so a worktree is one column or two and never
   * more. Stored state can still name several -- it did until this rule -- and
   * the newest is the one that survives, which is exactly what a window too
   * narrow for all of them already did.
   */
  const openPanelsOf = (worktree: Worktree): PanelName[] =>
    (panels[worktree.id] ?? []).filter((panel) => PANELS.includes(panel)).slice(-1)

  /**
   * Whether a worktree's files panel has anything open beside its tree.
   *
   * This is a layout fact -- it is what decides whether the panel is one unit
   * or three -- so it is answered here, from the same state the panel reads,
   * rather than reported upwards by the pane once it has rendered. A tile whose
   * width depended on what its own contents decided would settle a frame late,
   * and the row would jump after the click rather than with it.
   *
   * Each mode has its own answer because each opens a different thing: Files
   * keeps a list of tabs, Changes and Commits open one and close it again.
   */
  const filesContentOpen = (worktree: Worktree): boolean => {
    switch (filesModeByWorktree[worktree.id] ?? 'files') {
      case 'files':
        return (openFilesByWorktree[worktree.id] ?? []).length > 0
      case 'commits':
        return commitByWorktree[worktree.id] !== undefined
      default:
        return (openPathByWorktree[worktree.id] ?? '') !== ''
    }
  }

  /**
   * Claude's pane and the open panel, each sized in units.
   *
   * A panel asks for what it wants and settles for what there is. Files wants
   * three units, but a window with only four cannot hold that beside Claude --
   * so it takes two rather than costing you the agent, because a narrower
   * editor beats no Claude at all. Only when even the minimum will not fit is
   * Claude's pane dropped, which is the phone rule and is what leaves a single
   * pane showing the panel you opened.
   *
   * Nothing is ever wider than the window, which is what lets `nearestOffset`
   * always have an answer.
   */
  const panesOf = (worktree: Worktree, capacity: number): Pane[] => {
    const asks = (kind: 'claude' | PanelName): number =>
      kind === 'files' && !filesContentOpen(worktree) ? FILES_TREE_UNITS : PANE_UNITS[kind]
    const fits = (kind: 'claude' | PanelName): number => Math.min(asks(kind), capacity)
    const claude: Pane = {
      kind: 'claude',
      key: paneKey(worktree.id, 'claude'),
      worktree,
      units: fits('claude'),
    }
    const panel = openPanelsOf(worktree)[0]
    if (panel === undefined) return [claude]

    const pane = (units: number): Pane => ({
      kind: panel,
      key: paneKey(worktree.id, panel),
      worktree,
      units,
    })
    const wants = fits(panel)
    // Two units is every pane's floor, and a panel that asks for less than that
    // is already at its own: a collapsed files panel cannot give anything back.
    const least = Math.min(wants, 2, capacity)
    if (claude.units + wants <= capacity) return [claude, pane(wants)]
    /*
     * A panel that asked for more than a pane's floor asked because it splits.
     * The files panel is a tree or a list beside the file, diff or commit you
     * opened, and it spends about a quarter of its width on that left-hand
     * side -- so squeezed back to two units the half you are actually reading
     * lands at 56 to 63 columns, under the MIN_PANE_COLUMNS this whole layout
     * exists to guarantee.
     *
     * So Claude gives way, not the panel. It used to be the other way round,
     * on the argument that a narrower editor beats no agent -- but a diff you
     * cannot read at 80 columns is not a narrower editor, it is a broken one,
     * and the agent is still there when you close the panel. `wants > least`
     * is exactly "this panel would have to be squeezed", since `least` is what
     * the squeeze would give it.
     */
    if (wants === least && claude.units + least <= capacity) return [claude, pane(least)]
    // Alone on the window, so it takes the whole of it rather than what it
    // asked for -- there is nothing left to share the row with.
    return [pane(capacity)]
  }

  const charWidth = measureMonoCharWidth(TERMINAL_FONT_SIZE, TERMINAL_FONT_FAMILY)
  const minPaneWidth = MIN_PANE_COLUMNS * charWidth + PANE_CHROME_WIDTH
  /*
   * The row is a grid of units, and every tile is a whole number of them.
   *
   * A unit is half a pane. `pitch` is one unit plus the gap that follows it,
   * and the floor is half of a pane's own -- so two units still clear
   * MIN_PANE_COLUMNS, which is the promise, while a pane may now be three of
   * them. A tile of u units is `u * pitch - GAP` wide: it swallows the gaps
   * between the units it covers, so tiles of any width occupy exactly the same
   * run of the row as the units they span.
   *
   * Two units minimum, which is one pane -- and below that it is the pitch that
   * gives, not the row: `units` cannot go under two, so a window narrower than
   * a pane's own floor divides into two units smaller than half of one and the
   * pane shrinks past MIN_PANE_COLUMNS with it. The floor is a promise about
   * how a row is divided among the windows in it, not one a window smaller than
   * a single pane can keep.
   */
  const unitPitch = (minPaneWidth + GAP) / 2
  const units = Math.max(2, Math.floor((width - GAP) / unitPitch))
  const pitch = (width - GAP) / units

  /*
   * `group` rather than a project id, because a leaving slot outlives the list
   * that produced it -- `useTileMotion` keeps it on screen for the exit -- and
   * anything re-derived from `projects` is gone by then. Closing a project is a
   * button *inside* this cell now, so that is the common path rather than a
   * rare one.
   */
  type Cell = {
    key: string
    worktree: Worktree | null
    group: ProjectGroup | null
    panes: Pane[]
    at: number
    units: number
  }
  const cells: Cell[] = []
  /*
   * Where the row may come to rest: every pane's leading edge, in units.
   *
   * Not every unit. A unit is half a pane, so a marker on each one let the row
   * stop with a pane cut down the middle -- half of Claude beside half of a
   * terminal -- and on a phone, where a window is the screen, that is the
   * *usual* place a swipe landed: two halves of two worktrees and neither of
   * them readable. A pane is the smallest thing worth looking at, so it is the
   * smallest thing worth stopping on, and it is already the granularity the
   * Cmd+arrow walk uses -- `stops` below is the same list said in panes rather
   * than in units.
   */
  const rests: number[] = []
  let next = 0
  const push = (
    key: string,
    worktree: Worktree | null,
    group: ProjectGroup | null,
    panes: Pane[],
  ): void => {
    let span = 0
    for (const pane of panes) {
      rests.push(next + span)
      span += pane.units
    }
    cells.push({ key, worktree, group, panes, at: next, units: span })
    next += span
  }
  /*
   * Each project's windows, then that project's own new-worktree tile.
   *
   * The row arrives grouped by project already, so the tile lands at the end of
   * the run it belongs to and never has to ask which project it is for -- which
   * is what the single tile at the far end of the row could not answer once
   * more than one project was open, and why it used to appear only when exactly
   * one was.
   */
  for (const group of groups) {
    const key = projectKey(group.project.id)
    push(key, null, group, [
      { kind: 'project', key, units: Math.min(PANE_UNITS.project, units) },
    ])
    for (const worktree of group.awake) push(worktree.id, worktree, null, panesOf(worktree, units))
  }
  const totalUnits = next
  /*
   * The far end is a resting place whether or not a pane begins there.
   *
   * The last offset the row can reach is `totalUnits - units`, and that lands
   * mid-pane whenever the tail of the row does not divide evenly -- so without
   * it the nearest stop before the end is where mandatory snapping would hold
   * the row, and the last window could never be seen whole. It is also exactly
   * the low end of `nearestOffset`'s range for the last tile, which is what
   * makes revealing that tile and resting at the end the same offset.
   */
  const lastOffset = Math.max(0, totalUnits - units)
  const rest = [...new Set([...rests.filter((at) => at < lastOffset), lastOffset])].sort(
    (a, b) => a - b,
  )
  /*
   * The wheel handler subscribes once and would otherwise close over the first
   * render's list. Written during render, read only from the listener.
   */
  const restRef = useRef(rest)
  restRef.current = rest

  const slots: Slot<Cell>[] = cells.map((cell) => ({
    key: cell.key,
    width: Math.max(0, cell.units * pitch - GAP),
    data: cell,
  }))
  const moving = useTileMotion(width > 0 ? slots : [])

  /*
   * Bring what was just asked for into view.
   *
   * This is what replaces displacing things to make the new thing visible. On a
   * phone, where a pane is a screenful, opening a panel scrolls to it -- the
   * same outcome as the old rule that pushed Claude out, without discarding any
   * state to get there.
   */
  /*
   * Navigation is by the spot, and it moves as little as it can.
   *
   * Every tile begins on a spot boundary, so every offset the row can rest at
   * is `spot * pitch` for some spot, and a tile is never shown half-cut. Which
   * of those offsets a request lands on is the least movement that brings the
   * whole of the named worktree on screen -- see `nearestOffset`. Asking for a
   * worktree says which one you want to see, not where on the screen to put
   * it, so whatever was already in front of you stays there if it can.
   */
  const target = scrollTo === null ? undefined : cells.find((cell) => cell.key === scrollTo.id)
  /*
   * The request this has already answered.
   *
   * `target` is found in a list rebuilt every render, so it is a new object
   * every render and the effect below runs every render -- and it used to
   * scroll every render with it, which quietly forbade scrolling the row by
   * hand: a state update, and attention brings one about once a second,
   * dragged the row back to the last worktree that had been navigated to. The
   * nonce is what actually says "this is a new request".
   *
   * Recorded only once the scroll happens, because a request can arrive before
   * the tile it names: waking a worktree asks for it in the same breath, and
   * the tile is a render behind.
   */
  const answered = useRef<number | null>(null)
  useEffect(() => {
    if (target === undefined || width === 0 || scrollTo === null) return
    if (answered.current === scrollTo.nonce) return
    const grid = gridRef.current
    if (!grid) return
    // Answered before deciding whether to move: a request that turns out to
    // need no scroll has still been dealt with, and must not be reconsidered
    // later against a row that has since been scrolled by hand.
    answered.current = scrollTo.nonce
    /*
     * A tile you can already see the whole of is left exactly where it is:
     * there is nothing more of it to show, and moving the row would slide
     * every other window sideways for no gain -- the terminal you were reading
     * beside it included.
     */
    const tile = { at: target.at, units: target.units }
    if (wholeOnScreen(tile, grid.scrollLeft, pitch, width)) return
    const offset = nearestOffset(tile, grid.scrollLeft / pitch, units, restRef.current)
    grid.scrollTo({ left: offset * pitch, behavior: 'smooth' })
    // scrollTo carries a counter, so asking twice for one worktree is two
    // requests; the spot alone would compare equal and scroll nowhere.
  }, [scrollTo, target, pitch, width, units])

  /*
   * Clicking into a window you can only see part of brings the rest of it over.
   *
   * Navigation lands the row on a tile boundary, but a drag or a wheel leaves
   * it wherever the gesture ended -- so the window you reach for is often the
   * one hanging half off an edge, and the caret used to go into a pane a third
   * of which was on screen and stay there. Clicking into a pane says the same
   * thing clicking its tab says: this is the one I am working in. So it means
   * what every other navigation here means, and reaches the same two functions:
   * the least movement that brings the whole tile over, and nothing at all for
   * one you can already see.
   *
   * The whole tile rather than the pane that was clicked, which is the rule the
   * row has everywhere else -- a tile is never wider than the window, so the
   * pane comes with it, and stopping at the pane's own edge would be this one
   * action deliberately leaving a window half-cut.
   *
   * It does not go through `onReveal` and the request above, deliberately.
   * That hands the keyboard to the pane it names, and this is triggered *by*
   * the keyboard arriving -- re-handing it would take the caret off whatever
   * inside the pane was actually clicked, a file in the tree or one terminal's
   * tab among several. Measured: after a click that scrolls, `activeElement` is
   * still the terminal's own textarea, and still the todo box when that is what
   * was clicked.
   *
   * Focus is the trigger rather than the click, which is what it means to be
   * working in a pane -- and the click on a pane's bar is already a reveal of
   * its own. The one thing that does nothing is a click on a part of a panel
   * that takes no focus, empty space under a short list of todos being the only
   * real example.
   */
  const revealTile = (tile: { at: number; units: number }): void => {
    const grid = gridRef.current
    if (!grid || width === 0) return
    if (wholeOnScreen(tile, grid.scrollLeft, pitch, width)) return
    const offset = nearestOffset(tile, grid.scrollLeft / pitch, units, rest)
    grid.scrollTo({ left: offset * pitch, behavior: 'smooth' })
  }

  /*
   * A window that grows brings the rest of itself over.
   *
   * Opening a file, a diff or a commit is what does this: the files panel is
   * one unit while it is only its tree and three once something is open in it,
   * so a tile goes three units to five on a click inside a pane that is already
   * on screen. The half that appears is on the *right*, which is the edge it
   * runs off -- and the pane you just opened something in is the one that goes
   * under, since the panel sits to the right of Claude. Opening a panel is a
   * reveal already; opening something *inside* one was not, and that is the
   * same action one level down.
   *
   * It is the same least-movement rule as every other navigation here, so a
   * tile that still fits where it is does not move, and one that does not
   * shifts by the fewest units that bring the whole of it over.
   *
   * Growth is the trigger, not size: a tile that shrinks (you closed the file)
   * has nothing hidden to show, and moving the row then would take a window you
   * *were* reading out from under you for nothing.
   *
   * Spans are remembered rather than derived, because what a tile was is not
   * something the render has -- and a *new* tile counts as no growth at all:
   * waking one and making one each scroll to it themselves, and a tile arriving
   * mid-row must not drag the row to wherever it landed.
   *
   * Not across a resize, which is the one other thing that changes a span. The
   * capacity of the row changes with the window, so a tile can gain a unit
   * without anything being opened, and the row is already putting itself back
   * where it was by spot -- see `unitRef`. Two effects scrolling the same row in
   * one commit is one of them losing.
   */
  const spans = useRef(new Map<string, number>())
  const capacity = useRef(units)
  useEffect(() => {
    if (width === 0) return
    const was = spans.current
    const resized = capacity.current !== units
    spans.current = new Map(cells.map((cell) => [cell.key, cell.units]))
    capacity.current = units
    if (resized) return
    const grown = cells.find((cell) => cell.units > (was.get(cell.key) ?? cell.units))
    if (grown !== undefined) revealTile(grown)
    // `cells` is rebuilt every render, so there is no dependency to name: the
    // remembered spans are what say whether anything actually happened.
  })

  /*
   * Cmd+Left and Cmd+Right step through the worktrees.
   *
   * The terminals have no claim on it: xterm produces nothing at all for a
   * Cmd-modified arrow -- its keyboard handler bails out on `metaKey` before
   * building a sequence -- so no bytes reach tmux, the shell or Claude. And it
   * is the binding a terminal emulator would use anyway: Cmd+arrow means
   * "switch tab" in iTerm and Terminal.
   *
   * The browser does claim it on macOS, where it is history back and forward,
   * which is why the event is cancelled rather than merely acted on.
   *
   * "Where you are" is the worktree that has the keyboard, so this is the
   * keyboard version of clicking the tab beside the one you are on.
   *
   * A step asks for its neighbour the way a tab click does, so it scrolls only
   * as far as it has to: a neighbour already wholly on screen just takes the
   * keyboard. The row stays put while you walk along the windows in front of
   * you, and moves when you reach one you cannot see the whole of -- which,
   * with panels open, is what "the next worktree" often is.
   */
  /*
   * The stops a step lands on: every pane of every worktree, in row order.
   *
   * Panes rather than worktrees, so stepping right out of Claude reaches the
   * panel beside it instead of skipping over it to the next window -- the
   * panel is where you were going most of the time. It falls out of `panesOf`
   * with no special case: a worktree with nothing open contributes one stop,
   * one with a panel two, and a window too narrow to hold Claude one again.
   */
  const stops = cells.flatMap((cell) =>
    cell.panes.map((pane) => ({
      // The cell's own key: a worktree id, or `add:<projectId>` for the tile at
      // the end of a project's run. The walk does not care which.
      id: cell.key,
      kind: pane.kind as PaneKind,
      at: cell.at,
      units: cell.units,
    })),
  )
  useEffect(() => {
    const step = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      /*
       * A dialog is the only thing that keeps this key.
       *
       * It is modal -- the row is behind a scrim and you are answering a
       * question -- so stepping the windows underneath would be acting on
       * something nobody asked about. Everywhere else the shortcut belongs to
       * the row: a todo's prompt, the editor in the files panel and the
       * terminals are all places you sit for minutes at a time, and a
       * navigation key that dies wherever the caret happens to be is a
       * navigation key you cannot rely on. Cmd+Left as "start of line" is the
       * price, and Home still does it.
       */
      const target = event.target as HTMLElement | null
      if (target?.closest('.dialog')) return

      const grid = gridRef.current
      if (!grid || stops.length === 0 || pitch <= 0) return
      /*
       * Where you are, most authoritative first.
       *
       * What actually holds the keyboard comes before what React last recorded,
       * and that ordering is the fix for two real bugs. `active` is state, so a
       * step taken before it commits is measured from the previous one; and the
       * row scrolls *smoothly*, so a second press while that animation runs
       * found the tile not wholly on screen and fell through to the leftmost
       * unit -- which threw the walk back to a tile you had already left.
       * Measured: Right, Right, Left netted nothing at all instead of one stop.
       * The DOM cannot be stale and does not care that the row is moving.
       *
       * The `wholeOnScreen` test survives for the case it was written for: no
       * pane holds the keyboard, you have scrolled by hand, and the honest
       * answer is the tile you are looking at rather than the one you left.
       */
      const held = (document.activeElement as HTMLElement | null)
        ?.closest('[data-pane]')
        ?.getAttribute('data-pane')
      let here =
        held === undefined || held === null
          ? -1
          : stops.findIndex((stop) => paneKey(stop.id, stop.kind) === held)

      if (here === -1) {
        const at = stops.findIndex(
          (stop) => stop.id === active?.id && stop.kind === active.pane,
        )
        const seen = stops[at]
        const tile = seen ? { at: seen.at, units: seen.units } : null
        here = tile && wholeOnScreen(tile, grid.scrollLeft, pitch, width) ? at : -1
      }
      if (here === -1) {
        /*
         * Back to the leftmost unit, and to that tile's *first* pane: landing
         * mid-tile would make the next step continue from a pane you are not
         * looking at.
         */
        const unit = Math.round(grid.scrollLeft / pitch)
        const owner = stops.filter((stop) => stop.at <= unit).at(-1)
        here =
          owner === undefined
            ? 0
            : stops.findIndex((stop) => stop.id === owner.id)
      }
      const to = stops[here + (event.key === 'ArrowRight' ? 1 : -1)]
      /*
       * Taken outright, and this handler listens in the capture phase so that
       * it can be. A text field's own handling runs at the target, before a
       * listener on the document would ever see the key: without capturing,
       * the caret would jump to the start of the line *and* the row would step.
       */
      event.preventDefault()
      event.stopPropagation()
      // Through the same request the top bar makes, rather than scrolling from
      // here: arriving somewhere is one thing, and it also hands over the
      // keyboard.
      if (to) onReveal(to.id, to.kind)
    }
    document.addEventListener('keydown', step, true)
    return () => document.removeEventListener('keydown', step, true)
  }, [stops, active, pitch, width, onReveal])

  /*
   * Cmd+I, Cmd+O and Cmd+F open a worktree's terminals, todos and files.
   *
   * The keyboard version of the three toggles in that window's own bar, and
   * the same click: pressed on the panel already showing, it closes it and
   * gives the width back to Claude. One shortcut per panel rather than one
   * that cycles, because which panel you want is a thing you know before you
   * press anything.
   *
   * "Which worktree" is the one that has the keyboard, the same question the
   * Cmd+arrow step asks and in the same order -- the DOM first, `active`
   * second. There is no third answer here: a step walks the row and so can
   * start from whatever tile you have scrolled to, but this acts on one
   * window, and with no window to act on the key is better left to the
   * browser than guessed at.
   *
   * The browser claims all three on macOS -- find, open a file, and Safari's
   * "use selection for find" -- and, unlike Cmd+N, Cmd+T and Cmd+W, it lets
   * all three be taken. So they are cancelled outright, in the capture phase:
   * that is what stops the find bar opening, and it is also what keeps the key
   * from reaching xterm, whose own handler cannot suppress a browser default
   * even when it returns false.
   */
  /*
   * The legend: Cmd is down, so say what the keys would do.
   *
   * The landing panes are read from `active` rather than from the DOM, which is
   * the opposite of what the stepper does and right for the opposite reason.
   * The stepper answers between two renders, where React's record can be a
   * press behind; this is rendered, so by the time it is on screen `active` has
   * committed -- and it is the only one of the two that re-renders the row when
   * it changes, which is what makes the hint follow you as you walk.
   */
  const keysLit = useMetaHeld()
  const at = keysLit
    ? stops.findIndex((stop) => stop.id === active?.id && stop.kind === active?.pane)
    : -1
  const landing = {
    left: at > 0 ? stops[at - 1]?.id : undefined,
    right: at === -1 ? undefined : stops[at + 1]?.id,
  }

  useEffect(() => {
    const open = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const panel = PANEL_FOR_KEY.get(event.key)
      if (panel === undefined) return
      // A dialog keeps its keys for the same reason it keeps Cmd+arrow: it is
      // modal, and opening a panel behind the scrim acts on something nobody
      // asked about.
      const target = event.target as HTMLElement | null
      if (target?.closest('.dialog')) return

      const held = (document.activeElement as HTMLElement | null)
        ?.closest('[data-pane]')
        ?.getAttribute('data-pane')
      /*
       * The worktree the keyboard is in, and `undefined` when that is the
       * new-worktree tile -- which has no panels to open, so the key does
       * nothing there rather than acting on whichever window was last active.
       */
      const holding = stops.find((stop) => paneKey(stop.id, stop.kind) === held)
      const here = holding
        ? cells.find((cell) => cell.key === holding.id)?.worktree
        : cells.find((cell) => cell.worktree?.id === active?.id)?.worktree
      if (!here) return

      event.preventDefault()
      event.stopPropagation()
      onTogglePanel(here.id, panel)
    }
    document.addEventListener('keydown', open, true)
    return () => document.removeEventListener('keydown', open, true)
  }, [stops, cells, active, onTogglePanel])

  /*
   * Keep your place across a resize.
   *
   * A scroll offset measured in the old spot width points somewhere arbitrary
   * once the spots are re-sized, which is how you end up part-way through a
   * tile without having scrolled there. The spot index is what survives; the
   * offset is recomputed from it.
   */
  const unitRef = useRef(0)
  useEffect(() => {
    const grid = gridRef.current
    if (!grid || width === 0) return
    grid.scrollTo({ left: unitRef.current * pitch, behavior: 'auto' })
  }, [pitch, width])

  /*
   * A sideways gesture moves the row, and only a sideways one.
   *
   * Scrolling *down* used to move it too, on the argument that a terminal on
   * the alternate screen has nothing of its own to scroll and the row is the
   * only thing that does -- so a wheel over most of a window would otherwise do
   * nothing at all. That argument loses to what it costs: reading down a diff
   * or a file and running off its end threw the row sideways, and so did any
   * stray downward graze over a terminal. Nothing is the right answer to a
   * downward wheel over a window; the row is walked with the tabs, Cmd+arrows,
   * or a sideways gesture, which is the axis it actually scrolls in.
   *
   * By the spot, because `scroll-snap-type: x mandatory` would drag anything
   * shorter straight back -- measured, a 120px sideways nudge snapped to where
   * it started and read as dead, where a 600px flick landed a spot along.
   * Anything with sideways scrolling of its own keeps first claim through
   * `inner`, and a gesture carries its own target so a second notch steps on
   * from where the row is already going rather than from the tile it has not
   * left yet.
   */
  useEffect(() => {
    const grid = gridRef.current
    if (!grid || pitch <= 0) return
    let aim: number | null = null
    let idle: ReturnType<typeof setTimeout> | undefined
    const onWheel = (event: WheelEvent): void => {
      // Whatever already acted on it -- a terminal scrolling its own scrollback
      // -- has spent the gesture.
      if (event.defaultPrevented) return
      // Down belongs to whatever is under the pointer, and to nothing if that
      // is a terminal. Only a gesture along the row moves the row.
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
      if (inner(event.target, grid, event.deltaX)) return

      const pixels =
        event.deltaMode === 1
          ? event.deltaX * WHEEL_LINE
          : event.deltaMode === 2
            ? event.deltaX * grid.clientWidth
            : event.deltaX
      // One event, one notch, or the row stays where it is. See WHEEL_STEP.
      if (Math.abs(pixels) < WHEEL_STEP) return
      event.preventDefault()
      clearTimeout(idle)
      idle = setTimeout(() => {
        aim = null
      }, WHEEL_IDLE_MS)

      const from = aim ?? grid.scrollLeft / pitch
      /*
       * A notch travels to the next place the row may rest, in the direction it
       * is going -- one pane, whatever that pane is worth in units. It was two
       * units flat, which is one pane only while every pane is one: the files
       * panel is three, so a notch left it a unit inside the next pane and the
       * one after that had to undo it.
       *
       * The ends are where they are rather than clamped arithmetic: `rest`
       * holds nothing past the last offset the row can reach, which is not the
       * last unit that exists -- clamping at `totalUnits - 1` once let `aim`
       * climb past the end and made the first notch back read as dead.
       *
       * A hair of tolerance, because `from` is a fraction of a pitch and a row
       * resting exactly on a stop must step off it rather than at it.
       */
      const stops = restRef.current
      const to =
        pixels > 0
          ? (stops.find((at) => at > from + 0.01) ?? stops[stops.length - 1] ?? 0)
          : ([...stops].reverse().find((at) => at < from - 0.01) ?? stops[0] ?? 0)
      aim = to
      grid.scrollTo({ left: to * pitch })
    }
    grid.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      clearTimeout(idle)
      grid.removeEventListener('wheel', onWheel)
    }
  }, [pitch, totalUnits])

  return (
    <section className="view overview">
      <div
        className="grid"
        ref={gridRef}
        onScroll={(event) => {
          const el = event.currentTarget
          if (pitch > 0) unitRef.current = Math.round(el.scrollLeft / pitch)
        }}
      >
        {/*
          * One marker per place the row may rest -- see `rest`: each pane's
          * leading edge, and the far end. A scroll therefore comes to rest with
          * a pane against the left edge and never part-way through one.
          *
          * Markers rather than the panes themselves, which are what you would
          * reach for: a pane is a share of its tile's width and sits half a gap
          * out from the unit grid, so snapping to one would leave the row a few
          * pixels off every time. These are out of flow and take no space.
          */}
        {width > 0 &&
          rest.map((at) => (
            <i
              key={at}
              className="grid__spot"
              style={{ left: GAP + at * pitch }}
              aria-hidden="true"
            />
          ))}
        {/* Nothing renders until the row is measured, so a terminal is never
            built at a width that is about to change. */}
        {width > 0 &&
          moving.map((slot) => {
            const worktree = slot.data.worktree
            return (
              <div
                key={slot.key}
                data-tile={slot.key}
                /*
                 * Focus anywhere inside a window says you are in that worktree
                 * -- its Claude, a terminal, a tab strip, a panel's button --
                 * and the top bar marks it. React's onFocus is focusin, which
                 * bubbles, so this one listener covers everything the tile
                 * will ever hold rather than each pane reporting for itself.
                 *
                 * To the pane now, not just the worktree: a Cmd+arrow step
                 * counts from where you are, and that is a pane. It is read off
                 * the nearest `data-pane`, which both the bar segments and the
                 * pane bodies carry.
                 */
                onFocus={
                  worktree === null
                    ? undefined
                    : (event) => {
                        const key = (event.target as HTMLElement)
                          .closest('[data-pane]')
                          ?.getAttribute('data-pane')
                        const pane = slot.data.panes.find((one) => one.key === key)
                        onActivate(
                          worktree.id,
                          pane === undefined || pane.kind === 'project' ? 'claude' : pane.kind,
                        )
                        // Not for a tile on its way out: it is held at its old
                        // place by the motion, and its `at` names a run of the
                        // row the rest of the windows have already closed over.
                        if (!slot.leaving) revealTile(slot.data)
                      }
                }
                className={slot.leaving ? 'slot slot--leaving' : 'slot'}
                // Its own width either way; a closing tile is taken to nothing
                // by the keyframe, which is the only thing that can animate a
                // node that was just re-created. See .slot--leaving.
                style={{ width: slot.width, marginRight: GAP }}
              >
                {/*
                 * Held at the width the tile will end at, so the terminal
                 * inside is laid out once and a growing tile uncovers finished
                 * content rather than reflowing it frame by frame. Whatever is
                 * not uncovered yet is simply clipped.
                 */}
                <div className="slot__inner" style={{ width: slot.width }}>
                  {worktree === null ? (
                    <div
                      className="tile tile--project"
                      data-pane={paneKey(slot.key, 'project')}
                      onFocus={() => onActivate(slot.key, 'project')}
                    >
                      {slot.data.group === null ? null : (
                        <ProjectPane
                          project={slot.data.group.project}
                          awake={slot.data.group.awake}
                          asleep={slot.data.group.asleep}
                          sessions={sessions}
                          todos={todos}
                          activeId={active?.id ?? null}
                          focus={scrollTo?.id === slot.key ? scrollTo.nonce : null}
                          onWake={onWake}
                          onReveal={onReveal}
                          onSleep={onSleep}
                          onCreated={onCreated}
                          onCloseProject={onCloseProject}
                        />
                      )}
                    </div>
                  ) : (
                    <WorktreeTile
                      worktree={worktree}
                      project={projectById.get(worktree.projectId)}
                      todos={worktreeTodos(todos, worktree.id)}
                      moveTo={moveTo}
                      panes={slot.data.panes}
                      /*
                       * Non-null only for the worktree just navigated to, and a
                       * fresh number each time it is asked for, so going back
                       * to one you were on hands the keyboard over again.
                       */
                      focus={scrollTo?.id === worktree.id ? scrollTo.nonce : null}
                      focusPane={scrollTo?.id === worktree.id ? scrollTo.pane : null}
                      session={claudeSession(sessions, worktree.id)}
                      current={active?.id === worktree.id}
                      terminals={terminalSessions(sessions, worktree.id)}
                      activeTerminalId={activeTerminalByWorktree[worktree.id] ?? null}
                      openPath={openPathByWorktree[worktree.id] ?? ''}
                      openFiles={openFilesByWorktree[worktree.id] ?? EMPTY_FILES}
                      expandedDirs={expandedByWorktree[worktree.id] ?? EMPTY_DIRS}
                      filesMode={filesModeByWorktree[worktree.id] ?? 'files'}
                      keysLit={keysLit}
                      /*
                       * Left wins when a worktree is both, which cannot happen
                       * -- see the prop -- but leaves the rule written down
                       * rather than depending on the layout to keep it true.
                       */
                      step={
                        landing.left === worktree.id
                          ? 'left'
                          : landing.right === worktree.id
                            ? 'right'
                            : null
                      }
                      commit={commitByWorktree[worktree.id] ?? null}
                      scroller={gridRef}
                      onStart={() => onStart(worktree.id)}
                      onReveal={() => onReveal(worktree.id)}
                      onTogglePanel={(panel) => onTogglePanel(worktree.id, panel)}
                      onQueueDrained={() => onQueueDrained(worktree.id)}
                      onSelectTerminal={(sessionId) => onSelectTerminal(worktree.id, sessionId)}
                      onNewTerminal={() => onNewTerminal(worktree.id)}
                      onCloseTerminal={(sessionId) => onCloseTerminal(worktree.id, sessionId)}
                      onOpenPath={(path) => onOpenPath(worktree.id, path)}
                      onCloseFile={(path) => onCloseFile(worktree.id, path)}
                      onSelectCommit={(hash) => selectCommit(worktree.id, hash)}
                      onToggleDir={(dir) => onToggleDir(worktree.id, dir)}
                      onExpandDir={(dir) => onExpandDir(worktree.id, dir)}
                      onFilesMode={(mode) => onFilesMode(worktree.id, mode)}
                    />
                  )}
                </div>
              </div>
            )
          })}
      </div>
    </section>
  )
}
