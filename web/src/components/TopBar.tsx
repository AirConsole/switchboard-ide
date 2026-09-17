import { useEffect, useState } from 'react'
import type { Project, Session, Usage, Worktree, WorktreeTodo } from '@switchboard/shared'
import type { ProjectGroup } from '../App.js'
import { api } from '../api.js'
import { WorktreeTab, summaryClass, worktreeTitle } from './WorktreeTab.js'
import { UsageBars, useUsage } from './UsageBars.js'
import { MobileBar } from './MobileBar.js'
import { useNarrow } from './useNarrow.js'
import { projectKey } from '../views/Overview.js'
import {
  claudeSession,
  mostUrgentStatus,
  queuedTodoCount,
  stateLabel,
  worktreeStatus,
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
  /**
   * Put the keyboard back in the pane it came from.
   *
   * Only the phone's sheet uses it, and for the reason every dialog does: it is
   * the one thing here outside the row that takes focus away from it, so
   * closing it without going anywhere has to hand the keyboard back rather than
   * leave it on the document.
   */
  onRefocus: () => void
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

  const tab = (worktree: Worktree, sleeping: boolean): React.ReactElement => {
    const queued = queuedTodoCount(todos, worktree.id)
    return (
      <WorktreeTab
        key={worktree.id}
        worktree={worktree}
        status={worktreeStatus(sessions, worktree.id)}
        queued={queued}
        sleeping={sleeping}
        // Where you are. A sleeping worktree is nowhere, whatever the row was
        // last asked for -- it has no window to be in.
        active={!sleeping && worktree.id === activeId}
        title={worktreeTitle(worktree, sessions, queued, sleeping)}
        onPick={() => (sleeping ? onWake(worktree.id) : onReveal(worktree.id))}
        /* Already asleep, so there is nothing to put away and no × to do it
           with. Waking it is what its body is for. */
        onClose={
          sleeping ? undefined : { title: `Put ${worktree.name} away`, run: () => onSleep(worktree.id) }
        }
      />
    )
  }
  const asleepSignal = summaryClass(asleepStatus)

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
        title={`${project.host.kind === 'remote' ? `on ${hostLabel(project.host)}\n` : ''}${project.root}\n${
          asleep.length === 0 ? 'Nothing asleep' : `${asleep.length} asleep`
        }\nClick for this project's worktrees, a new one, and closing it`}
      >
        {/*
          * Which machine, and only when it is not this one.
          *
          * Linking a machine brings everything open on it, so two projects with
          * the same name is the normal case rather than a collision -- the same
          * checkout on two machines is what these ids are namespaced to tell
          * apart in the first place. Without this the strip read "one two one
          * two" and the only way to tell which was which was to hover for the
          * path, in the one part of the interface you are meant to be able to
          * scan.
          *
          * Ahead of the name and dimmer, the way a path segment sits before
          * what it qualifies: the project is still the thing you are looking
          * for, and the machine is where it happens to be.
          */}
        {project.host.kind === 'remote' && (
          <span className="tabgroup__host">{hostLabel(project.host)}</span>
        )}
        <span className="tabgroup__name">{project.name}</span>
        {/* That there is something behind this project you cannot see. The
            count sat here for a day and was noise: how many is a thing you find
            out by looking, and the pane is one click away. */}
        {asleep.length > 0 && <span className="tabgroup__zz">zZ</span>}
      </button>

      {awake.map((worktree) => tab(worktree, false))}
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
/**
 * What to call the machine a project is on.
 *
 * Its own name where it gave one -- the same word the machine picker shows, so
 * the two halves of the interface do not name it differently -- and its host
 * otherwise, which is the next most recognisable thing about it.
 */
const hostLabel = (host: { baseUrl: string; name?: string }): string => {
  if (host.name !== undefined && host.name !== '') return host.name
  try {
    return new URL(host.baseUrl).hostname
  } catch {
    return host.baseUrl
  }
}

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
  onRefocus,
}: TopBarProps): React.ReactElement => {
  const usage = useUsage()
  const narrow = useNarrow()
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
  /*
   * A phone gets the same bar's worth of information behind one button.
   *
   * Branching here rather than in `App` so that `useUsage` stays mounted across
   * the switch: it is called above this line, and swapping two sibling
   * components would unmount it on every rotation, drop the reading it is
   * holding, and ask again -- and a request that lands outside the server's
   * five-minute cache runs `claude -p /usage` for a turn of the phone.
   */
  if (narrow) {
    return (
      <MobileBar
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
        onRefocus={onRefocus}
      />
    )
  }
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
