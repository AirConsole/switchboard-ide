import { useEffect, useRef, useState } from 'react'
import type { Project, RecentProject } from '@switchboard/shared'
import { ApiError, api, type BrowseResult, type ServerRow } from '../api.js'
import { useEscape } from './useEscape.js'
import { useDialogKeys } from './useDialogKeys.js'
import { useStore } from '../store.js'
import { machineHasProjects } from '../selectors.js'

export interface OpenProjectDialogProps {
  onClose: () => void
  /** With the project when one was opened, so the row can wake something of it. */
  onOpened: (project?: Project) => void
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
 * Address and password for a machine to link.
 *
 * The password is that machine's, typed once. It goes to this server, which
 * logs in to the machine with it and keeps the link token it gets back -- the
 * password itself is kept nowhere. It is emptied from the field the moment it
 * is submitted rather than left to be read off the screen.
 */
const AddServer = ({
  busy,
  initialUrl,
  onAdd,
}: {
  busy: boolean
  /** Filled in when linking a machine again, which is the same form. */
  initialUrl?: string
  onAdd: (baseUrl: string, password: string) => void
}): React.ReactElement => {
  const [baseUrl, setBaseUrl] = useState(initialUrl ?? '')
  const [password, setPassword] = useState('')
  const submit = (): void => {
    if (baseUrl.trim() === '' || password === '') return
    onAdd(baseUrl.trim(), password)
    setPassword('')
  }
  return (
    // Its Enter is its own; see `useDialogKeys`.
    <div className="addserver" data-own-enter>
      <input
        className="field__input"
        placeholder="http://box.local:8083"
        value={baseUrl}
        spellCheck={false}
        autoFocus={initialUrl === undefined}
        onChange={(event) => setBaseUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
      />
      <input
        className="field__input"
        placeholder="its password"
        type="password"
        autoComplete="off"
        value={password}
        autoFocus={initialUrl !== undefined}
        onChange={(event) => setPassword(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
      />
      <button
        className="btn"
        onClick={submit}
        disabled={busy || baseUrl.trim() === '' || password === ''}
      >
        {initialUrl === undefined ? 'Link' : 'Link again'}
      </button>
      <span className="field__hint">
        That machine&apos;s own password. This server signs in to it once and keeps the link it
        gets back, not the password; your browser never talks to that machine. Over plain{' '}
        <code>http://</code> only addresses on your own network are accepted.
      </span>
    </div>
  )
}

export const OpenProjectDialog = ({
  onClose,
  onOpened,
}: OpenProjectDialogProps): React.ReactElement => {
  useEscape(onClose)
  const signOut = useStore((state) => state.signOut)
  const box = useRef<HTMLDivElement | null>(null)
  /* No initial focus: this one is a form, and the hand that opened it is
     aiming at the path field rather than at an answer. */
  useDialogKeys(box, { focus: false })
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
  /** The machine being linked again, if any. */
  const [relinking, setRelinking] = useState<string | null>(null)
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
  /** Its own generation: `browse` is called again on every click, and a shared
   * counter then discarded the recents reply that was still on its way -- so
   * one machine's closed projects sat under another machine's chip until you
   * switched again. */
  const recentReads = useRef(0)

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

  /*
   * Emptied before the new machine answers, not after.
   *
   * Left up, they are another machine's directories under this machine's chip,
   * and nothing about the screen says so -- a peer that is asleep takes the
   * full request timeout, and the error path leaves the old listing where it
   * was. Clicking one of those rows opened a path read from machine A on
   * machine B, and with "create" that is a mkdir and a git init in the wrong
   * place. Empty is honest; stale is not.
   */
  useEffect(() => {
    setListing(null)
    setRecents([])
    // The path too, and it is the stronger vector of the two: the listing is
    // only something to click, while this is what Open actually sends. A peer
    // that is asleep takes the full timeout and then errors, and a path read
    // from one machine sitting under another machine's chip with the button
    // live opens it there -- and "the same checkout path on two machines is the
    // normal case", so it usually succeeds, silently, on the wrong one.
    setPath('')
    setProposal(null)
    browse('', host)
  }, [host])

  // Not fatal if it fails: the picker below opens any project this can.
  useEffect(() => {
    const read = ++recentReads.current
    void api
      .recents(host)
      .then((rows) => {
        if (read === recentReads.current) setRecents(rows)
      })
      .catch(() => {
        if (read === recentReads.current) setRecents([])
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
  const addServer = (baseUrl: string, password: string): void => {
    if (busy) return
    setBusy(true)
    void api
      .addServer({ baseUrl, password })
      .then(async (server) => {
        /*
         * Its projects reach the row through the snapshot, so read it before
         * deciding. A machine with projects open is done: they are in the row
         * now, and the dialog closes onto them. See `machineHasProjects`.
         */
        await useStore
          .getState()
          .refresh()
          .catch(() => {})
        if (machineHasProjects(useStore.getState().projects, server.baseUrl)) {
          onOpened()
          return
        }
        setBusy(false)
        setAdding(false)
        setRelinking(null)
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
          rows.some((row) => row.key === server.key)
            ? rows.map((row) => (row.key === server.key ? { ...row, ...server, refused: false } : row))
            : [...rows, { ...server, refused: false }],
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
    if (host !== undefined && server === undefined) {
      /*
       * The chip says a machine the list no longer has -- another tab forgot it
       * while this dialog was open. Falling through opened *that machine's*
       * path here, and with "create" that is a mkdir and a git init in the
       * wrong place. It is the same vector `addServer` adds the row
       * synchronously to close; the refresh path left it open.
       */
      setError('That machine is no longer registered here.')
      // Unwound, like every other error path here. Left set, the chips, the
      // Add button, the rows and Enter are all dead and the only way out of
      // the dialog is Esc.
      setBusy(false)
      return
    }
    /*
     * One call, to the machine the project will live on.
     *
     * It used to be two -- open it there, then record a pointer here -- which
     * meant a half-open state nobody asked for: the peer had the project and
     * this machine did not. There is nothing to record now. A linked machine
     * contributes everything it has open, so opening it there *is* opening it
     * here, one snapshot later.
     */
    const request = api.openProject(target, {
      create,
      commitExisting,
      ...(server === undefined ? {} : { host: server.key }),
    })
    void request
      .then((project) => onOpened(project))
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
        <div className="dialog" ref={box} onClick={(event) => event.stopPropagation()}>
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
      <div className="dialog" ref={box} onClick={(event) => event.stopPropagation()}>
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
                  {server.refused && (
                    /*
                     * No colour: a machine that stopped accepting this one is
                     * not an agent blocked on you. Said in words, with the fix
                     * one click away.
                     */
                    <button
                      className="chip"
                      title={`${server.baseUrl} no longer accepts this machine -- its password probably changed`}
                      disabled={busy}
                      onClick={() => {
                        setAdding(false)
                        setRelinking(server.baseUrl)
                      }}
                    >
                      link again
                    </button>
                  )}
                  <button
                    className="chip chip--drop"
                    title={`Forget ${server.baseUrl}`}
                    aria-label={`Forget ${server.name}`}
                    disabled={busy}
                    onClick={() => {
                      // The refusal is the useful half -- a machine with
                      // projects open says so rather than taking them with it.
                      void api
                        .forgetServer(server.baseUrl)
                        .then(() => {
                          if (host === server.key) setHost(undefined)
                          setError(null)
                          loadServers()
                        })
                        .catch((err: unknown) =>
                          setError(err instanceof Error ? err.message : String(err)),
                        )
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
            {relinking !== null && (
              <AddServer key={relinking} busy={busy} initialUrl={relinking} onAdd={addServer} />
            )}
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
          {/*
           * Here rather than in the top bar, whose width is budgeted to the
           * pixel and gives things up in a fixed order as it narrows. This
           * dialog is already where the machine-level things live.
           */}
          <button className="btn btn--quiet dialog__aside" onClick={() => void signOut()}>
            Sign out
          </button>
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
