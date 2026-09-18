import { useEffect, useRef } from 'react'
import type { Project, Session, Worktree, WorktreeTodo } from '@switchboard/shared'
import { NewWorktreeForm } from './NewWorktreeForm.js'
import { WorktreeTab, worktreeTitle } from './WorktreeTab.js'
import { useListKeys } from './useListKeys.js'
import { queuedTodoCount, worktreeStatus } from '../selectors.js'

export interface ProjectPaneProps {
  project: Project
  /** This project's worktrees, split the way the row splits them. */
  awake: Worktree[]
  asleep: Worktree[]
  sessions: Session[]
  todos: WorktreeTodo[]
  activeId: string | null
  /** Bumped when the row navigates here, to hand the keyboard over. */
  focus: number | null
  /**
   * Whether the keyboard goes into the branch box, or onto the pane itself.
   *
   * False on a phone, where a caret *is* the on-screen keyboard: arriving here
   * would throw it over half the pane before you had seen it, and you got here
   * by asking to look. But the pane still has to take the keyboard, because the
   * row's walk reads where the keyboard is -- a pane that takes none is a pane
   * the walk cannot get past, measured at 390px as a step right that moved the
   * row and then stopped answering. A box is not a caret: focusing it summons
   * no keyboard, and tapping the field still does, which is the phone's own
   * rule for when one is wanted.
   */
  caret: boolean
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
 * Both lists are `WorktreeTab`, the same component the strip's tabs are. A
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
  focus,
  caret,
  onWake,
  onReveal,
  onSleep,
  onCreated,
  onCloseProject,
}: ProjectPaneProps): React.ReactElement => {
  const box = useRef<HTMLDivElement | null>(null)
  /*
   * The column is every worktree, then the form and the way out; the second
   * control on a worktree's line is its ×, which is the shape a tab in the top
   * bar has.
   */
  useListKeys(box, {
    rows: '.projpane__list .tab__body, .projpane__foot .field__input, .projpane__foot .btn, .projpane__close',
    cells: '.tab__body, .tab__close',
    line: '.tab',
  })
  // Where the caret is not wanted, the pane itself answers -- see `caret`.
  useEffect(() => {
    if (focus === null || caret) return
    box.current?.focus()
  }, [focus, caret])
  return (
  <div className="projpane" ref={box} tabIndex={-1}>
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
              <WorktreeTab
                key={worktree.id}
                worktree={worktree}
                status={worktreeStatus(sessions, worktree.id)}
                queued={queuedTodoCount(todos, worktree.id)}
                sleeping={false}
                active={worktree.id === activeId}
                title={worktreeTitle(
                  worktree,
                  sessions,
                  queuedTodoCount(todos, worktree.id),
                  false,
                )}
                onPick={() => onReveal(worktree.id)}
                onClose={{ title: `Put ${worktree.name} away`, run: () => onSleep(worktree.id) }}
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
              <WorktreeTab
                key={worktree.id}
                worktree={worktree}
                status={worktreeStatus(sessions, worktree.id)}
                queued={queuedTodoCount(todos, worktree.id)}
                sleeping
                title={worktreeTitle(
                  worktree,
                  sessions,
                  queuedTodoCount(todos, worktree.id),
                  true,
                )}
                onPick={() => onWake(worktree.id)}
              />
            ))}
          </div>
        </section>
      )}

    </div>
    {/*
      * The two things that are not a list are pinned under it.
      *
      * The lists are what grows -- a project can have twenty worktrees -- and a
      * form you have to scroll to is a form you stop using. So the lists take
      * the slack and these two stay where they are, in the order you reach for
      * them: making one is the everyday thing, closing the project the last.
      */}
    {/*
      * One block, not two. The form and Close project are both things you do to
      * the project rather than to one of its worktrees, and they were reading
      * as a form with a stray button under it -- so they share a heading, a
      * rhythm and an edge, and the button is the last row of the form rather
      * than a peer of it.
      *
      * It turns --danger under the pointer, which is the red the project's ×
      * used to turn: said on the thing itself now rather than on a glyph beside
      * the name.
      */}
    <div className="projpane__foot">
      <span className="projpane__footlabel">New worktree</span>
      <NewWorktreeForm project={project} focus={caret ? focus : null} onCreated={onCreated} />
      <button className="projpane__close" onClick={() => onCloseProject(project.id)}>
        Close project
      </button>
    </div>
  </div>
  )
}
