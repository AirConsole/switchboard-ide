import { useLayoutEffect, useRef, useState } from 'react'
import type { Project, Session, Worktree, WorktreeTodo } from '@switchboard/shared'
import type { ProjectGroup } from '../App.js'
import { WorktreeTab, summaryClass, worktreeTitle } from './WorktreeTab.js'
import { UsageBars, useUsage } from './UsageBars.js'
import { LinkIcon } from './LinkIcon.js'
import { MACHINE_KEY, projectKey } from '../views/Overview.js'
import { PanelIcon } from './PanelIcon.js'
import { useStore } from '../store.js'
import {
  queuedTodoCount,
  worktreeStatus,
  type WorktreeStatus,
} from '../selectors.js'

/**
 * The last rung of the ladder -- see the sweep in `TopBar`.
 *
 * 0 the bar as it is, 1 without the usage tracks, 2 without the `Open project`
 * label, 3 with every project but the current one collapsed to its head, 4 with
 * all of them collapsed, 5 without the usage readout at all. Past it the strip
 * scrolls, which is what it has always done and the honest end of the ladder.
 */
const LAST_STAGE = 5

/**
 * Is this the project you are in?
 *
 * Either one of its worktrees has the row, or its own pane does -- `activeId`
 * carries both, and a project whose *pane* you are looking at is as much where
 * you are as one whose terminal you are typing in. It decides which project
 * keeps its tabs at rung 3, and which head lights up once the tabs are gone.
 */
const isCurrent = (group: ProjectGroup, activeId: string | null): boolean =>
  activeId !== null &&
  (activeId === projectKey(group.project.id) || group.awake.some((w) => w.id === activeId))

export interface TopBarProps {
  /** Every open project, in the order they were opened. */
  groups: ProjectGroup[]
  sessions: Session[]
  /** Every todo, so a tab can say how much is queued behind it. */
  todos: WorktreeTodo[]
  onOpenProject: () => void
  /** Walk to this project's own pane in the row. */
  onRevealProject: (project: Project) => void
  /** Go to the machine's own terminal, the window at the end of the row. */
  onRevealMachine: () => void
  onWake: (worktreeId: string) => void
  /** Bring an awake worktree's window into view. */
  onReveal: (worktreeId: string) => void
  /**
   * Put a worktree away: the tab's × asks this, and the dialog behind it is
   * where sleeping and deleting are told apart.
   */
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
 * A new worktree: a bare plus, where the open-project glyph is a plus in a
 * square. Same stroke, same box -- the square is what says "a project", and
 * this one adds to a project that is already here.
 */
const NewWorktreeIcon = (): React.ReactElement => (
  <svg
    className="topbar__icon"
    viewBox="0 0 16 16"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
)

/**
 * Sign out: a door with the way out drawn through its open side.
 *
 * The convention every web application uses for this, which is the whole
 * argument for it -- an icon with no label has to be one the reader has already
 * learnt somewhere else. Same 16 box, same hairline stroke and `currentColor` as
 * the two above, so the three controls in the chrome read as one set.
 */
const SignOutIcon = (): React.ReactElement => (
  <svg
    className="topbar__icon"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9.4 2.6H4.2a1.6 1.6 0 0 0-1.6 1.6v7.6a1.6 1.6 0 0 0 1.6 1.6h5.2" />
    <path d="M11.2 5.4 13.8 8l-2.6 2.6M13.4 8H6.6" />
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
  current,
  onRevealProject,
  onWake,
  onReveal,
}: {
  group: ProjectGroup
  sessions: Session[]
  todos: WorktreeTodo[]
  /** Holds the row or its own pane -- see `isCurrent`. */
  current: boolean
} & Pick<
  TopBarProps,
  'activeId' | 'onRevealProject' | 'onWake' | 'onReveal'
>): React.ReactElement => {
  const { project, awake, asleep } = group
  /*
   * What the head's state bar says, and only two states can say anything.
   *
   * It stands for the worktrees with no tab of their own. Expanded that is the
   * sleeping ones -- sleeping does not mean stopped, Claude can be left
   * running, so one of them being blocked on you still has to reach the top
   * bar. Collapsed it is all of them, which is the same sentence with a wider
   * subject: the awake ones have no tab either once the bar has taken them.
   *
   * Both are computed every render and both are on the pill, because which one
   * is showing is a CSS question -- the rung is written on the header, and
   * nothing React renders may depend on it.
   */
  const statusOf = (w: Worktree): WorktreeStatus => worktreeStatus(sessions, w.id)
  const shutSignal = summaryClass([...asleep, ...awake].map(statusOf))
  const openSignal = summaryClass(asleep.map(statusOf))

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
        /*
         * No × up here any more: it is in the window's own bar, at the end of
         * the panel toggles.
         *
         * A tab in the strip is an index entry -- it says which worktree, and
         * what its agent is doing -- and putting the one destructive door in
         * the row onto a 62px target beside the name you are aiming for was a
         * mis-click waiting to happen. The same reasoning put sleeping on the
         * tab in the first place, when the alternative was a trashcan *and* a
         * zZ in the window's bar; the bar has since given both of those up, so
         * there is one control to put back rather than two.
         */
      />
    )
  }

  return (
    <div className={current ? 'tabgroup tabgroup--current' : 'tabgroup'}>
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
          openSignal,
          shutSignal === '' ? '' : `${shutSignal}-shut`,
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onRevealProject(project)}
        /* True at every rung, because the tabs that used to say it are the
           first thing the bar gives up -- and a title that described only the
           expanded bar would be a lie exactly when it was the only thing left
           to read. */
        title={`${project.host.kind === 'remote' ? `on ${hostLabel(project.host)}\n` : ''}${project.root}\n${
          awake.length === 0 ? 'Nothing awake' : `${awake.length} awake: ${awake.map((w) => w.name).join(', ')}`
        }${asleep.length === 0 ? '' : `, ${asleep.length} asleep`}\nClick for this project's worktrees, a new one, and closing it`}
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
          * A link glyph rather than the machine's name: "not this machine" is
          * what has to be scannable, and it says that in 12px where the name
          * took up to 96. Which machine is in the title above and in the
          * glyph's accessible name. See `LinkIcon`.
          */}
        {project.host.kind === 'remote' && <LinkIcon machine={hostLabel(project.host)} />}
        <span className="tabgroup__name">{project.name}</span>
        {/*
          * How many windows this head is standing in for, once the bar has
          * taken their tabs. Always rendered and hidden by CSS until then,
          * because the sweep that picks the rung measures the markup it is
          * about to show.
          *
          * Only when there is something awake, and that is not cosmetic: a
          * project with nothing awake has no tab to give up, so a count on it
          * would make the bar *wider* as it collapsed -- and every rung getting
          * narrower is the whole reason the sweep can stop at the first one
          * that fits.
          */}
        {awake.length > 0 && <span className="tabgroup__count">{awake.length}</span>}
      </button>

      {/*
        * A new worktree, as the segment after the name.
        *
        * It goes to the same place the name does -- the project's pane, where
        * arriving puts the caret in the branch box -- and that is the point:
        * the pane is where a worktree is made, and this is the door to it that
        * says so, rather than one you have to know the name leads to.
        *
        * Only where the project's tabs are showing. It is a segment of the
        * expanded slab, and a collapsed head is a summary: a + beside a pill
        * standing for four windows would be a control on a thing that is no
        * longer drawn. So it is hidden at exactly the rungs the tabs are (see
        * `data-stage` in the stylesheet), which also keeps every rung narrower
        * than the last -- the property the sweep stops on. And not rendered at
        * all with nothing awake, since then there are no tabs to show; that is
        * a count, not a rung, so it is React's to decide.
        */}
      {awake.length > 0 && (
        <button
          className="tabgroup__add"
          onClick={() => onRevealProject(project)}
          title={`New worktree in ${project.name}`}
          aria-label={`New worktree in ${project.name}`}
        >
          <NewWorktreeIcon />
        </button>
      )}

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
  onRevealMachine,
  onWake,
  onReveal,
}: TopBarProps): React.ReactElement => {
  const usage = useUsage()
  const signOut = useStore((state) => state.signOut)
  const bar = useRef<HTMLElement | null>(null)
  const strip = useRef<HTMLElement | null>(null)
  /*
   * How much a tab may say, from how many there are.
   *
   * Chrome shrinks its tabs and drops what stops fitting; the widths here come
   * from the names, so what a tab can afford to say comes from the count. Four
   * steps, and the last one still keeps the name, the bullet and the ×.
   *
   * Count-driven and deliberately *not* part of the ladder below: "a tab may
   * not be 200px when there are thirteen of them" is true on a 2560px monitor
   * where the ladder never fires, and it has to shave labels before the ladder
   * starts dropping whole regions.
   */
  const tabCount = groups.reduce(
    (total, group) => total + group.awake.length + (group.asleep.length > 0 ? 1 : 0),
    0,
  )
  const tight = tabCount > 12 ? 3 : tabCount > 9 ? 2 : tabCount > 6 ? 1 : 0

  /*
   * The bar gives things up in order, as it runs out of room.
   *
   * `data-stage` on the header is the rung, and every rung is a CSS
   * consequence of it: 1 drops the usage tracks, 2 the `Open project` label, 3
   * the tabs of every project but the one you are in, 4 the rest of them, 5 the
   * usage readout altogether. The strip is what runs out -- it is `flex: 1;
   * min-width: 0`, so it takes whatever the other two leave -- and it says so
   * by `scrollWidth > clientWidth`.
   *
   * **Why a sweep and not state.** Each rung either hands the strip more room
   * or takes content out of it, so `fits` is monotone in the rung and "start at
   * 0, descend to the first that fits" returns the least sufficient one. Held
   * in React state it would need a signature of every width-affecting thing --
   * names, counts, the dirty mark, which project is current, whether usage has
   * landed -- and one missed term is a bar that stays collapsed after it has
   * room again. Worse, it would unmount and remount every hidden tab on each
   * pass: no paint happens between them, but a node that leaves the DOM between
   * mousedown and mouseup produces no click, and a focused one hands focus to
   * the document.
   *
   * So the rung is written on the DOM, once, inside one synchronous block --
   * and **nothing React renders may depend on it**. The count, the tabs and the
   * usage rows are always in the markup; CSS is what hides them. Otherwise a
   * pass would measure rung n against the text of rung n-1.
   *
   * No dependency array, so it runs after every commit -- which is exactly the
   * set of things that can change a width. A layout effect, so the answer is
   * settled before the browser paints and no one sees the full bar flash.
   * Idempotent, because it starts from 0 every time, which is what makes
   * StrictMode's double invocation a non-event.
   */
  /*
   * Walk down the rungs until the strip fits, from the top every time.
   *
   * The header is measured too, not only the strip: squeezed hard enough --
   * `Open project` and the usage bars are 314px between them -- the strip is
   * given a clientWidth of 0 and stops being able to report an overflow at all,
   * while the header's own flex line is the thing that has overrun.
   */
  const settle = (): void => {
    const header = bar.current
    const nav = strip.current
    if (!header || !nav) return
    const over = (): boolean =>
      nav.scrollWidth > nav.clientWidth + 1 || header.scrollWidth > header.clientWidth + 1
    let stage = 0
    header.dataset.stage = '0'
    while (stage < LAST_STAGE && over()) header.dataset.stage = String(++stage)
  }

  // Every commit, because a commit is the only way a width in here changes:
  // a name, a count, the dirty mark, which project is current, usage landing.
  useLayoutEffect(settle)

  /*
   * And every resize -- of the header, not the strip.
   *
   * The header's width is the app's, since `.app` is a two-row grid of one
   * column, so it never moves in answer to a rung. The strip's does: dropping
   * the usage bars widens it by 189px, so an observer on it would fire on the
   * consequence of its own callback and earn a "ResizeObserver loop completed
   * with undelivered notifications", which drops the rest of that frame's
   * notifications on the floor.
   */
  useLayoutEffect(() => {
    const header = bar.current
    if (!header) return
    const observer = new ResizeObserver(settle)
    observer.observe(header)
    return () => observer.disconnect()
    // `settle` reads refs and writes the DOM; it closes over nothing that
    // changes, so re-subscribing on every render would only churn the observer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
  /* `data-stage` is written by the sweep above and never from here: React diffs
     against its own last props, so a render with an unchanged prop would not
     put back what the effect wrote, and the two would drift apart. */
  <header className="topbar" ref={bar}>
    <button className="topbar__open" onClick={onOpenProject} title="Open another project">
      <OpenProjectIcon />
      <span className="topbar__label">Open project</span>
    </button>
    <nav className="tabstrip" data-tight={tight} ref={strip}>
      {groups.map((group) => (
        <Group
          key={group.project.id}
          group={group}
          sessions={sessions}
          todos={todos}
          activeId={activeId}
          current={isCurrent(group, activeId)}
          onRevealProject={onRevealProject}
          onWake={onWake}
          onReveal={onReveal}
        />
      ))}
    </nav>
    {usage !== null && <UsageBars usage={usage} />}
    {/*
      * The way out, in the opposite corner from the way in.
      *
      * It was in the open-project dialog, tucked into the foot away from that
      * dialog's own answers, on the argument that the bar's width is budgeted
      * to the pixel -- but the price of that was a door you had to already know
      * was behind another door. A 36px icon is affordable at every rung, and
      * this is the one control in the interface that is about the browser
      * rather than about any worktree, so it takes the far corner and the bar
      * never gives it up: the last rung of the ladder is what the machine looks
      * like when it is busiest, which is no time to lose the lock.
      *
      * No label, and none is missing: `title` and the accessible name say the
      * words, and the glyph is the one every web application uses. Its own
      * hairline on the left, the mirror of `Open project`'s on the right.
      */}
    {/*
      * The machine itself, beside the way out and for the same reason: it is
      * about the box rather than about any worktree, and this corner is the one
      * the ladder never takes anything from. It lights while you are in that
      * window, which is also the only mark the strip can make then -- no
      * project is current when the window you are in belongs to none.
      */}
    <button
      className={
        activeId === MACHINE_KEY ? 'topbar__signout topbar__machine--on' : 'topbar__signout'
      }
      onClick={onRevealMachine}
      title="A terminal on this machine"
      aria-label="A terminal on this machine"
    >
      <PanelIcon panel="terminals" className="topbar__icon" />
    </button>
    <button
      className="topbar__signout"
      onClick={() => void signOut()}
      title="Sign out of this browser"
      aria-label="Sign out"
    >
      <SignOutIcon />
    </button>
  </header>
  )
}
