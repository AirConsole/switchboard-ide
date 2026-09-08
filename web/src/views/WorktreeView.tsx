import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, Worktree } from '@ide-n-dream/shared'
import { TerminalView } from '../terminal/TerminalView.js'
import { agentSession, shellSessions, stateLabel } from '../selectors.js'

export interface WorktreeViewProps {
  worktree: Worktree
  sessions: Session[]
  stripHeight: number
  activeShellId: string | null
  onStripHeight: (height: number) => void
  onSelectShell: (sessionId: string) => void
  onStartAgent: () => void
  onNewShell: () => void
  onCloseSession: (sessionId: string) => void
  onRestartSession: (sessionId: string) => void
  onRemoveWorktree: () => void
}

const MIN_STRIP = 0
const MAX_STRIP = 700

export const WorktreeView = ({
  worktree,
  sessions,
  stripHeight,
  activeShellId,
  onStripHeight,
  onSelectShell,
  onStartAgent,
  onNewShell,
  onCloseSession,
  onRestartSession,
  onRemoveWorktree,
}: WorktreeViewProps): React.ReactElement => {
  const agent = agentSession(sessions, worktree.id)
  const shells = shellSessions(sessions, worktree.id)
  const activeShell = shells.find((s) => s.id === activeShellId) ?? shells[0]

  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const [dragHeight, setDragHeight] = useState<number | null>(null)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = { startY: event.clientY, startHeight: stripHeight }
      setDragHeight(stripHeight)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [stripHeight],
  )

  useEffect(() => {
    if (dragHeight === null) return
    const move = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      // Dragging up grows the strip, which is why the delta is inverted.
      const next = drag.startHeight - (event.clientY - drag.startY)
      setDragHeight(Math.max(MIN_STRIP, Math.min(MAX_STRIP, next)))
    }
    const up = (): void => {
      const drag = dragRef.current
      dragRef.current = null
      if (drag !== null && dragHeight !== null) onStripHeight(dragHeight)
      setDragHeight(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragHeight, onStripHeight])

  const effectiveStrip = dragHeight ?? stripHeight
  const showStrip = shells.length > 0 && effectiveStrip > 24

  return (
    <section className="view detail" style={{ gridTemplateRows: `1fr auto` }}>
      <div className="pane">
        <div className="pane__head">
          <span className="pane__title">{worktree.name}</span>
          <span className="micro">{worktree.branch ?? 'detached'}</span>
          <span className="micro">{stateLabel(agent)}</span>
          <button className="topbar__button" onClick={onNewShell}>
            New shell
          </button>
          {agent?.liveness === 'dead' && (
            <button className="topbar__button" onClick={() => onRestartSession(agent.id)}>
              Restart agent
            </button>
          )}
          {!worktree.isMain && (
            <button className="topbar__button" onClick={onRemoveWorktree}>
              Remove worktree
            </button>
          )}
          {/* The escape hatch: these are real tmux sessions, so the user can
              always take one over from a terminal. */}
          <span className="pane__hint" title={agent?.attachCommand ?? worktree.path}>
            {agent ? agent.attachCommand : worktree.path}
          </span>
        </div>
        {agent ? (
          <div className="terminal">
            <TerminalView session={agent} primary={true} />
          </div>
        ) : (
          <div className="empty">
            <h2 className="empty__title">No agent in {worktree.name}</h2>
            <p className="empty__body">
              Start a Claude session in this worktree. It runs in {worktree.path} and keeps running
              if you close this tab or restart the server.
            </p>
            <button className="btn" onClick={onStartAgent}>
              Start agent
            </button>
          </div>
        )}
      </div>

      {shells.length > 0 && (
        <div className="strip" style={{ height: showStrip ? effectiveStrip : undefined }}>
          <div
            className="strip__handle"
            onPointerDown={onPointerDown}
            role="separator"
            aria-orientation="horizontal"
          />
          <div className="strip__tabs">
            {shells.map((shell) => (
              <div
                key={shell.id}
                className={
                  shell.id === activeShell?.id ? 'strip__tab strip__tab--active' : 'strip__tab'
                }
              >
                <button onClick={() => onSelectShell(shell.id)}>
                  {shell.title}
                  {shell.liveness === 'dead' ? ' (exited)' : ''}
                </button>
                <button
                  className="strip__close"
                  onClick={() => onCloseSession(shell.id)}
                  title="Close this shell"
                  aria-label={`Close ${shell.title}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {showStrip && activeShell && (
            <div className="strip__body">
              <TerminalView session={activeShell} primary={true} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}
