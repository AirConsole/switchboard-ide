import { describe, expect, it } from 'vitest'
import { MACHINE_WORKTREE_ID, type Project, type Session, type Worktree, type WorktreeTodo } from '@switchboard/shared'
import {
  worktreeToWakeOnOpen,
  machineHasProjects,
  claudeSession,
  drainTakesKeyboard,
  machineSession,
  isRunning,
  mostUrgentStatus,
  orderWorktrees,
  queuedTodoCount,
  removalAsks,
  removalLanding,
  removalQuestions,
  removalWarnings,
  stateLabel,
  summarySignal,
  terminalSessions,
  titleFor,
  worktreeStatus,
  worktreeTodos,
} from '../src/selectors.js'

const session = (over: Partial<Session> & Pick<Session, 'id' | 'worktreeId' | 'kind'>): Session => ({
  tmuxName: `swb-${over.id}`,
  title: 'x',
  cols: 80,
  rows: 24,
  liveness: 'live',
  attention: 'idle',
  lastOutputAt: 0,
  createdAt: 0,
  attachCommand: 'tmux attach',
  ...over,
})

const worktree = (over: Partial<Worktree> & Pick<Worktree, 'id'>): Worktree => ({
  projectId: 'p-1',
  name: over.id,
  branch: 'work',
  path: `/repo/${over.id}`,
  isMain: false,
  ...over,
})

const todo = (over: Partial<WorktreeTodo> & Pick<WorktreeTodo, 'id' | 'worktreeId'>): WorktreeTodo => ({
  prompt: 'do the thing',
  createdAt: 0,
  ...over,
})

describe('picking sessions out of a worktree', () => {
  const sessions = [
    session({ id: 's1', worktreeId: 'a', kind: 'claude' }),
    session({ id: 's2', worktreeId: 'a', kind: 'shell' }),
    session({ id: 's3', worktreeId: 'a', kind: 'shell' }),
    session({ id: 's4', worktreeId: 'b', kind: 'claude' }),
  ]

  it('finds the worktree’s one Claude', () => {
    expect(claudeSession(sessions, 'a')?.id).toBe('s1')
    expect(claudeSession(sessions, 'nope')).toBeUndefined()
  })

  it('finds its terminals, in order, and none of another worktree’s', () => {
    expect(terminalSessions(sessions, 'a').map((s) => s.id)).toEqual(['s2', 's3'])
    expect(terminalSessions(sessions, 'b')).toEqual([])
  })
})

describe('worktreeStatus', () => {
  const claude = (over: Partial<Session>): Session[] => [
    session({ id: 's1', worktreeId: 'a', kind: 'claude', ...over }),
  ]

  it('calls a worktree with no agent off', () => {
    expect(worktreeStatus([], 'a')).toBe('off')
  })

  it('calls an exited agent off too', () => {
    // From outside, a worktree with no agent running is a worktree with no
    // agent running; the window says which it is once you are looking at it.
    expect(worktreeStatus(claude({ liveness: 'dead' }), 'a')).toBe('off')
  })

  it('passes attention through otherwise', () => {
    expect(worktreeStatus(claude({ attention: 'needs-you' }), 'a')).toBe('needs-you')
    expect(worktreeStatus(claude({ attention: 'working' }), 'a')).toBe('working')
    expect(worktreeStatus(claude({ attention: 'idle' }), 'a')).toBe('idle')
  })

  it('ignores a terminal, however busy', () => {
    expect(
      worktreeStatus([session({ id: 's', worktreeId: 'a', kind: 'shell', attention: 'working' })], 'a'),
    ).toBe('off')
  })
})

describe('mostUrgentStatus', () => {
  it('carries the one worth being told about', () => {
    // Blocked on you outranks busy, which outranks idle, which outranks off.
    expect(mostUrgentStatus(['off', 'idle', 'working', 'needs-you'])).toBe('needs-you')
    expect(mostUrgentStatus(['off', 'idle', 'working'])).toBe('working')
    expect(mostUrgentStatus(['off', 'idle'])).toBe('idle')
    expect(mostUrgentStatus(['off'])).toBe('off')
  })

  it('answers off for nothing at all', () => {
    expect(mostUrgentStatus([])).toBe('off')
  })
})

describe('orderWorktrees', () => {
  it('puts the main worktree first, then sorts by name', () => {
    const ordered = orderWorktrees([
      worktree({ id: '3', name: 'zebra' }),
      worktree({ id: '1', name: 'alpha' }),
      worktree({ id: '0', name: 'main', isMain: true }),
      worktree({ id: '2', name: 'Beta' }),
    ])
    expect(ordered.map((w) => w.name)).toEqual(['main', 'alpha', 'Beta', 'zebra'])
  })

  it('does not disturb the array it was given', () => {
    const input = [worktree({ id: 'b', name: 'b' }), worktree({ id: 'a', name: 'a' })]
    orderWorktrees(input)
    expect(input.map((w) => w.name)).toEqual(['b', 'a'])
  })
})

describe('stateLabel', () => {
  it('names every state a session can be in', () => {
    expect(stateLabel(undefined)).toBe('not running')
    expect(stateLabel(session({ id: 's', worktreeId: 'a', kind: 'claude', attention: 'idle' }))).toBe('idle')
    expect(stateLabel(session({ id: 's', worktreeId: 'a', kind: 'claude', attention: 'working' }))).toBe('working')
    expect(stateLabel(session({ id: 's', worktreeId: 'a', kind: 'claude', attention: 'needs-you' }))).toBe('needs you')
  })

  it('tells a deliberate /exit from a crash', () => {
    const dead = (exitStatus: number | null): Session =>
      session({ id: 's', worktreeId: 'a', kind: 'claude', liveness: 'dead', exitStatus })
    expect(stateLabel(dead(0))).toBe('exited')
    expect(stateLabel(dead(null))).toBe('exited')
    expect(stateLabel(dead(137))).toBe('exited (137)')
  })
})

describe('isRunning', () => {
  it('needs the session to be there and alive', () => {
    expect(isRunning(undefined)).toBe(false)
    expect(isRunning(session({ id: 's', worktreeId: 'a', kind: 'shell' }))).toBe(true)
    expect(isRunning(session({ id: 's', worktreeId: 'a', kind: 'shell', liveness: 'dead' }))).toBe(false)
  })
})

describe('worktreeTodos', () => {
  it('keeps creation order even as things are queued', () => {
    /*
     * Sorting queued ones to the top would move a row out from under the
     * pointer that just queued it, and take the focus of anything being edited
     * in it with it.
     */
    const todos = [
      todo({ id: 't1', worktreeId: 'a', createdAt: 1 }),
      todo({ id: 't2', worktreeId: 'a', createdAt: 2, queuedAt: 100 }),
      todo({ id: 't3', worktreeId: 'a', createdAt: 3, queuedAt: 50 }),
    ]
    const view = worktreeTodos(todos, 'a')
    expect(view.map((v) => v.todo.id)).toEqual(['t1', 't2', 't3'])
    // The first one pressed is (1), whatever order they were created in.
    expect(view.map((v) => v.position)).toEqual([null, 2, 1])
  })

  it('leaves another worktree’s todos alone', () => {
    const todos = [todo({ id: 't1', worktreeId: 'a' }), todo({ id: 't2', worktreeId: 'b' })]
    expect(worktreeTodos(todos, 'a').map((v) => v.todo.id)).toEqual(['t1'])
  })

  it('counts what is waiting to be typed in', () => {
    const todos = [
      todo({ id: 't1', worktreeId: 'a', queuedAt: 1 }),
      todo({ id: 't2', worktreeId: 'a' }),
      todo({ id: 't3', worktreeId: 'b', queuedAt: 1 }),
    ]
    expect(queuedTodoCount(todos, 'a')).toBe(1)
    expect(queuedTodoCount(todos, 'c')).toBe(0)
  })
})

describe('removalQuestions', () => {
  it('asks nothing of a worktree that holds nothing of its own', () => {
    expect(removalQuestions(worktree({ id: 'a', dirty: 0, unmerged: 0 }))).toEqual({
      discard: false,
      branch: false,
      branchGoesAnyway: true,
      remoteBranch: false,
      remoteBranchGoesAnyway: false,
    })
  })

  it('says nothing about a remote for a branch that was never pushed', () => {
    // No `remoteBranch` is not "a remote branch we know nothing about": there
    // is no ref, so there is nothing to offer to delete and nothing to delete
    // unasked. Both halves have to be false or the dialog would either ask
    // about a branch that does not exist or push a deletion of it.
    const questions = removalQuestions(worktree({ id: 'a', dirty: 0, unmerged: 3 }))
    expect(questions.remoteBranch).toBe(false)
    expect(questions.remoteBranchGoesAnyway).toBe(false)
  })

  it('asks about the pushed copy while it has commits of its own', () => {
    const questions = removalQuestions(
      worktree({ id: 'a', dirty: 0, unmerged: 0, remoteBranch: 'origin/work' }),
    )
    expect(questions.remoteBranch).toBe(true)
    expect(questions.remoteBranchGoesAnyway).toBe(false)
    // The local branch is spent and goes unasked; the remote is a separate
    // answer, and merging one does not decide the other.
    expect(questions.branchGoesAnyway).toBe(true)
  })

  it('takes a merged remote branch with the worktree, unasked', () => {
    const questions = removalQuestions(
      worktree({
        id: 'a',
        dirty: 0,
        // The local branch is *ahead* of what was pushed, so it is still a
        // question while the pushed copy is already spent. This is the pair
        // that a single checkbox for "the branch" would have got wrong.
        unmerged: 2,
        remoteBranch: 'origin/work',
        remoteBranchMerged: true,
      }),
    )
    expect(questions.remoteBranchGoesAnyway).toBe(true)
    expect(questions.remoteBranch).toBe(false)
    expect(questions.branch).toBe(true)
  })

  it('treats a server that did not say as not having said no', () => {
    // Same reading as `unmerged`: `remoteBranchMerged` absent leaves the
    // question standing rather than deleting on a remote we cannot vouch for.
    const questions = removalQuestions(worktree({ id: 'a', remoteBranch: 'origin/work' }))
    expect(questions.remoteBranch).toBe(true)
    expect(questions.remoteBranchGoesAnyway).toBe(false)
  })

  it('asks about uncommitted work, which is what git refuses over', () => {
    expect(removalQuestions(worktree({ id: 'a', dirty: 3, unmerged: 0 })).discard).toBe(true)
  })

  it('asks about the branch while it has commits of its own', () => {
    const questions = removalQuestions(worktree({ id: 'a', dirty: 0, unmerged: 2 }))
    expect(questions.branch).toBe(true)
    expect(questions.branchGoesAnyway).toBe(false)
  })

  it('treats an absent count as unknown rather than as zero', () => {
    // A server that did not send it has not told us the branch is spent.
    expect(removalQuestions(worktree({ id: 'a', dirty: 0 })).branch).toBe(true)
  })

  it('has no branch to ask about on a detached HEAD', () => {
    const questions = removalQuestions(worktree({ id: 'a', branch: null, unmerged: 5 }))
    expect(questions.branch).toBe(false)
    expect(questions.branchGoesAnyway).toBe(false)
  })
})

describe('removalWarnings', () => {
  const wt = worktree({ id: 'a' })

  it('says nothing about a worktree with nothing running in it', () => {
    expect(removalWarnings(wt, [], [])).toEqual([])
  })

  it('does not warn about an idle Claude', () => {
    // It is sitting at its prompt with nothing to lose but the conversation,
    // which is what removing a worktree means.
    const sessions = [session({ id: 's', worktreeId: 'a', kind: 'claude', attention: 'idle' })]
    expect(removalWarnings(wt, sessions, [])).toEqual([])
  })

  it('warns about a turn in flight and an unanswered question', () => {
    const at = (attention: Session['attention']): string[] =>
      removalWarnings(wt, [session({ id: 's', worktreeId: 'a', kind: 'claude', attention })], []).map(
        (w) => w.text,
      )
    expect(at('working')[0]).toContain('turn is killed mid-flight')
    expect(at('needs-you')[0]).toContain('goes unanswered')
  })

  it('counts todos, and says how many were queued', () => {
    const one = removalWarnings(wt, [], [todo({ id: 't1', worktreeId: 'a' })])
    expect(one[0]?.text).toBe('1 todo here. They go with the worktree.')
    const queued = removalWarnings(wt, [], [
      todo({ id: 't1', worktreeId: 'a', queuedAt: 1 }),
      todo({ id: 't2', worktreeId: 'a' }),
    ])
    expect(queued[0]?.text).toBe('2 todos here, 1 queued to run next. They go with the worktree.')
  })

  it('counts only terminals that are still running', () => {
    const sessions = [
      session({ id: 's1', worktreeId: 'a', kind: 'shell' }),
      session({ id: 's2', worktreeId: 'a', kind: 'shell', liveness: 'dead' }),
    ]
    expect(removalWarnings(wt, sessions, [])[0]?.text).toContain('1 terminal still running')
    expect(removalWarnings(wt, sessions, [])[0]?.text).toContain('in it is killed')
  })
})

describe('removalAsks', () => {
  it('is quiet only for a worktree that is clean, merged and empty', () => {
    expect(removalAsks(worktree({ id: 'a', dirty: 0, unmerged: 0 }), [], [])).toBe(false)
  })

  it('opens for a question git would raise', () => {
    expect(removalAsks(worktree({ id: 'a', dirty: 1, unmerged: 0 }), [], [])).toBe(true)
    expect(removalAsks(worktree({ id: 'a', dirty: 0, unmerged: 1 }), [], [])).toBe(true)
    // An unmerged branch on a remote is a question too, and the only one whose
    // answer leaves this machine -- without it the dialog is skipped and the
    // straight-through delete decides it silently.
    expect(
      removalAsks(
        worktree({ id: 'a', dirty: 0, unmerged: 0, remoteBranch: 'origin/work' }),
        [],
        [],
      ),
    ).toBe(true)
  })

  it('opens for something only the IDE knows about', () => {
    /*
     * A worktree can be clean and merged, and so have nothing for git to ask
     * about, while an agent is mid-turn in it with four todos lined up behind
     * it -- and that click used to remove it outright.
     */
    const clean = worktree({ id: 'a', dirty: 0, unmerged: 0 })
    const working = [session({ id: 's', worktreeId: 'a', kind: 'claude', attention: 'working' })]
    expect(removalAsks(clean, working, [])).toBe(true)
    expect(removalAsks(clean, [], [todo({ id: 't', worktreeId: 'a' })])).toBe(true)
  })
})

/*
 * Where removal leaves the keyboard.
 *
 * The row is every project's windows in a line, and this used to step along it
 * flat -- so removing the last worktree of one project handed the keyboard to
 * the first window of the *next* project. Each case below is that line read the
 * wrong way round, which is why the two runs are deliberately adjacent.
 */
describe('removalLanding', () => {
  const runs = [
    { project: { id: 'p1' }, awake: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    { project: { id: 'p2' }, awake: [{ id: 'd' }] },
  ]

  it('takes the one after it', () => {
    expect(removalLanding(runs, 'b')).toEqual({ kind: 'worktree', id: 'c' })
  })

  it('takes the one before it when it was the last of its project', () => {
    // Flat across the row this is 'd', which belongs to the next project.
    expect(removalLanding(runs, 'c')).toEqual({ kind: 'worktree', id: 'b' })
  })

  it('takes the project pane when nothing of that project is left awake', () => {
    // Flat across the row this is 'c', in the project before it.
    expect(removalLanding(runs, 'd')).toEqual({ kind: 'project', id: 'p2' })
  })

  it('says nothing about a worktree no run holds', () => {
    expect(removalLanding(runs, 'gone')).toBeNull()
  })
})

/*
 * What a head's bar says for the worktrees it stands in for.
 *
 * The case that matters is the third: composed with `mostUrgentStatus`, which
 * ranks working above idle, a project with one worktree at rest and one working
 * reported *nothing at all* -- the busy one won the ranking and then said
 * nothing, because a summary shows only amber and green. Collapsing the bar
 * makes that the common shape rather than a rare one, since every collapsed
 * head then has awake worktrees in its set.
 */
describe('summarySignal', () => {
  it('says amber when anything here needs you', () => {
    expect(summarySignal(['needs-you'])).toBe('needs-you')
    expect(summarySignal(['working', 'needs-you', 'idle'])).toBe('needs-you')
    // Amber outranks green, which is the one ranking this rule does have.
    expect(summarySignal(['idle', 'needs-you'])).toBe('needs-you')
  })

  it('says green when something has come to rest and nothing needs you', () => {
    expect(summarySignal(['idle'])).toBe('idle')
    expect(summarySignal(['off', 'idle'])).toBe('idle')
  })

  it('is not masked by a busy neighbour', () => {
    // The regression: `mostUrgentStatus` answers 'working' here, which clamps
    // to nothing, and the worktree that had finished stopped being reported.
    expect(summarySignal(['working', 'idle'])).toBe('idle')
    expect(summarySignal(['working', 'working', 'idle'])).toBe('idle')
  })

  it('says nothing when nothing here is worth saying', () => {
    expect(summarySignal([])).toBeNull()
    expect(summarySignal(['working'])).toBeNull()
    expect(summarySignal(['off', 'working', 'off'])).toBeNull()
  })
})

describe('titleFor', () => {
  it('leads with the circle for the state the row is scanned for', () => {
    expect(titleFor(['working', 'needs-you', 'idle'])).toBe('🟠 Switchboard')
    expect(titleFor(['working', 'idle'])).toBe('🟢 Switchboard')
  })

  it('is the bare name when nothing is worth saying', () => {
    // Grey has no circle: working and not running are the silence.
    expect(titleFor([])).toBe('Switchboard')
    expect(titleFor(['working', 'off'])).toBe('Switchboard')
  })
})

describe('drainTakesKeyboard', () => {
  /*
   * The bug: a queue drains on the server whether or not a browser is open, so
   * this fires in windows nobody is in -- and it moved the keyboard and scrolled
   * the row to them regardless, minutes after the todos were queued, out of
   * whatever the reader was actually doing.
   */
  it('leaves the keyboard alone in a window you are not in', () => {
    expect(drainTakesKeyboard({ id: 'wt-2', pane: 'todo' }, 'wt-1')).toBe(false)
    expect(drainTakesKeyboard(null, 'wt-1')).toBe(false)
  })

  /*
   * ...and the case that has to survive: the pane you are in is the one being
   * unmounted, so focus left alone falls to the body, where the row's own keys
   * stop working.
   */
  it('hands it on when the pane you are in is the one that closes', () => {
    expect(drainTakesKeyboard({ id: 'wt-1', pane: 'todo' }, 'wt-1')).toBe(true)
  })

  // Already in that worktree's Claude, or reading its files: nothing is closing
  // under you, so nothing moves.
  it('does not move within the same worktree', () => {
    expect(drainTakesKeyboard({ id: 'wt-1', pane: 'claude' }, 'wt-1')).toBe(false)
    expect(drainTakesKeyboard({ id: 'wt-1', pane: 'files' }, 'wt-1')).toBe(false)
  })
})

describe('worktreeToWakeOnOpen', () => {
  const wt = (id: string, extra: Partial<Worktree> = {}): Worktree =>
    ({ id, projectId: 'p1', name: id, isMain: false, ...extra }) as Worktree

  /*
   * Opening a folder the IDE had never seen put nothing in the row: its
   * worktrees were all asleep, so the click looked like it had done nothing.
   */
  it('wakes the main worktree of a project with nothing awake', () => {
    const worktrees = [wt('feature', { awake: false }), wt('main', { isMain: true, awake: false })]
    expect(worktreeToWakeOnOpen('p1', worktrees, [])).toBe('main')
  })

  it('leaves a project that already has something awake as it was', () => {
    const worktrees = [wt('feature', { awake: true }), wt('main', { isMain: true, awake: false })]
    expect(worktreeToWakeOnOpen('p1', worktrees, [])).toBeNull()
  })

  it('reads a machine too old to say by what is running there', () => {
    const worktrees = [wt('feature'), wt('main', { isMain: true })]
    const sessions = [{ id: 's', worktreeId: 'feature' }] as Session[]
    expect(worktreeToWakeOnOpen('p1', worktrees, sessions)).toBeNull()
    expect(worktreeToWakeOnOpen('p1', worktrees, [])).toBe('main')
  })

  it('says nothing for a project it cannot see', () => {
    expect(worktreeToWakeOnOpen('p2', [wt('main', { isMain: true })], [])).toBeNull()
  })
})

describe('machineHasProjects', () => {
  const project = (id: string, host: Project['host']): Project =>
    ({ id, name: id, host }) as unknown as Project

  it('is true only for a project that machine contributed', () => {
    const projects = [
      project('here', { kind: 'local' }),
      project('there', { kind: 'remote', baseUrl: 'https://box.example:83', name: 'box' }),
    ]
    expect(machineHasProjects(projects, 'https://box.example:83')).toBe(true)
    expect(machineHasProjects(projects, 'https://other.example:83')).toBe(false)
    // A local project never counts, whatever its path: the machine just linked
    // is by definition not this one.
    expect(machineHasProjects([projects[0]!], 'https://box.example:83')).toBe(false)
  })
})

/*
 * The machine's own terminal is found the way every other session is, by the
 * worktree id it recorded -- which is why that id is a reserved literal rather
 * than nothing. The two directions both matter: the machine's window must not
 * show a worktree's terminal, and a worktree's terminals panel must not show
 * the machine's.
 */
describe('machineSession', () => {
  const machine = session({ id: 'm1', worktreeId: MACHINE_WORKTREE_ID, kind: 'shell' })
  const theirs = session({ id: 's1', worktreeId: 'wt-abc', kind: 'shell' })
  const claude = session({ id: 'c1', worktreeId: 'wt-abc', kind: 'claude' })

  it('finds the machine shell and nothing else', () => {
    expect(machineSession([theirs, claude, machine])?.id).toBe('m1')
  })

  it('answers nothing where there is none', () => {
    expect(machineSession([theirs, claude])).toBeUndefined()
  })

  it('is not a worktree terminal, and a worktree does not see it', () => {
    expect(terminalSessions([theirs, machine], 'wt-abc').map((s) => s.id)).toEqual(['s1'])
    expect(terminalSessions([theirs, machine], MACHINE_WORKTREE_ID).map((s) => s.id)).toEqual(['m1'])
  })
})
