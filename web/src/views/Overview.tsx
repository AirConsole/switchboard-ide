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

/** Human name for a panel's toggle. */
const PANEL_LABEL: Record<PanelName, string> = { terminals: 'Terminals' }

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

interface WorktreeTileProps {
  worktree: Worktree
  /** The panes that fit, in display order. Never empty. */
  panes: Pane[]
  session: Session | undefined
  terminals: Session[]
  openPanels: PanelName[]
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
  openPanels,
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

  const identity = (
    <>
      {/* Plain text: with one view there is nowhere for a click on it to go.
          Everything actionable is an explicit control. */}
      <span className="tile__name">{worktree.name}</span>
      {worktree.branch && worktree.branch !== worktree.name && (
        <span className="tile__branch">{worktree.branch}</span>
      )}
      {worktree.dirty ? <span className="tile__branch">{worktree.dirty}&plusmn;</span> : null}
    </>
  )

  const controls = (
    <div className="tile__controls">
      <span className="tile__state">{stateLabel(session)}</span>
      {PANELS.map((panel) => {
        const open = openPanels.includes(panel)
        // Open but pushed out for want of width: the same distinction the top
        // bar's chips make, so the toggle never claims a pane that is not there.
        const pushed = open && !shownPanes.has(panel)
        return (
          <button
            key={panel}
            className={['tile__toggle', open ? 'tile__toggle--on' : '', pushed ? 'tile__toggle--pushed' : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => onTogglePanel(panel)}
            title={
              pushed
                ? `${PANEL_LABEL[panel]} are open but there is no room for them — widen the window`
                : open
                  ? `Close ${PANEL_LABEL[panel].toLowerCase()}`
                  : `Open ${PANEL_LABEL[panel].toLowerCase()} beside Claude`
            }
          >
            {PANEL_LABEL[panel]}
          </button>
        )
      })}
      <button
        className="tile__minimize"
        onClick={onMinimize}
        title={`Minimize ${worktree.name} to the top bar`}
        aria-label={`Minimize ${worktree.name}`}
      >
        {'−'}
      </button>
      {/* The main worktree cannot be removed, so it gets no control. */}
      {!worktree.isMain && (
        <button
          className="tile__remove"
          onClick={onRemove}
          title={`Remove ${worktree.name}`}
          aria-label={`Remove worktree ${worktree.name}`}
        >
          &times;
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
        title={session ? `${worktree.path}\n${session.attachCommand}` : worktree.path}
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
            {index === panes.length - 1 && controls}
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
                openPanels={panels[worktree.id] ?? []}
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
