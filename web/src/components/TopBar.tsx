import { useEffect, useRef, useState } from 'react'
import type { Project, Session, Worktree } from '@ide-n-dream/shared'
import type { ProjectGroup } from '../App.js'
import {
  claudeSession,
  mostUrgentStatus,
  stateLabel,
  worktreeStatus,
  type WorktreeStatus,
} from '../selectors.js'

export interface TopBarProps {
  /** Every open project, in the order they were opened. */
  groups: ProjectGroup[]
  sessions: Session[]
  onOpenProject: () => void
  onCloseProject: (projectId: string) => void
  onNewWorktree: (project: Project) => void
  onWake: (worktreeId: string) => void
  /** Bring an awake worktree's window into view. */
  onReveal: (worktreeId: string) => void
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
const WorktreeLabel = ({ worktree }: { worktree: Worktree }): React.ReactElement => (
  <>
    {worktree.name}
    {worktree.branch && worktree.branch !== worktree.name && (
      <span className="chip__branch">{worktree.branch}</span>
    )}
    {worktree.dirty ? <span className="chip__dirty">{worktree.dirty}&plusmn;</span> : null}
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
  onCloseProject,
  onNewWorktree,
  onWake,
  onReveal,
}: {
  group: ProjectGroup
  sessions: Session[]
} & Pick<
  TopBarProps,
  'onCloseProject' | 'onNewWorktree' | 'onWake' | 'onReveal'
>): React.ReactElement => {
  /*
   * Where to draw the dropdown, or null when it is closed.
   *
   * It has to be positioned against the viewport rather than against the tab it
   * hangs from: the tab lives in a horizontal scroller, and a scroller clips
   * what overflows it in *both* directions -- `overflow-x: auto` computes
   * `overflow-y` to auto as well. So an absolutely positioned menu was there in
   * the markup, at the right coordinates, and cut off entirely by the 44px bar.
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
      ].join(' ')}
      onClick={() => (sleeping ? onWake(worktree.id) : onReveal(worktree.id))}
      title={`${worktree.path}\n${stateLabel(claudeSession(sessions, worktree.id))}\n${
        sleeping ? 'Asleep — click to wake it' : 'Click to bring its window into view'
      }`}
    >
      {sleeping && (
        <span className="chip__zz" aria-hidden="true">
          zZ
        </span>
      )}
      <WorktreeLabel worktree={worktree} />
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
          title={`Close ${project.name}. Its worktrees and their sessions are left alone.`}
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
                    <WorktreeLabel worktree={worktree} />
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
  onOpenProject,
  onCloseProject,
  onNewWorktree,
  onWake,
  onReveal,
}: TopBarProps): React.ReactElement => (
  <header className="topbar">
    <nav className="groups">
      {groups.map((group) => (
        <Group
          key={group.project.id}
          group={group}
          sessions={sessions}
          onCloseProject={onCloseProject}
          onNewWorktree={onNewWorktree}
          onWake={onWake}
          onReveal={onReveal}
        />
      ))}
    </nav>
    <button className="topbar__open" onClick={onOpenProject} title="Open another project">
      + Open project
    </button>
  </header>
)
