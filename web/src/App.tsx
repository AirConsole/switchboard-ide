import { useEffect, useMemo, useState } from 'react'
import { api } from './api.js'
import { bindSocketToStore, useStore } from './store.js'
import { TopBar } from './components/TopBar.js'
import { NewWorktreeDialog } from './components/NewWorktreeDialog.js'
import { OpenProjectDialog } from './components/OpenProjectDialog.js'
import { RemoveWorktreeDialog } from './components/RemoveWorktreeDialog.js'
import { Overview } from './views/Overview.js'
import { claudeSession, orderWorktrees, shellSessions } from './selectors.js'

export const App = (): React.ReactElement => {
  const { projects, worktrees, sessions, ui, loaded, error, refresh, setUi, setError } = useStore()

  const [showOpenProject, setShowOpenProject] = useState(false)
  const [showNewWorktree, setShowNewWorktree] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

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

  const newShell = (worktreeId: string): void => {
    void api
      .createSession({ worktreeId, kind: 'shell' })
      .then((session) => {
        setUi({
          activeShellByWorktree: { ...ui.activeShellByWorktree, [worktreeId]: session.id },
        })
        return refresh()
      })
      .catch(fail)
  }

  const toggleMinimized = (worktreeId: string): void => {
    const wasMinimized = ui.minimized.includes(worktreeId)
    const minimized = wasMinimized
      ? ui.minimized.filter((id) => id !== worktreeId)
      : [...ui.minimized, worktreeId]
    // Minimizing the worktree whose shells are open closes them too: the tile
    // belongs to a worktree that is no longer on screen.
    const closesTerminals = !wasMinimized && ui.terminalsFor === worktreeId
    setUi({
      minimized,
      ...(closesTerminals ? { terminalsFor: null, minimizedBeforeTerminals: null } : {}),
    })
  }

  /**
   * Terminals is a focus mode: it shows one worktree's Claude and its shells,
   * and minimizes everything else. Switching it off restores exactly what was
   * expanded before, so focusing is a reversible detour rather than something
   * you have to rebuild afterwards.
   */
  const toggleTerminals = (worktreeId: string): void => {
    if (ui.terminalsFor === worktreeId) {
      setUi({
        terminalsFor: null,
        minimized: ui.minimizedBeforeTerminals ?? ui.minimized,
        minimizedBeforeTerminals: null,
      })
      return
    }
    setUi({
      terminalsFor: worktreeId,
      // Only remember the pre-focus layout once, so focusing straight from one
      // worktree to another still restores what was there before the first.
      minimizedBeforeTerminals: ui.minimizedBeforeTerminals ?? ui.minimized,
      minimized: projectWorktrees.filter((w) => w.id !== worktreeId).map((w) => w.id),
    })
    // The tile is only useful with something in it.
    if (shellSessions(sessions, worktreeId).length === 0) newShell(worktreeId)
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
      minimized={ui.minimized}
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
          onCreated={() => {
            setShowNewWorktree(false)
            void refresh()
          }}
        />
      )}
      {removing && worktrees.some((w) => w.id === removing) && (
        <RemoveWorktreeDialog
          worktree={worktrees.find((w) => w.id === removing)!}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            // A removed worktree cannot stay minimized or focused.
            setUi({
              minimized: ui.minimized.filter((id) => id !== removing),
              ...(ui.terminalsFor === removing
                ? {
                    terminalsFor: null,
                    minimized: ui.minimizedBeforeTerminals ?? ui.minimized,
                    minimizedBeforeTerminals: null,
                  }
                : {}),
            })
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
        terminalsFor={ui.terminalsFor}
        activeShellByWorktree={ui.activeShellByWorktree}
        onStart={startClaude}
        onMinimize={toggleMinimized}
        onRemoveWorktree={setRemoving}
        onToggleTerminals={toggleTerminals}
        onNewWorktree={() => setShowNewWorktree(true)}
        onSelectShell={(worktreeId, sessionId) =>
          setUi({
            activeShellByWorktree: { ...ui.activeShellByWorktree, [worktreeId]: sessionId },
          })
        }
        onNewShell={newShell}
        onCloseShell={(sessionId) => void api.killSession(sessionId).then(refresh).catch(fail)}
      />

      {dialogs}
    </div>
  )
}
