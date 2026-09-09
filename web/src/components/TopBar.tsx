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
   * The worktree you are in: the one the row last brought into view, and whose
   * Claude has the keyboard. Null before anything has been navigated to.
   */
  activeId: string | null
}

/** The tab class for a status: the line under it, and amber when blocked. */
const statusClass = (status: WorktreeStatus): string =>
  status === 'needs-you'
    ? 'chip--needs'
    : status === 'working'
      ? 'chip--working'
      : status === 'idle'
        ? 'chip--idle'
        : 'chip--off'

/** A worktree's tab: its name, its branch when that differs, its dirty count. */
const WorktreeLabel = ({
  worktree,
  queued,
}: {
  worktree: Worktree
  queued: number
}): React.ReactElement => (
  <>
    {worktree.name}
    {worktree.branch && worktree.branch !== worktree.name && (
      <span className="chip__branch">{worktree.branch}</span>
    )}
    {worktree.dirty ? <span className="chip__dirty">{worktree.dirty}&plusmn;</span> : null}
    {/* Said in the same quiet channel as the dirty count, because it is the same
        kind of fact: how much work is parked here. Not in colour and not in the
        underline -- those two already mean "blocked on you" and "done", and a
        third meaning on either would make them argue. */}
    {queued > 0 ? <span className="chip__queued">{queued} queued</span> : null}
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
}: {
  group: ProjectGroup
  sessions: Session[]
  todos: WorktreeTodo[]
} & Pick<
  TopBarProps,
  'activeId' | 'onCloseProject' | 'onNewWorktree' | 'onWake' | 'onReveal'
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

  const tab = (worktree: Worktree, sleeping: boolean): React.ReactElement => (
    <button
      key={worktree.id}
      className={[
        'chip',
        sleeping ? 'chip--asleep' : 'chip--shown',
        statusClass(worktreeStatus(sessions, worktree.id)),
        // Where you are. A sleeping worktree is nowhere, whatever the row was
        // last asked for -- it has no window to be in.
        !sleeping && worktree.id === activeId ? 'chip--active' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={() => (sleeping ? onWake(worktree.id) : onReveal(worktree.id))}
      title={[
        worktree.path,
        stateLabel(claudeSession(sessions, worktree.id)),
        ...(worktree.prompt ? [`“${worktree.prompt}”`] : []),
        ...(queuedTodoCount(todos, worktree.id) > 0
          ? [`${queuedTodoCount(todos, worktree.id)} queued to run next here`]
          : []),
        sleeping ? 'Asleep — click to wake it' : 'Click to bring its window into view',
      ].join('\n')}
    >
      {sleeping && (
        <span className="chip__zz" aria-hidden="true">
          zZ
        </span>
      )}
      <WorktreeLabel worktree={worktree} queued={queuedTodoCount(todos, worktree.id)} />
    </button>
  )

  return (
    <div className="group">
      <span className="group__name" title={project.root}>
        <span className="group__mark" aria-hidden="true" />
        {project.name}
        <button
          className="group__close"
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
          <button
            ref={anchor}
            className={['chip', 'chip--asleep', statusClass(asleepStatus)].join(' ')}
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
            {/* The count is part of the label, so it is set at the label's size
                rather than the tab's. */}
            <span className="chip__zz" aria-hidden="true">
              zZ {asleep.length}
            </span>
            <span className="chip__caret" aria-hidden="true">
              {'▾'}
            </span>
          </button>
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
        className="chip chip--add"
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
}: TopBarProps): React.ReactElement => {
  const usage = useUsage()
  return (
  <header className="topbar">
    <nav className="groups">
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
        />
      ))}
    </nav>
    {usage !== null && <UsageBars usage={usage} />}
    <button className="topbar__open" onClick={onOpenProject} title="Open another project">
      + Open project
    </button>
  </header>
  )
}
