import { useEffect, useMemo, useState } from 'react'
import { api } from './api.js'
import { bindSocketToStore, useStore } from './store.js'
import { TopBar } from './components/TopBar.js'
import { NewWorktreeDialog } from './components/NewWorktreeDialog.js'
import { OpenProjectDialog } from './components/OpenProjectDialog.js'
import { RemoveWorktreeDialog } from './components/RemoveWorktreeDialog.js'
import { Overview, paneKey } from './views/Overview.js'
import { claudeSession, orderWorktrees, terminalSessions } from './selectors.js'
import type { PanelName } from '@ide-n-dream/shared'

export const App = (): React.ReactElement => {
  const { projects, worktrees, sessions, ui, loaded, error, refresh, setUi, setError } = useStore()

  const [showOpenProject, setShowOpenProject] = useState(false)
  const [showNewWorktree, setShowNewWorktree] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  /**
   * Worktrees with a tile actually on screen, reported by the overview.
   *
   * Not persisted and not derived from `minimized`: whether a tile fits depends
   * on the window, so only the thing doing the layout can say.
   */
  const [shown, setShown] = useState<string[]>([])

  useEffect(() => {
    bindSocketToStore()
    void refresh()
  }, [refresh])

  const project = projects.find((p) => p.id === ui.activeProjectId) ?? projects[0]
  const projectWorktrees = useMemo(
    () => orderWorktrees(worktrees.filter((w) => w.projectId === project?.id), ui.tabOrder),
    [worktrees, project?.id, ui.tabOrder],
  )

  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err))

  const startClaude = (worktreeId: string): void => {
    const existing = claudeSession(sessions, worktreeId)
    // A worktree has one Claude session. If it exited, revive that one in place
    // -- respawning keeps its tmux session and history -- rather than leaving a
    // dead session behind and stacking a second one beside it.
    if (existing && existing.liveness !== 'dead') return
    const request = existing
      ? api.respawnSession(existing.id)
      : api.createSession({ worktreeId, kind: 'claude' })
    void request.then(() => refresh()).catch(fail)
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
   * A chip toggles whether its worktree is on screen.
   *
   * Keyed on what is actually visible, not on `minimized`, because a tile can
   * be absent for either reason. Bringing one back also marks it newest, which
   * brings back the panels it had open too: the layout protects the newest pane
   * and the rest of its tile, so a two-column worktree returns as two columns.
   */
  const toggleMinimized = (worktreeId: string): void => {
    if (shown.includes(worktreeId)) {
      setUi({ minimized: [...ui.minimized.filter((id) => id !== worktreeId), worktreeId] })
      return
    }
    setUi({
      minimized: ui.minimized.filter((id) => id !== worktreeId),
      newestPane: paneKey(worktreeId, 'claude'),
    })
  }

  /**
   * A panel is another column of its worktree's tile, opened and closed per
   * worktree and remembered there.
   *
   * Nothing else is minimized to make room, and nothing is restored on the way
   * out: the layout already pushes panes out from the right and brings them
   * straight back, so opening a panel on a normal window displaces the
   * worktrees to the right of it and closing it returns them. That makes this a
   * reversible detour without a scrap of saved layout to get out of step.
   */
  const togglePanel = (worktreeId: string, panel: PanelName): void => {
    const open = ui.panels[worktreeId] ?? []
    const wasOpen = open.includes(panel)
    setUi({
      panels: {
        ...ui.panels,
        [worktreeId]: wasOpen ? open.filter((name) => name !== panel) : [...open, panel],
      },
      // What you just asked for is what survives a window too narrow for both:
      // opening a panel displaces the Claude pane rather than never appearing,
      // and closing it hands the protection back to Claude.
      newestPane: paneKey(worktreeId, wasOpen ? 'claude' : panel),
    })
    // The panel is only useful with something in it.
    if (panel === 'terminals' && !wasOpen && terminalSessions(sessions, worktreeId).length === 0) {
      newTerminal(worktreeId)
    }
  }

  if (!loaded) {
    return (
      <div className="empty">
        <p className="empty__body">Loading…</p>
      </div>
    )
  }

  const topBar = (
    <TopBar
      project={project}
      worktrees={project ? projectWorktrees : []}
      sessions={sessions}
      shown={shown}
      onOpenProject={() => setShowOpenProject(true)}
      onNewWorktree={() => setShowNewWorktree(true)}
      onToggleMinimized={toggleMinimized}
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
      {showNewWorktree && project && (
        <NewWorktreeDialog
          project={project}
          onClose={() => setShowNewWorktree(false)}
          onCreated={(worktreeId) => {
            setShowNewWorktree(false)
            // A worktree you just created is the one you want to see.
            setUi({ newestPane: paneKey(worktreeId, 'claude') })
            void refresh()
          }}
        />
      )}
      {removing && worktrees.some((w) => w.id === removing) && (
        <RemoveWorktreeDialog
          worktree={worktrees.find((w) => w.id === removing)!}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            // A removed worktree leaves nothing of itself behind in the layout.
            const panels = { ...ui.panels }
            delete panels[removing]
            setUi({ minimized: ui.minimized.filter((id) => id !== removing), panels })
            setRemoving(null)
            void refresh()
          }}
        />
      )}
    </>
  )

  if (!project) {
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
        worktrees={projectWorktrees}
        sessions={sessions}
        minimized={ui.minimized}
        panels={ui.panels}
        newestPane={ui.newestPane}
        activeTerminalByWorktree={ui.activeTerminalByWorktree}
        onStart={startClaude}
        onMinimize={toggleMinimized}
        onRemoveWorktree={setRemoving}
        onTogglePanel={togglePanel}
        onNewWorktree={() => setShowNewWorktree(true)}
        onSelectTerminal={(worktreeId, sessionId) =>
          setUi({
            activeTerminalByWorktree: {
              ...ui.activeTerminalByWorktree,
              [worktreeId]: sessionId,
            },
          })
        }
        onVisibleWorktrees={setShown}
        onNewTerminal={newTerminal}
        onCloseTerminal={(sessionId) => void api.killSession(sessionId).then(refresh).catch(fail)}
      />

      {dialogs}
    </div>
  )
}
