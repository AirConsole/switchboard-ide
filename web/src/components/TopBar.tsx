import type { Project, Session, Worktree } from '@ide-n-dream/shared'
import { claudeSession, stateLabel, worktreeNeedsYou } from '../selectors.js'

export interface TopBarProps {
  project: Project | undefined
  worktrees: Worktree[]
  sessions: Session[]
  /** Worktrees present only here, with no tile in the grid. */
  minimized: string[]
  onOpenProject: () => void
  onNewWorktree: () => void
  onToggleMinimized: (worktreeId: string) => void
}

/**
 * The top bar is where every worktree lives.
 *
 * A worktree always has a chip here whether or not it has a tile, which is what
 * makes minimizing safe: the chip keeps carrying state, so a worktree with no
 * tile on screen can still tell you Claude is waiting on you. Amber is reserved
 * for exactly that, here as everywhere else.
 *
 * The right-hand side stays empty on purpose. A count of what is waiting would
 * only restate what the amber chips already say.
 */
export const TopBar = ({
  project,
  worktrees,
  sessions,
  minimized,
  onOpenProject,
  onNewWorktree,
  onToggleMinimized,
}: TopBarProps): React.ReactElement => {
  const minimizedIds = new Set(minimized)

  return (
    <header className="topbar">
      <button className="topbar__project" onClick={onOpenProject} title="Open a different project">
        <span className="topbar__mark" aria-hidden="true" />
        {project ? project.name : 'Open project'}
      </button>

      <nav className="chips">
        {worktrees.map((worktree) => {
          const isMinimized = minimizedIds.has(worktree.id)
          const needsYou = worktreeNeedsYou(sessions, worktree.id)
          return (
            <button
              key={worktree.id}
              className={[
                'chip',
                isMinimized ? 'chip--minimized' : 'chip--shown',
                needsYou ? 'chip--waiting' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onToggleMinimized(worktree.id)}
              title={`${worktree.path}\n${stateLabel(claudeSession(sessions, worktree.id))}\n${
                isMinimized ? 'Click to show its tile' : 'Click to minimize to the top bar'
              }`}
            >
              {worktree.name}
              {worktree.branch && worktree.branch !== worktree.name && (
                <span className="chip__branch">{worktree.branch}</span>
              )}
              {worktree.dirty ? <span className="chip__dirty">{worktree.dirty}&plusmn;</span> : null}
            </button>
          )
        })}
        {project && (
          <button
            className="chip chip--add"
            onClick={onNewWorktree}
            title="New worktree"
            aria-label="New worktree"
          >
            +
          </button>
        )}
      </nav>
    </header>
  )
}
