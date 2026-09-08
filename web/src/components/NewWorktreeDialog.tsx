import { useState } from 'react'
import type { Project } from '@ide-n-dream/shared'
import { api } from '../api.js'

export interface NewWorktreeDialogProps {
  project: Project
  onClose: () => void
  onCreated: (worktreeId: string) => void
}

export const NewWorktreeDialog = ({
  project,
  onClose,
  onCreated,
}: NewWorktreeDialogProps): React.ReactElement => {
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('')
  const [startClaude, setStartClaude] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = (): void => {
    if (branch.trim() === '') return
    setBusy(true)
    void api
      .createWorktree({
        projectId: project.id,
        branch: branch.trim(),
        base: base.trim() === '' ? undefined : base.trim(),
        startClaude,
      })
      .then((result) => onCreated(result.worktree.id))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }

  const directory = `${project.worktreeRoot}/${branch.trim().replace(/\//g, '-') || '...'}`
  // What the server will use if this is left empty.
  const defaultBase = project.defaultBase ?? 'HEAD'
  const hasRemoteBase = defaultBase !== 'HEAD'

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <h2 className="dialog__title">New worktree in {project.name}</h2>
        </div>
        <div className="dialog__body">
          <div className="field">
            <label className="field__label" htmlFor="branch">
              Branch
            </label>
            <input
              id="branch"
              className="field__input"
              value={branch}
              autoFocus
              spellCheck={false}
              placeholder="feature-name"
              onChange={(event) => setBranch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
            />
            <span className="field__hint">
              An existing branch is checked out; a new name is created. Directory: {directory}
            </span>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="base">
              Branch from
            </label>
            <input
              id="base"
              className="field__input"
              value={base}
              spellCheck={false}
              placeholder={defaultBase}
              onChange={(event) => setBase(event.target.value)}
            />
            <span className="field__hint">
              {hasRemoteBase
                ? `Left empty, it branches from ${defaultBase} so the worktree starts clean. Name a ref to carry local state instead.`
                : 'This repository has no remote, so it branches from your current HEAD.'}
            </span>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={startClaude}
              onChange={(event) => setStartClaude(event.target.checked)}
            />
            Start a Claude session here straight away
          </label>

          {error && <p className="field__hint" style={{ color: 'var(--danger)' }}>{error}</p>}
        </div>
        <div className="dialog__foot">
          <button className="btn btn--quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={submit} disabled={busy || branch.trim() === ''}>
            Create worktree
          </button>
        </div>
      </div>
    </div>
  )
}
