import { useEffect, useRef, useState } from 'react'
import type { RecentProject } from '@switchboard/shared'
import { ApiError, api, type BrowseResult, type ServerRow } from '../api.js'
import { useEscape } from './useEscape.js'

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
 *
 * Above all of it sit the projects you have closed, because closing one costs
 * nothing but the path, and walking the tree back down to it is the whole of
 * that cost.
 */
/**
 * Address and token for a machine to add.
 *
 * The token is this server's credential for the peer, not the user's: it is
 * handed over once and never comes back, which is why the field is emptied the
 * moment it is submitted rather than left to be read off the screen.
 */
const AddServer = ({
  busy,
  onAdd,
}: {
  busy: boolean
  onAdd: (baseUrl: string, token: string) => void
}): React.ReactElement => {
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const submit = (): void => {
    if (baseUrl.trim() === '') return
    onAdd(baseUrl.trim(), token)
    setToken('')
  }
  return (
    <div className="addserver">
      <input
        className="field__input"
        placeholder="http://box.local:8084"
        value={baseUrl}
        spellCheck={false}
        autoFocus
        onChange={(event) => setBaseUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
      />
      <input
        className="field__input"
        placeholder="token"
        type="password"
        value={token}
        spellCheck={false}
        onChange={(event) => setToken(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
      />
      <button className="btn" onClick={submit} disabled={busy || baseUrl.trim() === ''}>
        Add
      </button>
      <span className="field__hint">
        That machine&apos;s <code>SWB_TOKEN</code>. It is kept here and sent from this server; your
        browser never talks to it.
      </span>
    </div>
  )
}

export const OpenProjectDialog = ({
  onClose,
  onOpened,
}: OpenProjectDialogProps): React.ReactElement => {
  useEscape(onClose)
  const [listing, setListing] = useState<BrowseResult | null>(null)
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [path, setPath] = useState('')
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [commitExisting, setCommitExisting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * Which machine the picker is looking at. `undefined` is this one.
   *
   * Nothing else in the dialog changes with it: the listing, the recents and
   * opening all take it and the server decides what it means. The browser is
   * still talking to one origin.
   */
  const [host, setHost] = useState<string | undefined>(undefined)
  const [servers, setServers] = useState<ServerRow[]>([])
  const [adding, setAdding] = useState(false)

  /*
   * Which read is the current one.
   *
   * A machine that is slow to answer would otherwise overwrite a machine that
   * was quick: switch away from a remote peer and the local listing lands
   * first, the peer's lands second, and the chip says "This machine" over the
   * peer's disk -- with Open then targeting whichever the chip says.
   */
  const reads = useRef(0)

  const browse = (next: string, on = host): void => {
    const read = ++reads.current
    void api
      .browse(next, on)
      .then((result) => {
        if (read !== reads.current) return
        setListing(result)
        setPath(result.path)
        setError(null)
      })
      .catch((err: unknown) => {
        if (read !== reads.current) return
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  useEffect(() => browse('', host), [host])
  // Not fatal if it fails: the picker below opens any project this can.
  useEffect(() => {
    const read = reads.current
    void api
      .recents(host)
      .then((rows) => {
        if (read === reads.current) setRecents(rows)
      })
      .catch(() => {
        if (read === reads.current) setRecents([])
      })
  }, [host])
  const loadServers = (): void => {
    void api
      .servers()
      .then(setServers)
      .catch(() => {})
  }
  useEffect(loadServers, [])

  /**
   * Add a machine, then look at it.
   *
   * The token is asked for here and goes no further than this server, which
   * keeps it and speaks to the peer itself. Nothing about a peer is ever
   * reached from the browser.
   */
  const addServer = (baseUrl: string, token: string): void => {
    if (busy) return
    setBusy(true)
    void api
      .addServer({ baseUrl, ...(token.trim() === '' ? {} : { token: token.trim() }) })
      .then((server) => {
        setBusy(false)
        setAdding(false)
        setError(null)
        /*
         * Added to the list in the same render that selects it. Refreshing the
         * list from the server instead left `host` naming a machine `servers`
         * did not have yet, and `open()` reads `servers` to decide local versus
         * remote -- so clicking a directory in that window opened the peer's
         * path on *this* machine, and with "create" that is mkdir and git init
         * in the wrong place.
         */
        setServers((rows) =>
          rows.some((row) => row.key === server.key) ? rows : [...rows, server],
        )
        setHost(server.key)
      })
      .catch((err: unknown) => {
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  const open = (target: string, create = false): void => {
    // The buttons are disabled while a request is in flight; Enter has to
    // respect the same rule, or key repeat sends several opens whose failures
    // are swallowed when the dialog unmounts.
    if (busy) return
    setBusy(true)
    const server = servers.find((row) => row.key === host)
    // Two calls presented as one action, and they go to different machines: the
    // peer opens the project, because its git and its tmux are what will run
    // it, and then this server records the pointer so it survives a reload.
    const request =
      server === undefined
        ? api.openProject(target, { create, commitExisting })
        : api
            .openProject(target, { create, commitExisting, host: server.key })
            .then((project) =>
              api
                .openRemoteProject({
                  baseUrl: server.baseUrl,
                  root: project.root,
                  name: project.name,
                })
                // The peer has it and we do not, which is a real state and one
                // the user can act on -- adding it again will now succeed,
                // because the peer's own open is idempotent.
                .catch((err: unknown) => {
                  throw new Error(
                    `Opened on ${server.name}, but this machine could not record it: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  )
                }),
            )
    void request
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
          {/*
            * Which machine, before which directory -- the listing below is that
            * machine's disk, so choosing it second would mean browsing one and
            * opening on another.
            */}
          <div className="field">
            <span className="field__label">Machine</span>
            <div className="chips">
              <button
                className={host === undefined ? 'chip chip--on' : 'chip'}
                onClick={() => setHost(undefined)}
                disabled={busy}
              >
                This machine
              </button>
              {servers.map((server) => (
                <span key={server.key} className="chips__pair">
                  <button
                    className={host === server.key ? 'chip chip--on' : 'chip'}
                    onClick={() => setHost(server.key)}
                    disabled={busy}
                    title={server.baseUrl}
                  >
                    {server.name}
                  </button>
                  <button
                    className="chip chip--drop"
                    title={`Forget ${server.baseUrl}`}
                    aria-label={`Forget ${server.name}`}
                    disabled={busy}
                    onClick={() => {
                      if (host === server.key) setHost(undefined)
                      void api.forgetServer(server.baseUrl).then(loadServers).catch(() => {})
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
              <button className="chip" onClick={() => setAdding(!adding)} disabled={busy}>
                {adding ? 'Cancel' : '+ Add'}
              </button>
            </div>
            {adding && <AddServer busy={busy} onAdd={addServer} />}
          </div>

          {recents.length > 0 && (
            <div className="field">
              <span className="field__label">Recently closed</span>
              <div className="picker">
                {recents.map((recent) => (
                  <button
                    key={recent.root}
                    className="picker__row picker__row--repo"
                    onClick={() => open(recent.root)}
                    disabled={busy}
                    title={recent.root}
                  >
                    {recent.root}
                    <span className="picker__tag">open</span>
                  </button>
                ))}
              </div>
            </div>
          )}

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
