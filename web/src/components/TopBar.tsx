import { useEffect, useRef, useState } from 'react'
import type { Project, Session, Usage, Worktree, WorktreeTodo } from '@ide-n-dream/shared'
import type { ProjectGroup } from '../App.js'
import { api } from '../api.js'
import { ForkIcon } from './ForkIcon.js'
import {
  claudeSession,
  mostUrgentStatus,
  queuedTodoCount,
  stateLabel,
  worktreeStatus,
  type WorktreeStatus,
} from '../selectors.js'

export interface TopBarProps {
  /** Every open project, in the order they were opened. */
  groups: ProjectGroup[]
  sessions: Session[]
  /** Every todo, so a tab can say how much is queued behind it. */
  todos: WorktreeTodo[]
  onOpenProject: () => void
  onCloseProject: (projectId: string) => void
  onNewWorktree: (project: Project) => void
  onWake: (worktreeId: string) => void
  /** Bring an awake worktree's window into view. */
  onReveal: (worktreeId: string) => void
  /**
   * Put a worktree away: the tab's × asks this, and the dialog behind it is
   * where sleeping and deleting are told apart.
   */
  onSleep: (worktreeId: string) => void
  /**
   * The worktree you are in: the one the row last brought into view, and whose
   * Claude has the keyboard. Null before anything has been navigated to.
   */
  activeId: string | null
}

/**
 * Open a project.
 *
 * A square with a plus in it: the shape of a thing you add, at the chrome's
 * own hairline weight, in currentColor so it inherits the quiet-until-hovered
 * treatment of the button around it.
 */
const OpenProjectIcon = (): React.ReactElement => (
  <svg
    className="topbar__icon"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <rect x="2.3" y="2.3" width="11.4" height="11.4" rx="1.6" />
    <path d="M8 5.3v5.4M5.3 8h5.4" />
  </svg>
)

/** The tab class for a status: what colour its bullet is, if any. */
const statusClass = (status: WorktreeStatus): string =>
  status === 'needs-you'
    ? 'tab--needs'
    : status === 'working'
      ? 'tab--working'
      : status === 'idle'
        ? 'tab--idle'
        : 'tab--off'

/**
 * What a tab says: its name and its dirty count.
 *
 * A fragment of spans rather than a box of its own, because a tab's body is
 * already the box.
 *
 * It does not name the branch. A worktree is nearly always on the branch it is
 * named after, so it was a second copy of the name most of the time and every
 * tab paid width for it; the dropdown used to make an exception, and does not
 * any more now that its rows are tabs. The window's own bar names the branch,
 * and so does a tab's title.
 */
const WorktreeLabel = ({
  worktree,
  queued,
}: {
  worktree: Worktree
  queued: number
}): React.ReactElement => (
  <>
    <span className="tab__name">{worktree.name}</span>
    {worktree.dirty ? (
      <span className="tab__dirty">{worktree.dirty}&plusmn;</span>
    ) : worktree.unmerged ? (
      <ForkIcon className="tab__fork" />
    ) : null}
    {/* Said in the same quiet channel as the dirty count, because it is the same
        kind of fact: how much work is parked here. Not in colour and not on the
        bullet -- those already mean "blocked on you" and "done", and a third
        meaning on either would make them argue. */}
    {queued > 0 ? <span className="tab__queued">{queued} queued</span> : null}
  </>
)

/**
 * One project: its name, its awake worktrees, its sleeping ones, and a way to
 * add another.
 *
 * The sleeping ones collapse into a single tab, because a project's worktrees
 * accumulate and most of them are not what you are working on today. The
 * exception is a project where *everything* is asleep: collapsing then would
 * leave a group showing nothing but a dropdown, hiding the only thing it has,
 * so they are listed in place with a zZ in front until one of them is woken.
 */
const Group = ({
  group,
  sessions,
  todos,
  alone,
  activeId,
  onCloseProject,
  onNewWorktree,
  onWake,
  onReveal,
  onSleep,
}: {
  group: ProjectGroup
  sessions: Session[]
  todos: WorktreeTodo[]
  /**
   * Whether this is the only project open.
   *
   * With one project the + is the only + there is, and the strip has the room
   * to say what it does; with several, each sleeve has one and a label on every
   * one of them would be the same three words repeated across the bar.
   */
  alone: boolean
} & Pick<
  TopBarProps,
  'activeId' | 'onCloseProject' | 'onNewWorktree' | 'onWake' | 'onReveal' | 'onSleep'
>): React.ReactElement => {
  /*
   * Where to draw the dropdown, or null when it is closed.
   *
   * It has to be positioned against the viewport rather than against the tab it
   * hangs from: the tab lives in a horizontal scroller, and a scroller clips
   * what overflows it in *both* directions -- `overflow-x: auto` computes
   * `overflow-y` to auto as well. So an absolutely positioned menu was there in
   * the markup, at the right coordinates, and cut off entirely by the bar.
   */
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  const { project, awake, asleep } = group

  // A dropdown that only closes by pressing the thing that opened it is a
  // dropdown you get stuck with.
  useEffect(() => {
    if (at === null) return
    const dismiss = (event: Event): void => {
      const target = event.target as Node
      if (menu.current?.contains(target) || anchor.current?.contains(target)) return
      setAt(null)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAt(null)
    }
    /*
     * The menu hangs from a rect measured when it was opened, and the strip it
     * hangs from scrolls -- so a scroll or a resize with the menu open left it
     * pointing at a tab that had moved. Re-measured rather than dismissed,
     * because dismissing something you did not click is its own surprise.
     */
    const follow = (): void => {
      const box = anchor.current?.getBoundingClientRect()
      if (box) setAt({ left: box.left, top: box.bottom })
    }
    window.addEventListener('resize', follow)
    // Capture, so a scroll of the strip itself is heard as well as the window's.
    document.addEventListener('scroll', follow, true)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('resize', follow)
      document.removeEventListener('scroll', follow, true)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', key)
    }
  }, [at])
  const allAsleep = awake.length === 0 && asleep.length > 0
  /*
   * The collapsed tab stands for several worktrees, so it shows the most
   * urgent of them. Sleeping does not mean stopped -- Claude can be left
   * running -- so one of them being blocked on you has to reach the top bar
   * from behind a dropdown.
   */
  const asleepStatus = mostUrgentStatus(asleep.map((w) => worktreeStatus(sessions, w.id)))

  const tab = (worktree: Worktree, sleeping: boolean): React.ReactElement => {
    const queued = queuedTodoCount(todos, worktree.id)
    return (
      <span
        key={worktree.id}
        className={[
          'tab',
          sleeping ? 'tab--asleep' : 'tab--awake',
          statusClass(worktreeStatus(sessions, worktree.id)),
          // Where you are. A sleeping worktree is nowhere, whatever the row was
          // last asked for -- it has no window to be in.
          !sleeping && worktree.id === activeId ? 'tab--active' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <button
          className="tab__body"
          onClick={() => (sleeping ? onWake(worktree.id) : onReveal(worktree.id))}
          title={[
            worktree.path,
            ...(worktree.branch && worktree.branch !== worktree.name
              ? [`on ${worktree.branch}`]
              : []),
            stateLabel(claudeSession(sessions, worktree.id)),
            ...(worktree.prompt ? [`“${worktree.prompt}”`] : []),
            ...(worktree.dirty
              ? [`${worktree.dirty} uncommitted change${worktree.dirty === 1 ? '' : 's'}`]
              : []),
            ...(worktree.unmerged
              ? [
                  `${worktree.unmerged} commit${worktree.unmerged === 1 ? '' : 's'} not on the default branch`,
                ]
              : []),
            ...(queued > 0 ? [`${queued} queued to run next here`] : []),
            sleeping ? 'Asleep — click to wake it' : 'Click to bring its window into view',
          ].join('\n')}
        >
          {/* The bullet is on every tab, asleep or not: sleeping does not mean
              stopped -- Claude can be left running -- so a sleeper blocked on
              you has to be able to say so from the bar. The zZ beside it is
              the other fact. */}
          <span className="tab__dot" aria-hidden="true" />
          {sleeping && (
            <span className="tab__zz" aria-hidden="true">
              zZ
            </span>
          )}
          <span className="tab__label">
            <WorktreeLabel worktree={worktree} queued={queued} />
          </span>
        </button>
        {/* Already asleep, so there is nothing to put away and no × to do it
            with. Waking it is what its body is for. */}
        {!sleeping && (
          <button
            className="tab__close"
            onClick={() => onSleep(worktree.id)}
            title={`Put ${worktree.name} away`}
            aria-label={`Put ${worktree.name} away`}
          >
            &times;
          </button>
        )}
      </span>
    )
  }

  return (
    <div className="tabgroup">
      <span className="tabgroup__pill" title={project.root}>
        <span className="tabgroup__name">{project.name}</span>
        <button
          className="tabgroup__close"
          onClick={() => onCloseProject(project.id)}
          title={`Close ${project.name}, and choose what happens to what it is running`}
          aria-label={`Close project ${project.name}`}
        >
          &times;
        </button>
      </span>

      {awake.map((worktree) => tab(worktree, false))}
      {allAsleep && asleep.map((worktree) => tab(worktree, true))}

      {!allAsleep && asleep.length > 0 && (
        <>
          <span className={['tab', 'tab--zz', 'tab--asleep', statusClass(asleepStatus)].join(' ')}>
            <button
              ref={anchor}
              className="tab__body"
              onClick={() => {
                const box = anchor.current?.getBoundingClientRect()
                setAt((was) =>
                  was !== null || box === undefined ? null : { left: box.left, top: box.bottom },
                )
              }}
              title={`${asleep.length} sleeping — click to pick one to wake`}
              aria-label={`${asleep.length} sleeping worktrees, ${asleepStatus}`}
              aria-expanded={at !== null}
            >
              {/* The most urgent of the worktrees behind it, on the same
                  bullet every other tab uses. */}
              <span className="tab__dot" aria-hidden="true" />
              {/* The count is part of the label, so it is set at the label's
                  size rather than the tab's. */}
              <span className="tab__zz" aria-hidden="true">
                zZ {asleep.length}
              </span>
              <span className="tab__caret" aria-hidden="true">
                {'▾'}
              </span>
            </button>
          </span>
          {at !== null && (
            /*
             * The same tabs, stacked.
             *
             * A sleeping worktree is one of these tabs that happens not to be
             * in the row, so it is drawn by the same `tab()` -- the sleeve
             * under it, the bullet, the zZ, the name and its marks, the hover
             * panel. The list used to invent a row of its own, with the state
             * spelled out in words and the prompt on a second line, and that
             * made the same worktree look like two different objects depending
             * on where you met it. Both facts are still on the tab: the bullet
             * carries the state and the title carries the prompt, exactly as
             * they do in the bar.
             *
             * The click that wakes one is the tab's own; this closes the menu
             * behind it, and does it on the way out so `onWake` has already run.
             */
            <div
              className="menu menu--tabs"
              ref={menu}
              style={{ left: at.left, top: at.top }}
              onClick={() => setAt(null)}
            >
              {asleep.map((worktree) => tab(worktree, true))}
            </div>
          )}
        </>
      )}

      <button
        className={alone ? 'tabgroup__add tabgroup__add--labelled' : 'tabgroup__add'}
        onClick={() => onNewWorktree(project)}
        title={`New worktree in ${project.name}`}
        aria-label={`New worktree in ${project.name}`}
      >
        <span aria-hidden="true">+</span>
        {alone && <span className="tabgroup__add-label">New worktree</span>}
      </button>
    </div>
  )
}

/**
 * How often the browser asks for Claude's usage limits.
 *
 * The same five minutes the server caches for, so a poll that lands inside the
 * window is answered from the last reading rather than starting another
 * `claude -p /usage`. The client is what decides when a reading is taken and
 * the cache is what stops several tabs taking several -- which is also why a
 * hidden page does not ask at all, and asks once when it comes back rather
 * than on a timer nobody is watching.
 */
const USAGE_POLL_MS = 5 * 60 * 1000

const useUsage = (): Usage | null => {
  const [usage, setUsage] = useState<Usage | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      if (document.hidden) return
      void api
        .usage()
        .then((next) => {
          if (live) setUsage(next)
        })
        // A failed read leaves the last numbers on screen; the server says so
        // itself when its own read failed, and this is only the transport.
        .catch(() => {})
    }
    read()
    const timer = window.setInterval(read, USAGE_POLL_MS)
    document.addEventListener('visibilitychange', read)
    return () => {
      live = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', read)
    }
  }, [])
  return usage
}

/**
 * Claude's usage limits, as bars.
 *
 * One row per limit `/usage` reported, in its order: the session, the week, and
 * the week for whichever model has its own allowance. Greyscale, because these
 * are not attention -- amber and green mean an agent wants you -- but the fill
 * brightens once a limit is most of the way gone, which is the point at which
 * it starts to matter what you spend it on.
 *
 * Every row says when it comes back, because that is the second half of the
 * question the first half raises: 90% spent matters very differently at four
 * minutes to the hour than at four days. It is a countdown and not a clock
 * time -- `5h`, `4d` -- for width, which is the reason it used to be tooltip
 * only: one short cell costs 24px where `Sep 15, 8:59am` would cost the bar
 * more room than the bars themselves. The exact moment stays in the tooltip,
 * in the reader's own zone rather than the report's.
 */
/**
 * How long until a limit comes back, in one cell.
 *
 * One unit, rounded, because this is a glance and not a stopwatch: hours until
 * a day is left, then days. Under a minute is `now` rather than `0m` -- the
 * reading is up to five minutes old, so a countdown that has just run out is
 * telling you it has already happened.
 */
const untilText = (at: number, now: number): string => {
  const ms = at - now
  if (ms < 60_000) return 'now'
  const minutes = ms / 60_000
  if (minutes < 60) return `${Math.floor(minutes)}m`
  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

/** The exact moment, in the reader's zone: `Tue 08:59`, or `17:29` for today. */
const resetText = (at: number, now: number): string => {
  const when = new Date(at)
  const sameDay = when.toDateString() === new Date(now).toDateString()
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

const UsageBars = ({ usage }: { usage: Usage }): React.ReactElement | null => {
  /*
   * A countdown that does not count is a small lie, and the reading itself is
   * only taken every five minutes -- so `12m` would sit there for five of them
   * and then jump to `6m`. One tick a minute is what the smallest unit shown
   * needs; nothing here is per-second. Before the early return, because a hook
   * cannot be conditional.
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  if (usage.limits.length === 0) return null
  const resetsOf = (limit: Usage['limits'][number]): string => {
    if (limit.resetsAt !== null) {
      const until = untilText(limit.resetsAt, now)
      // "in now" is not a sentence; a limit that is due says so on its own.
      const left = until === 'now' ? '(now)' : `(in ${until})`
      return ` · resets ${resetText(limit.resetsAt, now)} ${left}`
    }
    // The prose did not parse, so it is repeated as it came.
    return limit.resets === null ? '' : ` · resets ${limit.resets}`
  }
  const title = [
    ...usage.limits.map((limit) => `${limit.label}: ${limit.percent}% used${resetsOf(limit)}`),
    usage.error === undefined
      ? `read ${new Date(usage.fetchedAt).toLocaleTimeString()}`
      : `last read ${new Date(usage.fetchedAt).toLocaleTimeString()} — ${usage.error}`,
  ].join('\n')
  return (
    <div
      className={usage.error === undefined ? 'usage' : 'usage usage--stale'}
      title={title}
      aria-label="Claude usage limits"
    >
      {usage.limits.map((limit) => (
        <div className="usage__row" key={limit.label}>
          <span className="usage__label">{limit.label}</span>
          <span className="usage__track">
            <i
              className={limit.percent >= 80 ? 'usage__fill usage__fill--high' : 'usage__fill'}
              style={{ width: `${limit.percent}%` }}
            />
          </span>
          <span className="usage__percent">{limit.percent}%</span>
          <span className="usage__resets">
            {limit.resetsAt === null ? '' : untilText(limit.resetsAt, now)}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * The top bar is where every worktree lives, grouped by the project it belongs
 * to.
 *
 * Every open project is here at once — there is no active one — so the bar is
 * also the index of more worktrees than fit on screen: clicking an awake one
 * brings its window into view. Tabs no longer toggle anything, because with
 * nothing hidden to make room there is nothing to toggle; the only two states a
 * worktree has are awake and asleep.
 *
 * Amber stays reserved for a worktree whose Claude is blocked on you, and it
 * has to survive being asleep, since sleeping can leave Claude running.
 */
export const TopBar = ({
  groups,
  sessions,
  todos,
  activeId,
  onOpenProject,
  onCloseProject,
  onNewWorktree,
  onWake,
  onReveal,
  onSleep,
}: TopBarProps): React.ReactElement => {
  const usage = useUsage()
  /*
   * How much a tab may say, from how many there are.
   *
   * Chrome shrinks its tabs and drops what stops fitting; the widths here come
   * from the names, so what a tab can afford to say comes from the count. Four
   * steps, and the last one still keeps the name, the bullet and the ×.
   */
  const tabCount = groups.reduce(
    (total, group) => total + group.awake.length + (group.asleep.length > 0 ? 1 : 0),
    0,
  )
  const tight = tabCount > 12 ? 3 : tabCount > 9 ? 2 : tabCount > 6 ? 1 : 0
  return (
  <header className="topbar">
    <button className="topbar__open" onClick={onOpenProject} title="Open another project">
      <OpenProjectIcon />
      Open project
    </button>
    <nav className="tabstrip" data-tight={tight}>
      {groups.map((group) => (
        <Group
          key={group.project.id}
          group={group}
          sessions={sessions}
          todos={todos}
          alone={groups.length === 1}
          activeId={activeId}
          onCloseProject={onCloseProject}
          onNewWorktree={onNewWorktree}
          onWake={onWake}
          onReveal={onReveal}
          onSleep={onSleep}
        />
      ))}
    </nav>
    {usage !== null && <UsageBars usage={usage} />}
  </header>
  )
}
