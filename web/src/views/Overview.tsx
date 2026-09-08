import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { PanelName, Session, Worktree } from '@ide-n-dream/shared'
import {
  TerminalView,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from '../terminal/TerminalView.js'
import { claudeSession, isRunning, stateLabel, terminalSessions } from '../selectors.js'
import { TerminalsScreen, TerminalsTabs } from './TerminalsPane.js'
import { GitBar, GitPane, useGitState } from './GitPane.js'
import {
  MIN_PANE_COLUMNS,
  PANE_CHROME_WIDTH,
  measureMonoCharWidth,
  planColumns,
} from './overviewLayout.js'
import { useTileMotion, type Slot } from './tileMotion.js'

/**
 * Gap between tiles, in px, and the same inset around the grid.
 *
 * Both live here rather than in the stylesheet because the tiles are positioned
 * from measured pixels: the arithmetic and the rendered spacing are the same
 * number or the tiles do not line up with their own gaps.
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
export const PANELS: readonly PanelName[] = ['terminals', 'git']

/** What a panel is called in prose, for the toggle's tooltip. */
const PANEL_NOUN: Record<PanelName, string> = { terminals: 'terminals', git: 'changes' }

/** The counts a panel's label can be built from. */
interface PanelCounts {
  terminals: number
  changes: number
}

/**
 * The toggle's label.
 *
 * Terminals count themselves rather than repeating the panel's name: the number
 * is the useful part at a glance, and with none open the toggle says what the
 * click will actually do, which is add one. The count is of the terminals the
 * panel would show, exited ones included -- a label offering to add the first
 * one over a tab strip that already has a tab in it would contradict itself.
 *
 * Exhaustive on purpose: adding a panel to PanelName will not compile until it
 * says what it is called.
 */
const panelLabel = (panel: PanelName, counts: PanelCounts): string => {
  switch (panel) {
    case 'terminals':
      if (counts.terminals === 0) return 'Add Terminal'
      return counts.terminals === 1 ? '1 Terminal' : `${counts.terminals} Terminals`
    case 'git':
      // The count is uncommitted files, the same number the bar already shows
      // beside the branch. Committed work has no number here because one figure
      // cannot stand for both, and the panel itself says how many commits.
      if (counts.changes === 0) return 'Changes'
      return counts.changes === 1 ? '1 Change' : `${counts.changes} Changes`
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
  // Only reads git while its panel is on screen; see the note on useGitState.
  const git = useGitState(
    worktree.id,
    `${worktree.dirty ?? 0}:${worktree.head ?? ''}`,
    shownPanes.has('git'),
  )
  const counts: PanelCounts = {
    terminals: terminals.length,
    changes: worktree.dirty ?? 0,
  }

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
            {panelLabel(panel, counts)}
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
    <div className={`tile tile--${state}`}>
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
            {pane.kind === 'git' && <GitBar state={git} />}
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
            {pane.kind === 'git' && <GitPane state={git} branch={worktree.branch} />}
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
  /** Worktrees with a tile, leftmost first. Null until seeded. */
  shown: string[] | null
  panels: Record<string, PanelName[]>
  newestPane: string | null
  activeTerminalByWorktree: Record<string, string>
  onStart: (worktreeId: string) => void
  onMinimize: (worktreeId: string) => void
  onRemoveWorktree: (worktreeId: string) => void
  onTogglePanel: (worktreeId: string, panel: PanelName) => void
  onCollapsePanels: (collapsed: { worktreeId: string; panel: PanelName }[]) => void
  onNewWorktree: () => void
  onSelectTerminal: (worktreeId: string, sessionId: string) => void
  onNewTerminal: (worktreeId: string) => void
  onCloseTerminal: (sessionId: string) => void
  /**
   * The order the grid settled on: what is shown, leftmost first, with
   * whatever no longer fits left out. Only the layout knows how much fits.
   */
  onShownOrder: (worktreeIds: string[]) => void
}

/**
 * The whole app: worktree tiles side by side, in the order you asked for them.
 *
 * One rule governs the grid. A worktree you ask for enters at the left, the
 * rest shift right, and whatever no longer fits falls off the right and is put
 * away in the top bar -- for good, not until the window happens to widen again.
 * That is what makes the grid followable: a tile only ever moves because you
 * did something, and it always moves the same way.
 *
 * Panels are a separate question, settled inside a tile: they keep a fixed
 * order beside Claude, and when a tile cannot have all of them the one you just
 * opened is the one that gets the room.
 */
export const Overview = ({
  worktrees,
  sessions,
  shown,
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
  onShownOrder,
}: OverviewProps): React.ReactElement => {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const { width } = useElementSize(gridRef)

  const byId = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  /*
   * A first run has no order to restore, so the worktrees are taken as they
   * come. After that the stored order is the truth, filtered to what still
   * exists -- a worktree removed elsewhere leaves no hole behind.
   */
  const order = (shown ?? worktrees.map((worktree) => worktree.id))
    .map((id) => byId.get(id))
    .filter((worktree): worktree is Worktree => worktree !== undefined)

  const charWidth = measureMonoCharWidth(TERMINAL_FONT_SIZE, TERMINAL_FONT_FAMILY)
  const minPaneWidth = MIN_PANE_COLUMNS * charWidth + PANE_CHROME_WIDTH
  // The measured box includes the grid's inset, which the tiles do not get.
  const available = Math.max(0, width - GAP * 2)
  const capacity = Math.max(1, Math.floor((available + GAP) / (minPaneWidth + GAP)))

  /*
   * The tile you just acted on keeps its room, and the rest fill in from the
   * left until the width runs out.
   *
   * The reservation is what makes a tile able to grow. Filling purely from the
   * left meant the last tile in the row was the one that did not fit -- so
   * opening a panel on the rightmost worktree pushed that very worktree off the
   * grid, which is the opposite of what the click asked for. Reserving it
   * instead means the others give way: they shift left and the leftmost leaves.
   *
   * It is the same principle as inside a tile, where the panel you just opened
   * is the one that gets the room. And it is not sticky -- every chip click and
   * every panel toggle moves it -- so a tile is only ever privileged for the
   * one action you just took.
   */
  const panesOf = (worktree: Worktree): Pane[] => {
    const open = panels[worktree.id] ?? []
    return [
      { kind: 'claude' as const, key: paneKey(worktree.id, 'claude'), worktree },
      ...PANELS.filter((panel) => open.includes(panel)).map((panel) => ({
        kind: panel,
        key: paneKey(worktree.id, panel),
        worktree,
      })),
    ]
  }

  const anchorId = newestPane === null ? null : newestPane.slice(0, newestPane.lastIndexOf(':'))
  const anchor = order.find((worktree) => worktree.id === anchorId) ?? order[0]

  const kept = new Set<string>()
  let used = 0
  if (anchor) {
    // Whatever it costs: a window too narrow for even this one still shows it,
    // narrowed below to the panes that fit.
    kept.add(anchor.id)
    used = panesOf(anchor).length
  }
  for (const worktree of order) {
    if (kept.has(worktree.id)) continue
    const panes = panesOf(worktree).length
    if (used + panes > capacity) break
    kept.add(worktree.id)
    used += panes
  }
  const fitting = order
    .filter((worktree) => kept.has(worktree.id))
    .map((worktree) => ({ worktree, panes: panesOf(worktree) }))

  /*
   * Only the reserved tile can still be over capacity, since every other one
   * was admitted only if it fit. Narrow it by the pane rule: the pane you just
   * asked for first, then the rest of the tile from the left.
   */
  const reserved = fitting.find((tile) => tile.worktree.id === anchor?.id)
  if (reserved && used > capacity) {
    reserved.panes = planColumns(
      reserved.panes,
      (pane) => pane.key,
      () => reserved.worktree.id,
      newestPane,
      available,
      minPaneWidth,
      GAP,
    )
  }

  /*
   * With little to show, the grid has room to be the action and the explanation
   * of what a worktree is; beyond that the top bar's + carries it.
   *
   * It has to earn its column like everything else. Appending it unconditionally
   * put two tiles in a grid with room for one, and both came out at a fifth of
   * the width a terminal needs.
   */
  const cells: { key: string; worktree: Worktree | null; panes: Pane[] }[] = fitting.map((tile) => ({
    key: tile.worktree.id,
    worktree: tile.worktree,
    panes: tile.panes,
  }))
  if (cells.length < ADD_TILE_THRESHOLD && used + 1 <= capacity) {
    cells.push({ key: ADD_KEY, worktree: null, panes: [{ kind: 'add', key: ADD_KEY }] })
  }

  /*
   * Geometry, in px, because the tiles are positioned rather than flowed: an
   * entry from off the left and an exit past the right edge are not things a
   * flex row can express.
   *
   * Every pane in the grid is the same width whatever tile it belongs to, which
   * is what keeps two worktrees side by side comparable.
   */
  const totalPanes = cells.reduce((n, cell) => n + cell.panes.length, 0)
  const paneWidth =
    totalPanes === 0 ? 0 : (available - GAP * Math.max(0, cells.length - 1)) / totalPanes
  type Cell = (typeof cells)[number]
  const slots: Slot<Cell>[] = []
  let x = GAP
  for (const cell of cells) {
    const tileWidth = paneWidth * cell.panes.length
    slots.push({ key: cell.key, left: x, width: tileWidth, data: cell })
    x += tileWidth + GAP
  }
  const moving = useTileMotion(width > 0 ? slots : [])

  /*
   * Tell the app what the grid settled on.
   *
   * Falling off the right is a change of state, not a trick of the width, so it
   * is written down: the worktree goes to the top bar and stays there until it
   * is asked for again. This is also what seeds the order on a first run.
   */
  const settled = fitting.map((tile) => tile.worktree.id).join(',')
  const anything = worktrees.length > 0
  useEffect(() => {
    /*
     * Nothing is written before there is anything to say.
     *
     * The first render happens before the snapshot arrives, when there are no
     * worktrees at all -- and reporting "none of them fit" then wrote an empty
     * order, which is indistinguishable from "you put them all away". The grid
     * stayed empty for good, however many worktrees turned up a moment later.
     */
    if (width > 0 && anything) onShownOrder(settled === '' ? [] : settled.split(','))
  }, [settled, width, anything, onShownOrder])

  /*
   * Panels with no room are closed, not remembered as open-behind-the-scenes.
   *
   * A panel that is open but has no pane is a state with nothing to show for
   * itself: the tile looks exactly as it would with the panel closed, so the
   * only honest thing its toggle can say is "closed".
   */
  const collapsedKey = fitting
    .flatMap((tile) =>
      (panels[tile.worktree.id] ?? [])
        .filter((panel) => !tile.panes.some((pane) => pane.kind === panel))
        .map((panel) => paneKey(tile.worktree.id, panel)),
    )
    .join(',')
  useEffect(() => {
    if (width === 0 || collapsedKey === '') return
    onCollapsePanels(
      collapsedKey.split(',').map((key) => {
        const cut = key.lastIndexOf(':')
        return { worktreeId: key.slice(0, cut), panel: key.slice(cut + 1) as PanelName }
      }),
    )
  }, [collapsedKey, width, onCollapsePanels])

  return (
    <section className="view overview">
      <div className="grid" ref={gridRef}>
        {/* Nothing renders until the grid is measured, so a terminal is never
            built at a width that is about to change. */}
        {width > 0 &&
          moving.map((slot) => {
            const worktree = slot.data.worktree
            return (
              <div
                key={slot.key}
                className={[
                  'slot',
                  // Not a worktree, so it does not arrive like one; see the
                  // note on .slot--from-right.
                  slot.data.worktree === null ? 'slot--from-right' : '',
                  slot.leaving ? 'slot--leaving' : '',
                  slot.leaving && slot.exit === 'left' ? 'slot--leaving-left' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ left: slot.left, width: slot.width }}
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
                      panes={slot.data.panes}
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
                  )}
                </div>
              </div>
            )
          })}
      </div>
    </section>
  )
}
