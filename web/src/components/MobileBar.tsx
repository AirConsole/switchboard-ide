import { useEffect, useState } from 'react'
import type { Project, Session, Usage, Worktree, WorktreeTodo } from '@switchboard/shared'
import type { ProjectGroup } from '../App.js'
import { WorktreeTab, summaryClass, worktreeTitle } from './WorktreeTab.js'
import { UsageBars } from './UsageBars.js'
import { useEscape } from './useEscape.js'
import { mostUrgentStatus, queuedTodoCount, worktreeStatus } from '../selectors.js'

export interface MobileBarProps {
  groups: ProjectGroup[]
  sessions: Session[]
  todos: WorktreeTodo[]
  /** Read once by the bar above this one, so rotating does not re-request it. */
  usage: Usage | null
  activeId: string | null
  onOpenProject: () => void
  onRevealProject: (project: Project) => void
  onReveal: (worktreeId: string) => void
  onWake: (worktreeId: string) => void
  onSleep: (worktreeId: string) => void
  /** Put the keyboard back where it was when the sheet closes without going anywhere. */
  onRefocus: () => void
}

/**
 * Three lines, which is the one icon everybody already knows means "the rest of
 * it is in here". Drawn at the chrome's own hairline weight in currentColor, so
 * it inherits the quiet-until-touched treatment of the button around it.
 */
const MenuIcon = (): React.ReactElement => (
  <svg
    className="topbar__icon"
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
  </svg>
)

/**
 * The top bar on a phone: one button, and everything else behind it.
 *
 * A 390px screen cannot hold a project, its tabs and 189px of usage bars in a
 * 38px band -- and what gets squeezed out is the tabs, which are the part the
 * bar is *for*. So the strip collapses to a hamburger and its contents stand up
 * vertically in a sheet, where a list of worktrees has the one dimension a
 * phone has plenty of.
 *
 * **The strip keeps its 38px.** It is the smallest comfortable touch target, so
 * shrinking it to fit one button would cost the button; and the height it would
 * save is a quarter of a terminal row, where dropping the row's own padding
 * saves six times that. The height is `--bar-h` either way, untouched.
 *
 * **Closed, the hamburger is still the answer to "does anything need me".**
 * That is the whole job of this interface and it cannot go behind a tap: the
 * button wears the same aggregate band the project head wears, over every
 * worktree of every project, awake and asleep, amber or green only -- see
 * `summaryClass`.
 */
export const MobileBar = ({
  groups,
  sessions,
  todos,
  usage,
  activeId,
  onOpenProject,
  onRevealProject,
  onReveal,
  onWake,
  onSleep,
  onRefocus,
}: MobileBarProps): React.ReactElement => {
  const [open, setOpen] = useState(false)

  /*
   * Everything, in one bar: what the heads say between them, plus what the tabs
   * say. The strip breaks this up by project and by worktree; a single button
   * cannot, so it takes the most urgent of the lot.
   */
  const signal = summaryClass(
    mostUrgentStatus(
      groups.flatMap((group) =>
        [...group.awake, ...group.asleep].map((w) => worktreeStatus(sessions, w.id)),
      ),
    ),
  )

  return (
    <>
      <header className="topbar topbar--narrow">
        <button
          className={['mobilebar__menu', signal].filter(Boolean).join(' ')}
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          aria-label="Projects and worktrees"
          title="Projects and worktrees"
        >
          <MenuIcon />
        </button>
      </header>
      {open && (
        <MobileSheet
          groups={groups}
          sessions={sessions}
          todos={todos}
          usage={usage}
          activeId={activeId}
          onOpenProject={onOpenProject}
          onRevealProject={onRevealProject}
          onReveal={onReveal}
          onWake={onWake}
          onSleep={onSleep}
          onClose={(wentSomewhere) => {
            setOpen(false)
            // Dismissed rather than used: the keyboard goes back to the pane it
            // came from, the way every dialog here returns it. Going somewhere
            // hands it over itself, and doing both would take it straight back.
            if (!wentSomewhere) onRefocus()
          }}
        />
      )}
    </>
  )
}

/**
 * The bar's contents, stood on end.
 *
 * Exactly what the strip holds and in its order -- Open project, then each
 * project's head followed by its awake worktrees -- because it is the same
 * thing, not a summary of it. A project's *sleeping* worktrees and its
 * new-worktree form are one tap further, in that project's own pane, which is
 * where they already live and where tapping its head takes you.
 *
 * It borrows the project pane's own vocabulary (`.projpane__section`,
 * `.projpane__heading`, `.projpane__list`) rather than inventing a third way to
 * stack a `WorktreeTab`. Two lists of worktrees have already drifted apart once
 * in this interface; a worktree met in the sheet and met in the pane it walks
 * you to has to be one object.
 */
const MobileSheet = ({
  groups,
  sessions,
  todos,
  usage,
  activeId,
  onOpenProject,
  onRevealProject,
  onReveal,
  onWake,
  onSleep,
  onClose,
}: Omit<MobileBarProps, 'onRefocus'> & {
  onClose: (wentSomewhere: boolean) => void
}): React.ReactElement => {
  useEscape(() => onClose(false))

  /*
   * A tap outside closes it. On the scrim rather than the document, so the
   * touch that dismisses cannot also land on whatever is under it -- and
   * `pointerdown` rather than `click`, which is the beat a dismissal should
   * happen on and what `useAnchoredMenu` uses for the same reason.
   */
  useEffect(() => {
    const away = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.mobilesheet') || target?.closest('.mobilebar__menu')) return
      onClose(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <div className="mobilesheet__scrim" aria-hidden="true" />
      <div className="mobilesheet" role="dialog" aria-label="Projects and worktrees">
        <div className="mobilesheet__body">
          <button
            className="mobilesheet__open"
            onClick={() => {
              onClose(true)
              onOpenProject()
            }}
          >
            Open project
          </button>
          {groups.map((group) => (
            <section className="projpane__section" key={group.project.id}>
              {/*
               * The head is the project's own row and it goes somewhere: its
               * pane, which holds the sleeping worktrees and the form for a new
               * one. Shaped like the head in the strip, because it is that.
               */}
              <button
                className="mobilesheet__head"
                onClick={() => {
                  onClose(true)
                  onRevealProject(group.project)
                }}
              >
                <span className="tabgroup__name">{group.project.name}</span>
                {group.asleep.length > 0 && <span className="tabgroup__zz">zZ</span>}
              </button>
              <div className="projpane__list mobilesheet__list">
                {group.awake.map((worktree) => (
                  <Row
                    key={worktree.id}
                    worktree={worktree}
                    sessions={sessions}
                    todos={todos}
                    activeId={activeId}
                    onPick={() => {
                      onClose(true)
                      onReveal(worktree.id)
                    }}
                    onSleep={() => onSleep(worktree.id)}
                  />
                ))}
                {group.awake.length === 0 && (
                  <p className="mobilesheet__none">Nothing awake in this project.</p>
                )}
              </div>
            </section>
          ))}
          {groups.length === 0 && <p className="mobilesheet__none">No project open.</p>}
        </div>
        {/*
         * Pinned, for the reason the project pane's foot is: a readout you have
         * to scroll a list of worktrees to reach is one you stop reading.
         */}
        {usage !== null && (
          <div className="mobilesheet__foot">
            <UsageBars usage={usage} />
          </div>
        )}
      </div>
    </>
  )
}

/** One worktree in the sheet: the same row the strip and the project pane draw. */
const Row = ({
  worktree,
  sessions,
  todos,
  activeId,
  onPick,
  onSleep,
}: {
  worktree: Worktree
  sessions: Session[]
  todos: WorktreeTodo[]
  activeId: string | null
  onPick: () => void
  onSleep: () => void
}): React.ReactElement => {
  const queued = queuedTodoCount(todos, worktree.id)
  return (
    <WorktreeTab
      worktree={worktree}
      status={worktreeStatus(sessions, worktree.id)}
      queued={queued}
      sleeping={false}
      active={worktree.id === activeId}
      title={worktreeTitle(worktree, sessions, queued, false)}
      onPick={onPick}
      onClose={{ title: `Put ${worktree.name} away`, run: onSleep }}
    />
  )
}
