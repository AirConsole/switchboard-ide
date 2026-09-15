import { useEffect, useRef, useState } from 'react'
import type { Project } from '@switchboard/shared'
import { api } from '../api.js'

export interface NewWorktreeFormProps {
  project: Project
  /** Bumped when the row navigates here, to hand the caret to the branch box. */
  focus: number | null
  onCreated: (worktreeId: string) => void
}

/**
 * Making a worktree: the foot of its project's pane, not a dialog over the row.
 *
 * It was a modal, and the modal was the wrong shape for what this is. A dialog
 * interrupts to ask one question and goes away; a project's "and one more"
 * never goes away, it is a standing offer under that project's list of windows.
 * Here the row keeps its own shape while you type, where a scrim hid the very
 * windows you were naming a branch against.
 *
 * It is one field. It had two more, and both were answering questions nobody
 * asks: **Branch from** was left empty every time, because the default -- the
 * remote's own default branch, or HEAD where there is no remote -- is what you
 * want unless you are doing something unusual, and something unusual is what
 * a terminal is for. **Start Claude here** was checked every time, because a
 * worktree with no agent in it is a directory, and the IDE is for the agents.
 * The server still takes both; this simply stops asking.
 *
 * There is no Cancel, because there is nothing to cancel back to: the pane is
 * part of the row whether or not you are using it. Escape is not taken either,
 * for the same reason -- it belongs to whatever a dialog is doing elsewhere.
 */
export const NewWorktreeForm = ({
  project,
  focus,
  onCreated,
}: NewWorktreeFormProps): React.ReactElement => {
  const [branch, setBranch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const branchRef = useRef<HTMLInputElement>(null)
  /*
   * What this name would do: check out a branch that is already there, or cut a
   * new one. `null` while nobody has typed anything or the answer is still in
   * flight, so the line under the field is empty rather than guessing.
   */
  const [fate, setFate] = useState<{
    valid: boolean
    exists: boolean
    usedBy?: string
  } | null>(null)

  /*
   * Arriving at a project means naming the next worktree often enough that the
   * caret belongs here. It is also what keeps the Cmd+arrow walk alive: the
   * stepper reads where it is from `activeElement`, so this pane has to hold
   * the keyboard somewhere, and a nonce rather than a boolean because coming
   * back to a pane you were already on has to hand it over again.
   */
  useEffect(() => {
    if (focus !== null) branchRef.current?.focus()
  }, [focus])

  /*
   * Asked a beat after you stop typing rather than per keystroke: it is one
   * `show-ref` on the server, but a name is typed a character at a time and
   * every one of those would be a request that is already stale.
   *
   * The guard is the branch itself rather than a counter -- a reply that is not
   * about what is in the field now is not worth showing, whichever order they
   * come back in.
   */
  useEffect(() => {
    const name = branch.trim()
    if (name === '') {
      setFate(null)
      return
    }
    let live = true
    const id = setTimeout(() => {
      void api
        .describeBranch(project.id, name)
        .then((answer) => {
          if (live) setFate(answer)
        })
        .catch(() => {
          // A question we could not ask is not an answer: say nothing rather
          // than claim the branch is new.
          if (live) setFate(null)
        })
    }, 250)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [branch, project.id])

  /*
   * Whether this name can be used at all.
   *
   * A branch is checked out in one worktree at a time, so a name already in use
   * is not slow -- it is refused, and git says so only after the button. `null`
   * while the answer is in flight, which is why this is a *known* no rather
   * than "not yet a yes": refusing on silence would make the button flicker
   * off on every keystroke.
   */
  const refused = fate !== null && (!fate.valid || fate.usedBy !== undefined)

  const submit = (): void => {
    // The button is disabled while a request is in flight; key repeat has to
    // respect the same rule, or holding Enter fires several creates whose
    // failures are swallowed as the pane re-renders.
    if (busy) return
    if (branch.trim() === '') return
    if (refused) return
    setBusy(true)
    void api
      .createWorktree({
        projectId: project.id,
        branch: branch.trim(),
        // No base: the server branches from the remote's default, or from HEAD
        // where there is no remote, which is what every use of this wanted.
        startClaude: true,
      })
      .then((result) => {
        // Emptied rather than left holding the name of a worktree that now
        // exists: the pane stays where it is, so the next thing typed into it
        // should be the next branch.
        setBranch('')
        setBusy(false)
        onCreated(result.worktree.id)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }

  const directory = `${project.worktreeRoot}/${branch.trim().replace(/\//g, '-') || '…'}`
  // What the server will branch from when the name is new.
  const base = project.defaultBase ?? 'HEAD'
  /*
   * Said relative to the project, because this line is read inside that
   * project's own pane and the absolute path is mostly its root repeated. It is
   * also what keeps the line to one row at this width -- see `.addform__fate`,
   * which reserves the room whether or not there is anything to put in it.
   */
  const near = (path: string): string =>
    path === project.root
      ? 'the project itself'
      : path.startsWith(`${project.root}/`)
        ? path.slice(project.root.length + 1)
        : path

  const says =
    fate === null
      ? ''
      : fate.usedBy !== undefined
        ? `“${branch.trim()}” is already checked out at ${near(fate.usedBy)}`
        : !fate.valid
          ? 'git will not take that as a branch name'
          : fate.exists
            ? `“${branch.trim()}” exists, so it is checked out rather than branched from ${base}`
            : `New branch, from ${base}`

  return (
    <div className="addform">
      <div className="addform__row">
        <input
          id={`branch-${project.id}`}
          ref={branchRef}
          className="field__input"
          value={branch}
          spellCheck={false}
          placeholder="branch-name"
          onChange={(event) => setBranch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
        <button
          className="btn"
          onClick={submit}
          disabled={busy || branch.trim() === '' || refused}
        >
          Create
        </button>
      </div>
      {/*
        * What the name means, and where it will land -- the two things you
        * cannot work out from the field itself. An existing branch is checked
        * out rather than cut from the default, which is the case that used to
        * be implied by a "Branch from" box left empty.
        */}
      <span className="addform__where" title={directory}>
        {directory}
      </span>
      {/* Always here, empty or not: the answer arrives a beat after you stop
          typing, and a line that appears then would shove the field you are
          still looking at. `.addform__fate` holds its two rows either way. */}
      <span
        className={
          refused || fate?.exists ? 'addform__fate addform__fate--on' : 'addform__fate'
        }
        title={fate?.usedBy ?? undefined}
      >
        {says}
      </span>
      {error && <p className="addform__error">{error}</p>}
    </div>
  )
}
