import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { Session, Worktree } from '@ide-n-dream/shared'
import { TerminalView, TERMINAL_FONT_FAMILY } from '../terminal/TerminalView.js'
import { claudeSession, stateLabel } from '../selectors.js'
import {
  MIN_TILE_COLUMNS,
  TILE_CHROME_WIDTH,
  measureMonoCharWidth,
  planOverviewColumns,
  sortMinimizedLast,
} from './overviewLayout.js'

/**
 * Tiles use a smaller type size than the detail view so a glanceable slice of
 * the session fits, but they still size the terminal to the tile rather than
 * scaling it down: a scaled terminal is unreadable, and cols/rows derived from
 * the real tile give you legible text at whatever size the grid allows.
 */
const TILE_FONT_SIZE = 12

/**
 * Gap between tiles, in px. Applied inline rather than from the stylesheet so
 * the layout arithmetic and the rendered spacing cannot drift apart.
 */
const GAP = 12

type Cell =
  | { kind: 'worktree'; key: string; worktree: Worktree; minimized: boolean }
  | { kind: 'add'; key: string; minimized: false }

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

interface TileProps {
  worktree: Worktree
  session: Session | undefined
  minimized: boolean
  onOpen: () => void
  onStart: () => void
  onRemove: () => void
  onToggleMinimized: () => void
}

const Tile = ({
  worktree,
  session,
  minimized,
  onOpen,
  onStart,
  onRemove,
  onToggleMinimized,
}: TileProps): React.ReactElement => {
  const state = session
    ? session.liveness === 'dead'
      ? 'dead'
      : session.attention === 'needs-you'
        ? 'waiting'
        : session.attention === 'working'
          ? 'working'
          : 'idle'
    : 'idle'

  return (
    <div className={minimized ? `tile tile--${state} tile--minimized` : `tile tile--${state}`}>
      {/* A div, not a button: the remove control lives in here and a button
          cannot be nested inside another button. */}
      <div className="tile__head">
        {/*
          The whole header bar is the action, not just the words, so there is no
          dead space to click -- only the controls on the right are carved out.
          While minimized that action is "expand", not "open": the terminal you
          would be navigating to is the very thing that is hidden, so bringing it
          back is what a click means.
        */}
        <button
          className="tile__open"
          onClick={minimized ? onToggleMinimized : onOpen}
          title={minimized ? `Expand ${worktree.name}` : worktree.path}
        >
          <span className="tile__name">{worktree.name}</span>
          {worktree.branch && worktree.branch !== worktree.name && (
            <span className="tile__branch">{worktree.branch}</span>
          )}
          {worktree.dirty ? <span className="tile__branch">{worktree.dirty}&plusmn;</span> : null}
          <span className="tile__state">{stateLabel(session)}</span>
        </button>
        {/*
          Minimizing keeps the header -- and with it the name, the state and the
          attention rail -- so a worktree that needs you still says so from the
          bottom of the overview.

          There is no matching expand control: while minimized, the whole header
          bar expands, so an icon for it would be a second button doing what the
          thing it sits on already does.
        */}
        {!minimized && (
          <button
            className="tile__minimize"
            onClick={onToggleMinimized}
            title={`Minimize ${worktree.name}`}
            aria-label={`Minimize ${worktree.name}`}
          >
            {'\u2212'}
          </button>
        )}
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
      {!minimized && (
      <div className="tile__screen">
        {session ? (
          // Tiles stay interactive on purpose: you can answer a prompt here
          // without opening the worktree.
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
      )}
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

export interface SplitViewProps {
  worktrees: Worktree[]
  sessions: Session[]
  onOpenWorktree: (worktreeId: string) => void
  onStart: (worktreeId: string) => void
  onNewWorktree: () => void
  onRemoveWorktree: (worktreeId: string) => void
  minimized: string[]
  onToggleMinimized: (worktreeId: string) => void
}

export const SplitView = ({
  worktrees,
  sessions,
  onOpenWorktree,
  onStart,
  onNewWorktree,
  onRemoveWorktree,
  minimized,
  onToggleMinimized,
}: SplitViewProps): React.ReactElement => {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const { width } = useElementSize(gridRef)

  const minimizedIds = new Set(minimized)
  const cells: Cell[] = worktrees.map((worktree) => ({
    kind: 'worktree' as const,
    key: worktree.id,
    worktree,
    minimized: minimizedIds.has(worktree.id),
  }))
  // Once the overview has real content, the grid is better spent on terminals
  // and the top bar already carries the action. With nothing (or almost
  // nothing) to show, this tile is both the action and the explanation of what
  // a worktree actually is.
  if (worktrees.length <= 1) cells.push({ kind: 'add', key: '__add', minimized: false })

  const charWidth = measureMonoCharWidth(TILE_FONT_SIZE, TERMINAL_FONT_FAMILY)
  const minTileWidth = MIN_TILE_COLUMNS * charWidth + TILE_CHROME_WIDTH
  const isMinimized = (cell: Cell): boolean => cell.minimized
  const columns = planOverviewColumns(
    sortMinimizedLast(cells, isMinimized),
    isMinimized,
    width,
    minTileWidth,
    GAP,
  )

  return (
    <section className="view overview">
      {/* No heading or count: the tiles name themselves, and the height is
          better spent on terminals. */}
      <div className="grid" ref={gridRef} style={{ gap: GAP }}>
        {/* Nothing renders until the grid is measured, so a terminal is never
            built at a width that is about to change. */}
        {width > 0 &&
          columns.map((cellsInColumn, columnIndex) => (
            <div className="grid__column" key={`column-${columnIndex}`} style={{ gap: GAP }}>
              {cellsInColumn.map((cell) =>
                cell.kind === 'add' ? (
                  <AddTile key={cell.key} onClick={onNewWorktree} />
                ) : (
                  <Tile
                    key={cell.key}
                    worktree={cell.worktree}
                    session={claudeSession(sessions, cell.worktree.id)}
                    minimized={cell.minimized}
                    onOpen={() => onOpenWorktree(cell.worktree.id)}
                    onStart={() => onStart(cell.worktree.id)}
                    onRemove={() => onRemoveWorktree(cell.worktree.id)}
                    onToggleMinimized={() => onToggleMinimized(cell.worktree.id)}
                  />
                ),
              )}
            </div>
          ))}
      </div>
    </section>
  )
}
