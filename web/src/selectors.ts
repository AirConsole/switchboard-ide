import type { Session, Worktree } from '@ide-n-dream/shared'

/** The Claude session for a worktree. There is at most one. */
export const claudeSession = (sessions: Session[], worktreeId: string): Session | undefined =>
  sessions.find((s) => s.worktreeId === worktreeId && s.kind === 'claude')

export const shellSessions = (sessions: Session[], worktreeId: string): Session[] =>
  sessions.filter((s) => s.worktreeId === worktreeId && s.kind === 'shell')

/**
 * A worktree needs you when Claude in it is blocked on an answer. This is the
 * value the whole overview is built around, so it is derived in one place.
 */
export const worktreeNeedsYou = (sessions: Session[], worktreeId: string): boolean =>
  sessions.some(
    (s) => s.worktreeId === worktreeId && s.kind === 'claude' && s.attention === 'needs-you',
  )

/** Main worktree first, then alphabetical, with the user's chip order applied. */
export const orderWorktrees = (worktrees: Worktree[], tabOrder: string[]): Worktree[] => {
  const rank = new Map(tabOrder.map((id, index) => [id, index]))
  return [...worktrees].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
    const ra = rank.get(a.id)
    const rb = rank.get(b.id)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.name.localeCompare(b.name)
  })
}

export const stateLabel = (session: Session | undefined): string => {
  if (!session) return 'not running'
  if (session.liveness === 'dead') {
    // A deliberate /exit reports 0; anything else is worth showing.
    return session.exitStatus ? `exited (${session.exitStatus})` : 'exited'
  }
  if (session.attention === 'needs-you') return 'needs you'
  if (session.attention === 'working') return 'working'
  return 'idle'
}

/** Whether a session is present AND still running. */
export const isRunning = (session: Session | undefined): boolean =>
  session !== undefined && session.liveness !== 'dead'
