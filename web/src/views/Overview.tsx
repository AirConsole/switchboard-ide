import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type {
  FilesMode,
  PanelName,
  Project,
  Session,
  Worktree,
  WorktreeTodo,
} from '@ide-n-dream/shared'
import {
  TerminalView,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from '../terminal/TerminalView.js'
import { api } from '../api.js'
import {
  claudeSession,
  isRunning,
  terminalSessions,
  worktreeTodos,
  type TodoView,
} from '../selectors.js'
import { TodoBar, TodoPane } from './TodoPane.js'
import { TerminalsScreen, TerminalsTabs } from './TerminalsPane.js'
import { useChangesState } from './ChangesPane.js'
import { FilesBar, FilesPane, useFilesState } from './FilesPane.js'
import { MIN_PANE_COLUMNS, PANE_CHROME_WIDTH, measureMonoCharWidth } from './overviewLayout.js'
import { useTileMotion, type Slot } from './tileMotion.js'
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
const ADD_KEY = '__add'

/*
 * One shared empty list for worktrees with nothing expanded. A fresh `[]` each
 * render would be a new identity, and the files hook re-reads its directories
 * whenever that changes.
 */
const EMPTY_DIRS: string[] = []

/**
 * Is the whole of a tile on screen already?
 *
 * A tile begins one gap into its own run of the row -- the leading inset, which
 * `scroll-padding-left` matches -- and ends at the far edge of the last spot it
 * covers: it swallows the gaps between the spots it spans and leaves only the
 * trailing one outside itself, so `(spot + spots) * pitch` is its right edge.
 *
 * A pixel of slack at each end, because `pitch` is fractional and `scrollLeft`
 * is not: a tile flush against an edge must not read as one pixel over it.
 */
const wholeOnScreen = (
  tile: { spot: number; spots: number },
  scrollLeft: number,
  pitch: number,
  width: number,
): boolean =>
  GAP + tile.spot * pitch >= scrollLeft - 1 &&
  (tile.spot + tile.spots) * pitch <= scrollLeft + width + 1

/**
 * Which spot to scroll to so a tile is wholly on screen, moving as little as
 * possible.
 *
 * A tile of s spots at `spot` is whole on screen for every offset from
 * `spot + s - capacity` -- its right edge against the right edge of the window
 * -- to `spot`, its left edge against the left. The nearest of those to where
 * the row already sits is the answer: going to the one-spot worktree just off
 * the right edge scrolls by one spot and keeps the one you were on beside it,
 * rather than pulling the new one to the front and taking everything else off
 * the screen with it.
 *
 * The range is never empty, because a tile is never wider than the window --
 * see `panesOf` -- so it always holds `spot` itself. Offsets are spot indices,
 * which is what the row is allowed to come to rest on.
 */
const nearestOffset = (
  tile: { spot: number; spots: number },
  at: number,
  capacity: number,
): number => Math.min(Math.max(at, tile.spot + tile.spots - capacity), tile.spot)

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
const panelLabel = (panel: PanelName, counts: PanelCounts): string => {
  switch (panel) {
    case 'todo':
      // What is queued outranks what is merely written down: one is about to
      // happen to this worktree and the other is a list. With nothing queued it
      // counts itself like the terminals do.
      if (counts.queued > 0) return counts.queued === 1 ? '1 Queued' : `${counts.queued} Queued`
      if (counts.todos === 0) return 'Todo'
      return counts.todos === 1 ? '1 Todo' : `${counts.todos} Todos`
    case 'terminals':
      if (counts.terminals === 0) return 'Terminal'
      return counts.terminals === 1 ? '1 Terminal' : `${counts.terminals} Terminals`
    case 'files':
      /*
       * The count is uncommitted files, and it belongs on this toggle now that
       * the panel opens on them: a number on a control promises that clicking
       * shows you those N things, which is exactly what Changes mode does.
       */
      if (counts.changes === 0) return 'Files'
      return counts.changes === 1 ? 'Files 1±' : `Files ${counts.changes}±`
  }
}

/** How a pane is identified in the layout. */
export const paneKey = (worktreeId: string, pane: 'claude' | PanelName): string =>
  `${worktreeId}:${pane}`

type Pane =
  | { kind: 'claude'; key: string; worktree: Worktree }
  | { kind: PanelName; key: string; worktree: Worktree }
  | { kind: 'add'; key: string }

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
 * Removing a worktree is the one destructive thing in the bar, so it is the one
 * control that is not a word: an icon is read before it is parsed. Hairlines at
 * the same weight as the rest of the chrome, and currentColor so it inherits
 * the quiet-until-hovered treatment of the button around it.
 */
const TrashIcon = (): React.ReactElement => (
  <svg
    className="tile__icon"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M2.5 4.5h11" />
    <path d="M6.25 2.5h3.5" />
    <path d="M4.1 4.5l.55 8.1a1 1 0 0 0 1 .9h4.7a1 1 0 0 0 1-.9l.55-8.1" />
    <path d="M6.6 7v3.8M9.4 7v3.8" />
  </svg>
)

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
  session: Session | undefined
  terminals: Session[]
  activeTerminalId: string | null
  /** The file this worktree has open, and the directories it has expanded. */
  openPath: string
  expandedDirs: string[]
  /** Which face its files panel is showing. */
  filesMode: FilesMode
  /** The scroller, so the tile can tell whether it is worth mounting. */
  scroller: RefObject<HTMLElement | null>
  onStart: () => void
  onSleep: () => void
  /** Bring this worktree wholly into view. */
  onReveal: () => void
  onRemove: () => void
  onTogglePanel: (panel: PanelName) => void
  /** Close panels, for reasons other than the layout running out of room. */
  onCollapsePanels: (collapsed: { worktreeId: string; panel: PanelName }[]) => void
  onSelectTerminal: (sessionId: string) => void
  onNewTerminal: () => void
  onCloseTerminal: (sessionId: string) => void
  onOpenPath: (path: string) => void
  onToggleDir: (dir: string) => void
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
  panes,
  focus,
  session,
  terminals,
  activeTerminalId,
  openPath,
  expandedDirs,
  filesMode,
  scroller,
  onStart,
  onSleep,
  onReveal,
  onRemove,
  onTogglePanel,
  onCollapsePanels,
  onSelectTerminal,
  onNewTerminal,
  onCloseTerminal,
  onOpenPath,
  onToggleDir,
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
  const columns = `repeat(${panes.length}, minmax(0, 1fr))`
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
  })
  const files = useFilesState({
    worktreeId: worktree.id,
    revision,
    enabled: filesOpen && filesMode === 'files',
    path: openPath,
    expanded: expandedDirs,
    onOpen: onOpenPath,
    onToggleDir,
  })
  const counts: PanelCounts = {
    todos: todos.length,
    queued: todos.filter((view) => view.position !== null).length,
    terminals: terminals.length,
    changes: worktree.dirty ?? 0,
  }

  const claudeIndex = panes.findIndex((pane) => pane.kind === 'claude')
  const controlsIndex = claudeIndex === -1 ? 0 : claudeIndex
  const revealHint = `Click to bring ${worktree.name}'s window into view`

  const identity = (
    <span className="tile__label">
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
   * What acts on the worktree comes first, then what it can show.
   *
   * The state used to lead this row and is gone: the rail down the tile's edge
   * already carries it -- amber for blocked on you, green for come to rest --
   * and a word repeating a colour you scan for is a word spent twice. Which
   * leaves the panel toggles as the far end of the bar, where the panel they
   * open begins.
   */
  const controls = (
    <div className="tile__controls">
      {/* The main worktree cannot be removed, so it gets no control. */}
      {!worktree.isMain && (
        <button
          className="tile__remove"
          onClick={onRemove}
          title={`Remove ${worktree.name}`}
          aria-label={`Remove worktree ${worktree.name}`}
        >
          <TrashIcon />
        </button>
      )}
      <button
        className="tile__zz"
        onClick={onSleep}
        title={`Put ${worktree.name} to sleep and hide its window`}
        aria-label={`Sleep ${worktree.name}`}
      >
        zZ
      </button>
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
            {panelLabel(panel, counts)}
          </button>
        )
      })}
    </div>
  )

  return (
    <div className={`tile tile--${state}`} ref={tileRef}>
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
          <div className="tile__seg" key={pane.key}>
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
              <FilesBar mode={filesMode} files={files} changes={changes} />
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
                    focus={focus}
                  />
                )
              ) : (
                <div className="tile__idle">
                  <p className="tile__idle-text">{idleReason(session)}</p>
                  {exitOutput.length > 0 && (
                    <pre
                      className="tile__idle-output"
                      /*
                       * Opened at the bottom, like a terminal: the last thing a
                       * failing command says is the part that says why, and a
                       * long one starts scrolled past it otherwise.
                       */
                      ref={(element) => {
                        if (element) element.scrollTop = element.scrollHeight
                      }}
                    >
                      {exitOutput.join('\n')}
                    </pre>
                  )}
                  <button className="btn" onClick={onStart}>
                    Start Claude
                  </button>
                </div>
              ))}
            {pane.kind === 'terminals' && near && (
              <TerminalsScreen
                terminals={terminals}
                activeTerminalId={activeTerminalId}
                fontSize={TERMINAL_FONT_SIZE}
              />
            )}
            {pane.kind === 'todo' && (
              <TodoPane
                worktreeId={worktree.id}
                todos={todos}
                claudeRunning={running}
                /*
                 * Closed the way the layout closes a panel it could not keep,
                 * rather than through the toggle: the toggle also scrolls to
                 * the worktree, and a queue draining in a window you are not
                 * looking at must not drag the row over to it.
                 */
                onQueueDrained={() => onCollapsePanels([{ worktreeId: worktree.id, panel: 'todo' }])}
              />
            )}
            {pane.kind === 'files' && (
              <FilesPane
                mode={filesMode}
                onMode={onFilesMode}
                files={files}
                changes={changes}
                branch={worktree.branch}
                near={near}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

const AddTile = ({ onClick }: { onClick: () => void }): React.ReactElement => (
  <button className="tile--add" onClick={onClick}>
    <span className="tile--add__mark" aria-hidden="true">
      +
    </span>
    <span className="tile--add__label">New worktree</span>
    <p className="tile--add__hint">
      Branches off and checks out its own directory, with Claude running in it.
    </p>
  </button>
)

/**
 * Whether anything between `from` and the row would rather have this wheel.
 *
 * Standard scroll chaining, done by hand because the row has to know when the
 * wheel is spare. A panel with more to show scrolls itself; one already at its
 * end passes the gesture on, which is what the browser would do if the row
 * scrolled in the same axis as the wheel.
 */
const inner = (from: EventTarget | null, stop: Element, delta: number): boolean => {
  for (let el = from as HTMLElement | null; el && el !== stop; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight) continue
    const overflow = getComputedStyle(el).overflowY
    if (overflow !== 'auto' && overflow !== 'scroll') continue
    const room =
      delta < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1
    if (room) return true
  }
  return false
}

/**
 * How much wheel makes one spot: a notch, and nothing smaller.
 *
 * A mouse notch is exactly 100px in Chrome, so one notch is one spot. It has
 * to be a whole notch in one event, though, rather than a total accumulated
 * over a gesture. A trackpad -- and a Magic Mouse -- reports a scroll as a
 * stream of small deltas with momentum after it, so accumulating meant an
 * incidental graze while reading moved the row a spot and a flick walked it
 * several: measured over a tile's bar, ten trackpad-sized deltas of 12px took
 * the row 0 -> 794, and a forty-event flick 0 -> 1588. Nobody asked for that,
 * and it read as the row moving on its own.
 *
 * Sideways gestures still scroll the row, natively and by the pixel, which is
 * the axis a trackpad has for a strip like this anyway. Firefox reports lines
 * rather than pixels; 40 is the usual line for a wheel, so its three-line
 * notch clears the same bar.
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
  sessions: Session[]
  panels: Record<string, PanelName[]>
  activeTerminalByWorktree: Record<string, string>
  /** Where each worktree's files panel is standing. */
  openPathByWorktree: Record<string, string>
  /** Directories each worktree has expanded in its file tree. */
  expandedByWorktree: Record<string, string[]>
  /** Which face each worktree's files panel is showing. */
  filesModeByWorktree: Record<string, FilesMode>
  /**
   * The project a new worktree would go to, when there is only one open.
   *
   * Null with several open, because the add tile would have to guess which one
   * it added to -- the top bar's per-project `+` is unambiguous and is there
   * either way.
   */
  addTo: Project | null
  /**
   * A request to bring a worktree's tile into view: its id, plus a counter so
   * that asking twice for the same one is two requests. Set when you click a
   * worktree in the top bar, step to one, wake one, or open one of its panels.
   */
  scrollTo: { id: string; nonce: number } | null
  /**
   * The worktree you are in, which is where a Cmd+arrow step counts from. It
   * follows focus, not only navigation, so clicking into a window makes the
   * next step continue from there.
   */
  activeId: string | null
  /** Anything in this worktree took focus, so this is where you are now. */
  onActivate: (worktreeId: string) => void
  onStart: (worktreeId: string) => void
  onSleep: (worktreeId: string) => void
  /** Bring that worktree wholly into view, and hand its Claude the keyboard. */
  onReveal: (worktreeId: string) => void
  onRemoveWorktree: (worktreeId: string) => void
  onTogglePanel: (worktreeId: string, panel: PanelName) => void
  onNewWorktree: () => void
  onSelectTerminal: (worktreeId: string, sessionId: string) => void
  onNewTerminal: (worktreeId: string) => void
  /** Closing the last one closes the panel too, so it needs the worktree. */
  onCloseTerminal: (worktreeId: string, sessionId: string) => void
  onOpenPath: (worktreeId: string, path: string) => void
  onToggleDir: (worktreeId: string, dir: string) => void
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
  sessions,
  panels,
  activeTerminalByWorktree,
  openPathByWorktree,
  expandedByWorktree,
  filesModeByWorktree,
  addTo,
  scrollTo,
  activeId,
  onActivate,
  onStart,
  onSleep,
  onReveal,
  onRemoveWorktree,
  onTogglePanel,
  onNewWorktree,
  onSelectTerminal,
  onNewTerminal,
  onCloseTerminal,
  onOpenPath,
  onToggleDir,
  onFilesMode,
}: OverviewProps): React.ReactElement => {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const { width } = useElementSize(gridRef)
  const projectById = new Map(projects.map((project) => [project.id, project]))

  /*
   * A tile's panes. Each one takes a spot in the row.
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

  const panesOf = (worktree: Worktree, capacity: number): Pane[] => {
    const open = openPanelsOf(worktree)
    const claude: Pane = { kind: 'claude', key: paneKey(worktree.id, 'claude'), worktree }
    // The newest `capacity` panels, in the order they were opened.
    const kept = new Set(open.length > capacity ? open.slice(open.length - capacity) : open)
    const panelPanes: Pane[] = PANELS.filter((panel) => kept.has(panel)).map((panel) => ({
      kind: panel,
      key: paneKey(worktree.id, panel),
      worktree,
    }))
    return panelPanes.length + 1 <= capacity ? [claude, ...panelPanes] : panelPanes
  }

  const charWidth = measureMonoCharWidth(TERMINAL_FONT_SIZE, TERMINAL_FONT_FAMILY)
  const minPaneWidth = MIN_PANE_COLUMNS * charWidth + PANE_CHROME_WIDTH
  // n panes occupy GAP + n * (paneWidth + GAP): the leading inset plus one
  // trailing margin each. Solved for n, then for paneWidth.
  /*
   * The row is a grid of spots, and every tile is a whole number of them.
   *
   * A spot is as wide as it has to be for `spots` of them to fill the window
   * exactly, and never narrower than MIN_PANE_COLUMNS -- so the window divides
   * evenly and a single worktree on a wide screen gets the whole of it.
   *
   * `pitch` is a spot plus the gap that follows it, which is the unit
   * everything else is expressed in. A tile of s spots is `s * pitch - GAP`
   * wide: it swallows the gaps between the spots it covers, so two one-spot
   * tiles and one two-spot tile occupy exactly the same run of the row.
   */
  const spots = Math.max(1, Math.floor((width - GAP) / (minPaneWidth + GAP)))
  const pitch = (width - GAP) / spots

  type Cell = { key: string; worktree: Worktree | null; panes: Pane[]; spot: number }
  const cells: Cell[] = []
  let next = 0
  for (const worktree of worktrees) {
    const panes = panesOf(worktree, spots)
    cells.push({ key: worktree.id, worktree, panes, spot: next })
    next += panes.length
  }
  if (addTo !== null) {
    cells.push({ key: ADD_KEY, worktree: null, panes: [{ kind: 'add', key: ADD_KEY }], spot: next })
    next += 1
  }
  const totalSpots = next

  const slots: Slot<Cell>[] = cells.map((cell) => ({
    key: cell.key,
    width: Math.max(0, cell.panes.length * pitch - GAP),
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
    const tile = { spot: target.spot, spots: target.panes.length }
    if (wholeOnScreen(tile, grid.scrollLeft, pitch, width)) return
    const offset = nearestOffset(tile, Math.round(grid.scrollLeft / pitch), spots)
    grid.scrollTo({ left: offset * pitch, behavior: 'smooth' })
    // scrollTo carries a counter, so asking twice for one worktree is two
    // requests; the spot alone would compare equal and scroll nowhere.
  }, [scrollTo, target, pitch, width, spots])

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
  const stops = cells.filter((cell) => cell.worktree !== null)
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
       * Where you are is the worktree holding the keyboard -- but only while
       * you can still see the whole of it. Since stepping no longer always
       * scrolls, the leftmost spot is no longer the answer on its own: three
       * windows that all fit share one leftmost tile, and every step would
       * offer the same neighbour again. If you have scrolled the active
       * worktree off the side, though, it is not where you are looking, and
       * the tile at the leftmost spot is the honest answer once more.
       */
      const active = stops.findIndex((cell) => cell.key === activeId)
      const seen = stops[active]
      const tile = seen ? { spot: seen.spot, spots: seen.panes.length } : null
      let here = tile && wholeOnScreen(tile, grid.scrollLeft, pitch, width) ? active : -1
      if (here === -1) {
        const at = Math.round(grid.scrollLeft / pitch)
        // The tile that holds the leftmost spot.
        here = 0
        for (let index = 0; index < stops.length; index++) {
          if ((stops[index]?.spot ?? 0) <= at) here = index
        }
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
      if (to?.worktree) onReveal(to.worktree.id)
    }
    document.addEventListener('keydown', step, true)
    return () => document.removeEventListener('keydown', step, true)
  }, [stops, activeId, pitch, width, onReveal])

  /*
   * Keep your place across a resize.
   *
   * A scroll offset measured in the old spot width points somewhere arbitrary
   * once the spots are re-sized, which is how you end up part-way through a
   * tile without having scrolled there. The spot index is what survives; the
   * offset is recomputed from it.
   */
  const spotRef = useRef(0)
  useEffect(() => {
    const grid = gridRef.current
    if (!grid || width === 0) return
    grid.scrollTo({ left: spotRef.current * pitch, behavior: 'auto' })
  }, [pitch, width])

  /*
   * The wheel moves the row.
   *
   * A terminal on the alternate screen has nothing of its own to scroll, and
   * `TerminalView` stops xterm turning the wheel into arrow keys there, so
   * without this a wheel over most of the window did nothing at all. The row
   * is the thing that scrolls, and this is the pointer's way of saying so.
   *
   * By the spot, because `scroll-snap-type: x mandatory` would drag anything
   * shorter straight back: a wheel notch is ~100px against a spot of ~780, so
   * adding pixels to `scrollLeft` would snap to where it started and read as
   * dead. Panels keep first claim through `inner`, and a gesture carries its
   * own target so a second notch steps on from where the row is already going
   * rather than from the tile it has not left yet.
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
      // Sideways is the scroller's own axis, and it can have it.
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      if (inner(event.target, grid, event.deltaY)) return

      const pixels =
        event.deltaMode === 1
          ? event.deltaY * WHEEL_LINE
          : event.deltaMode === 2
            ? event.deltaY * grid.clientWidth
            : event.deltaY
      // One event, one notch, or the row stays where it is. See WHEEL_STEP.
      if (Math.abs(pixels) < WHEEL_STEP) return
      event.preventDefault()
      clearTimeout(idle)
      idle = setTimeout(() => {
        aim = null
      }, WHEEL_IDLE_MS)

      const from = aim ?? Math.round(grid.scrollLeft / pitch)
      const to = Math.min(Math.max(from + (pixels > 0 ? 1 : -1), 0), Math.max(0, totalSpots - 1))
      aim = to
      grid.scrollTo({ left: to * pitch })
    }
    grid.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      clearTimeout(idle)
      grid.removeEventListener('wheel', onWheel)
    }
  }, [pitch, totalSpots])

  return (
    <section className="view overview">
      <div
        className="grid"
        ref={gridRef}
        onScroll={(event) => {
          const el = event.currentTarget
          if (pitch > 0) spotRef.current = Math.round(el.scrollLeft / pitch)
        }}
      >
        {/*
          * One marker per spot, so a scroll comes to rest on a spot boundary
          * rather than part-way through one.
          *
          * Markers rather than the tiles themselves: a tile wider than the
          * window has to be scrollable *within*, to reach the spots it covers,
          * and snapping to tile starts alone would refuse to stop there. They
          * are out of flow and take no space, and the panes cannot be used for
          * this -- a multi-pane tile divides its own width evenly, which is
          * half a gap out from the spot grid.
          */}
        {width > 0 &&
          Array.from({ length: totalSpots }, (_, index) => (
            <i
              key={index}
              className="grid__spot"
              style={{ left: GAP + index * pitch }}
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
                 */
                onFocus={worktree === null ? undefined : () => onActivate(worktree.id)}
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
                    <AddTile onClick={onNewWorktree} />
                  ) : (
                    <WorktreeTile
                      worktree={worktree}
                      project={projectById.get(worktree.projectId)}
                      todos={worktreeTodos(todos, worktree.id)}
                      panes={slot.data.panes}
                      /*
                       * Non-null only for the worktree just navigated to, and a
                       * fresh number each time it is asked for, so going back
                       * to one you were on hands the keyboard over again.
                       */
                      focus={scrollTo?.id === worktree.id ? scrollTo.nonce : null}
                      session={claudeSession(sessions, worktree.id)}
                      terminals={terminalSessions(sessions, worktree.id)}
                      activeTerminalId={activeTerminalByWorktree[worktree.id] ?? null}
                      openPath={openPathByWorktree[worktree.id] ?? ''}
                      expandedDirs={expandedByWorktree[worktree.id] ?? EMPTY_DIRS}
                      filesMode={filesModeByWorktree[worktree.id] ?? 'changes'}
                      scroller={gridRef}
                      onStart={() => onStart(worktree.id)}
                      onSleep={() => onSleep(worktree.id)}
                      onReveal={() => onReveal(worktree.id)}
                      onRemove={() => onRemoveWorktree(worktree.id)}
                      onTogglePanel={(panel) => onTogglePanel(worktree.id, panel)}
                      onCollapsePanels={onCollapsePanels}
                      onSelectTerminal={(sessionId) => onSelectTerminal(worktree.id, sessionId)}
                      onNewTerminal={() => onNewTerminal(worktree.id)}
                      onCloseTerminal={(sessionId) => onCloseTerminal(worktree.id, sessionId)}
                      onOpenPath={(path) => onOpenPath(worktree.id, path)}
                      onToggleDir={(dir) => onToggleDir(worktree.id, dir)}
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
