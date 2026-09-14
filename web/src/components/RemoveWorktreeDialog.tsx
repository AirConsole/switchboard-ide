import { useState } from 'react'
import type { Session, Worktree, WorktreeTodo } from '@switchboard/shared'
import { api } from '../api.js'
import { removalQuestions, removalWarnings } from '../selectors.js'
import { useEscape } from './useEscape.js'

export interface RemoveWorktreeDialogProps {
  worktree: Worktree
  /** For the warnings: what is running in the worktree, and what is queued. */
  sessions: Session[]
  todos: WorktreeTodo[]
  onClose: () => void
  onRemoved: () => void
}

/**
 * Removal is destructive and irreversible, so the dialog names exactly what goes
 * away and keeps the extra hazards (discarding changes, deleting the branch,
 * deleting its copy on the remote) as separate opt-ins rather than bundling
 * them into one "force" switch.
 *
 * None is offered when it has nothing to decide -- see `removalQuestions`.
 * A checkbox for uncommitted changes in a clean worktree is a hazard the reader
 * has to rule out before acting, and a branch already merged into the default
 * one holds nothing: leaving it behind is litter, so it goes with the worktree
 * and is not put to a vote. The copy on the remote is asked about on exactly
 * the same terms, and answered separately: a branch can be merged on the remote
 * while the local one is ahead of it, or the other way round, and one checkbox
 * for both would delete whichever half the reader was not thinking about.
 *
 * What is *running* is told, not asked: a working Claude, a queue of todos, a
 * terminal with something in it are all destroyed whatever you answer, so a
 * checkbox would be a decision that does not exist. They are the reason this
 * dialog opens for a worktree git has nothing to say about -- see
 * `removalWarnings` -- and pressing the red button is the confirmation.
 *
 * Every hazard here is red. Amber means one thing in this interface -- an agent
 * is blocked on you -- and a modal that has already interrupted you does not
 * need a second severity: `--danger` is the colour of the button they all lead
 * to.
 */
export const RemoveWorktreeDialog = ({
  worktree,
  sessions,
  todos,
  onClose,
  onRemoved,
}: RemoveWorktreeDialogProps): React.ReactElement => {
  useEscape(onClose)
  const asks = removalQuestions(worktree)
  const warnings = removalWarnings(worktree, sessions, todos)
  const [force, setForce] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [deleteRemoteBranch, setDeleteRemoteBranch] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = (): void => {
    setBusy(true)
    void api
      .removeWorktree(worktree.id, {
        // Each answer comes from its own checkbox, or from the fact that made
        // asking pointless -- never from a box that was not on screen.
        force: asks.discard && force,
        deleteBranch: asks.branch ? deleteBranch : asks.branchGoesAnyway,
        deleteRemoteBranch: asks.remoteBranch
          ? deleteRemoteBranch
          : asks.remoteBranchGoesAnyway,
      })
      .then(() => onRemoved())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <h2 className="dialog__title">Remove worktree {worktree.name}?</h2>
        </div>
        <div className="dialog__body">
          <p className="empty__body">
            This stops every session running in the worktree and deletes its directory.
            {asks.branch && ' The branch is kept unless you ask for it to go too.'}
            {asks.branchGoesAnyway && (
              <>
                {' '}
                Its branch &ldquo;{worktree.branch}&rdquo; has nothing the default branch does
                not, so that goes with it.
              </>
            )}
            {asks.remoteBranchGoesAnyway &&
              /* Two wordings because the two branches are judged separately and
                 either can be the spent one: "so does its copy on the remote"
                 is only true after the sentence about the local branch, and the
                 remote can be merged while the local branch is still ahead of
                 it -- unpushed commits -- in which case that sentence is not
                 on screen and this has to stand by itself. */
              (asks.branchGoesAnyway ? (
                <> And nor does its copy &ldquo;{worktree.remoteBranch}&rdquo;, so that is
                  deleted from the remote too.
                </>
              ) : (
                <> Its copy on the remote, &ldquo;{worktree.remoteBranch}&rdquo;, has nothing
                  the default branch does not, so that is deleted.
                </>
              ))}
          </p>
          <p className="field__hint">{worktree.path}</p>
          {asks.discard && (
            <p className="dialog__warn">
              {worktree.dirty} uncommitted change{worktree.dirty === 1 ? '' : 's'} here. Git will
              refuse to remove it unless you discard them.
            </p>
          )}
          {warnings.map((warning) => (
            <p className="dialog__warn" key={warning.key}>
              {warning.text}
            </p>
          ))}
          {asks.discard && (
            <label className="check">
              <input
                type="checkbox"
                checked={force}
                onChange={(event) => setForce(event.target.checked)}
              />
              Discard uncommitted changes
            </label>
          )}
          {asks.branch && (
            <label className="check">
              <input
                type="checkbox"
                checked={deleteBranch}
                onChange={(event) => setDeleteBranch(event.target.checked)}
              />
              {/* The name in quotes: unquoted, "Delete the branch files as well"
                  reads as a sentence about files rather than about a branch
                  called `files`, and someone asked what it meant. */}
              Delete the branch &ldquo;{worktree.branch}&rdquo; as well
            </label>
          )}
          {asks.remoteBranch && (
            <label className="check">
              <input
                type="checkbox"
                checked={deleteRemoteBranch}
                onChange={(event) => setDeleteRemoteBranch(event.target.checked)}
              />
              {/* The only thing on this dialog that leaves the machine, so it
                  says where it is going rather than just naming the ref. */}
              Delete &ldquo;{worktree.remoteBranch}&rdquo; from the remote as well
            </label>
          )}
          {error && <p className="dialog__warn">{error}</p>}
        </div>
        <div className="dialog__foot">
          <button className="btn btn--quiet" onClick={onClose}>
            Keep it
          </button>
          <button className="btn btn--danger" onClick={submit} disabled={busy}>
            Remove worktree
          </button>
        </div>
      </div>
    </div>
  )
}
