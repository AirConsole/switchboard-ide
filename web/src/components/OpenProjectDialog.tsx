import { useEffect, useState } from 'react'
import { ApiError, api, type BrowseResult } from '../api.js'

export interface OpenProjectDialogProps {
  onClose: () => void
  onOpened: () => void
}

/** A path the user asked for that does not exist yet. */
interface MissingPath {
  path: string
  /** Set when creating here would nest a repository inside another one. */
  insideRepo: string | null
}

/**
 * Folder picker for opening a project.
 *
 * It reads as a path list in the vernacular of the thing it browses: monospace
 * rows, with repositories called out so the one directory you can actually open
 * is obvious before you click it.
 *
 * Typing a path that does not exist is treated as intent to start a new project
 * rather than as a mistake, so it asks to create it instead of dead-ending.
 */
export const OpenProjectDialog = ({
  onClose,
  onOpened,
}: OpenProjectDialogProps): React.ReactElement => {
  const [listing, setListing] = useState<BrowseResult | null>(null)
  const [path, setPath] = useState('')
  const [missing, setMissing] = useState<MissingPath | null>(null)
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
      .openProject(target, { create })
      .then(() => onOpened())
      .catch((err: unknown) => {
        setBusy(false)
        if (err instanceof ApiError && err.code === 'path-missing') {
          setMissing({
            path: typeof err.details.path === 'string' ? err.details.path : target,
            insideRepo:
              typeof err.details.insideRepo === 'string' ? err.details.insideRepo : null,
          })
          setError(null)
          return
        }
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  if (missing) {
    return (
      <div className="scrim" onClick={onClose}>
        <div className="dialog" onClick={(event) => event.stopPropagation()}>
          <div className="dialog__head">
            <h2 className="dialog__title">Create this project?</h2>
          </div>
          <div className="dialog__body">
            <p className="empty__body">Nothing exists at this path yet.</p>
            <p className="field__hint">{missing.path}</p>
            <p className="empty__body">
              Creating it makes the directory and initialises a git repository with an empty first
              commit, so you can branch a worktree straight away.
            </p>
            {missing.insideRepo && (
              <p className="field__hint" style={{ color: 'var(--signal)' }}>
                This puts a new repository inside {missing.insideRepo}, which is usually not what
                you want. To work on that repository, open it instead.
              </p>
            )}
          </div>
          <div className="dialog__foot">
            <button className="btn btn--quiet" onClick={() => setMissing(null)}>
              Back
            </button>
            <button className="btn" onClick={() => open(missing.path, true)} disabled={busy}>
              Create and open
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
              that does not exist yet can be created.
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
