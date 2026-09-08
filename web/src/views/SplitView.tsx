import type { Session, Worktree } from '@ide-n-dream/shared'
import { TerminalView } from '../terminal/TerminalView.js'
import { claudeSession, stateLabel } from '../selectors.js'

/**
 * Tiles use a smaller type size than the detail view so a glanceable slice of
 * the session fits, but they still size the terminal to the tile rather than
 * scaling it down: a scaled terminal is unreadable, and cols/rows derived from
 * the real tile give you legible text at whatever size the grid allows.
 */
const TILE_FONT_SIZE = 12

interface TileProps {
  worktree: Worktree
  session: Session | undefined
  onOpen: () => void
  onStart: () => void
}

const Tile = ({ worktree, session, onOpen, onStart }: TileProps): React.ReactElement => {
  const state = session
    ? session.liveness === 'dead'
      ? 'dead'
      : session.attention === 'needs-you'
        ? 'waiting'
        : session.attention === 'working'
          ? 'working'
          : 'idle'
    : 'idle'

  return (
    <div className={`tile tile--${state}`}>
      <button className="tile__head" onClick={onOpen} title={worktree.path}>
        <span className="tile__name">{worktree.name}</span>
        {worktree.branch && worktree.branch !== worktree.name && (
          <span className="tile__branch">{worktree.branch}</span>
        )}
        {worktree.dirty ? <span className="tile__branch">{worktree.dirty}&plusmn;</span> : null}
        <span className="tile__state">{stateLabel(session)}</span>
      </button>
      <div className="tile__screen">
        {session ? (
          // Tiles stay interactive on purpose: you can answer a prompt here
          // without opening the worktree.
          <TerminalView session={session} primary={true} fontSize={TILE_FONT_SIZE} />
        ) : (
          <div className="tile__idle">
            <p className="tile__idle-text">Claude is not running in this worktree.</p>
            <button className="btn" onClick={onStart}>
              Start Claude
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export interface SplitViewProps {
  worktrees: Worktree[]
  sessions: Session[]
  onOpenWorktree: (worktreeId: string) => void
  onStart: (worktreeId: string) => void
  onNewWorktree: () => void
}

export const SplitView = ({
  worktrees,
  sessions,
  onOpenWorktree,
  onStart,
  onNewWorktree,
}: SplitViewProps): React.ReactElement => (
  <section className="view overview">
    <div className="overview__head">
      <h1 className="overview__title">Worktrees</h1>
      <span className="micro">
        {worktrees.length === 1 ? '1 worktree' : `${worktrees.length} worktrees`}
      </span>
    </div>
    <div className="grid">
      {worktrees.map((worktree) => (
        <Tile
          key={worktree.id}
          worktree={worktree}
          session={claudeSession(sessions, worktree.id)}
          onOpen={() => onOpenWorktree(worktree.id)}
          onStart={() => onStart(worktree.id)}
        />
      ))}
      <button className="tile--add" onClick={onNewWorktree}>
        <span className="tile--add__mark" aria-hidden="true">
          +
        </span>
        <span className="tile--add__label">New worktree</span>
        <p className="tile--add__hint">
          Branches off and checks out its own directory, with Claude running in it.
        </p>
      </button>
    </div>
  </section>
)
