import { useEffect, useMemo, useState } from 'react'
import { api } from './api.js'
import { bindSocketToStore } from './store.js'
import { useStore } from './store.js'
import { TopBar } from './components/TopBar.js'
import { NewWorktreeDialog } from './components/NewWorktreeDialog.js'
import { OpenProjectDialog } from './components/OpenProjectDialog.js'
import { RemoveWorktreeDialog } from './components/RemoveWorktreeDialog.js'
import { SplitView } from './views/SplitView.js'
import { WorktreeView } from './views/WorktreeView.js'
import { orderWorktrees, shellSessions } from './selectors.js'

export const App = (): React.ReactElement => {
  const {
    projects,
    worktrees,
    sessions,
    ui,
    loaded,
    error,
    refresh,
    setUi,
    setError,
  } = useStore()

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
  // Only an exact match counts. Falling back to some other worktree would
  // silently show work you did not ask for, so if the one you were in has gone
  // -- removed here, from another tab, or on the command line -- the render
  // below drops to the overview instead.
  const activeWorktree = projectWorktrees.find((w) => w.id === ui.activeWorktreeId)

  const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err))

  const openWorktree = (worktreeId: string): void => {
    setUi({ view: 'detail', activeWorktreeId: worktreeId })
  }

  const startClaude = (worktreeId: string): void => {
    void api
      .createSession({ worktreeId, kind: 'claude' })
      .then(() => refresh())
      .catch(fail)
  }

  const newShell = (worktreeId: string): void => {
    void api
      .createSession({ worktreeId, kind: 'shell' })
      .then((session) => {
        setUi({
          activeSessionByWorktree: { ...ui.activeSessionByWorktree, [worktreeId]: session.id },
        })
        return refresh()
      })
      .catch(fail)
  }

  if (!loaded) {
    return (
      <div className="empty">
        <p className="empty__body">Loading…</p>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="app">
        <TopBar
          project={undefined}
          worktrees={[]}
          sessions={[]}
          view="split"
          activeWorktreeId={null}
          onOpenProject={() => setShowOpenProject(true)}
          onNewWorktree={() => setShowNewWorktree(true)}
          onShowOverview={() => setUi({ view: 'split' })}
          onSelectWorktree={openWorktree}
        />
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
        {showOpenProject && (
          <OpenProjectDialog
            onClose={() => setShowOpenProject(false)}
            onOpened={() => {
              setShowOpenProject(false)
              void refresh()
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <TopBar
        project={project}
        worktrees={projectWorktrees}
        sessions={sessions}
        view={ui.view}
        activeWorktreeId={activeWorktree?.id ?? null}
        onOpenProject={() => setShowOpenProject(true)}
        onNewWorktree={() => setShowNewWorktree(true)}
        onShowOverview={() => setUi({ view: 'split' })}
        onSelectWorktree={openWorktree}
      />

      {error && (
        <div className="banner">
          {error}
          <button className="banner__dismiss" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {ui.view === 'detail' && activeWorktree ? (
        <WorktreeView
          worktree={activeWorktree}
          sessions={sessions}
          stripHeight={ui.terminalStripHeight}
          activeShellId={
            ui.activeSessionByWorktree[activeWorktree.id] ??
            shellSessions(sessions, activeWorktree.id)[0]?.id ??
            null
          }
          onStripHeight={(height) => setUi({ terminalStripHeight: height })}
          onSelectShell={(sessionId) =>
            setUi({
              activeSessionByWorktree: {
                ...ui.activeSessionByWorktree,
                [activeWorktree.id]: sessionId,
              },
            })
          }
          onStart={() => startClaude(activeWorktree.id)}
          onNewShell={() => newShell(activeWorktree.id)}
          onCloseSession={(sessionId) => void api.killSession(sessionId).then(refresh).catch(fail)}
          onRestartSession={(sessionId) =>
            void api.respawnSession(sessionId).then(refresh).catch(fail)
          }
          onRemoveWorktree={() => setRemoving(activeWorktree.id)}
        />
      ) : (
        <SplitView
          worktrees={projectWorktrees}
          sessions={sessions}
          onOpenWorktree={openWorktree}
          onStart={startClaude}
          onNewWorktree={() => setShowNewWorktree(true)}
          onRemoveWorktree={setRemoving}
        />
      )}

      {showOpenProject && (
        <OpenProjectDialog
          onClose={() => setShowOpenProject(false)}
          onOpened={() => {
            setShowOpenProject(false)
            void refresh()
          }}
        />
      )}
      {showNewWorktree && (
        <NewWorktreeDialog
          project={project}
          onClose={() => setShowNewWorktree(false)}
          onCreated={(worktreeId) => {
            setShowNewWorktree(false)
            void refresh()
            openWorktree(worktreeId)
          }}
        />
      )}
      {removing && (
        <RemoveWorktreeDialog
          worktree={worktrees.find((w) => w.id === removing)!}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null)
            setUi({ view: 'split', activeWorktreeId: null })
            void refresh()
          }}
        />
      )}
    </div>
  )
}
