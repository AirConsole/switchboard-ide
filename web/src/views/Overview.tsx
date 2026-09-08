import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Session, Worktree } from '@ide-n-dream/shared'
import {
  TerminalView,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from '../terminal/TerminalView.js'
import { claudeSession, isRunning, stateLabel, terminalSessions } from '../selectors.js'
import { TerminalsTile } from './TerminalsTile.js'
import {
  MIN_TILE_COLUMNS,
  TILE_CHROME_WIDTH,
  measureMonoCharWidth,
  planTiles,
} from './overviewLayout.js'

/**
 * Gap between tiles, in px. Applied inline rather than from the stylesheet so
 * the layout arithmetic and the rendered spacing cannot drift apart.
 */
const GAP = 12

/** Below this many tiles, the grid has room to explain what a worktree is. */
const ADD_TILE_THRESHOLD = 2

/** How the add tile is identified in the layout. */
const ADD_KEY = '__add'

/** How a worktree's terminals tile is identified in the layout. */
export const terminalsTileKey = (worktreeId: string): string => `${worktreeId}:terminals`

type Cell =
  | { kind: 'worktree'; key: string; worktree: Worktree }
  | { kind: 'terminals'; key: string; worktree: Worktree }
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

interface WorktreeTileProps {
  worktree: Worktree
  session: Session | undefined
  terminalsOpen: boolean
  onStart: () => void
  onMinimize: () => void
  onRemove: () => void
  onToggleTerminals: () => void
}

const WorktreeTile = ({
  worktree,
  session,
  terminalsOpen,
  onStart,
  onMinimize,
  onRemove,
  onToggleTerminals,
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

  return (
    <div className={`tile tile--${state}`}>
      {/* The label is plain text: with one view there is nowhere for a click on
          it to go. Everything actionable is an explicit control. */}
      <div
        className="tile__head"
        title={session ? `${worktree.path}\n${session.attachCommand}` : worktree.path}
      >
        <span className="tile__name">{worktree.name}</span>
        {worktree.branch && worktree.branch !== worktree.name && (
          <span className="tile__branch">{worktree.branch}</span>
        )}
        {worktree.dirty ? <span className="tile__branch">{worktree.dirty}&plusmn;</span> : null}
        <span className="tile__state">{stateLabel(session)}</span>
        <button
          className={terminalsOpen ? 'tile__toggle tile__toggle--on' : 'tile__toggle'}
          onClick={onToggleTerminals}
          title={
            terminalsOpen
              ? 'Close the terminals and restore the other worktrees'
              : 'Show this worktree’s terminals and minimize the others'
          }
        >
          Terminals
        </button>
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
      <div className="tile__screen">
        {running && session ? (
          <TerminalView session={session} primary={true} fontSize={TERMINAL_FONT_SIZE} />
        ) : (
          <div className="tile__idle">
            <p className="tile__idle-text">Claude is not running in this worktree.</p>
            <button className="btn" onClick={onStart}>
              Start Claude
            </button>
          </div>
        )}
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
  terminalsFor: string | null
  newestTile: string | null
  activeTerminalByWorktree: Record<string, string>
  onStart: (worktreeId: string) => void
  onMinimize: (worktreeId: string) => void
  onRemoveWorktree: (worktreeId: string) => void
  onToggleTerminals: (worktreeId: string) => void
  onNewWorktree: () => void
  onSelectTerminal: (worktreeId: string, sessionId: string) => void
  onNewTerminal: (worktreeId: string) => void
  onCloseTerminal: (sessionId: string) => void
  /** Which worktrees ended up with a tile on screen, so the top bar can tell. */
  onVisibleWorktrees: (worktreeIds: string[]) => void
}

/**
 * The whole app: tiles side by side, each a full-height column.
 *
 * There are no rows. A tile that cannot have MIN_TILE_COLUMNS is pushed out
 * rather than squeezed, so the narrower the window the fewer worktrees are on
 * screen -- down to one on a phone.
 */
export const Overview = ({
  worktrees,
  sessions,
  minimized,
  terminalsFor,
  newestTile,
  activeTerminalByWorktree,
  onStart,
  onMinimize,
  onRemoveWorktree,
  onToggleTerminals,
  onNewWorktree,
  onSelectTerminal,
  onNewTerminal,
  onCloseTerminal,
  onVisibleWorktrees,
}: OverviewProps): React.ReactElement => {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const { width } = useElementSize(gridRef)

  const minimizedIds = new Set(minimized)
  const cells: Cell[] = []
  for (const worktree of worktrees) {
    if (minimizedIds.has(worktree.id)) continue
    cells.push({ kind: 'worktree', key: worktree.id, worktree })
    if (worktree.id === terminalsFor) {
      cells.push({ kind: 'terminals', key: terminalsTileKey(worktree.id), worktree })
    }
  }
  // With little to show, the grid has room to be the action and the explanation
  // of what a worktree is; beyond that the top bar's + carries it.
  if (cells.length < ADD_TILE_THRESHOLD) cells.push({ kind: 'add', key: ADD_KEY })

  const charWidth = measureMonoCharWidth(TERMINAL_FONT_SIZE, TERMINAL_FONT_FAMILY)
  const minTileWidth = MIN_TILE_COLUMNS * charWidth + TILE_CHROME_WIDTH
  const plan = planTiles(cells, (cell) => cell.key, newestTile, width, minTileWidth, GAP)

  /*
   * Tell the top bar which worktrees actually got a tile.
   *
   * "Not minimized" is no longer the same as "on screen": a tile can be pushed
   * out for want of width. A chip that claimed otherwise would be lying, and
   * clicking it would minimize a worktree the user cannot even see.
   */
  const visibleKey = plan.visible
    .filter((cell) => cell.kind === 'worktree')
    .map((cell) => cell.key)
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
          plan.visible.map((cell) => {
            if (cell.kind === 'add') {
              return <AddTile key={cell.key} onClick={onNewWorktree} />
            }
            if (cell.kind === 'terminals') {
              return (
                <TerminalsTile
                  key={cell.key}
                  worktree={cell.worktree}
                  terminals={terminalSessions(sessions, cell.worktree.id)}
                  activeTerminalId={activeTerminalByWorktree[cell.worktree.id] ?? null}
                  fontSize={TERMINAL_FONT_SIZE}
                  onSelect={(sessionId) => onSelectTerminal(cell.worktree.id, sessionId)}
                  onNew={() => onNewTerminal(cell.worktree.id)}
                  onClose={onCloseTerminal}
                />
              )
            }
            return (
              <WorktreeTile
                key={cell.key}
                worktree={cell.worktree}
                session={claudeSession(sessions, cell.worktree.id)}
                terminalsOpen={cell.worktree.id === terminalsFor}
                onStart={() => onStart(cell.worktree.id)}
                onMinimize={() => onMinimize(cell.worktree.id)}
                onRemove={() => onRemoveWorktree(cell.worktree.id)}
                onToggleTerminals={() => onToggleTerminals(cell.worktree.id)}
              />
            )
          })}
      </div>
    </section>
  )
}
