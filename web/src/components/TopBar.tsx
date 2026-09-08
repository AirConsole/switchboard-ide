import type { Project, Session, Worktree } from '@ide-n-dream/shared'
import { waitingCount, worktreeNeedsYou } from '../selectors.js'

export interface TopBarProps {
  project: Project | undefined
  worktrees: Worktree[]
  sessions: Session[]
  view: 'split' | 'detail'
  activeWorktreeId: string | null
  onOpenProject: () => void
  onNewWorktree: () => void
  onShowOverview: () => void
  onSelectWorktree: (worktreeId: string) => void
}

export const TopBar = ({
  project,
  worktrees,
  sessions,
  view,
  activeWorktreeId,
  onOpenProject,
  onNewWorktree,
  onShowOverview,
  onSelectWorktree,
}: TopBarProps): React.ReactElement => {
  const waiting = waitingCount(sessions)

  return (
    <header className="topbar">
      <button className="topbar__project" onClick={onOpenProject} title="Open a different project">
        <span className="topbar__mark" aria-hidden="true" />
        {project ? project.name : 'Open project'}
      </button>

      <nav className="tabs">
        {worktrees.map((worktree) => {
          const needsYou = worktreeNeedsYou(sessions, worktree.id)
          const isActive = view === 'detail' && worktree.id === activeWorktreeId
          return (
            <button
              key={worktree.id}
              className={['tab', isActive ? 'tab--active' : '', needsYou ? 'tab--waiting' : '']
                .filter(Boolean)
                .join(' ')}
              onClick={() => onSelectWorktree(worktree.id)}
              title={worktree.path}
            >
              {worktree.name}
              {worktree.branch && worktree.branch !== worktree.name && (
                <span className="tab__branch">{worktree.branch}</span>
              )}
              {worktree.dirty ? <span className="tab__dirty">{worktree.dirty}&plusmn;</span> : null}
            </button>
          )
        })}
      </nav>

      <div className="topbar__actions">
        {/*
          The signature readout. It is the only amber element in the chrome, and
          it answers the question the whole app exists to answer. With nothing
          blocked it goes quiet rather than turning green: absence of signal,
          not a second signal competing for attention.
        */}
        <div
          className={waiting > 0 ? 'waiting waiting--active' : 'waiting'}
          title={waiting > 0 ? 'Agents blocked on an answer from you' : 'No agent is waiting on you'}
        >
          {waiting > 0 ? (
            <>
              <span className="waiting__count">{waiting}</span>
              waiting
            </>
          ) : (
            'all clear'
          )}
        </div>
        <button
          className={view === 'split' ? 'topbar__button topbar__button--active' : 'topbar__button'}
          onClick={onShowOverview}
        >
          Overview
        </button>
        <button className="topbar__button" onClick={onNewWorktree} disabled={!project}>
          New worktree
        </button>
      </div>
    </header>
  )
}
