import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { PanelName, Project, Session, Worktree } from '@ide-n-dream/shared'
import {
  TerminalView,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
} from '../terminal/TerminalView.js'
import { claudeSession, isRunning, stateLabel, terminalSessions } from '../selectors.js'
import { TerminalsScreen, TerminalsTabs } from './TerminalsPane.js'
import { GitBar, GitPane, useGitState } from './GitPane.js'
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
  /** Claude's pane and one for each open panel, in display order. */
  panes: Pane[]
  session: Session | undefined
  terminals: Session[]
  activeTerminalId: string | null
  /** The scroller, so the tile can tell whether it is worth mounting. */
  scroller: RefObject<HTMLElement | null>
  onStart: () => void
  onSleep: () => void
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
  scroller,
  onStart,
  onSleep,
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

  const identity = (
    <span className="tile__label">
      <span className="tile__name">{worktree.name}</span>
      {worktree.branch && worktree.branch !== worktree.name && (
        <span className="tile__branch">{worktree.branch}</span>
      )}
      {worktree.dirty ? <span className="tile__branch">{worktree.dirty}&plusmn;</span> : null}
    </span>
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
      <button
        className="tile__zz"
        onClick={onSleep}
        title={`Sleep ${worktree.name}: stop what it is running and give back its place`}
        aria-label={`Sleep ${worktree.name}`}
      >
        zZ
      </button>
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
    <div className={`tile tile--${state}`} ref={tileRef}>
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
            {pane.kind === 'git' && <GitBar state={git} />}
            {index === controlsIndex && controls}
          </div>
        ))}
      </div>

      <div className="tile__body" style={{ gridTemplateColumns: columns }}>
        {panes.map((pane) => (
          <div className="tile__pane" key={pane.key} data-pane={pane.key}>
            {pane.kind === 'claude' &&
              (running && session ? (
                near && <TerminalView session={session} primary={true} fontSize={TERMINAL_FONT_SIZE} />
              ) : (
                <div className="tile__idle">
                  <p className="tile__idle-text">Claude is not running in this worktree.</p>
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
  /** Awake worktrees, in the order the row shows them. */
  worktrees: Worktree[]
  sessions: Session[]
  panels: Record<string, PanelName[]>
  activeTerminalByWorktree: Record<string, string>
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
   * worktree in the top bar, wake one, or open one of its panels.
   */
  scrollTo: { id: string; nonce: number } | null
  onStart: (worktreeId: string) => void
  onSleep: (worktreeId: string) => void
  onRemoveWorktree: (worktreeId: string) => void
  onTogglePanel: (worktreeId: string, panel: PanelName) => void
  /** Close panels a screenful could not hold. */
  onCollapsePanels: (collapsed: { worktreeId: string; panel: PanelName }[]) => void
  onNewWorktree: () => void
  onSelectTerminal: (worktreeId: string, sessionId: string) => void
  onNewTerminal: (worktreeId: string) => void
  onCloseTerminal: (sessionId: string) => void
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
  sessions,
  panels,
  activeTerminalByWorktree,
  addTo,
  scrollTo,
  onStart,
  onSleep,
  onRemoveWorktree,
  onTogglePanel,
  onCollapsePanels,
  onNewWorktree,
  onSelectTerminal,
  onNewTerminal,
  onCloseTerminal,
}: OverviewProps): React.ReactElement => {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const { width } = useElementSize(gridRef)

  /*
   * A tile's panes, and what to do when it wants more than a screenful.
   *
   * Ordinarily: Claude and every open panel, in PANELS order -- fixed, so
   * opening one does not shuffle the others.
   *
   * A tile is never allowed to be wider than the window, because a tile wider
   * than the window is a tile you can only ever see part of. So when Claude and
   * the open panels come to more panes than fit, Claude's pane is the one that
   * goes: you asked for the panel, and its own toggle says it is open, whereas
   * Claude is always a click away again by closing one. That is what makes a
   * phone work -- one pane, and opening a panel swaps to it.
   *
   * If even the panels alone will not fit, the oldest of them are closed for
   * real rather than hidden, so a lit toggle never claims a pane that is not
   * there. The stored list is in the order they were opened, so the newest are
   * the ones kept.
   */
  const openPanelsOf = (worktree: Worktree): PanelName[] =>
    (panels[worktree.id] ?? []).filter((panel) => PANELS.includes(panel))

  const panesOf = (worktree: Worktree, fit: number): Pane[] => {
    const open = openPanelsOf(worktree)
    const claude: Pane = { kind: 'claude', key: paneKey(worktree.id, 'claude'), worktree }
    const kept = open.length > fit ? new Set(open.slice(open.length - fit)) : new Set(open)
    const panelPanes: Pane[] = PANELS.filter((panel) => kept.has(panel)).map((panel) => ({
      kind: panel,
      key: paneKey(worktree.id, panel),
      worktree,
    }))
    return panelPanes.length + 1 <= fit ? [claude, ...panelPanes] : panelPanes
  }

  const charWidth = measureMonoCharWidth(TERMINAL_FONT_SIZE, TERMINAL_FONT_FAMILY)
  const minPaneWidth = MIN_PANE_COLUMNS * charWidth + PANE_CHROME_WIDTH
  // n panes occupy GAP + n * (paneWidth + GAP): the leading inset plus one
  // trailing margin each. Solved for n, then for paneWidth.
  const fit = Math.max(1, Math.floor((width - GAP) / (minPaneWidth + GAP)))

  type Cell = { key: string; worktree: Worktree | null; panes: Pane[] }
  const cells: Cell[] = worktrees.map((worktree) => ({
    key: worktree.id,
    worktree,
    panes: panesOf(worktree, fit),
  }))
  if (addTo !== null) {
    cells.push({ key: ADD_KEY, worktree: null, panes: [{ kind: 'add', key: ADD_KEY }] })
  }

  /*
   * Tiles are packed into screenfuls, and no tile is split across two.
   *
   * Dividing the window by the panes that fit is not enough on its own: a
   * two-pane tile that happens to begin in the second half of a screen runs off
   * the right edge, and half a worktree is showing. So a tile that will not fit
   * in what is left of a screenful starts the next one instead.
   *
   * The tiles on a screenful then share it, rather than a short screenful being
   * padded out with nothing: one tile left alone by the tile after it takes the
   * whole width. So every screenful is exactly one window wide, which is also
   * what keeps the arithmetic below from drifting page by page.
   */
  const pages: Cell[][] = []
  let filling: Cell[] = []
  let used = 0
  for (const cell of cells) {
    if (used > 0 && used + cell.panes.length > fit) {
      pages.push(filling)
      filling = []
      used = 0
    }
    filling.push(cell)
    used += cell.panes.length
  }
  if (filling.length > 0) pages.push(filling)

  /** Which screenful each tile is on, so scrolling can address one. */
  const pageOf = new Map<string, number>()
  const slots: Slot<Cell>[] = []
  pages.forEach((page, index) => {
    for (const cell of page) pageOf.set(cell.key, index)
    // Every screenful pays its own leading inset and every tile a trailing one,
    // so a screenful spans GAP + panes + GAP-per-tile = width exactly, wherever
    // in the row it is. Uniform, which is what lets a scroll snap to k * width.
    const panesHere = page.reduce((n, cell) => n + cell.panes.length, 0)
    const paneWidth = Math.max(0, (width - GAP - GAP * page.length) / panesHere)
    for (const cell of page) {
      slots.push({ key: cell.key, width: paneWidth * cell.panes.length, data: cell })
    }
  })
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
   * Scrolling is by the screenful, not by the pixel.
   *
   * Every screenful is exactly one window wide and no tile is split across two,
   * so bringing a worktree into view means going to the screenful it is on --
   * and once there, all of it is showing. Nothing has to be aligned by hand,
   * and there is no way to come to rest looking at half a worktree.
   */
  const page = scrollTo === null ? undefined : pageOf.get(scrollTo.id)
  useEffect(() => {
    if (page === undefined || width === 0) return
    gridRef.current?.scrollTo({ left: page * width, behavior: 'smooth' })
    // scrollTo carries a counter, so asking twice for one worktree is two
    // requests; `page` alone would compare equal and scroll nowhere.
  }, [scrollTo, page, width])

  /*
   * Keep the screenful you were on when the window changes size.
   *
   * A resize re-flows every screenful, so a scroll offset measured in the old
   * width points somewhere arbitrary in the new one -- which is exactly how you
   * end up looking at half a tile without having scrolled there. The remembered
   * index is what survives the change; the offset is recomputed from it.
   */
  const pageRef = useRef(0)
  useEffect(() => {
    const grid = gridRef.current
    if (!grid || width === 0) return
    grid.scrollTo({ left: pageRef.current * width, behavior: 'auto' })
  }, [width])

  /*
   * Panels that could not be kept are closed, not left open with nothing to
   * show: a toggle that claims a pane which is not on screen is a toggle that
   * lies. Only reachable when more panels are open than a screenful can hold.
   */
  const collapsedKey = worktrees
    .flatMap((worktree) => {
      const open = openPanelsOf(worktree)
      if (open.length <= fit) return []
      return open.slice(0, open.length - fit).map((panel) => paneKey(worktree.id, panel))
    })
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
      <div
        className="grid"
        ref={gridRef}
        onScroll={(event) => {
          const el = event.currentTarget
          if (width > 0) pageRef.current = Math.round(el.scrollLeft / width)
        }}
      >
        {/* Nothing renders until the row is measured, so a terminal is never
            built at a width that is about to change. */}
        {width > 0 &&
          moving.map((slot) => {
            const worktree = slot.data.worktree
            const startsPage = pages[pageOf.get(slot.key) ?? 0]?.[0]?.key === slot.key
            return (
              <div
                key={slot.key}
                data-tile={slot.key}
                className={[
                  'slot',
                  // The first tile of a screenful is where scrolling comes to
                  // rest, so it is the snap point.
                  startsPage ? 'slot--page' : '',
                  slot.leaving ? 'slot--leaving' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                // Its own width either way; a closing tile is taken to nothing
                // by the keyframe, which is the only thing that can animate a
                // node that was just re-created. See .slot--leaving.
                // The tile that starts a screenful carries that screenful's
                // leading inset, so every one is laid out the same way.
                style={{
                  width: slot.width,
                  marginRight: GAP,
                  marginLeft: startsPage ? GAP : 0,
                }}
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
                      scroller={gridRef}
                      onStart={() => onStart(worktree.id)}
                      onSleep={() => onSleep(worktree.id)}
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
