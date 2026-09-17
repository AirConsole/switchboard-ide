import type { Session, Worktree, WorktreeTodo } from '@switchboard/shared'

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
 * What a bar standing for several worktrees says, if anything.
 *
 * Two states only, and no ranking between the rest: **amber if anything here
 * needs you, else green if anything here has come to rest**, else nothing. A
 * summary that is always lit is not a summary, so working and not-running are
 * silent -- and silence is the common case, which is what makes the two
 * colours worth scanning for.
 *
 * Deliberately not `mostUrgentStatus`, which ranks *working* above *idle* and
 * is right for "what is the single most urgent thing here". Composed with the
 * amber-or-green clamp it went wrong in a way nobody would predict: a project
 * with one worktree at rest and one working reported *nothing*, because the
 * working one won the ranking and then said nothing. A busy neighbour must not
 * mask a finished agent.
 */
export const summarySignal = (
  statuses: WorktreeStatus[],
): 'needs-you' | 'idle' | null =>
  statuses.includes('needs-you') ? 'needs-you' : statuses.includes('idle') ? 'idle' : null

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
  /** The same question again, of the copy on the remote. */
  remoteBranch: boolean
  /** The copy on the remote goes unasked, for the same reason the branch does. */
  remoteBranchGoesAnyway: boolean
}

export const removalQuestions = (worktree: Worktree): RemovalQuestions => {
  /*
   * `unmerged` is optional on the model, and absent is not the same as zero:
   * a server that did not send it has not told us the branch is spent, so the
   * question stands. A detached HEAD has no branch to ask about at all.
   */
  const unmerged = worktree.unmerged === undefined || worktree.unmerged > 0
  /*
   * And the same of the remote, read the same cautious way round: a branch is
   * only spent when the server said so. `remoteBranch` absent is the whole
   * answer for a branch that was never pushed -- there is nothing on a remote
   * to ask about, so neither half is true and the dialog says nothing about it.
   */
  const onRemote = worktree.remoteBranch !== undefined
  const remoteSpent = worktree.remoteBranchMerged === true
  return {
    discard: (worktree.dirty ?? 0) > 0,
    branch: worktree.branch !== null && unmerged,
    branchGoesAnyway: worktree.branch !== null && !unmerged,
    remoteBranch: onRemote && !remoteSpent,
    remoteBranchGoesAnyway: onRemote && remoteSpent,
  }
}

/**
 * Something removal destroys that git will not mention.
 *
 * The questions above are about the repository; these are about what is
 * *running*, and they are warnings rather than questions because there is
 * nothing to decide: a turn in progress, a queue waiting to be typed in and a
 * terminal's scrollback all go, whatever you answer. They exist so that the
 * dialog opens at all -- a worktree can be clean and merged, and so have
 * nothing for git to ask about, while an agent is mid-turn in it with four
 * todos lined up behind it, and that click used to remove it outright.
 */
export interface RemovalWarning {
  key: 'claude' | 'todos' | 'terminals'
  text: string
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`

export const removalWarnings = (
  worktree: Worktree,
  sessions: Session[],
  todos: WorktreeTodo[],
): RemovalWarning[] => {
  const warnings: RemovalWarning[] = []
  /*
   * An idle Claude is not a warning: it is sitting at its prompt with nothing
   * to lose but the conversation, which is what removing a worktree means.
   * Working and needs-you both are -- one loses a turn mid-flight, the other a
   * question nobody answered.
   */
  const status = worktreeStatus(sessions, worktree.id)
  if (status === 'working') {
    warnings.push({ key: 'claude', text: 'Claude is working here. Its turn is killed mid-flight.' })
  } else if (status === 'needs-you') {
    warnings.push({
      key: 'claude',
      text: 'Claude is waiting for an answer here. The question goes unanswered.',
    })
  }

  const mine = todos.filter((todo) => todo.worktreeId === worktree.id)
  if (mine.length > 0) {
    const queued = mine.filter((todo) => todo.queuedAt !== undefined).length
    const run = queued === 0 ? '' : `, ${queued} queued to run next`
    warnings.push({
      key: 'todos',
      text: `${plural(mine.length, 'todo')} here${run}. They go with the worktree.`,
    })
  }

  const terminals = terminalSessions(sessions, worktree.id).filter(isRunning)
  if (terminals.length > 0) {
    const it = terminals.length === 1 ? 'it' : 'them'
    warnings.push({
      key: 'terminals',
      text: `${plural(terminals.length, 'terminal')} still running. Whatever is in ${it} is killed, scrollback included.`,
    })
  }
  return warnings
}

/**
 * Whether removal has anything to say, and so whether to open its dialog.
 *
 * Questions or warnings: the dialog is worth two clicks either to decide
 * something or to be told something irreversible is about to happen. Only a
 * worktree that is clean, merged, running nothing and holding nothing goes
 * without it.
 */
export const removalAsks = (
  worktree: Worktree,
  sessions: Session[],
  todos: WorktreeTodo[],
): boolean => {
  const questions = removalQuestions(worktree)
  if (questions.discard || questions.branch || questions.remoteBranch) return true
  return removalWarnings(worktree, sessions, todos).length > 0
}

/**
 * Just enough of a project's run of windows to answer the question below.
 * Structural on purpose: `ProjectGroup` is `App`'s, and `App` imports this.
 */
interface Run {
  project: { id: string }
  awake: { id: string }[]
}

/** Where the keyboard goes when the window you are in is removed. */
export type RemovalLanding =
  | { kind: 'worktree'; id: string }
  | { kind: 'project'; id: string }
  | null

/**
 * Where a removal leaves you: the neighbouring worktree **in the same
 * project**, and that project's own pane when it was the last one awake.
 *
 * The one after it, or the one before it when it was the last -- where the eye
 * already is, and where a Cmd+arrow step from the gap would have taken you.
 *
 * Scoped to the project rather than to the row, because the row is every
 * project's windows in a line: "the next one" across the whole row is the first
 * window of the *next project* whenever you remove a project's last worktree,
 * which is somebody else's work and nowhere you asked to be.
 *
 * The project's pane is the fallback because it is the head of that run and is
 * there whether or not anything else is -- the one landing a removal can always
 * promise -- and it is where you go to make the next worktree, which is often
 * why the last one went. `null` only when the worktree is in no run at all,
 * which leaves the caller nothing to say.
 *
 * Answered against the row as it still stands, with the worktree being removed
 * still in it: it is the refresh afterwards that drops it.
 */
export const removalLanding = (runs: Run[], worktreeId: string): RemovalLanding => {
  const mine = runs.find((run) => run.awake.some((w) => w.id === worktreeId))
  if (mine === undefined) return null
  const at = mine.awake.findIndex((w) => w.id === worktreeId)
  const next = mine.awake[at + 1] ?? (at > 0 ? mine.awake[at - 1] : undefined)
  return next === undefined
    ? { kind: 'project', id: mine.project.id }
    : { kind: 'worktree', id: next.id }
}

/**
 * Whether a drained queue takes the keyboard with it.
 *
 * RUN NEXT types a worktree's todos into its Claude and the panel closes when
 * the last one goes. Only the window whose **todo pane you were in** hands the
 * keyboard on -- to its own Claude, which is where the prompt just went and
 * where you were already looking.
 *
 * Anywhere else it must not move: a queue drains on the server whether or not a
 * browser is open, so this fires in windows you are not in, minutes after you
 * queued anything, while you are reading a diff or typing in another agent. It
 * used to move regardless, which scrolled the row to a worktree you had not
 * asked about and took the caret out of whatever you were writing.
 *
 * The case it keeps is the one that has to be kept: the pane you are in is
 * being unmounted, and focus left alone falls to the body, which is where the
 * row's own keys stop working.
 */
export const drainTakesKeyboard = (
  active: { id: string; pane: string } | null,
  worktreeId: string,
): boolean => active?.id === worktreeId && active.pane === 'todo'

/**
 * The worktree to wake when a project is opened with nothing of it awake.
 *
 * A project that arrives with every worktree asleep has no window in the row,
 * so opening it looked like it had done nothing -- a new folder especially,
 * which has nothing running to seed from. Its main worktree is the one that
 * always exists. A project that already has something awake -- opened again
 * with its agents left running -- is left exactly as it was.
 */
export const worktreeToWakeOnOpen = (
  projectId: string,
  worktrees: readonly Worktree[],
  sessions: readonly Session[],
): string | null => {
  const mine = worktrees.filter((w) => w.projectId === projectId)
  const isAwake = (w: Worktree): boolean => w.awake ?? sessions.some((s) => s.worktreeId === w.id)
  if (mine.some(isAwake)) return null
  return (mine.find((w) => w.isMain) ?? mine[0])?.id ?? null
}
