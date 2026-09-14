import { useState } from 'react'
import type { Project } from '@switchboard/shared'
import { api } from '../api.js'

export interface NewWorktreeFormProps {
  project: Project
  onCreated: (worktreeId: string) => void
}

/**
 * Making a worktree: a section of its project's pane, not a dialog over the row.
 *
 * It was a modal, and the modal was the wrong shape for what this is. A dialog
 * interrupts to ask one question and goes away; a project's "and one more"
 * never goes away, it is a standing offer at the end of that project's run of
 * windows. As a tile it is somewhere you can *walk to* -- Cmd+arrow steps into
 * it like any other pane -- and the row keeps its own shape while you type,
 * where a scrim hid the very windows you were naming a branch relative to.
 *
 * It briefly had a tile of its own at the end of each project's run; it sits
 * inside that project's pane now, under the lists of its worktrees, which is
 * where "and one more" belongs.
 *
 * There is no Cancel, because there is nothing to cancel back to: the pane is
 * part of the row whether or not you are using it. Escape is not taken either,
 * for the same reason -- it belongs to whatever a dialog is doing elsewhere.
 */
export const NewWorktreeForm = ({
  project,
  onCreated,
}: NewWorktreeFormProps): React.ReactElement => {
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('')
  const [startClaude, setStartClaude] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = (): void => {
    // The button is disabled while a request is in flight; key repeat has to
    // respect the same rule, or holding Enter fires several creates whose
    // failures are swallowed as the tile re-renders.
    if (busy) return
    if (branch.trim() === '') return
    setBusy(true)
    void api
      .createWorktree({
        projectId: project.id,
        branch: branch.trim(),
        base: base.trim() === '' ? undefined : base.trim(),
        startClaude,
      })
      .then((result) => {
        // Emptied rather than left holding the name of a worktree that now
        // exists: the tile stays where it is, so the next thing typed into it
        // should be the next branch.
        setBranch('')
        setBase('')
        setBusy(false)
        onCreated(result.worktree.id)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }

  const directory = `${project.worktreeRoot}/${branch.trim().replace(/\//g, '-') || '…'}`
  // What the server will use if this is left empty.
  const defaultBase = project.defaultBase ?? 'HEAD'
  const hasRemoteBase = defaultBase !== 'HEAD'

  return (
    <div className="addform">
      <div className="field">
        <label className="field__label" htmlFor={`branch-${project.id}`}>
          Branch
        </label>
        <input
          id={`branch-${project.id}`}
          className="field__input"
          value={branch}
          spellCheck={false}
          placeholder="feature-name"
          onChange={(event) => setBranch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
        <span className="field__hint">
          An existing branch is checked out; a new name is created.
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`base-${project.id}`}>
          Branch from
        </label>
        <input
          id={`base-${project.id}`}
          className="field__input"
          value={base}
          spellCheck={false}
          placeholder={defaultBase}
          onChange={(event) => setBase(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
        <span className="field__hint">
          {hasRemoteBase
            ? `Empty branches from ${defaultBase}, so it starts clean.`
            : 'No remote here, so it branches from your current HEAD.'}
        </span>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={startClaude}
          onChange={(event) => setStartClaude(event.target.checked)}
        />
        Start Claude here
      </label>

      {error && <p className="addform__error">{error}</p>}

      <div className="addform__foot">
        <span className="addform__where" title={directory}>
          {directory}
        </span>
        <button className="btn" onClick={submit} disabled={busy || branch.trim() === ''}>
          Create
        </button>
      </div>
    </div>
  )
}
