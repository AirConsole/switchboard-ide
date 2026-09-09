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
  /** Scroll this worktree to the leftmost spot. */
  onReveal: () => void
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
  onReveal,
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
  const revealHint = `Click to bring ${worktree.name}'s window into view`

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
        title={`Put ${worktree.name} to sleep and hide its window`}
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
          if ((event.target as HTMLElement).closest('button, .termtabs, .git__bar')) return
          onReveal()
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
  onReveal: (worktreeId: string) => void
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
  onReveal,
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
  const openPanelsOf = (worktree: Worktree): PanelName[] =>
    (panels[worktree.id] ?? []).filter((panel) => PANELS.includes(panel))

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
   * Navigation is by the spot.
   *
   * Every tile begins on a spot boundary, so scrolling to `spot * pitch` puts
   * that tile hard against the left edge -- which is what clicking a worktree,
   * anywhere it can be clicked, does. Whatever follows it fills the rest of the
   * window, and the front of the tile after that shows if there is room for
   * part of it, which is how you know the row continues.
   */
  const target = scrollTo === null ? undefined : cells.find((cell) => cell.key === scrollTo.id)
  useEffect(() => {
    if (target === undefined || width === 0) return
    gridRef.current?.scrollTo({ left: target.spot * pitch, behavior: 'smooth' })
    // scrollTo carries a counter, so asking twice for one worktree is two
    // requests; the spot alone would compare equal and scroll nowhere.
  }, [scrollTo, target, pitch, width])

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
   * Panels that could not be kept are closed, not left open with nothing to
   * show: a toggle that claims a pane which is not on screen is a toggle that
   * lies. Only reachable when more panels are open than a screenful can hold.
   */
  const collapsedKey = worktrees
    .flatMap((worktree) => {
      const open = openPanelsOf(worktree)
      if (open.length <= spots) return []
      // More panels open than the window has spots: the oldest have nowhere to
      // be, and a panel with nowhere to be is closed, not hidden.
      return open.slice(0, open.length - spots).map((panel) => paneKey(worktree.id, panel))
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
                      panes={slot.data.panes}
                      session={claudeSession(sessions, worktree.id)}
                      terminals={terminalSessions(sessions, worktree.id)}
                      activeTerminalId={activeTerminalByWorktree[worktree.id] ?? null}
                      scroller={gridRef}
                      onStart={() => onStart(worktree.id)}
                      onSleep={() => onSleep(worktree.id)}
                      onReveal={() => onReveal(worktree.id)}
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
