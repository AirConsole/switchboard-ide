import { useState } from 'react'
import type { Worktree } from '@ide-n-dream/shared'
import { api } from '../api.js'

export interface RemoveWorktreeDialogProps {
  worktree: Worktree
  onClose: () => void
  onRemoved: () => void
}

/**
 * Removal is destructive and irreversible, so the dialog names exactly what goes
 * away and keeps the two extra hazards (discarding changes, deleting the branch)
 * as separate opt-ins rather than bundling them into one "force" switch.
 */
export const RemoveWorktreeDialog = ({
  worktree,
  onClose,
  onRemoved,
}: RemoveWorktreeDialogProps): React.ReactElement => {
  const [force, setForce] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = (): void => {
    setBusy(true)
    void api
      .removeWorktree(worktree.id, { force, deleteBranch })
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
            The branch is kept unless you ask for it to go too.
          </p>
          <p className="field__hint">{worktree.path}</p>
          {worktree.dirty ? (
            <p className="field__hint" style={{ color: 'var(--signal)' }}>
              {worktree.dirty} uncommitted change{worktree.dirty === 1 ? '' : 's'} here. Git will
              refuse to remove it unless you discard them.
            </p>
          ) : null}
          <label className="check">
            <input
              type="checkbox"
              checked={force}
              onChange={(event) => setForce(event.target.checked)}
            />
            Discard uncommitted changes
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={(event) => setDeleteBranch(event.target.checked)}
            />
            Delete the branch {worktree.branch ?? ''} as well
          </label>
          {error && <p className="field__hint" style={{ color: 'var(--danger)' }}>{error}</p>}
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
