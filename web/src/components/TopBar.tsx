import { useState } from 'react'
import type { Project, Session, Worktree } from '@ide-n-dream/shared'
import type { ProjectGroup } from '../App.js'
import { claudeSession, stateLabel, worktreeNeedsYou } from '../selectors.js'

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
  const [open, setOpen] = useState(false)
  const { project, awake, asleep } = group
  const allAsleep = awake.length === 0 && asleep.length > 0
  // A sleeping worktree can still be one whose Claude was left running, so the
  // collapsed tab has to be able to call for you the way a tab does.
  const asleepNeedsYou = asleep.some((w) => worktreeNeedsYou(sessions, w.id))

  const tab = (worktree: Worktree, sleeping: boolean): React.ReactElement => (
    <button
      key={worktree.id}
      className={[
        'chip',
        sleeping ? 'chip--asleep' : 'chip--shown',
        worktreeNeedsYou(sessions, worktree.id) ? 'chip--waiting' : '',
      ]
        .filter(Boolean)
        .join(' ')}
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
        <div className="chip__drawer">
          <button
            className={['chip', 'chip--asleep', asleepNeedsYou ? 'chip--waiting' : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => setOpen((was) => !was)}
            title={`${asleep.length} sleeping — click to pick one to wake`}
            aria-expanded={open}
          >
            <span className="chip__zz" aria-hidden="true">
              zZ
            </span>
            {asleep.length}
            <span className="chip__caret" aria-hidden="true">
              {'▾'}
            </span>
          </button>
          {open && (
            <div className="menu">
              {asleep.map((worktree) => (
                <button
                  key={worktree.id}
                  className={
                    worktreeNeedsYou(sessions, worktree.id) ? 'menu__row menu__row--waiting' : 'menu__row'
                  }
                  onClick={() => {
                    setOpen(false)
                    onWake(worktree.id)
                  }}
                  title={worktree.path}
                >
                  <WorktreeLabel worktree={worktree} />
                </button>
              ))}
            </div>
          )}
        </div>
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
