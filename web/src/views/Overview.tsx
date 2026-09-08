import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { PanelName, Session, Worktree } from '@ide-n-dream/shared'
import {
  TerminalView,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from '../terminal/TerminalView.js'
import { claudeSession, isRunning, stateLabel, terminalSessions } from '../selectors.js'
import { TerminalsScreen, TerminalsTabs } from './TerminalsPane.js'
import {
  MIN_PANE_COLUMNS,
  PANE_CHROME_WIDTH,
  measureMonoCharWidth,
  planColumns,
} from './overviewLayout.js'

/**
 * Gap between tiles, in px. Applied inline rather than from the stylesheet so
 * the layout arithmetic and the rendered spacing cannot drift apart.
 */
const GAP = 12

/** Below this many worktree tiles, the grid has room to explain itself. */
const ADD_TILE_THRESHOLD = 2

/** How the add tile is identified in the layout. */
const ADD_KEY = '__add'

/**
 * Every panel, in the order they sit beside Claude.
 *
 * The order is fixed rather than the order they were opened, so a worktree's
 * panes do not shuffle underneath you: opening files would always put it in the
 * same place relative to the terminals.
 */
export const PANELS: readonly PanelName[] = ['terminals']

/** What a panel is called in prose, for the toggle's tooltip. */
const PANEL_NOUN: Record<PanelName, string> = { terminals: 'terminals' }

/**
 * The toggle's label.
 *
 * Terminals count themselves rather than repeating the panel's name: the number
 * is the useful part at a glance, and with none open the toggle says what the
 * click will actually do, which is make one. The count is of the terminals the
 * panel would show, exited ones included -- a label reading "new" over a tab
 * strip that already has a tab in it would be a contradiction.
 *
 * Exhaustive on purpose: adding a panel to PanelName will not compile until it
 * says what it is called.
 */
const panelLabel = (panel: PanelName, terminals: number): string => {
  switch (panel) {
    case 'terminals':
      if (terminals === 0) return 'New Terminal'
      return terminals === 1 ? '1 Terminal' : `${terminals} Terminals`
  }
}

/** How a pane is identified in the layout. */
export const paneKey = (worktreeId: string, pane: 'claude' | PanelName): string =>
  `${worktreeId}:${pane}`

type Pane =
  | { kind: 'claude'; key: string; worktree: Worktree }
  | { kind: PanelName; key: string; worktree: Worktree }
  | { kind: 'add'; key: string }

/**
 * A tile: one worktree and the panes it currently shows.
 *
 * A worktree is one tile however many columns it occupies, which is what lets
 * its bar run across the lot. The add tile is a group of one with no worktree.
 */
interface Tile {
  key: string
  worktree: Worktree | null
  panes: Pane[]
}

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

/** Which panes each expanded worktree wants, left to right. */
const wantedPanes = (
  worktrees: Worktree[],
  minimized: string[],
  panels: Record<string, PanelName[]>,
): Pane[] => {
  const minimizedIds = new Set(minimized)
  const panes: Pane[] = []
  for (const worktree of worktrees) {
    if (minimizedIds.has(worktree.id)) continue
    panes.push({ kind: 'claude', key: paneKey(worktree.id, 'claude'), worktree })
    // Read through PANELS rather than the stored array, which comes from a file
    // the user could have edited and may name a panel that no longer exists.
    const open = panels[worktree.id] ?? []
    for (const panel of PANELS) {
      if (open.includes(panel)) panes.push({ kind: panel, key: paneKey(worktree.id, panel), worktree })
    }
  }
  return panes
}

/** Consecutive panes of the same worktree, gathered into one tile. */
const gatherTiles = (panes: Pane[]): Tile[] => {
  const tiles: Tile[] = []
  for (const pane of panes) {
    const key = pane.kind === 'add' ? ADD_KEY : pane.worktree.id
    const last = tiles[tiles.length - 1]
    if (last && last.key === key) {
      last.panes.push(pane)
      continue
    }
    tiles.push({ key, worktree: pane.kind === 'add' ? null : pane.worktree, panes: [pane] })
  }
  return tiles
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
  /** The panes that fit, in display order. Never empty. */
  panes: Pane[]
  session: Session | undefined
  terminals: Session[]
  activeTerminalId: string | null
  onStart: () => void
  onMinimize: () => void
  onRemove: () => void
  onTogglePanel: (panel: PanelName) => void
  onSelectTerminal: (sessionId: string) => void
  onNewTerminal: () => void
  onCloseTerminal: (sessionId: string) => void
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
  panes,
  session,
  terminals,
  activeTerminalId,
  onStart,
  onMinimize,
  onRemove,
  onTogglePanel,
  onSelectTerminal,
  onNewTerminal,
  onCloseTerminal,
}: WorktreeTileProps): React.ReactElement => {
  // An exited session is offered as something to restart, not shown as a dead
  // terminal: whatever it printed last is of no use at a glance.
  const running = isRunning(session)
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
          : 'idle'

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
  const claudeIndex = panes.findIndex((pane) => pane.kind === 'claude')
  const controlsIndex = claudeIndex === -1 ? 0 : claudeIndex
  const minimizeHint = `Click to minimize ${worktree.name} to the top bar`

  /*
   * A real button, not text with a handler on the bar around it: clicking the
   * bar is the mouse gesture, and this is the same thing reachable by keyboard.
   * Both call the same handler, and the bar's guard below lets this one win.
   */
  const identity = (
    <button className="tile__label" onClick={onMinimize} title={minimizeHint}>
      <span className="tile__name">{worktree.name}</span>
      {worktree.branch && worktree.branch !== worktree.name && (
        <span className="tile__branch">{worktree.branch}</span>
      )}
      {worktree.dirty ? <span className="tile__branch">{worktree.dirty}&plusmn;</span> : null}
    </button>
  )

  const controls = (
    <div className="tile__controls">
      <span className="tile__state">{stateLabel(session)}</span>
      {PANELS.map((panel) => {
        /*
         * Lit when the panel's pane is on screen, which is the only thing the
         * toggle ever claims. A panel with no room for its pane is collapsed
         * outright rather than held open behind the scenes, so this cannot
         * disagree with what the tile is showing.
         */
        const on = shownPanes.has(panel)
        return (
          <button
            key={panel}
            className={on ? 'tile__toggle tile__toggle--on' : 'tile__toggle'}
            onClick={() => onTogglePanel(panel)}
            title={
              on
                ? `Close ${PANEL_NOUN[panel]}`
                : `Open ${PANEL_NOUN[panel]} beside Claude`
            }
          >
            {panelLabel(panel, terminals.length)}
          </button>
        )
      })}
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
    </div>
  )

  return (
    // Grow in proportion to the panes held, so every pane in the grid is the
    // same width whether its tile has one column or four.
    <div className={`tile tile--${state}`} style={{ flexGrow: panes.length }}>
      <div
        className="tile__bar"
        style={{ gridTemplateColumns: columns }}
        title={
          session
            ? `${worktree.path}\n${session.attachCommand}\n${minimizeHint}`
            : `${worktree.path}\n${minimizeHint}`
        }
        onClick={(event) => {
          /*
           * Minimizing is the bar's own gesture, so it fires on the bar itself
           * and on the identity -- but never through something that already
           * does its own job. Panel toggles, remove and a panel's controls
           * would otherwise minimize the worktree out from under the click.
           */
          if ((event.target as HTMLElement).closest('button, .termtabs')) return
          onMinimize()
        }}
      >
        {panes.map((pane, index) => (
          <div className="tile__seg" key={pane.key}>
            {index === 0 && identity}
            {pane.kind === 'terminals' && (
              <TerminalsTabs
                terminals={terminals}
                activeTerminalId={activeTerminalId}
                onSelect={onSelectTerminal}
                onNew={onNewTerminal}
                onClose={onCloseTerminal}
              />
            )}
            {index === controlsIndex && controls}
          </div>
        ))}
      </div>

      <div className="tile__body" style={{ gridTemplateColumns: columns }}>
        {panes.map((pane) => (
          <div className="tile__pane" key={pane.key}>
            {pane.kind === 'claude' &&
              (running && session ? (
                <TerminalView session={session} primary={true} fontSize={TERMINAL_FONT_SIZE} />
              ) : (
                <div className="tile__idle">
                  <p className="tile__idle-text">Claude is not running in this worktree.</p>
                  <button className="btn" onClick={onStart}>
                    Start Claude
                  </button>
                </div>
              ))}
            {pane.kind === 'terminals' && (
              <TerminalsScreen
                terminals={terminals}
                activeTerminalId={activeTerminalId}
                fontSize={TERMINAL_FONT_SIZE}
                onNew={onNewTerminal}
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

export interface OverviewProps {
  worktrees: Worktree[]
  sessions: Session[]
  minimized: string[]
  panels: Record<string, PanelName[]>
  newestPane: string | null
  activeTerminalByWorktree: Record<string, string>
  onStart: (worktreeId: string) => void
  onMinimize: (worktreeId: string) => void
  onRemoveWorktree: (worktreeId: string) => void
  onTogglePanel: (worktreeId: string, panel: PanelName) => void
  /**
   * Close panels the layout could not find room for. Reported from here
   * because only the layout knows what fit.
   */
  onCollapsePanels: (collapsed: { worktreeId: string; panel: PanelName }[]) => void
  onNewWorktree: () => void
  onSelectTerminal: (worktreeId: string, sessionId: string) => void
  onNewTerminal: (worktreeId: string) => void
  onCloseTerminal: (sessionId: string) => void
  /** Which worktrees ended up with a tile on screen, so the top bar can tell. */
  onVisibleWorktrees: (worktreeIds: string[]) => void
}

/**
 * The whole app: worktree tiles side by side.
 *
 * There are no rows. Every pane is one full-height column, and a pane that
 * cannot have MIN_PANE_COLUMNS is pushed out rather than squeezed -- so the
 * narrower the window the less is on screen, down to a single column on a
 * phone.
 */
export const Overview = ({
  worktrees,
  sessions,
  minimized,
  panels,
  newestPane,
  activeTerminalByWorktree,
  onStart,
  onMinimize,
  onRemoveWorktree,
  onTogglePanel,
  onCollapsePanels,
  onNewWorktree,
  onSelectTerminal,
  onNewTerminal,
  onCloseTerminal,
  onVisibleWorktrees,
}: OverviewProps): React.ReactElement => {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const { width } = useElementSize(gridRef)

  const panes = wantedPanes(worktrees, minimized, panels)
  // With little to show, the grid has room to be the action and the explanation
  // of what a worktree is; beyond that the top bar's + carries it.
  const expanded = new Set(panes.map((pane) => (pane.kind === 'add' ? ADD_KEY : pane.worktree.id)))
  if (expanded.size < ADD_TILE_THRESHOLD) panes.push({ kind: 'add', key: ADD_KEY })

  const charWidth = measureMonoCharWidth(TERMINAL_FONT_SIZE, TERMINAL_FONT_FAMILY)
  const minPaneWidth = MIN_PANE_COLUMNS * charWidth + PANE_CHROME_WIDTH
  const visible = planColumns(
    panes,
    (pane) => pane.key,
    (pane) => (pane.kind === 'add' ? ADD_KEY : pane.worktree.id),
    newestPane,
    width,
    minPaneWidth,
    GAP,
  )
  const tiles = gatherTiles(visible)

  /*
   * Panels with no room are collapsed, not remembered as open-behind-the-scenes.
   *
   * A panel that is open but has no pane is a state with nothing to show for
   * itself: the tile looks exactly as it would with the panel closed, so the
   * only honest thing its toggle can say is "closed". Rather than dress that up
   * as a third state, the panel is closed for real and the toggle goes with it.
   *
   * Only worktrees that actually have a tile are considered. A minimized
   * worktree has no panes at all, and collapsing its panels would throw away
   * the width it is meant to come back at.
   */
  const collapsedKeys = tiles
    .filter((tile) => tile.worktree !== null)
    .flatMap((tile) =>
      (panels[tile.worktree!.id] ?? [])
        .filter((panel) => !tile.panes.some((pane) => pane.kind === panel))
        .map((panel) => paneKey(tile.worktree!.id, panel)),
    )
  const collapsedKey = collapsedKeys.join(',')
  useEffect(() => {
    if (width === 0 || collapsedKey === '') return
    // One call for the lot: a patch per panel would each be built from the same
    // pre-collapse state, and the last would undo the rest.
    onCollapsePanels(
      collapsedKey.split(',').map((key) => {
        const cut = key.lastIndexOf(':')
        return { worktreeId: key.slice(0, cut), panel: key.slice(cut + 1) as PanelName }
      }),
    )
  }, [collapsedKey, width, onCollapsePanels])

  /*
   * Tell the top bar which worktrees actually got a tile.
   *
   * "Not minimized" is no longer the same as "on screen": a tile can be pushed
   * out for want of width. A chip that claimed otherwise would be lying, and
   * clicking it would minimize a worktree the user cannot even see.
   */
  const visibleKey = tiles
    .filter((tile) => tile.worktree !== null)
    .map((tile) => tile.key)
    .join(',')
  useEffect(() => {
    if (width > 0) onVisibleWorktrees(visibleKey === '' ? [] : visibleKey.split(','))
  }, [visibleKey, width, onVisibleWorktrees])

  return (
    <section className="view overview">
      <div className="grid" ref={gridRef} style={{ gap: GAP }}>
        {/* Nothing renders until the grid is measured, so a terminal is never
            built at a width that is about to change. */}
        {width > 0 &&
          tiles.map((tile) => {
            const worktree = tile.worktree
            if (!worktree) return <AddTile key={tile.key} onClick={onNewWorktree} />
            return (
              <WorktreeTile
                key={tile.key}
                worktree={worktree}
                panes={tile.panes}
                session={claudeSession(sessions, worktree.id)}
                terminals={terminalSessions(sessions, worktree.id)}
                activeTerminalId={activeTerminalByWorktree[worktree.id] ?? null}
                onStart={() => onStart(worktree.id)}
                onMinimize={() => onMinimize(worktree.id)}
                onRemove={() => onRemoveWorktree(worktree.id)}
                onTogglePanel={(panel) => onTogglePanel(worktree.id, panel)}
                onSelectTerminal={(sessionId) => onSelectTerminal(worktree.id, sessionId)}
                onNewTerminal={() => onNewTerminal(worktree.id)}
                onCloseTerminal={onCloseTerminal}
              />
            )
          })}
      </div>
    </section>
  )
}
