import { useState } from 'react'
import type { Session, Worktree } from '@ide-n-dream/shared'
import { claudeSession, terminalSessions } from '../selectors.js'

/** What to leave running when a worktree goes to sleep. */
export interface SleepOptions {
  claude: boolean
  terminals: boolean
}

export interface SleepWorktreeDialogProps {
  worktree: Worktree
  sessions: Session[]
  onClose: () => void
  onSleep: (keep: SleepOptions) => void
}

/**
 * Sleeping stops what a worktree is running.
 *
 * It asks rather than acting, because the two halves are not equally
 * recoverable and the dialog is where that can be said. Claude comes back where
 * it left off -- waking continues the conversation -- so stopping it costs
 * nothing but the restart. A terminal's scrollback is gone for good, and so is
 * anything running in it, which is why that is the option worth pausing over.
 *
 * The copy talks about the worktree and what happens to it, not about tiles or
 * rows: those are how it happens to be drawn, and the reader is deciding
 * whether to stop an agent, not whether to rearrange a screen.
 */
export const SleepWorktreeDialog = ({
  worktree,
  sessions,
  onClose,
  onSleep,
}: SleepWorktreeDialogProps): React.ReactElement => {
  const [keepClaude, setKeepClaude] = useState(false)
  const [keepTerminals, setKeepTerminals] = useState(false)

  const claude = claudeSession(sessions, worktree.id)
  const terminals = terminalSessions(sessions, worktree.id)

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <h2 className="dialog__title">Sleep {worktree.name}?</h2>
        </div>
        <div className="dialog__body">
          <p className="empty__body">
            Stops Claude and every terminal in this worktree, giving the machine back their
            processes and memory. Nothing on disk changes — the branch and its files stay exactly
            as they are.
          </p>
          <p className="empty__body">
            Waking the worktree continues the same conversation rather than starting a new one.
          </p>
          <p className="field__hint">{worktree.path}</p>
          <label className="check">
            <input
              type="checkbox"
              checked={keepClaude}
              onChange={(event) => setKeepClaude(event.target.checked)}
              disabled={claude === undefined}
            />
            Keep Claude running
            {claude === undefined ? (
              <span className="field__hint"> — not running</span>
            ) : (
              <span className="field__hint"> — it carries on working while the worktree sleeps</span>
            )}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={keepTerminals}
              onChange={(event) => setKeepTerminals(event.target.checked)}
              disabled={terminals.length === 0}
            />
            {terminals.length === 1 ? 'Keep the terminal' : 'Keep the terminals'}
            {terminals.length === 0 ? (
              <span className="field__hint"> — none open</span>
            ) : (
              // Said plainly, because this is the half that does not come back.
              <span className="field__hint">
                {' '}
                — otherwise {terminals.length === 1 ? 'it is' : 'they are'} stopped, ending
                whatever {terminals.length === 1 ? 'it is' : 'they are'} running and losing{' '}
                {terminals.length === 1 ? 'its' : 'their'} scrollback
              </span>
            )}
          </label>
        </div>
        <div className="dialog__foot">
          <button className="btn btn--quiet" onClick={onClose}>
            Leave it awake
          </button>
          <button
            className="btn"
            onClick={() => onSleep({ claude: keepClaude, terminals: keepTerminals })}
          >
            Sleep
          </button>
        </div>
      </div>
    </div>
  )
}
