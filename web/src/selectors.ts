import type { Session, Worktree, WorktreeTodo } from '@ide-n-dream/shared'

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

/** A worktree's todo, with where it sits in that worktree's run queue. */
export interface TodoView {
  todo: WorktreeTodo
  /** 1-based place in the queue, or null when RUN NEXT is off. */
  position: number | null
}

/**
 * One worktree's todos, oldest first, each with its queue position.
 *
 * The list keeps creation order even as things are queued: sorting queued ones
 * to the top would move a row out from under the pointer that just queued it,
 * and take the focus of anything being edited in it with it. The position and
 * the queued row's own mark carry the order instead.
 */
export const worktreeTodos = (todos: WorktreeTodo[], worktreeId: string): TodoView[] => {
  const mine = todos.filter((t) => t.worktreeId === worktreeId)
  const queue = mine
    .filter((t) => t.queuedAt !== undefined)
    .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))
  return [...mine]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((todo) => {
      const at = queue.indexOf(todo)
      return { todo, position: at === -1 ? null : at + 1 }
    })
}

/** How many of a worktree's todos are waiting to be typed into Claude. */
export const queuedTodoCount = (todos: WorktreeTodo[], worktreeId: string): number =>
  todos.filter((t) => t.worktreeId === worktreeId && t.queuedAt !== undefined).length

/**
 * What removing a worktree still has to ask about.
 *
 * Both halves of "is there anything of yours left in here" answer a question
 * the dialog would otherwise put to you for nothing: uncommitted work is what
 * makes git refuse the removal without `--force`, and commits the default
 * branch does not have are what make deleting the branch a decision rather
 * than tidying up. With neither, the removal takes nothing with it that is not
 * already on the default branch -- so nothing is asked, and the caller can
 * skip the dialog altogether.
 */
export interface RemovalQuestions {
  /** Uncommitted work is here, so discarding it has to be opted into. */
  discard: boolean
  /** Unmerged commits are here, so whether the branch goes is a choice. */
  branch: boolean
  /** The branch goes without being asked about: it holds nothing of its own. */
  branchGoesAnyway: boolean
}

export const removalQuestions = (worktree: Worktree): RemovalQuestions => {
  /*
   * `unmerged` is optional on the model, and absent is not the same as zero:
   * a server that did not send it has not told us the branch is spent, so the
   * question stands. A detached HEAD has no branch to ask about at all.
   */
  const unmerged = worktree.unmerged === undefined || worktree.unmerged > 0
  return {
    discard: (worktree.dirty ?? 0) > 0,
    branch: worktree.branch !== null && unmerged,
    branchGoesAnyway: worktree.branch !== null && !unmerged,
  }
}

/** Whether removal has anything to ask, and so whether to open its dialog. */
export const removalAsks = (worktree: Worktree): boolean => {
  const questions = removalQuestions(worktree)
  return questions.discard || questions.branch
}
