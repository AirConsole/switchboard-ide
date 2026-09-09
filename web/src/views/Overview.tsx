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

/** What to leave running when a worktree goes to sleep. */
export interface SleepOptions {
  claude: boolean
  terminals: boolean
}

/**
 * Put this worktree to sleep, and say what to spare.
 *
 * The plain click sleeps at once, because sleeping is the ordinary way to put a
 * worktree away and the expensive half of it is undone by waking: the
 * conversation is continued, not restarted. The caret is for the two things
 * waking cannot undo -- a Claude that is mid-thought, and a terminal's
 * scrollback, which nothing brings back.
 */
const SleepControl = ({
  name,
  onSleep,
}: {
  name: string
  onSleep: (keep: SleepOptions) => void
}): React.ReactElement => {
  const [open, setOpen] = useState(false)
  const [keep, setKeep] = useState<SleepOptions>({ claude: false, terminals: false })

  return (
    <div className="tile__sleep">
      <button
        className="tile__zz"
        onClick={() => onSleep({ claude: false, terminals: false })}
        title={`Sleep ${name}: stop Claude and its terminals. Waking continues the conversation.`}
        aria-label={`Sleep ${name}`}
      >
        zZ
      </button>
      <button
        className="tile__zz-more"
        onClick={() => setOpen((was) => !was)}
        title="Sleep, keeping something running"
        aria-label="Sleep options"
        aria-expanded={open}
      >
        {'\u25be'}
      </button>
      {open && (
        <div className="menu menu--sleep">
          <label className="check">
            <input
              type="checkbox"
              checked={keep.claude}
              onChange={(event) => setKeep({ ...keep, claude: event.target.checked })}
            />
            Keep Claude running
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={keep.terminals}
              onChange={(event) => setKeep({ ...keep, terminals: event.target.checked })}
            />
            Keep terminals
          </label>
          <button
            className="btn"
            onClick={() => {
              setOpen(false)
              onSleep(keep)
            }}
          >
            Sleep
          </button>
        </div>
      )}
    </div>
  )
}

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
  onSleep: (keep: SleepOptions) => void
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
      <SleepControl name={worktree.name} onSleep={onSleep} />
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
   * A pane to bring into view, keyed as `paneKey` builds them. Set when you
   * click a worktree in the top bar or open one of its panels.
   */
  scrollTo: string | null
  onStart: (worktreeId: string) => void
  onSleep: (worktreeId: string, keep: SleepOptions) => void
  onRemoveWorktree: (worktreeId: string) => void
  onTogglePanel: (worktreeId: string, panel: PanelName) => void
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
  onNewWorktree,
  onSelectTerminal,
  onNewTerminal,
  onCloseTerminal,
}: OverviewProps): React.ReactElement => {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const { width } = useElementSize(gridRef)

  const panesOf = (worktree: Worktree): Pane[] => {
    // Read through PANELS rather than the stored array, which comes from a file
    // the user could have edited and may name a panel that no longer exists.
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

  const cells: { key: string; worktree: Worktree | null; panes: Pane[] }[] = worktrees.map(
    (worktree) => ({ key: worktree.id, worktree, panes: panesOf(worktree) }),
  )
  if (addTo !== null) {
    cells.push({ key: ADD_KEY, worktree: null, panes: [{ kind: 'add', key: ADD_KEY }] })
  }

  /*
   * One width for every pane in the row, and one rule to pick it.
   *
   * Panes share the window evenly while they all fit, which is what keeps two
   * worktrees looking exactly as they always have. Past that they stop
   * shrinking and take the 80-column floor instead, and the row overflows --
   * a narrow pane is worse than a pane you have to scroll to.
   *
   * The floor is itself capped at the scrollport, so a single pane on a phone
   * gets the whole width and reflows to it rather than being clipped: one
   * cramped pane beats an empty screen. The same cap is why two panes on a
   * phone come out one screenful each.
   */
  const charWidth = measureMonoCharWidth(TERMINAL_FONT_SIZE, TERMINAL_FONT_FAMILY)
  const minPaneWidth = MIN_PANE_COLUMNS * charWidth + PANE_CHROME_WIDTH
  const totalPanes = cells.reduce((n, cell) => n + cell.panes.length, 0)
  /*
   * The even share has to pay for every tile's margin, since in that case they
   * all have to fit at once. The floor must not: it is measured against the
   * scrollport, because "a pane never narrower than the window" is the whole
   * point of it and there is no reason twelve sleeping-elsewhere tiles should
   * make the one you are reading narrower.
   */
  const even = totalPanes === 0 ? 0 : Math.max(0, width - GAP - GAP * cells.length) / totalPanes
  const floor = Math.min(Math.max(0, width - GAP * 2), minPaneWidth)
  const paneWidth = totalPanes === 0 ? 0 : Math.max(floor, even)

  type Cell = (typeof cells)[number]
  const slots: Slot<Cell>[] = cells.map((cell) => ({
    key: cell.key,
    width: paneWidth * cell.panes.length,
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
  useEffect(() => {
    if (scrollTo === null || width === 0) return
    const grid = gridRef.current
    const pane = grid?.querySelector(`[data-pane="${CSS.escape(scrollTo)}"]`)
    if (!grid || !pane) return
    /*
     * Aligned to the left inset rather than left to `scrollIntoView`, which
     * takes the least action that makes an element visible -- and so does
     * nothing at all for a pane already showing by a sliver, which is exactly
     * the case here when a tile is wider than the window.
     */
    const delta = pane.getBoundingClientRect().left - grid.getBoundingClientRect().left - GAP
    if (Math.abs(delta) > 1) grid.scrollTo({ left: grid.scrollLeft + delta, behavior: 'smooth' })
  }, [scrollTo, width])

  return (
    <section className="view overview">
      <div className="grid" ref={gridRef}>
        {/* Nothing renders until the row is measured, so a terminal is never
            built at a width that is about to change. */}
        {width > 0 &&
          moving.map((slot) => {
            const worktree = slot.data.worktree
            return (
              <div
                key={slot.key}
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
                      onSleep={(keep) => onSleep(worktree.id, keep)}
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
