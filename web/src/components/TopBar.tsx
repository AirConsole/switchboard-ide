import { useEffect, useRef, useState } from 'react'
import type { Project, Session, Usage, Worktree, WorktreeTodo } from '@switchboard/shared'
import type { ProjectGroup } from '../App.js'
import { api } from '../api.js'
import { projectKey } from '../views/Overview.js'
import { WorktreeRow } from './WorktreeRow.js'
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
  /** Walk to this project's own pane in the row. */
  onRevealProject: (project: Project) => void
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
  activeId,
  onRevealProject,
  onWake,
  onReveal,
  onSleep,
}: {
  group: ProjectGroup
  sessions: Session[]
  todos: WorktreeTodo[]
} & Pick<
  TopBarProps,
  'activeId' | 'onRevealProject' | 'onWake' | 'onReveal' | 'onSleep'
>): React.ReactElement => {
  const { project, awake, asleep } = group
  /*
   * What the head's state bar says, and only two states can say anything.
   *
   * It stands for the worktrees with no tab of their own -- the sleeping ones.
   * Sleeping does not mean stopped, Claude can be left running, so one of them
   * being blocked on you still has to reach the top bar; that was the zZ tab's
   * job and this is what took it over. Amber and green only: the two states a
   * row of agents is scanned for. Working and not-running say nothing here,
   * because a summary that is always lit is not a summary.
   */
  const asleepStatus = mostUrgentStatus(asleep.map((w) => worktreeStatus(sessions, w.id)))
  const asleepSignal =
    asleepStatus === 'needs-you'
      ? 'tab--needs'
      : asleepStatus === 'idle'
        ? 'tab--idle'
        : ''

  return (
    <div className="tabgroup">
      {/*
        * The project's name is its pane's tab.
        *
        * It used to be a label with an × on it that closed the project -- the
        * same glyph a worktree's tab uses to merely sleep, one mis-click apart.
        * Closing lives in the pane now; this walks you there and lights while
        * you are in it, exactly as a worktree's tab does for its window.
        *
        * The state bar aggregates only the SLEEPING worktrees, and only in
        * amber and green. An awake one already says its own state on its own
        * tab, so the head reports what has no tab -- which is the job the zZ
        * tab used to do, and the one thing that could not be lost when it went.
        * Grey and dashed are left off deliberately: this is a summary, and the
        * two colours are the only states a row of agents is scanned for.
        */}
      <button
        className={[
          'tabgroup__pill',
          activeId === projectKey(project.id) ? 'tabgroup__pill--on' : '',
          asleepSignal,
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onRevealProject(project)}
        title={`${project.root}\n${
          asleep.length === 0 ? 'Nothing asleep' : `${asleep.length} asleep`
        }\nClick for this project's worktrees, a new one, and closing it`}
      >
        <span className="tabgroup__name">{project.name}</span>
        {/* The one thing the zZ tab said that a colour cannot: how many
            worktrees exist that you cannot see. Said in the quiet channel, the
            way a tab says its dirty count. */}
        {asleep.length > 0 && <span className="tabgroup__zz">zZ {asleep.length}</span>}
      </button>

      {awake.map((worktree) => (
        <WorktreeRow
          key={worktree.id}
          worktree={worktree}
          sleeping={false}
          sessions={sessions}
          todos={todos}
          activeId={activeId}
          onWake={onWake}
          onReveal={onReveal}
          onSleep={onSleep}
        />
      ))}
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
  onRevealProject,
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
          activeId={activeId}
          onRevealProject={onRevealProject}
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
