import type {
  AppSnapshot,
  FileContent,
  FileHit,
  FileListing,
  FileSaved,
  FileUnchanged,
  Project,
  RecentProject,
  Session,
  UiState,
  Usage,
  Worktree,
  WorktreeChanges,
  WorktreeTodo,
} from '@switchboard/shared'

/**
 * A failed request, carrying the server's machine-readable `code` so callers can
 * offer a specific recovery rather than only showing the message.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  })
  if (!response.ok) {
    // The server puts the useful text in `error`; surfacing it beats a bare 400.
    const body: unknown = await response.json().catch(() => null)
    if (body && typeof body === 'object') {
      const { error, code, ...details } = body as {
        error?: unknown
        code?: unknown
        [key: string]: unknown
      }
      throw new ApiError(
        error === undefined ? `${response.status} ${response.statusText}` : String(error),
        response.status,
        typeof code === 'string' ? code : undefined,
        details,
      )
    }
    throw new ApiError(`${response.status} ${response.statusText}`, response.status)
  }
  return (await response.json()) as T
}

export interface BrowseResult {
  path: string
  parent: string | null
  entries: { name: string; path: string; isRepo: boolean }[]
}

/** A machine this server can read from, as the picker sees it. */
export interface ServerRow {
  /** The short key that scopes its ids; what `host` takes everywhere. */
  key: string
  baseUrl: string
  name: string
  /** That machine no longer accepts this one; linking it again fixes it. */
  refused?: boolean
}

export const api = {
  /**
   * A single-use ticket for the next socket upgrade.
   *
   * The socket does not take the session cookie -- see `socket.ts` -- so this
   * is what opens it. Throwing on 401 is load-bearing: the caller reads that as
   * "signed out" and shows a login, rather than retrying forever.
   */
  async wsTicket(): Promise<string> {
    const { ticket } = await request<{ ticket: string }>('/api/ws-ticket', { method: 'POST' })
    return ticket
  },

  async login(password: string): Promise<void> {
    await request<{ ok: true }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    })
  },

  async logout(): Promise<void> {
    await request<{ ok: true }>('/api/logout', { method: 'POST' })
  },

  snapshot: () => request<AppSnapshot>('/api/snapshot'),

  /** Claude's usage limits. The server caches these for five minutes. */
  usage: () => request<Usage>('/api/usage'),
  /**
   * Closed projects, newest first; already filtered to ones still on disk.
   *
   * `host` names a machine the server holds a pointer to, and everything about
   * reaching it is the server's business -- this is still our own origin. That
   * is the whole of what the browser knows about remote projects.
   */
  recents: (host?: string) =>
    request<RecentProject[]>(`/api/recents${host === undefined ? '' : `?host=${host}`}`),
  browse: (path: string, host?: string) =>
    request<BrowseResult>(
      `/api/browse?path=${encodeURIComponent(path)}${host === undefined ? '' : `&host=${host}`}`,
    ),

  /**
   * The machines this one is linked to.
   *
   * Linking is the whole of the relationship: everything open on a linked
   * machine is open here. There is nothing to subscribe to per project, and
   * nothing here records one -- a remote project arrives in the snapshot under
   * that machine's own id.
   */
  servers: () => request<ServerRow[]>('/api/servers'),
  addServer: (input: { baseUrl: string; password: string }) =>
    request<ServerRow>('/api/servers', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  forgetServer: (baseUrl: string) =>
    request<{ ok: true }>('/api/servers', {
      method: 'DELETE',
      body: JSON.stringify({ baseUrl }),
    }),

  openProject: (
    path: string,
    opts: { create?: boolean; commitExisting?: boolean; host?: string } = {},
  ) =>
    request<Project>(`/api/projects${opts.host === undefined ? '' : `?host=${opts.host}`}`, {
      method: 'POST',
      body: JSON.stringify({
        path,
        create: opts.create ?? false,
        commitExisting: opts.commitExisting ?? true,
      }),
    }),
  /** Close a project. `sleep` stops every session it is running on the way out. */
  closeProject: (id: string, opts: { sleep: boolean }) =>
    request<{ ok: true }>(`/api/projects/${id}?sleep=${opts.sleep}`, { method: 'DELETE' }),
  patchUi: (patch: Partial<UiState>) =>
    request<UiState>('/api/ui', { method: 'PATCH', body: JSON.stringify(patch) }),
  /** Whether that branch is already there, so the form can say what it will do. */
  describeBranch: (projectId: string, name: string) =>
    request<{ valid: boolean; exists: boolean; usedBy?: string }>(
      `/api/projects/${projectId}/branch?name=${encodeURIComponent(name)}`,
    ),
  createWorktree: (body: { projectId: string; branch: string; base?: string; startClaude: boolean }) =>
    request<{ worktree: Worktree; sessions: Session[] }>('/api/worktrees', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeWorktree: (
    id: string,
    opts: { force: boolean; deleteBranch: boolean; deleteRemoteBranch: boolean },
  ) =>
    request<{ ok: true }>(
      `/api/worktrees/${id}?force=${opts.force}&deleteBranch=${opts.deleteBranch}` +
        `&deleteRemoteBranch=${opts.deleteRemoteBranch}`,
      { method: 'DELETE' },
    ),
  /** Stop what a worktree is running. Either half can be kept alive. */
  sleepWorktree: (worktreeId: string, keep: { claude: boolean; terminals: boolean }) =>
    request<{ ok: true; sessions: Session[] }>(
      `/api/worktrees/${worktreeId}/sleep?keepClaude=${keep.claude}&keepTerminals=${keep.terminals}`,
      { method: 'POST' },
    ),

  /** Make sure Claude is running in a worktree, resuming its conversation. */
  wakeWorktree: (worktreeId: string) =>
    request<{ ok: true; session?: Session }>(`/api/worktrees/${worktreeId}/wake`, {
      method: 'POST',
    }),

  /**
   * The last lines a dead session printed, for saying why it stopped. Asked for
   * only when something has stopped, so it is not part of the snapshot.
   */
  sessionTail: (sessionId: string) =>
    request<{ lines: string[] }>(`/api/sessions/${sessionId}/tail`),

  changes: (worktreeId: string) =>
    request<WorktreeChanges>(`/api/worktrees/${worktreeId}/changes`),

  /** The patch for one uncommitted file, or for one commit. */
  diff: (
    worktreeId: string,
    what: { file: string; untracked: boolean; from?: string } | { commit: string },
  ) => {
    const query =
      'commit' in what
        ? `commit=${encodeURIComponent(what.commit)}`
        : `file=${encodeURIComponent(what.file)}&untracked=${what.untracked}` +
          (what.from === undefined ? '' : `&from=${encodeURIComponent(what.from)}`)
    return request<{ patch: string }>(`/api/worktrees/${worktreeId}/diff?${query}`)
  },

  /*
   * Todos are read from the snapshot, not fetched: every one of these mutations
   * makes the server broadcast an invalidate, which refetches it. A GET here
   * would be a second answer to a question the snapshot already answers.
   */
  createTodo: (worktreeId: string, body: { prompt: string }) =>
    request<WorktreeTodo>(`/api/worktrees/${worktreeId}/todos`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** `queued` is the RUN NEXT toggle. */
  patchTodo: (id: string, patch: { prompt?: string; queued?: boolean; worktreeId?: string }) =>
    request<WorktreeTodo>(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTodo: (id: string) => request<{ ok: true }>(`/api/todos/${id}`, { method: 'DELETE' }),

  /** One directory of a worktree's files. `''` is its root. */
  tree: (worktreeId: string, path: string) =>
    request<FileListing>(
      `/api/worktrees/${worktreeId}/tree?path=${encodeURIComponent(path)}`,
    ),

  /**
   * Files whose path matches a fragment, anywhere in the worktree.
   *
   * The other half of `tree`, which only ever shows one directory: this is how
   * you reach a file whose directory you have never opened.
   */
  find: (worktreeId: string, q: string) =>
    request<{ hits: FileHit[]; truncated?: boolean }>(
      `/api/worktrees/${worktreeId}/find?q=${encodeURIComponent(q)}`,
    ),

  /**
   * One file's contents.
   *
   * `ifNotRev` is the rev already held, and makes this the follow-poll as well
   * as the first read: an unchanged file costs the server one stat and answers
   * `{ unchanged: true }` rather than sending the whole thing back every two
   * seconds.
   */
  readFile: (worktreeId: string, path: string, ifNotRev?: string) =>
    request<FileContent | FileUnchanged>(
      `/api/worktrees/${worktreeId}/file?path=${encodeURIComponent(path)}` +
        (ifNotRev === undefined ? '' : `&ifNotRev=${encodeURIComponent(ifNotRev)}`),
    ),

  /**
   * Where the browser fetches a media file's bytes from.
   *
   * A URL rather than a request, because what asks for it is an `<img src>`.
   * The rev goes in it so that a file the agent regenerates is a different URL:
   * the element repaints on the next poll instead of showing what the browser
   * still has.
   */
  /*
   * `rev` is a cache key and nothing else -- the server accepts it and does not
   * read it -- so it is optional: a Markdown preview's images have no poll of
   * their own to key one off, and the route answers `no-store` regardless.
   */
  rawFileUrl: (worktreeId: string, path: string, rev?: string) =>
    `/api/worktrees/${worktreeId}/raw?path=${encodeURIComponent(path)}` +
    (rev === undefined ? '' : `&rev=${encodeURIComponent(rev)}`),

  /**
   * The same bytes, to keep rather than to draw.
   *
   * `download=1` is what takes the media table off the answer, and it is the
   * only way the bytes of a file the panel would not open -- one past the size
   * cap, or one with no text in it -- ever leave the IDE. No rev: nothing
   * caches an attachment, and there is no element here to repaint.
   */
  downloadFileUrl: (worktreeId: string, path: string) =>
    `/api/worktrees/${worktreeId}/raw?path=${encodeURIComponent(path)}&download=1`,

  /**
   * Save a file, refused with 409 `stale-file` if it moved since it was read.
   *
   * There is no force flag: the refusal carries the file's current rev, so
   * overwriting deliberately is the same call again with that rev.
   */
  writeFile: (worktreeId: string, body: { path: string; text: string; ifRev: string }) =>
    request<FileSaved>(`/api/worktrees/${worktreeId}/file`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  createSession: (body: { worktreeId: string; kind: 'claude' | 'shell'; title?: string }) =>
    request<Session>('/api/sessions', { method: 'POST', body: JSON.stringify(body) }),
  killSession: (id: string) => request<{ ok: true }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  respawnSession: (id: string) =>
    request<Session>(`/api/sessions/${id}/respawn`, { method: 'POST' }),
}
