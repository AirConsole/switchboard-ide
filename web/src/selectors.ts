import type { Session, Worktree } from '@ide-n-dream/shared'

/** The Claude session for a worktree. There is at most one. */
export const claudeSession = (sessions: Session[], worktreeId: string): Session | undefined =>
  sessions.find((s) => s.worktreeId === worktreeId && s.kind === 'claude')

/**
 * The worktree's terminals.
 *
 * The wire calls these `shell` sessions, because the pane literally runs $SHELL
 * and that kind is recorded in tmux metadata that running sessions are adopted
 * by. The interface calls them terminals.
 */
export const terminalSessions = (sessions: Session[], worktreeId: string): Session[] =>
  sessions.filter((s) => s.worktreeId === worktreeId && s.kind === 'shell')

/**
 * What a worktree's Claude is doing, as one value.
 *
 * `off` covers both never started and exited: from outside, a worktree with no
 * agent running is a worktree with no agent running, and the tile says which it
 * is once you are looking at it.
 */
export type WorktreeStatus = 'needs-you' | 'working' | 'idle' | 'off'

export const worktreeStatus = (sessions: Session[], worktreeId: string): WorktreeStatus => {
  const claude = claudeSession(sessions, worktreeId)
  if (!claude || claude.liveness === 'dead') return 'off'
  if (claude.attention === 'needs-you') return 'needs-you'
  if (claude.attention === 'working') return 'working'
  return 'idle'
}

/**
 * The one status worth showing for a group of worktrees.
 *
 * In this order, because it is the order you want to be told: a worktree
 * blocked on you outranks one that is busy, which outranks one sitting idle,
 * which outranks one that is not running at all. A collapsed tab standing for
 * several worktrees can only carry one, so it carries the most urgent.
 */
const URGENCY: WorktreeStatus[] = ['needs-you', 'working', 'idle', 'off']

export const mostUrgentStatus = (statuses: WorktreeStatus[]): WorktreeStatus =>
  URGENCY.find((status) => statuses.includes(status)) ?? 'off'

/**
 * Main worktree first, then alphabetical, within one project.
 *
 * A stable order is the point: a tile is where you last saw it, which is what
 * lets the top bar be an index into a row that scrolls. The reorderable version
 * this replaces read a `tabOrder` that nothing ever wrote.
 */
export const orderWorktrees = (worktrees: Worktree[]): Worktree[] =>
  [...worktrees].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
    return a.name.localeCompare(b.name)
  })

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
