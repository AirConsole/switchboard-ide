import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { bindSocketToStore, useStore } from './store.js'
import { TopBar } from './components/TopBar.js'
import { NewWorktreeDialog } from './components/NewWorktreeDialog.js'
import { OpenProjectDialog } from './components/OpenProjectDialog.js'
import { RemoveWorktreeDialog } from './components/RemoveWorktreeDialog.js'
import { Overview } from './views/Overview.js'
import { SleepWorktreeDialog, type SleepOptions } from './components/SleepWorktreeDialog.js'
import { claudeSession, orderWorktrees, terminalSessions } from './selectors.js'
import type { PanelName, Project, Worktree } from '@ide-n-dream/shared'

/** A project and its worktrees, split into the awake ones and the sleeping. */
export interface ProjectGroup {
  project: Project
  awake: Worktree[]
  asleep: Worktree[]
}

export const App = (): React.ReactElement => {
  const { projects, worktrees, sessions, ui, loaded, error, refresh, setUi, setError } = useStore()

  const [showOpenProject, setShowOpenProject] = useState(false)
  const [addingTo, setAddingTo] = useState<Project | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [sleeping, setSleeping] = useState<string | null>(null)
  /**
   * A request to bring a worktree's tile into view.
   *
   * Carries a counter, because asking twice for the same worktree has to be two
   * requests: opening a second panel on a tile you already scrolled to changes
   * its width again, and a bare id would compare equal and scroll nowhere.
   *
   * Deliberately not persisted -- it is a consequence of the click you just
   * made, not a fact about the layout. Restoring one on load would scroll you
   * somewhere for a reason that no longer exists.
   *
   * It names a worktree and nothing about where to put it: the row moves as
   * far as it takes to show the whole of that one, and no further. Every way
   * of asking -- a tab, a step, waking, opening a panel -- means the same
   * thing by it.
   */
  const [scrollTo, setScrollTo] = useState<{ id: string; nonce: number } | null>(null)
  const reveal = (id: string): void =>
    setScrollTo((previous) => ({ id, nonce: (previous?.nonce ?? 0) + 1 }))

  useEffect(() => {
    bindSocketToStore()
    void refresh()
  }, [refresh])

  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err))

  /**
   * Which worktrees are awake.
   *
   * Null in stored state means a first run, not "none awake", so it seeds from
   * what is actually running: a worktree with live sessions is awake. That makes
   * the arrival of sleep invisible on a machine already mid-work, and means the
   * IDE dropped on a repository with twenty worktrees and nothing running starts
   * with all twenty asleep.
   */
  const awake = useMemo(() => {
    if (ui.awake !== null) return new Set(ui.awake)
    return new Set(
      worktrees.filter((w) => sessions.some((s) => s.worktreeId === w.id)).map((w) => w.id),
    )
  }, [ui.awake, worktrees, sessions])

  /**
   * Projects in the order they were opened, each split into awake and asleep.
   *
   * Every registered project is open -- there is no active one -- so the top
   * bar shows them all and the row shows every awake worktree across them.
   */
  const groups = useMemo<ProjectGroup[]>(
    () =>
      projects.map((project) => {
        const mine = orderWorktrees(worktrees.filter((w) => w.projectId === project.id))
        return {
          project,
          awake: mine.filter((w) => awake.has(w.id)),
          asleep: mine.filter((w) => !awake.has(w.id)),
        }
      }),
    [projects, worktrees, awake],
  )

  /** Every awake worktree, in the order the row shows them. */
  const rowWorktrees = useMemo(() => groups.flatMap((group) => group.awake), [groups])

  const setAwake = (ids: Iterable<string>): void => setUi({ awake: [...ids] })

  /*
   * On arrival, the first worktree is the active one and its Claude has the
   * keyboard.
   *
   * Once, and only once there is something to point at -- the first render
   * happens before the snapshot lands. After that the active worktree is
   * whatever you last navigated to, and this must not keep dragging it back.
   */
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    const first = rowWorktrees[0]
    if (first === undefined) return
    started.current = true
    reveal(first.id)
    // `reveal` is rebuilt every render and this fires once, so it is not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowWorktrees])

  /**
   * Wake a worktree: bring back its tile and its agent.
   *
   * The server does the part a client cannot -- resuming the conversation that
   * was stopped rather than starting a blank one -- and we scroll to it, since
   * with several worktrees awake it may well arrive off the side of the row.
   */
  const wake = (worktreeId: string): void => {
    setAwake([...awake, worktreeId])
    reveal(worktreeId)
    void api.wakeWorktree(worktreeId).then(refresh).catch(fail)
  }

  /**
   * Sleep a worktree: give back its space and, unless told otherwise, its
   * processes.
   */
  const sleep = (worktreeId: string, keep: SleepOptions): void => {
    setSleeping(null)
    setAwake([...awake].filter((id) => id !== worktreeId))
    void api.sleepWorktree(worktreeId, keep).then(refresh).catch(fail)
  }

  const startClaude = (worktreeId: string): void => {
    const existing = claudeSession(sessions, worktreeId)
    // A worktree has one Claude session. If it exited, revive that one in place
    // -- respawning keeps its tmux session and history -- rather than leaving a
    // dead session behind and stacking a second one beside it.
    if (existing && existing.liveness !== 'dead') return
    // Through wake either way, so a restart continues the conversation for the
    // same reason waking does.
    void api.wakeWorktree(worktreeId).then(refresh).catch(fail)
  }

  const newTerminal = (worktreeId: string): void => {
    // The wire calls it a shell -- the pane runs $SHELL -- while the interface
    // calls it a terminal.
    void api
      .createSession({ worktreeId, kind: 'shell' })
      .then((session) => {
        setUi({
          activeTerminalByWorktree: {
            ...ui.activeTerminalByWorktree,
            [worktreeId]: session.id,
          },
        })
        return refresh()
      })
      .catch(fail)
  }

  /**
   * A panel is another column of its worktree's tile, remembered per worktree.
   *
   * Nothing is displaced to make room any more: the tile simply gets wider and
   * the row gets longer. Opening one scrolls to it, which is what makes it
   * visible on a window too narrow to hold the tile whole.
   */
  const togglePanel = (worktreeId: string, panel: PanelName): void => {
    const open = ui.panels[worktreeId] ?? []
    const wasOpen = open.includes(panel)
    setUi({
      panels: {
        // Appended, so the list stays in the order panels were opened -- which
        // is how a tile with room for one pane knows which to show.
        ...ui.panels,
        [worktreeId]: wasOpen ? open.filter((name) => name !== panel) : [...open, panel],
      },
    })
    // The tile just changed width, so bring the whole of it back into view.
    reveal(worktreeId)
    // The panel is only useful with something in it.
    if (panel === 'terminals' && !wasOpen && terminalSessions(sessions, worktreeId).length === 0) {
      newTerminal(worktreeId)
    }
  }

  /**
   * Close panels the layout could not keep.
   *
   * The layout is the only thing that knows what fits, so it says so and the
   * state follows -- a panel with nowhere to go is closed rather than left open
   * with nothing to show, which is what keeps its toggle honest.
   */
  const collapsePanels = useCallback(
    (collapsed: { worktreeId: string; panel: PanelName }[]): void => {
      const next = { ...ui.panels }
      for (const { worktreeId, panel } of collapsed) {
        next[worktreeId] = (next[worktreeId] ?? []).filter((name) => name !== panel)
      }
      setUi({ panels: next })
    },
    // Stable between panel changes, so the layout's report does not re-fire on
    // every unrelated render.
    [ui.panels, setUi],
  )

  if (!loaded) {
    return (
      <div className="empty">
        <p className="empty__body">Loading…</p>
      </div>
    )
  }

  const topBar = (
    <TopBar
      groups={groups}
      sessions={sessions}
      onOpenProject={() => setShowOpenProject(true)}
      onCloseProject={(id) => void api.closeProject(id).then(refresh).catch(fail)}
      onNewWorktree={setAddingTo}
      onWake={wake}
      onReveal={reveal}
    />
  )

  const dialogs = (
    <>
      {showOpenProject && (
        <OpenProjectDialog
          onClose={() => setShowOpenProject(false)}
          onOpened={() => {
            setShowOpenProject(false)
            void refresh()
          }}
        />
      )}
      {addingTo && (
        <NewWorktreeDialog
          project={addingTo}
          onClose={() => setAddingTo(null)}
          onCreated={(worktreeId) => {
            setAddingTo(null)
            // A worktree you just made is one you want to work in, so it starts
            // awake -- and it is scrolled to, since the row may be long.
            setAwake([...awake, worktreeId])
            reveal(worktreeId)
            void refresh()
          }}
        />
      )}
      {sleeping && worktrees.some((w) => w.id === sleeping) && (
        <SleepWorktreeDialog
          worktree={worktrees.find((w) => w.id === sleeping)!}
          sessions={sessions}
          onClose={() => setSleeping(null)}
          onSleep={(keep) => sleep(sleeping, keep)}
        />
      )}
      {removing && worktrees.some((w) => w.id === removing) && (
        <RemoveWorktreeDialog
          worktree={worktrees.find((w) => w.id === removing)!}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            // A removed worktree leaves nothing of itself behind.
            const panels = { ...ui.panels }
            delete panels[removing]
            setUi({ awake: [...awake].filter((id) => id !== removing), panels })
            setRemoving(null)
            void refresh()
          }}
        />
      )}
    </>
  )

  if (projects.length === 0) {
    return (
      <div className="app">
        {topBar}
        <div className="empty">
          <h1 className="empty__title">No project open</h1>
          <p className="empty__body">
            Choose a git repository. Every branch you work on becomes a worktree with Claude running
            in it, and they all keep running whether or not this page is open.
          </p>
          <button className="btn" onClick={() => setShowOpenProject(true)}>
            Open project
          </button>
        </div>
        {dialogs}
      </div>
    )
  }

  return (
    <div className="app">
      {topBar}

      {error && (
        <div className="banner">
          {error}
          <button className="banner__dismiss" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <Overview
        worktrees={rowWorktrees}
        projects={projects}
        sessions={sessions}
        panels={ui.panels}
        activeTerminalByWorktree={ui.activeTerminalByWorktree}
        // With one project open there is no question which project a new
        // worktree belongs to; with several there is, and the top bar's
        // per-project + is the unambiguous way to say it.
        addTo={projects.length === 1 ? (projects[0] ?? null) : null}
        scrollTo={scrollTo}
        onStart={startClaude}
        onSleep={setSleeping}
        onReveal={reveal}
        onRemoveWorktree={setRemoving}
        onTogglePanel={togglePanel}
        onCollapsePanels={collapsePanels}
        onNewWorktree={() => setAddingTo(projects[0] ?? null)}
        onSelectTerminal={(worktreeId, sessionId) =>
          setUi({
            activeTerminalByWorktree: {
              ...ui.activeTerminalByWorktree,
              [worktreeId]: sessionId,
            },
          })
        }
        onNewTerminal={newTerminal}
        onCloseTerminal={(sessionId) => void api.killSession(sessionId).then(refresh).catch(fail)}
      />

      {dialogs}
    </div>
  )
}
