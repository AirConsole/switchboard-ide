import type { Project, Session, Worktree, WorktreeTodo } from '@switchboard/shared'
import { NewWorktreeForm } from './NewWorktreeForm.js'
import { WorktreeRow } from './WorktreeRow.js'

export interface ProjectPaneProps {
  project: Project
  /** This project's worktrees, split the way the row splits them. */
  awake: Worktree[]
  asleep: Worktree[]
  sessions: Session[]
  todos: WorktreeTodo[]
  activeId: string | null
  onWake: (worktreeId: string) => void
  onReveal: (worktreeId: string) => void
  onSleep: (worktreeId: string) => void
  onCreated: (worktreeId: string) => void
  onCloseProject: (projectId: string) => void
}

/**
 * Everything that is about the project rather than about one of its worktrees.
 *
 * The top bar used to carry all of this: a × on the project's name, a `zZ N ▾`
 * tab whose dropdown listed the sleepers, and a + for a new worktree. Four
 * controls and a floating menu in a 38px strip whose actual job is to tell you
 * which agent is blocked on you. They are here instead, in a pane you can walk
 * to, and the strip is left with the project's name and the windows that are
 * awake.
 *
 * The sleepers are the reason this exists rather than being a tidy-up. They were
 * reachable only from a menu you had to hold open, and a menu is the wrong place
 * for a list you want to scan -- a sleeping worktree can still have Claude
 * running in it. Here they are simply the second list.
 *
 * Both lists are `WorktreeRow`, the same component the strip's tabs are. A
 * worktree met here and met up there has to be one object, which is also why
 * the rows keep the `.tab*` classes: only the container differs.
 */
export const ProjectPane = ({
  project,
  awake,
  asleep,
  sessions,
  todos,
  activeId,
  onWake,
  onReveal,
  onSleep,
  onCreated,
  onCloseProject,
}: ProjectPaneProps): React.ReactElement => (
  <div className="projpane">
    <div className="projpane__bar">
      <span className="projpane__name" title={project.root}>
        {project.name}
      </span>
    </div>
    <div className="projpane__body">
      <section className="projpane__section">
        <h3 className="projpane__heading">
          Awake <span className="projpane__count">{awake.length}</span>
        </h3>
        {awake.length === 0 ? (
          <p className="projpane__empty">No windows open.</p>
        ) : (
          <div className="projpane__list">
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
        )}
      </section>

      {asleep.length > 0 && (
        <section className="projpane__section">
          <h3 className="projpane__heading">
            Asleep <span className="projpane__count">{asleep.length}</span>
          </h3>
          <div className="projpane__list">
            {asleep.map((worktree) => (
              <WorktreeRow
                key={worktree.id}
                worktree={worktree}
                sleeping
                sessions={sessions}
                todos={todos}
                activeId={activeId}
                onWake={onWake}
                onReveal={onReveal}
                onSleep={onSleep}
              />
            ))}
          </div>
        </section>
      )}

      <section className="projpane__section">
        <h3 className="projpane__heading">New worktree</h3>
        <NewWorktreeForm project={project} onCreated={onCreated} />
      </section>

      {/*
        * Closing the project is last and on its own, below everything you might
        * be here to do. It used to be a × on the project's name in the strip,
        * one mis-click from the × that merely sleeps a worktree -- the same
        * glyph for a keystroke you undo by clicking again and one you do not.
        */}
      <section className="projpane__section projpane__section--close">
        <button className="btn btn--quiet" onClick={() => onCloseProject(project.id)}>
          Close project
        </button>
        <p className="projpane__note">
          Takes its windows off the row. Nothing on disk changes.
        </p>
      </section>
    </div>
  </div>
)
