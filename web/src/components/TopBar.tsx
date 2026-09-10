import { useEffect, useRef, useState } from 'react'
import type { Project, Session, Usage, Worktree, WorktreeTodo } from '@ide-n-dream/shared'
import type { ProjectGroup } from '../App.js'
import { api } from '../api.js'
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
 * What a tab says: its name, its branch when that differs, its dirty count.
 *
 * Rendered both on a tab and in the sleeping-worktrees dropdown, which is why
 * it is a fragment of spans rather than a box of its own.
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
    {worktree.branch && worktree.branch !== worktree.name && (
      <span className="tab__branch">{worktree.branch}</span>
    )}
    {worktree.dirty ? <span className="tab__dirty">{worktree.dirty}&plusmn;</span> : null}
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
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', key)
    return () => {
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
            stateLabel(claudeSession(sessions, worktree.id)),
            ...(worktree.prompt ? [`“${worktree.prompt}”`] : []),
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
            <div className="menu" ref={menu} style={{ left: at.left, top: at.top }}>
              {asleep.map((worktree) => {
                const status = worktreeStatus(sessions, worktree.id)
                return (
                  <button
                    key={worktree.id}
                    className="menu__row"
                    onClick={() => {
                      setAt(null)
                      onWake(worktree.id)
                    }}
                    title={worktree.path}
                  >
                    <span className="menu__line">
                      <WorktreeLabel worktree={worktree} queued={queuedTodoCount(todos, worktree.id)} />
                      {/* Said in words rather than a dot: there is room here, and
                          a sleeping worktree with Claude still running is the
                          thing you most need to be able to tell apart. */}
                      <span
                        className={
                          status === 'needs-you'
                            ? 'menu__state menu__state--needs'
                            : status === 'working'
                              ? 'menu__state menu__state--working'
                              : status === 'idle'
                                ? 'menu__state menu__state--idle'
                                : 'menu__state'
                        }
                      >
                        {stateLabel(claudeSession(sessions, worktree.id))}
                      </span>
                    </span>
                    {/* What it was doing when you put it down. A sleeping
                        worktree is the one you have least chance of recognising
                        by name alone. */}
                    {worktree.prompt && <span className="menu__prompt">{worktree.prompt}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      <button
        className="tabgroup__add"
        onClick={() => onNewWorktree(project)}
        title={`New worktree in ${project.name}`}
        aria-label={`New worktree in ${project.name}`}
      >
        +
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
 * The reset times live in the tooltip. They are the second question ("when does
 * this come back"), and putting them on the bar would double its width.
 */
const UsageBars = ({ usage }: { usage: Usage }): React.ReactElement | null => {
  if (usage.limits.length === 0) return null
  const title = [
    ...usage.limits.map(
      (limit) =>
        `${limit.label}: ${limit.percent}% used${limit.resets === null ? '' : ` · resets ${limit.resets}`}`,
    ),
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
