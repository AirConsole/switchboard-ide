import type {
  AppSnapshot,
  FileContent,
  FileListing,
  FileSaved,
  FileUnchanged,
  Project,
  Session,
  UiState,
  Worktree,
  WorktreeChanges,
} from '@ide-n-dream/shared'

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

export const api = {
  snapshot: () => request<AppSnapshot>('/api/snapshot'),
  browse: (path: string) => request<BrowseResult>(`/api/browse?path=${encodeURIComponent(path)}`),
  openProject: (path: string, opts: { create?: boolean; commitExisting?: boolean } = {}) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        path,
        create: opts.create ?? false,
        commitExisting: opts.commitExisting ?? true,
      }),
    }),
  closeProject: (id: string) => request<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),
  patchUi: (patch: Partial<UiState>) =>
    request<UiState>('/api/ui', { method: 'PATCH', body: JSON.stringify(patch) }),
  createWorktree: (body: { projectId: string; branch: string; base?: string; startClaude: boolean }) =>
    request<{ worktree: Worktree; sessions: Session[] }>('/api/worktrees', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeWorktree: (id: string, opts: { force: boolean; deleteBranch: boolean }) =>
    request<{ ok: true }>(
      `/api/worktrees/${id}?force=${opts.force}&deleteBranch=${opts.deleteBranch}`,
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

  /** One directory of a worktree's files. `''` is its root. */
  tree: (worktreeId: string, path: string) =>
    request<FileListing>(
      `/api/worktrees/${worktreeId}/tree?path=${encodeURIComponent(path)}`,
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
