import type { AppSnapshot, Project, Session, UiState, Worktree } from '@ide-n-dream/shared'

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  })
  if (!response.ok) {
    // The server puts the useful text in `error`; surfacing it beats a bare 400.
    const body: unknown = await response.json().catch(() => null)
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `${response.status} ${response.statusText}`
    throw new Error(message)
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
  openProject: (path: string) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ path }) }),
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
  createSession: (body: { worktreeId: string; kind: 'claude' | 'shell'; title?: string }) =>
    request<Session>('/api/sessions', { method: 'POST', body: JSON.stringify(body) }),
  killSession: (id: string) => request<{ ok: true }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  respawnSession: (id: string) =>
    request<Session>(`/api/sessions/${id}/respawn`, { method: 'POST' }),
}
