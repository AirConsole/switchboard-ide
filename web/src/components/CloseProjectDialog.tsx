import type { Project, Session, Worktree } from '@switchboard/shared'
import { useEscape } from './useEscape.js'

export interface CloseProjectDialogProps {
  project: Project
  /** The project's worktrees, and every session running in them. */
  worktrees: Worktree[]
  sessions: Session[]
  onCancel: () => void
  /** Close it. `sleep` stops everything the project is running. */
  onClose: (sleep: boolean) => void
}

/** "3 worktrees", "1 worktree" -- said in the interface's own nouns. */
const count = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`

/**
 * Closing a project asks what to do with what it is running.
 *
 * It has to ask, because the honest answer is not obvious either way. A closed
 * project's agents carry on in tmux -- that is the whole design, and re-opening
 * the project picks them back up mid-conversation -- but they also disappear
 * from the interface entirely, which is how you end up with Claude sessions
 * alive on the machine and nothing on screen owning them.
 *
 * The choice is deliberately all-or-nothing, unlike sleeping a single worktree,
 * which offers to keep Claude or the terminals. There you are still looking at
 * the worktree afterwards, so a half-stopped one is a state you can see and
 * undo. Here the project is leaving the interface, and a project stopped in
 * half is exactly the state nobody can find again.
 */
export const CloseProjectDialog = ({
  project,
  worktrees,
  sessions,
  onCancel,
  onClose,
}: CloseProjectDialogProps): React.ReactElement => {
  useEscape(onCancel)
  const mine = new Set(worktrees.map((w) => w.id))
  const running = sessions.filter((s) => mine.has(s.worktreeId) && s.liveness !== 'dead')
  const claudes = running.filter((s) => s.kind === 'claude').length
  const terminals = running.filter((s) => s.kind === 'shell').length
  const nothingRunning = running.length === 0

  return (
    <div className="scrim" onClick={onCancel}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <h2 className="dialog__title">Close {project.name}?</h2>
        </div>
        <div className="dialog__body">
          <p className="empty__body">
            Takes {project.name} out of the top bar, with its{' '}
            {count(worktrees.length, 'worktree', 'worktrees')}. Nothing on disk changes — the
            repository, its branches and every worktree stay exactly as they are, and opening it
            again brings them all back.
          </p>
          <p className="field__hint">{project.root}</p>

          {nothingRunning ? (
            <p className="empty__body">Nothing is running in it, so there is nothing to stop.</p>
          ) : (
            <>
              <p className="empty__body">
                {/* What is actually at stake, counted, so the choice below is
                    about this project rather than about the idea of one. */}
                It is running {claudes > 0 && count(claudes, 'Claude session', 'Claude sessions')}
                {claudes > 0 && terminals > 0 && ' and '}
                {terminals > 0 && count(terminals, 'terminal', 'terminals')}.
              </p>
              <p className="empty__body">
                <strong>Leave them running</strong> and they carry on without a window — opening
                the project again picks each one up where it left off.{' '}
                <strong>Stop everything</strong> ends every Claude session and kills every
                terminal in the project. A conversation comes back when you start Claude again; a
                terminal's scrollback, and anything still running in it, does not.
              </p>
            </>
          )}
        </div>
        <div className="dialog__foot">
          <button className="btn btn--quiet" onClick={onCancel}>
            Cancel
          </button>
          {nothingRunning ? (
            <button className="btn" onClick={() => onClose(false)}>
              Close
            </button>
          ) : (
            <>
              <button className="btn" onClick={() => onClose(false)}>
                Leave them running
              </button>
              {/* Killing terminals is the one irrecoverable half of this, so it
                  is the one control that reads as destructive. */}
              <button className="btn btn--danger" onClick={() => onClose(true)}>
                Stop everything
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
