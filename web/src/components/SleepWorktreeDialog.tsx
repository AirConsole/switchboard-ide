import { useState } from 'react'
import type { Session, Worktree, WorktreeTodo } from '@ide-n-dream/shared'
import { claudeSession, removalAsks, terminalSessions } from '../selectors.js'
import { useEscape } from './useEscape.js'

/** What to leave running when a worktree goes to sleep. */
export interface SleepOptions {
  claude: boolean
  terminals: boolean
}

export interface SleepWorktreeDialogProps {
  worktree: Worktree
  sessions: Session[]
  /** Only for the delete button's label; see `removalAsks`. */
  todos: WorktreeTodo[]
  onClose: () => void
  onSleep: (keep: SleepOptions) => void
  /**
   * Remove this worktree, when it can be removed at all.
   *
   * Sleeping and deleting are the same question asked with different force --
   * "put this away" and "put this away for good" -- so they are asked in one
   * place rather than from two controls in two parts of the interface. Whether
   * this opens another dialog or does the removal outright is the caller's
   * business; the label says which, and `removalAsks` is what decides.
   */
  onDelete?: () => void
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
 * The copy is about the worktree. Its window going away is worth saying, since
 * that is the visible half of what the click does, but "tile" and "row" are
 * names for how the interface is built rather than for anything the reader has
 * in mind: they are deciding what happens to a worktree.
 */
export const SleepWorktreeDialog = ({
  worktree,
  sessions,
  todos,
  onClose,
  onSleep,
  onDelete,
}: SleepWorktreeDialogProps): React.ReactElement => {
  useEscape(onClose)
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
            Puts the {worktree.name} worktree to sleep and hides its window. Claude and every
            terminal in it are stopped, and the machine gets their processes and memory back.
          </p>
          <p className="empty__body">
            Nothing on disk changes — the branch and its files stay exactly as they are, and
            waking the worktree continues the same conversation rather than starting a new one.
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
              <span className="field__hint"> — leaves it working on whatever it is doing</span>
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
              // What keeping them gives you, in one glance. Both halves of it
              // matter and neither survives a stop: a command still running,
              // and everything already printed.
              <span className="field__hint"> — leaves processes running and keeps history</span>
            )}
          </label>
        </div>
        {/* `--split` because one of these is not undoable: see the stylesheet. */}
        <div className="dialog__foot dialog__foot--split">
          {/* First in the row and first in the tab order, which is the same
              thing: the corner it sits in is the far one from the buttons this
              dialog is actually for, and nothing about it should be reachable
              by a hand aiming at those. The main worktree cannot be removed, so
              it is not offered -- the gate that used to sit on the window's
              trashcan moved with the action. */}
          {onDelete !== undefined && !worktree.isMain && (
            <button className="btn btn--danger" onClick={onDelete}>
              {/* The ellipsis means "and then it will ask you something", so it
                  is dropped when there is nothing left to ask: a worktree with
                  nothing uncommitted, nothing unmerged, nothing running and no
                  todos is removed by this click, and the label should not
                  promise another one. */}
              Delete worktree{removalAsks(worktree, sessions, todos) ? '…' : ''}
            </button>
          )}
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
