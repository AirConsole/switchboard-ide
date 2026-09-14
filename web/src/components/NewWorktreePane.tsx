import { useEffect, useRef, useState } from 'react'
import type { Project } from '@switchboard/shared'
import { api } from '../api.js'

export interface NewWorktreePaneProps {
  project: Project
  /** Bumped when the row navigates here, to hand the caret to the branch box. */
  focus: number | null
  onCreated: (worktreeId: string) => void
}

/**
 * Making a worktree, as a tile in the row rather than a dialog over it.
 *
 * It was a modal, and the modal was the wrong shape for what this is. A dialog
 * interrupts to ask one question and goes away; a project's "and one more"
 * never goes away, it is a standing offer at the end of that project's run of
 * windows. As a tile it is somewhere you can *walk to* -- Cmd+arrow steps into
 * it like any other pane -- and the row keeps its own shape while you type,
 * where a scrim hid the very windows you were naming a branch relative to.
 *
 * One unit wide, which is the width the placeholder already had: this holds two
 * short fields and a button and nothing that reads better for being wider. It
 * is the same exception `PANE_UNITS.add` always was -- the 80-column floor is a
 * promise about panes you read code in.
 *
 * There is no Cancel, because there is nothing to cancel back to: the tile is
 * part of the row whether or not you are using it. Escape is not taken either,
 * for the same reason -- it belongs to whatever a dialog is doing elsewhere.
 */
export const NewWorktreePane = ({
  project,
  focus,
  onCreated,
}: NewWorktreePaneProps): React.ReactElement => {
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('')
  const [startClaude, setStartClaude] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const branchRef = useRef<HTMLInputElement>(null)

  /*
   * Arriving here means typing a branch name, so the caret goes to the field
   * that takes one -- the same contract every other pane has with `focus`, and
   * the reason a nonce rather than a boolean: coming back to a tile you were
   * already on has to hand the keyboard over again.
   */
  useEffect(() => {
    if (focus !== null) branchRef.current?.focus()
  }, [focus])

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
    <div className="addpane">
      <div className="addpane__bar">
        <span className="addpane__project" title={project.root}>
          {project.name}
        </span>
        <span className="addpane__slash" aria-hidden="true">
          /
        </span>
        <span className="addpane__title">New worktree</span>
      </div>
      <div className="addpane__body">
        <div className="field">
          <label className="field__label" htmlFor={`branch-${project.id}`}>
            Branch
          </label>
          <input
            id={`branch-${project.id}`}
            ref={branchRef}
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

        {error && <p className="addpane__error">{error}</p>}
      </div>
      <div className="addpane__foot">
        <span className="addpane__where" title={directory}>
          {directory}
        </span>
        <button className="btn" onClick={submit} disabled={busy || branch.trim() === ''}>
          Create
        </button>
      </div>
    </div>
  )
}
