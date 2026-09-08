import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Session, Worktree } from '@ide-n-dream/shared'
import { TerminalView, TERMINAL_FONT_FAMILY } from '../terminal/TerminalView.js'
import { claudeSession, isRunning, shellSessions, stateLabel } from '../selectors.js'
import { ShellsTile } from './ShellsTile.js'
import {
  MIN_TILE_COLUMNS,
  TILE_CHROME_WIDTH,
  measureMonoCharWidth,
  planOverviewColumns,
} from './overviewLayout.js'

/**
 * Tiles use a smaller type size than a full-window terminal would, so a
 * glanceable slice fits, but they still size the terminal to the tile rather
 * than scaling it down: a scaled terminal is unreadable, and cols/rows derived
 * from the real tile give legible text at whatever size the grid allows.
 */
const TILE_FONT_SIZE = 12

/**
 * Gap between tiles, in px. Applied inline rather than from the stylesheet so
 * the layout arithmetic and the rendered spacing cannot drift apart.
 */
const GAP = 12

/** Below this many tiles, the grid has room to explain what a worktree is. */
const ADD_TILE_THRESHOLD = 2

type Cell =
  | { kind: 'worktree'; key: string; worktree: Worktree }
  | { kind: 'shells'; key: string; worktree: Worktree }
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
              ? 'Close the shells and restore the other worktrees'
              : 'Show this worktree’s shells and minimize the others'
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
          <TerminalView session={session} primary={true} fontSize={TILE_FONT_SIZE} />
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
  activeShellByWorktree: Record<string, string>
  onStart: (worktreeId: string) => void
  onMinimize: (worktreeId: string) => void
  onRemoveWorktree: (worktreeId: string) => void
  onToggleTerminals: (worktreeId: string) => void
  onNewWorktree: () => void
  onSelectShell: (worktreeId: string, sessionId: string) => void
  onNewShell: (worktreeId: string) => void
  onCloseShell: (sessionId: string) => void
}

/**
 * The whole app: a grid of tiles.
 *
 * Cells are the expanded worktrees, plus the shells tile of whichever worktree
 * has Terminals on, placed right after it. They are all laid out by the same
 * rules, so the shells tile is as wide and as legible as any Claude tile.
 */
export const Overview = ({
  worktrees,
  sessions,
  minimized,
  terminalsFor,
  activeShellByWorktree,
  onStart,
  onMinimize,
  onRemoveWorktree,
  onToggleTerminals,
  onNewWorktree,
  onSelectShell,
  onNewShell,
  onCloseShell,
}: OverviewProps): React.ReactElement => {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const { width } = useElementSize(gridRef)

  const minimizedIds = new Set(minimized)
  const cells: Cell[] = []
  for (const worktree of worktrees) {
    if (minimizedIds.has(worktree.id)) continue
    cells.push({ kind: 'worktree', key: worktree.id, worktree })
    if (worktree.id === terminalsFor) {
      cells.push({ kind: 'shells', key: `${worktree.id}:shells`, worktree })
    }
  }
  // With little to show, the grid has room to be the action and the explanation
  // of what a worktree is; beyond that the top bar's + carries it.
  if (cells.length < ADD_TILE_THRESHOLD) cells.push({ kind: 'add', key: '__add' })

  const charWidth = measureMonoCharWidth(TILE_FONT_SIZE, TERMINAL_FONT_FAMILY)
  const minTileWidth = MIN_TILE_COLUMNS * charWidth + TILE_CHROME_WIDTH
  const columns = planOverviewColumns(cells, width, minTileWidth, GAP)

  return (
    <section className="view overview">
      <div className="grid" ref={gridRef} style={{ gap: GAP }}>
        {/* Nothing renders until the grid is measured, so a terminal is never
            built at a width that is about to change. */}
        {width > 0 &&
          columns.map((cellsInColumn, columnIndex) => (
            <div className="grid__column" key={`column-${columnIndex}`} style={{ gap: GAP }}>
              {cellsInColumn.map((cell) => {
                if (cell.kind === 'add') {
                  return <AddTile key={cell.key} onClick={onNewWorktree} />
                }
                if (cell.kind === 'shells') {
                  const shells = shellSessions(sessions, cell.worktree.id)
                  return (
                    <ShellsTile
                      key={cell.key}
                      worktree={cell.worktree}
                      shells={shells}
                      activeShellId={activeShellByWorktree[cell.worktree.id] ?? null}
                      fontSize={TILE_FONT_SIZE}
                      onSelectShell={(sessionId) => onSelectShell(cell.worktree.id, sessionId)}
                      onNewShell={() => onNewShell(cell.worktree.id)}
                      onCloseShell={onCloseShell}
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
          ))}
      </div>
    </section>
  )
}
