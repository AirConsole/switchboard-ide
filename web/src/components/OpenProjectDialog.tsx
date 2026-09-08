import { useEffect, useState } from 'react'
import { ApiError, api, type BrowseResult } from '../api.js'

export interface OpenProjectDialogProps {
  onClose: () => void
  onOpened: () => void
}

/**
 * A path that cannot be opened as-is, and what we would do about it.
 *
 * Both cases end in the same action -- make this path into a project -- but they
 * need different explanations, so they stay distinct rather than collapsing into
 * one vague "set up" message.
 */
type Proposal =
  | {
      kind: 'create'
      path: string
      /** Set when creating here would nest a repository inside another one. */
      insideRepo: string | null
    }
  | {
      kind: 'init'
      path: string
      /** Top-level entries already in the directory. */
      entries: number
      /** Heavy generated directories that a first commit would sweep in. */
      junk: string[]
    }

const readString = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback

const readNumber = (value: unknown): number => (typeof value === 'number' ? value : 0)

const readStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/**
 * Folder picker for opening a project.
 *
 * It reads as a path list in the vernacular of the thing it browses: monospace
 * rows, with repositories called out so the one directory you can actually open
 * is obvious before you click it.
 *
 * A path that does not exist, or a directory that is not a repository yet, is
 * treated as intent to start a project there rather than as a mistake, so the
 * dialog offers to set it up instead of dead-ending on an error.
 */
export const OpenProjectDialog = ({
  onClose,
  onOpened,
}: OpenProjectDialogProps): React.ReactElement => {
  const [listing, setListing] = useState<BrowseResult | null>(null)
  const [path, setPath] = useState('')
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [commitExisting, setCommitExisting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const browse = (next: string): void => {
    void api
      .browse(next)
      .then((result) => {
        setListing(result)
        setPath(result.path)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  useEffect(() => browse(''), [])

  const open = (target: string, create = false): void => {
    setBusy(true)
    void api
      .openProject(target, { create, commitExisting })
      .then(() => onOpened())
      .catch((err: unknown) => {
        setBusy(false)
        if (err instanceof ApiError && err.code === 'path-missing') {
          setError(null)
          setProposal({
            kind: 'create',
            path: readString(err.details.path, target),
            insideRepo:
              typeof err.details.insideRepo === 'string' ? err.details.insideRepo : null,
          })
          return
        }
        if (err instanceof ApiError && err.code === 'not-a-repo') {
          setError(null)
          setProposal({
            kind: 'init',
            path: readString(err.details.path, target),
            entries: readNumber(err.details.entries),
            junk: readStrings(err.details.junk),
          })
          return
        }
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  if (proposal) {
    return (
      <div className="scrim" onClick={onClose}>
        <div className="dialog" onClick={(event) => event.stopPropagation()}>
          <div className="dialog__head">
            <h2 className="dialog__title">
              {proposal.kind === 'create' ? 'Create this project?' : 'Start a project here?'}
            </h2>
          </div>
          <div className="dialog__body">
            <p className="empty__body">
              {proposal.kind === 'create'
                ? 'Nothing exists at this path yet.'
                : 'This directory is not a git repository yet.'}
            </p>
            <p className="field__hint">{proposal.path}</p>

            {proposal.kind === 'create' ? (
              <>
                <p className="empty__body">
                  Creating it makes the directory and initialises a git repository with an empty
                  first commit, so you can branch a worktree straight away.
                </p>
                {proposal.insideRepo && (
                  <p className="field__hint" style={{ color: 'var(--signal)' }}>
                    This puts a new repository inside {proposal.insideRepo}, which is usually not
                    what you want. To work on that repository, open it instead.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="empty__body">
                  {proposal.entries === 0
                    ? 'The directory is empty. Initialising makes a repository with an empty first commit, so you can branch a worktree straight away.'
                    : 'Initialising makes a repository here and commits once, so you can branch a worktree straight away.'}
                </p>
                {proposal.entries > 0 && (
                  <>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={commitExisting}
                        onChange={(event) => setCommitExisting(event.target.checked)}
                      />
                      Put the {proposal.entries} existing{' '}
                      {proposal.entries === 1 ? 'entry' : 'entries'} in that commit
                    </label>
                    {!commitExisting && (
                      <p className="field__hint">
                        Left out, the first commit has no files, so a new worktree starts empty
                        instead of containing your project.
                      </p>
                    )}
                    {commitExisting && proposal.junk.length > 0 && (
                      <p className="field__hint" style={{ color: 'var(--signal)' }}>
                        There is no .gitignore here, so this would commit {proposal.junk.join(', ')}
                        . Add a .gitignore first, or leave the files out and commit them yourself.
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </div>
          <div className="dialog__foot">
            <button className="btn btn--quiet" onClick={() => setProposal(null)}>
              Back
            </button>
            <button className="btn" onClick={() => open(proposal.path, true)} disabled={busy}>
              {proposal.kind === 'create' ? 'Create and open' : 'Initialise and open'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <h2 className="dialog__title">Open project</h2>
        </div>
        <div className="dialog__body">
          <div className="field">
            <label className="field__label" htmlFor="project-path">
              Repository path
            </label>
            <input
              id="project-path"
              className="field__input"
              value={path}
              spellCheck={false}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') open(path)
              }}
            />
            <span className="field__hint">
              Any directory inside a repository works; it resolves to the repository root. A path
              that does not exist, or is not a repository yet, can be set up as one.
            </span>
          </div>

          <div className="picker">
            {listing?.parent && (
              <button className="picker__row" onClick={() => browse(listing.parent!)}>
                ../
                <span className="picker__tag">up</span>
              </button>
            )}
            {listing?.entries.map((entry) => (
              <button
                key={entry.path}
                className={entry.isRepo ? 'picker__row picker__row--repo' : 'picker__row'}
                onClick={() => (entry.isRepo ? open(entry.path) : browse(entry.path))}
                title={entry.path}
              >
                {entry.name}/
                <span className="picker__tag">{entry.isRepo ? 'git repo' : 'browse'}</span>
              </button>
            ))}
          </div>

          {error && <p className="field__hint" style={{ color: 'var(--danger)' }}>{error}</p>}
        </div>
        <div className="dialog__foot">
          <button className="btn btn--quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={() => open(path)} disabled={busy || path.trim() === ''}>
            Open project
          </button>
        </div>
      </div>
    </div>
  )
}
