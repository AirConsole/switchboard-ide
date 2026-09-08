import { useRef } from 'react'
import type { Session, Worktree } from '@ide-n-dream/shared'
import { TerminalView } from '../terminal/TerminalView.js'
import { useTileFontSize } from '../terminal/useTileFontSize.js'
import { agentSession, stateLabel } from '../selectors.js'

interface TileProps {
  worktree: Worktree
  session: Session | undefined
  onOpen: () => void
  onStartAgent: () => void
}

const Tile = ({ worktree, session, onOpen, onStartAgent }: TileProps): React.ReactElement => {
  const screenRef = useRef<HTMLDivElement | null>(null)
  const fontSize = useTileFontSize(screenRef, session?.cols ?? 120, session?.rows ?? 34)

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
      <button className="tile__head" onClick={onOpen} title={`Open ${worktree.name}`}>
        <span className="tile__name">{worktree.name}</span>
        {worktree.branch && worktree.branch !== worktree.name && (
          <span className="tile__branch">{worktree.branch}</span>
        )}
        <span className="tile__state">{stateLabel(session)}</span>
      </button>
      <div className="tile__screen" ref={screenRef}>
        {session ? (
          // Tiles attach as non-primary, so they never renegotiate the pty size.
          // They stay interactive on purpose: you can answer a blocked agent
          // from the overview without opening it.
          <TerminalView session={session} primary={false} fontSize={fontSize} />
        ) : (
          <div className="tile__idle">
            <p className="tile__idle-text">No agent in this worktree yet.</p>
            <button className="btn" onClick={onStartAgent}>
              Start agent
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
  onStartAgent: (worktreeId: string) => void
}

export const SplitView = ({
  worktrees,
  sessions,
  onOpenWorktree,
  onStartAgent,
}: SplitViewProps): React.ReactElement => (
  <section className="view overview">
    <div className="overview__head">
      <h1 className="overview__title">Agents</h1>
      <span className="micro">
        {worktrees.length} worktree{worktrees.length === 1 ? '' : 's'}
      </span>
    </div>
    <div className="grid">
      {worktrees.map((worktree) => (
        <Tile
          key={worktree.id}
          worktree={worktree}
          session={agentSession(sessions, worktree.id)}
          onOpen={() => onOpenWorktree(worktree.id)}
          onStartAgent={() => onStartAgent(worktree.id)}
        />
      ))}
    </div>
  </section>
)
