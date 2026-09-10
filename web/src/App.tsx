import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { bindSocketToStore, useStore } from './store.js'
import { TopBar } from './components/TopBar.js'
import { NewWorktreeDialog } from './components/NewWorktreeDialog.js'
import { OpenProjectDialog } from './components/OpenProjectDialog.js'
import { CloseProjectDialog } from './components/CloseProjectDialog.js'
import { RemoveWorktreeDialog } from './components/RemoveWorktreeDialog.js'
import { Overview, type PaneKind } from './views/Overview.js'
import { ancestorsOf } from './views/FilesPane.js'
import { SleepWorktreeDialog, type SleepOptions } from './components/SleepWorktreeDialog.js'
import { claudeSession, orderWorktrees, terminalSessions } from './selectors.js'
import type { FilesMode, PanelName, Project, UiState, Worktree } from '@ide-n-dream/shared'

/** A project and its worktrees, split into the awake ones and the sleeping. */
export interface ProjectGroup {
  project: Project
  awake: Worktree[]
  asleep: Worktree[]
}

export const App = (): React.ReactElement => {
  const { projects, worktrees, sessions, todos, ui, loaded, error, refresh, setUi, setError } =
    useStore()

  const [showOpenProject, setShowOpenProject] = useState(false)
  const [addingTo, setAddingTo] = useState<Project | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [closingProject, setClosingProject] = useState<string | null>(null)
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
  const [scrollTo, setScrollTo] = useState<{
    id: string
    /** Which pane of it to hand the keyboard to. */
    pane: PaneKind
    nonce: number
  } | null>(null)
  /**
   * The worktree you are in.
   *
   * Not the same thing as the last scroll request, though navigating is one way
   * to arrive: clicking into a terminal, a tab strip or a panel puts you in
   * that worktree without asking the row to move, and the bar has to say so.
   * It is also what a Cmd+arrow step counts from, so stepping continues from
   * the window you clicked into rather than from the one you last navigated to.
   */
  /**
   * Where you are, to the pane.
   *
   * A Cmd+arrow step counts from here, and the walk now runs through panes as
   * well as worktrees -- so knowing the worktree is no longer enough to say
   * what the next stop is.
   */
  const [active, setActive] = useState<{ id: string; pane: PaneKind } | null>(null)
  /**
   * Focus moved; remember where, unless it is where we already were.
   *
   * The identity check is not a nicety. `activeId` was a string, so writing the
   * same one back was free -- an object is not, and this fires on every focus
   * move *within* a pane, of which there are many: clicking from a search box
   * to a result, tabbing along a tab strip. Without the guard each one
   * re-renders the whole row, and the row holds live terminals.
   */
  const activate = useCallback((id: string, pane: PaneKind): void => {
    setActive((previous) =>
      previous?.id === id && previous.pane === pane ? previous : { id, pane },
    )
  }, [])

  const reveal = (id: string, pane: PaneKind = 'claude'): void => {
    setActive({ id, pane })
    setScrollTo((previous) => ({ id, pane, nonce: (previous?.nonce ?? 0) + 1 }))
  }

  useEffect(() => {
    const unbind = bindSocketToStore()
    void refresh()
    return unbind
  }, [refresh])

  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err))

  /*
   * The current UI state, for callbacks that must keep one identity across
   * renders. `openPath` is handed to every tile in the row, and rebuilding it
   * on each render would restart the files hook's effects everywhere at once.
   */
  const uiRef = useRef(ui)
  uiRef.current = ui

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

  /*
   * Forget the per-worktree UI of worktrees that are gone.
   *
   * `onRemoved` clears `panels` for the one you removed, and nothing clears
   * anything for a worktree removed outside the IDE -- so the open file, the
   * expanded directories, the chosen terminal and the files mode accumulated
   * for every worktree that ever existed, and all of it is persisted to the
   * server and to localStorage on every change.
   *
   * Only once the snapshot has actually loaded: before that `worktrees` is
   * empty, and pruning against it would wipe the lot.
   */
  useEffect(() => {
    if (!loaded || worktrees.length === 0) return
    const known = new Set(worktrees.map((worktree) => worktree.id))
    const prune = <T,>(map: Record<string, T>): Record<string, T> | null => {
      const kept = Object.fromEntries(Object.entries(map).filter(([id]) => known.has(id)))
      return Object.keys(kept).length === Object.keys(map).length ? null : (kept as Record<string, T>)
    }
    const panels = prune(ui.panels)
    const active = prune(ui.activeTerminalByWorktree)
    const open = prune(ui.openPathByWorktree)
    const expanded = prune(ui.expandedByWorktree)
    const modes = prune(ui.filesModeByWorktree)
    const files = prune(ui.openFilesByWorktree)
    if (!panels && !active && !open && !expanded && !modes && !files) return
    setUi({
      ...(panels ? { panels } : {}),
      ...(active ? { activeTerminalByWorktree: active } : {}),
      ...(open ? { openPathByWorktree: open } : {}),
      ...(expanded ? { expandedByWorktree: expanded } : {}),
      ...(modes ? { filesModeByWorktree: modes } : {}),
      ...(files ? { openFilesByWorktree: files } : {}),
    })
  }, [loaded, worktrees, ui, setUi])

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
        // Read at write time, not from the render that started the request:
        // spawning a terminal takes a tmux round trip, and a selection made in
        // another window while it was in flight came back undone.
        setUi({
          activeTerminalByWorktree: {
            ...useStore.getState().ui.activeTerminalByWorktree,
            [worktreeId]: session.id,
          },
        })
        return refresh()
      })
      .catch(fail)
  }

  /**
   * Close a terminal, and the panel with it when that was the last one.
   *
   * The panel is the terminals, not a container for them: with none left there
   * is nothing for it to show, and a pane saying so is a pane you then have to
   * close by hand. So the tile narrows on the same click, and the keyboard goes
   * back to that worktree's Claude -- the terminal that had it is gone, and
   * `reveal` is what hands it over.
   *
   * Checked before the kill, while the session is still in the snapshot: one
   * left means this is it.
   */
  const closeTerminal = (worktreeId: string, sessionId: string): void => {
    if (terminalSessions(sessions, worktreeId).length <= 1) {
      setUi({
        panels: {
          ...ui.panels,
          [worktreeId]: (ui.panels[worktreeId] ?? []).filter((panel) => panel !== 'terminals'),
        },
      })
      reveal(worktreeId)
    }
    void api.killSession(sessionId).then(refresh).catch(fail)
  }

  /**
   * Show one of a worktree's panels, or close the one that is showing.
   *
   * One at a time: a worktree is Claude and at most one panel, so a tile is one
   * column or two and the whole of it fits a window that could only ever hold
   * part of it before. Opening replaces rather than appends, which is also what
   * makes the toggles a set of alternatives instead of a row of switches.
   */
  const togglePanel = (worktreeId: string, panel: PanelName): void => {
    const open = ui.panels[worktreeId] ?? []
    const wasOpen = open.includes(panel)
    setUi({ panels: { ...ui.panels, [worktreeId]: wasOpen ? [] : [panel] } })
    /*
     * The tile just changed width, so bring the whole of it back into view --
     * and hand the keyboard to what was just opened, which is the pane you
     * asked for and the one you are about to type into: the new-todo box, the
     * files panel's editor or its finder, the terminal. Closing gives it back
     * to Claude, because the pane that had it no longer exists.
     */
    reveal(worktreeId, wasOpen ? 'claude' : panel)
    // The panel is only useful with something in it.
    if (panel === 'terminals' && !wasOpen && terminalSessions(sessions, worktreeId).length === 0) {
      newTerminal(worktreeId)
    }
  }

  /**
   * A worktree's todo queue has emptied itself into Claude.
   *
   * The panel was open to line work up; with the queue drained it is a list
   * nobody asked to see, holding a spot in the row. Closed the way closing the
   * last terminal closes its panel -- but without `reveal`, because that click
   * is one you just made and this is a server typing a prompt into a window you
   * may not even be looking at. Dragging the row over to it would be the row
   * moving for something you did not do.
   */
  const queueDrained = useCallback(
    (worktreeId: string): void => {
      setUi({
        panels: {
          ...ui.panels,
          [worktreeId]: (ui.panels[worktreeId] ?? []).filter((panel) => panel !== 'todo'),
        },
      })
      /*
       * The panel is going, so the keyboard goes to that worktree's Claude --
       * which is exactly who the queue was just typed into, and where you would
       * be looking to see what it does with it. Written out rather than calling
       * `reveal`, whose identity changes every render and would defeat the
       * memoisation the drain effect depends on; both setters are stable.
       */
      setActive({ id: worktreeId, pane: 'claude' })
      setScrollTo((previous) => ({
        id: worktreeId,
        pane: 'claude',
        nonce: (previous?.nonce ?? 0) + 1,
      }))
    },
    [ui.panels, setUi],
  )

  /**
   * Open a file in a worktree's files panel.
   *
   * Opening also expands the directories above it, which is what makes a
   * restored file visible in the tree without the expansion having to be
   * derived from the path -- and leaves collapsing an ancestor working
   * normally, which a derived set would quietly undo.
   *
   * Stable between renders, because it is handed to every tile and a fresh
   * identity each render would re-run the files hook for every worktree.
   */
  const openPath = useCallback(
    (worktreeId: string, path: string): void => {
      const ui = uiRef.current
      const was = ui.expandedByWorktree[worktreeId] ?? []
      const opened = new Set([...was, ...ancestorsOf(path)])
      /*
       * In Files mode the file also joins the tabs above the editor, which is
       * what makes the pane exist at all. Only in Files mode: picking a changed
       * file in Changes opens its diff, and collecting diffs as tabs is not
       * what the list is for. It joins on the mode switch instead, below.
       */
      const tabs = ui.openFilesByWorktree[worktreeId] ?? []
      const keeps = (ui.filesModeByWorktree[worktreeId] ?? 'files') === 'files'
      const next = keeps && path !== '' && !tabs.includes(path) ? [...tabs, path] : tabs
      setUi({
        openPathByWorktree: { ...ui.openPathByWorktree, [worktreeId]: path },
        expandedByWorktree: { ...ui.expandedByWorktree, [worktreeId]: [...opened] },
        ...(next === tabs ? {} : { openFilesByWorktree: { ...ui.openFilesByWorktree, [worktreeId]: next } }),
      })
    },
    [setUi],
  )

  /**
   * Close one of a worktree's open files.
   *
   * The keyboard goes to the tab on the right, falling back to the left, which
   * is the rule every tab strip has; closing the last one empties the list and
   * takes the editor with it, leaving the panel as the tree alone.
   */
  const closeFile = useCallback(
    (worktreeId: string, path: string): void => {
      const ui = uiRef.current
      const tabs = ui.openFilesByWorktree[worktreeId] ?? []
      const at = tabs.indexOf(path)
      if (at === -1) return
      const next = tabs.filter((file) => file !== path)
      const patch: Partial<UiState> = {
        openFilesByWorktree: { ...ui.openFilesByWorktree, [worktreeId]: next },
      }
      if (ui.openPathByWorktree[worktreeId] === path) {
        const heir = next[at] ?? next[at - 1] ?? ''
        patch.openPathByWorktree = { ...ui.openPathByWorktree, [worktreeId]: heir }
      }
      setUi(patch)
    },
    [setUi],
  )

  /**
   * Which face a worktree's files panel shows.
   *
   * Stable between renders for the same reason `openPath` is: it is handed to
   * every tile in the row, and a fresh identity each render would restart the
   * panel's effects for every worktree at once.
   */
  const filesMode = useCallback(
    (worktreeId: string, mode: FilesMode): void => {
      const ui = uiRef.current
      const patch: Partial<UiState> = {
        filesModeByWorktree: { ...ui.filesModeByWorktree, [worktreeId]: mode },
      }
      /*
       * The one selection serves all three modes, so arriving in Files with a
       * file picked in Changes has to give that file a tab -- otherwise the
       * editor would have nothing to sit under and the panel would close on
       * the file you just asked to read.
       */
      const path = ui.openPathByWorktree[worktreeId] ?? ''
      const tabs = ui.openFilesByWorktree[worktreeId] ?? []
      if (mode === 'files' && path !== '' && !tabs.includes(path)) {
        patch.openFilesByWorktree = { ...ui.openFilesByWorktree, [worktreeId]: [...tabs, path] }
      }
      setUi(patch)
    },
    [setUi],
  )

  /** Expand or collapse one directory of a worktree's file tree. */
  const toggleDir = useCallback(
    (worktreeId: string, dir: string): void => {
      const ui = uiRef.current
      const was = ui.expandedByWorktree[worktreeId] ?? []
      const next = was.includes(dir) ? was.filter((d) => d !== dir) : [...was, dir]
      setUi({ expandedByWorktree: { ...ui.expandedByWorktree, [worktreeId]: next } })
    },
    [setUi],
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
      todos={todos}
      onOpenProject={() => setShowOpenProject(true)}
      onCloseProject={setClosingProject}
      onNewWorktree={setAddingTo}
      onWake={wake}
      onReveal={reveal}
      onSleep={setSleeping}
      activeId={active?.id ?? null}
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
      {closingProject && projects.some((p) => p.id === closingProject) && (
        <CloseProjectDialog
          project={projects.find((p) => p.id === closingProject)!}
          worktrees={worktrees.filter((w) => w.projectId === closingProject)}
          sessions={sessions}
          onCancel={() => setClosingProject(null)}
          onClose={(sleep) => {
            /*
             * Stopping everything means its worktrees are no longer awake, so
             * re-opening the project starts them asleep rather than claiming
             * agents that were killed. Leaving them running keeps the awake
             * set, which is what makes re-opening pick them up mid-flight.
             */
            if (sleep) {
              const mine = new Set(
                worktrees.filter((w) => w.projectId === closingProject).map((w) => w.id),
              )
              setAwake([...awake].filter((id) => !mine.has(id)))
            }
            setClosingProject(null)
            void api.closeProject(closingProject, { sleep }).then(refresh).catch(fail)
          }}
        />
      )}
      {sleeping && worktrees.some((w) => w.id === sleeping) && (
        <SleepWorktreeDialog
          worktree={worktrees.find((w) => w.id === sleeping)!}
          sessions={sessions}
          onClose={() => setSleeping(null)}
          onSleep={(keep) => sleep(sleeping, keep)}
          /*
           * Putting a worktree away and getting rid of it are the same
           * question asked with different force, so they are asked in the same
           * place: the trashcan that used to live in the window's own bar is
           * gone, and this hands over to the dialog that does the deleting.
           */
          onDelete={() => {
            setSleeping(null)
            setRemoving(sleeping)
          }}
        />
      )}
      {removing && worktrees.some((w) => w.id === removing) && (
        <RemoveWorktreeDialog
          worktree={worktrees.find((w) => w.id === removing)!}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            // A removed worktree leaves nothing of itself behind, "where you
            // are" included -- it would otherwise point at a window that is
            // not there, which is what a Cmd+arrow step would count from.
            const panels = { ...ui.panels }
            delete panels[removing]
            setUi({ awake: [...awake].filter((id) => id !== removing), panels })
            if (active?.id === removing) setActive(null)
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
        todos={todos}
        sessions={sessions}
        panels={ui.panels}
        activeTerminalByWorktree={ui.activeTerminalByWorktree}
        openPathByWorktree={ui.openPathByWorktree}
        openFilesByWorktree={ui.openFilesByWorktree}
        expandedByWorktree={ui.expandedByWorktree}
        filesModeByWorktree={ui.filesModeByWorktree}
        // With one project open there is no question which project a new
        // worktree belongs to; with several there is, and the top bar's
        // per-project + is the unambiguous way to say it.
        addTo={projects.length === 1 ? (projects[0] ?? null) : null}
        scrollTo={scrollTo}
        active={active}
        onActivate={activate}
        onStart={startClaude}
        onReveal={reveal}
        onTogglePanel={togglePanel}
        onQueueDrained={queueDrained}
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
        onOpenPath={openPath}
        onCloseFile={closeFile}
        onToggleDir={toggleDir}
        onFilesMode={filesMode}
        onCloseTerminal={closeTerminal}
      />

      {dialogs}
    </div>
  )
}
