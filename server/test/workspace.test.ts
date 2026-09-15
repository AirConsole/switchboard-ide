import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Session } from '@switchboard/shared'
import { HttpError } from '../src/http-error.js'
import {
  makeRepo,
  makeRepoWithCommit,
  makeRepoWithRemote,
  type TempRemoteRepo,
  type TempRepo,
} from './helpers/repo.js'

/* See state.test.ts: `stateFile` is derived from config at import time. */
const stateDir = await mkdtemp(join(tmpdir(), 'swb-workspace-'))
process.env.SWB_STATE_DIR = stateDir
const { StateStore } = await import('../src/state.js')
const { Workspace } = await import('../src/workspace.js')
type SessionEngine = ConstructorParameters<typeof Workspace>[1]

/** What was killed, so the ordering against git's removal can be asserted. */
interface FakeEngine {
  engine: SessionEngine
  killedWorktrees: string[]
  killedProjects: string[]
  sessions: Session[]
}

const fakeEngine = (): FakeEngine => {
  const killedWorktrees: string[] = []
  const killedProjects: string[] = []
  const sessions: Session[] = []
  return {
    killedWorktrees,
    killedProjects,
    sessions,
    engine: {
      list: () => sessions,
      killForWorktree: async (id: string) => {
        killedWorktrees.push(id)
      },
      killForProject: async (id: string) => {
        killedProjects.push(id)
      },
    } as unknown as SessionEngine,
  }
}

const statusOf = async (promise: Promise<unknown>): Promise<number | string | unknown> => {
  try {
    await promise
    return 'did not throw'
  } catch (err) {
    return err instanceof HttpError ? err.status : err
  }
}

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined | unknown> => {
  try {
    await promise
    return 'did not throw'
  } catch (err) {
    return err instanceof HttpError ? err.code : err
  }
}

let store: InstanceType<typeof StateStore>
let engine: FakeEngine
let workspace: InstanceType<typeof Workspace>
let repo: TempRepo

beforeEach(async () => {
  await rm(join(stateDir, 'state.json'), { force: true })
  store = new StateStore()
  await store.load()
  engine = fakeEngine()
  workspace = new Workspace(store, engine.engine)
  repo = await makeRepoWithCommit()
})

afterEach(async () => {
  await store.flush()
  await repo.cleanup()
  vi.useRealTimers()
})

describe('openProject', () => {
  it('registers a repository and derives its id from the root', async () => {
    const project = await workspace.openProject(repo.path)
    expect(project.root).toBe(resolve(repo.path))
    expect(store.project(project.id)).toBeDefined()
  })

  it('normalises a subdirectory to the repository root', async () => {
    // Otherwise opening a subdirectory registers a near-duplicate project, and
    // every worktree then exists twice under two ids.
    await repo.write('src/a.ts', 'a\n')
    await repo.commit('add src')
    const fromRoot = await workspace.openProject(repo.path)
    const fromSub = await workspace.openProject(join(repo.path, 'src'))
    expect(fromSub.id).toBe(fromRoot.id)
    expect(store.projects).toHaveLength(1)
  })

  it('normalises a linked worktree to the repository it belongs to', async () => {
    const path = join(repo.path, '.claude', 'worktrees', 'inner')
    await repo.git('worktree', 'add', '-b', 'inner', path)
    const fromRoot = await workspace.openProject(repo.path)
    expect((await workspace.openProject(path)).id).toBe(fromRoot.id)
  })

  it('reports a missing path so the client can offer to create it', async () => {
    const missing = join(repo.path, 'nope')
    expect(await codeOf(workspace.openProject(missing))).toBe('path-missing')
  })

  it('warns that a proposed project would sit inside another repository', async () => {
    // Creating a repository inside another one is almost always a mistake.
    try {
      await workspace.openProject(join(repo.path, 'inner', 'deeper'))
      expect.unreachable()
    } catch (err) {
      expect((err as HttpError).details?.insideRepo).toBe(resolve(repo.path))
    }
  })

  it('creates and initialises a directory when asked to', async () => {
    const fresh = join(repo.path, '..', `swb-fresh-${Date.now()}`)
    try {
      const project = await workspace.openProject(fresh, { create: true })
      expect(project.root).toBe(resolve(fresh))
      // A repository with no commits has no HEAD, and `git worktree add`
      // refuses to run against one -- so the first commit is not optional.
      expect(await workspace.createWorktree({ projectId: project.id, branch: 'wt' })).toBeDefined()
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })

  it('describes a plain directory so the client can offer to initialise it', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'swb-plain-'))
    try {
      await mkdir(join(plain, 'node_modules'), { recursive: true })
      await writeFile(join(plain, 'index.js'), 'x\n')
      try {
        await workspace.openProject(plain)
        expect.unreachable()
      } catch (err) {
        const details = (err as HttpError).details
        expect((err as HttpError).code).toBe('not-a-repo')
        // Reported so the client can warn before `git add -A` sweeps it in.
        expect(details?.junk).toEqual(['node_modules'])
        expect(details?.hasGitignore).toBe(false)
      }
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  it('says nothing about junk once a .gitignore is there to handle it', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'swb-plain-'))
    try {
      await mkdir(join(plain, 'node_modules'), { recursive: true })
      await writeFile(join(plain, '.gitignore'), 'node_modules\n')
      try {
        await workspace.openProject(plain)
        expect.unreachable()
      } catch (err) {
        expect((err as HttpError).details?.junk).toEqual([])
      }
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })

  it('refuses a path that is a file', async () => {
    expect(await statusOf(workspace.openProject(join(repo.path, 'README.md')))).toBe(400)
  })

  it('takes a project back out of the recents when it is opened again', async () => {
    const project = await workspace.openProject(repo.path)
    await workspace.closeProject(project.id)
    expect(await workspace.recentProjects()).toHaveLength(1)
    await workspace.openProject(repo.path)
    expect(await workspace.recentProjects()).toEqual([])
  })
})

describe('closeProject', () => {
  it('leaves everything running unless sleeping was asked for', async () => {
    /*
     * Closing is about the registry and nothing else: a project closed with its
     * agents left running is a deliberate thing to do -- they carry on in tmux
     * and re-opening the project adopts them back.
     */
    const project = await workspace.openProject(repo.path)
    await workspace.closeProject(project.id)
    expect(engine.killedProjects).toEqual([])
    expect(store.project(project.id)).toBeUndefined()
  })

  it('stops everything when sleeping was asked for', async () => {
    const project = await workspace.openProject(repo.path)
    await workspace.closeProject(project.id, { sleep: true })
    expect(engine.killedProjects).toEqual([project.id])
  })

  it('takes only its own worktrees’ todos', async () => {
    /*
     * Collected before the project goes, because afterwards its worktrees are
     * no longer listed and there is nothing left to match todos against.
     */
    const project = await workspace.openProject(repo.path)
    const mine = (await workspace.worktrees())[0]
    const theirs = await workspace.createTodo({ worktreeId: mine!.id, prompt: 'ours' })
    store.addTodo({ id: 'other', worktreeId: 'wt-elsewhere', prompt: 'not ours', createdAt: 0 })
    await workspace.closeProject(project.id)
    expect(store.todos.map((t) => t.id)).toEqual(['other'])
    expect(store.todo(theirs.id)).toBeUndefined()
  })

  it('remembers it, so the picker can offer the path back', async () => {
    const project = await workspace.openProject(repo.path)
    await workspace.closeProject(project.id)
    expect((await workspace.recentProjects())[0]?.root).toBe(resolve(repo.path))
  })

  it('does not offer back a recent whose directory has gone', async () => {
    /*
     * It would send the picker into its "create this project?" proposal,
     * offering to make a repository where a deleted one used to be.
     */
    const gone = await makeRepo()
    const project = await workspace.openProject(gone.path)
    await workspace.closeProject(project.id)
    await gone.cleanup()
    expect(await workspace.recentProjects()).toEqual([])
  })
})

describe('createWorktree', () => {
  let projectId: string

  beforeEach(async () => {
    projectId = (await workspace.openProject(repo.path)).id
  })

  it('creates one where claude --worktree would put it', async () => {
    const worktree = await workspace.createWorktree({ projectId, branch: 'feature' })
    expect(resolve(worktree.path)).toBe(join(resolve(repo.path), '.claude', 'worktrees', 'feature'))
    expect(worktree.branch).toBe('feature')
  })

  it('keeps the new worktree out of the main worktree’s dirty count', async () => {
    await workspace.createWorktree({ projectId, branch: 'feature' })
    const main = (await workspace.worktrees()).find((w) => w.isMain)
    expect(main?.dirty).toBe(0)
  })

  it('flattens a slashed branch into one directory', async () => {
    const worktree = await workspace.createWorktree({ projectId, branch: 'feature/login' })
    expect(worktree.path.endsWith('feature-login')).toBe(true)
  })

  it('refuses a branch name git would not take, before running git at all', async () => {
    /*
     * Validating up front turns a confusing git error into a clear message --
     * so the message has to be ours. Letting it through and reporting whatever
     * `git worktree add` said is the same status and a worse answer.
     */
    await expect(workspace.createWorktree({ projectId, branch: 'has space' })).rejects.toThrow(
      'invalid branch name: has space',
    )
  })

  it('refuses a base that git would read as an option', async () => {
    /*
     * The same trap as the diff route: `base` lands where git parses options,
     * so `--lock` made a worktree the UI could no longer remove.
     */
    expect(
      await statusOf(workspace.createWorktree({ projectId, branch: 'wt', base: '--lock' })),
    ).toBe(400)
  })

  it('refuses when the path is already taken', async () => {
    await workspace.createWorktree({ projectId, branch: 'feature' })
    expect(await statusOf(workspace.createWorktree({ projectId, branch: 'feature' }))).toBe(409)
  })

  it('reports git’s own words when git refuses', async () => {
    /*
     * git writes the useful part of a failure to stderr. node's own `message`
     * carries it too, but behind `Command failed: git worktree add ...` -- the
     * command line, which is not something to show a person.
     */
    try {
      await workspace.createWorktree({ projectId, branch: 'wt', base: 'no-such-ref' })
      expect.unreachable()
    } catch (err) {
      const { message } = err as HttpError
      expect(message).toContain('no-such-ref')
      expect(message).not.toContain('Command failed')
    }
  })
})

describe('describeBranch', () => {
  /*
   * The form asks this on every pause in typing so it can say which of the two
   * things `git worktree add` does it is about to do -- check out a branch that
   * is already there, or cut a new one from the default. Getting "exists" wrong
   * means telling someone they are making a fresh branch when they are about to
   * check out work that is already on one.
   */
  it('knows an existing branch from a new name', async () => {
    const projectId = (await workspace.openProject(repo.path)).id
    await repo.git('branch', 'already-here')

    expect(await workspace.describeBranch(projectId, 'already-here')).toEqual({
      valid: true,
      exists: true,
    })
    expect(await workspace.describeBranch(projectId, 'brand-new')).toEqual({
      valid: true,
      exists: false,
    })
  })

  it('refuses a branch some worktree already has checked out', async () => {
    /*
     * A branch is checked out in one worktree at a time. Without this the form
     * happily offers Create and git refuses after the click, with "already used
     * by worktree at ..." -- and the path in that message is the useful half,
     * so it is what comes back rather than a bare boolean.
     */
    const projectId = (await workspace.openProject(repo.path)).id
    const made = await workspace.createWorktree({ projectId, branch: 'taken' })

    const answer = await workspace.describeBranch(projectId, 'taken')
    expect(answer.exists).toBe(true)
    expect(answer.usedBy).toBe(made.path)

    // The branch it was cut from is checked out by the main worktree, which is
    // just as much in use.
    expect((await workspace.describeBranch(projectId, 'main')).usedBy).toBe(repo.path)
  })

  it('leaves usedBy off a branch nothing has checked out', async () => {
    const projectId = (await workspace.openProject(repo.path)).id
    await repo.git('branch', 'parked')
    expect(await workspace.describeBranch(projectId, 'parked')).toEqual({
      valid: true,
      exists: true,
    })
  })

  it('does not call a name git would refuse valid', async () => {
    const projectId = (await workspace.openProject(repo.path)).id
    // Same rules `createWorktree` enforces, asked before rather than after.
    expect(await workspace.describeBranch(projectId, 'has space')).toEqual({
      valid: false,
      exists: false,
    })
    expect(await workspace.describeBranch(projectId, '   ')).toEqual({
      valid: false,
      exists: false,
    })
  })
})

describe('removeWorktree', () => {
  let projectId: string
  let worktreeId: string
  let path: string

  beforeEach(async () => {
    projectId = (await workspace.openProject(repo.path)).id
    const worktree = await workspace.createWorktree({ projectId, branch: 'feature' })
    worktreeId = worktree.id
    path = worktree.path
  })

  it('removes a clean worktree and everything running in it', async () => {
    await workspace.removeWorktree({ worktreeId, force: false, alsoDeleteBranch: false, alsoDeleteRemoteBranch: false })
    expect(engine.killedWorktrees).toEqual([worktreeId])
    expect((await workspace.worktrees()).map((w) => w.id)).not.toContain(worktreeId)
  })

  it('refuses to remove the main worktree in its own words', async () => {
    // Its own refusal rather than git's: it comes before anything is touched,
    // and `git worktree remove` failing afterwards would read the same to a
    // caller that only looked at the status.
    const main = (await workspace.worktrees()).find((w) => w.isMain)
    await expect(
      workspace.removeWorktree({ worktreeId: main!.id, force: false, alsoDeleteBranch: false, alsoDeleteRemoteBranch: false }),
    ).rejects.toThrow('refusing to remove the main worktree')
    expect(engine.killedWorktrees).toEqual([])
  })

  it('refuses dirty work before killing anything', async () => {
    /*
     * Sessions have to die before git will remove the directory, but killing
     * them and only then discovering that git refuses would leave the worktree
     * intact and its work in progress gone.
     */
    await writeFile(join(path, 'scratch.txt'), 'unsaved work\n')
    workspace.invalidate()
    expect(
      await codeOf(workspace.removeWorktree({ worktreeId, force: false, alsoDeleteBranch: false, alsoDeleteRemoteBranch: false })),
    ).toBe('worktree-dirty')
    expect(engine.killedWorktrees).toEqual([])
  })

  it('refuses when git could not say whether the worktree is dirty', async () => {
    /*
     * Unknown is not clean. Git failing to answer is exactly when killing the
     * sessions first would be worst -- the agent dies and the removal is then
     * refused anyway.
     */
    await rm(path, { recursive: true, force: true })
    expect(
      await codeOf(workspace.removeWorktree({ worktreeId, force: false, alsoDeleteBranch: false, alsoDeleteRemoteBranch: false })),
    ).toBe('worktree-unknown')
    expect(engine.killedWorktrees).toEqual([])
  })

  it('removes dirty work when force says to', async () => {
    await writeFile(join(path, 'scratch.txt'), 'unsaved work\n')
    workspace.invalidate()
    await workspace.removeWorktree({ worktreeId, force: true, alsoDeleteBranch: false, alsoDeleteRemoteBranch: false })
    expect((await workspace.worktrees()).map((w) => w.id)).not.toContain(worktreeId)
  })

  it('deletes the branch when asked, and keeps it otherwise', async () => {
    await workspace.removeWorktree({ worktreeId, force: false, alsoDeleteBranch: false, alsoDeleteRemoteBranch: false })
    expect(await repo.git('branch', '--list', 'feature')).toContain('feature')

    const second = await workspace.createWorktree({ projectId, branch: 'other' })
    await workspace.removeWorktree({
      worktreeId: second.id,
      force: false,
      alsoDeleteBranch: true,
      alsoDeleteRemoteBranch: false,
    })
    expect(await repo.git('branch', '--list', 'other')).toBe('')
  })

  it('does not fail the removal over a branch git declines to delete', async () => {
    // The worktree is gone, which is what was asked; an unmerged branch git
    // will not delete is not a failure of this operation.
    await repo.git('-C', path, 'commit', '--allow-empty', '-m', 'unmerged work')
    await workspace.removeWorktree({ worktreeId, force: false, alsoDeleteBranch: true, alsoDeleteRemoteBranch: false })
    expect((await workspace.worktrees()).map((w) => w.id)).not.toContain(worktreeId)
    expect(await repo.git('branch', '--list', 'feature')).toContain('feature')
  })

  it('takes the worktree’s todos with it', async () => {
    const todo = await workspace.createTodo({ worktreeId, prompt: 'do the thing' })
    await workspace.removeWorktree({ worktreeId, force: false, alsoDeleteBranch: false, alsoDeleteRemoteBranch: false })
    expect(store.todo(todo.id)).toBeUndefined()
  })
})

describe('removeWorktree, and the branch on the remote', () => {
  let remote: TempRemoteRepo
  let projectId: string
  let worktreeId: string

  beforeEach(async () => {
    remote = await makeRepoWithRemote()
    projectId = (await workspace.openProject(remote.path)).id
    const worktree = await workspace.createWorktree({ projectId, branch: 'feature' })
    worktreeId = worktree.id
    await remote.git('-C', worktree.path, 'commit', '--allow-empty', '-m', 'work')
    await remote.git('-C', worktree.path, 'push', '-u', 'origin', 'feature')
    workspace.invalidate()
  })

  afterEach(async () => {
    await remote.cleanup()
  })

  it('reports the pushed branch and whether the default branch has it', async () => {
    const before = (await workspace.worktrees()).find((w) => w.id === worktreeId)
    expect(before?.remoteBranch).toBe('origin/feature')
    expect(before?.remoteBranchMerged).toBe(false)

    await remote.git('merge', '--no-ff', 'feature', '-m', 'merge')
    await remote.git('push', 'origin', 'main')
    workspace.invalidate()
    const after = (await workspace.worktrees()).find((w) => w.id === worktreeId)
    expect(after?.remoteBranchMerged).toBe(true)
  })

  it('deletes the branch on the remote when asked', async () => {
    await workspace.removeWorktree({
      worktreeId,
      force: false,
      alsoDeleteBranch: true,
      alsoDeleteRemoteBranch: true,
    })
    expect(await remote.git('ls-remote', '--heads', 'origin', 'feature')).toBe('')
    expect((await workspace.worktrees()).map((w) => w.id)).not.toContain(worktreeId)
  })

  it('leaves the remote alone when it was not asked about', async () => {
    await workspace.removeWorktree({
      worktreeId,
      force: false,
      alsoDeleteBranch: true,
      alsoDeleteRemoteBranch: false,
    })
    expect(await remote.git('ls-remote', '--heads', 'origin', 'feature')).toContain('feature')
  })

  it('destroys nothing local when the remote refuses the deletion', async () => {
    /*
     * The ordering, and the reason for it. The push is the one step here that
     * reaches off this machine and the one that fails for reasons nothing
     * local can predict -- here a lease that does not hold, because somebody
     * pushed to the branch after our last fetch. Doing it last would have
     * killed the agent, deleted the directory and then failed, leaving a
     * closed dialog and a branch still on the remote.
     */
    const theirs = await remote.elsewhere()
    await theirs.git('checkout', '-b', 'feature', 'origin/feature')
    await theirs.git('commit', '--allow-empty', '-m', 'work this clone has not seen')
    await theirs.git('push', 'origin', 'feature')

    expect(
      await codeOf(
        workspace.removeWorktree({
          worktreeId,
          force: false,
          alsoDeleteBranch: true,
          alsoDeleteRemoteBranch: true,
        }),
      ),
    ).toBe('remote-branch')
    expect(engine.killedWorktrees).toEqual([])
    expect((await workspace.worktrees()).map((w) => w.id)).toContain(worktreeId)
    expect(await remote.git('branch', '--list', 'feature')).toContain('feature')
    expect(await remote.git('ls-remote', '--heads', 'origin', 'feature')).toContain('feature')
  })

  it('is not failed by a remote branch somebody else already deleted', async () => {
    // Gone is the outcome that was asked for.
    await remote.git('push', 'origin', '--delete', 'feature')
    workspace.invalidate()
    await workspace.removeWorktree({
      worktreeId,
      force: false,
      alsoDeleteBranch: true,
      alsoDeleteRemoteBranch: true,
    })
    expect((await workspace.worktrees()).map((w) => w.id)).not.toContain(worktreeId)
  })
})

describe('todos', () => {
  let worktreeId: string
  let projectId: string

  beforeEach(async () => {
    projectId = (await workspace.openProject(repo.path)).id
    worktreeId = (await workspace.worktrees())[0]!.id
  })

  it('refuses a todo for a worktree that is not there, before storing anything', async () => {
    expect(await statusOf(workspace.createTodo({ worktreeId: 'wt-nope', prompt: 'x' }))).toBe(404)
    expect(store.todos).toEqual([])
  })

  it('refuses an empty prompt', async () => {
    expect(await statusOf(workspace.createTodo({ worktreeId, prompt: '   ' }))).toBe(400)
  })

  it('strips control bytes on the way to a terminal', async () => {
    /*
     * Without this a prompt could carry its own escape sequences into the TUI:
     * a literal `ESC[201~` would end the bracketed paste early and hand the
     * rest to the app as keys.
     */
    const todo = await workspace.createTodo({
      worktreeId,
      prompt: 'do \x1b[201~this\x07 and \x00that',
    })
    expect(todo.prompt).toBe('do [201~this and that')
  })

  it('keeps the newlines and tabs, which are the point', async () => {
    const todo = await workspace.createTodo({ worktreeId, prompt: 'one\r\ntwo\n\tthree' })
    expect(todo.prompt).toBe('one\ntwo\n\tthree')
  })

  it('gives each queued todo a strictly later place than the last', async () => {
    /*
     * Strictly after, rather than simply `Date.now()`: two clicks inside the
     * same millisecond would otherwise tie, and the order of (1) and (2) would
     * be arbitrary.
     */
    vi.useFakeTimers()
    const first = await workspace.createTodo({ worktreeId, prompt: 'first' })
    const second = await workspace.createTodo({ worktreeId, prompt: 'second' })
    await workspace.updateTodo(first.id, { queued: true })
    await workspace.updateTodo(second.id, { queued: true })
    expect(store.todo(second.id)!.queuedAt!).toBeGreaterThan(store.todo(first.id)!.queuedAt!)
  })

  it('clears the last error when a human queues it again', async () => {
    // Queueing it again is the human saying "try that once more".
    store.addTodo({ id: 't-1', worktreeId, prompt: 'x', createdAt: 0, lastError: 'it went wrong' })
    await workspace.updateTodo('t-1', { queued: true })
    expect(store.todo('t-1')?.lastError).toBeUndefined()
  })

  it('takes a todo out of the queue without deleting it', async () => {
    store.addTodo({ id: 't-1', worktreeId, prompt: 'x', createdAt: 0, queuedAt: 5 })
    await workspace.updateTodo('t-1', { queued: false })
    expect(store.todo('t-1')?.queuedAt).toBeUndefined()
    expect(store.todo('t-1')).toBeDefined()
  })

  it('refuses to edit or delete one that is on its way into Claude', async () => {
    // Its prompt may already be in flight; editing it now would change
    // something that has effectively been sent.
    store.addTodo({ id: 't-1', worktreeId, prompt: 'x', createdAt: 0, dispatchingAt: 1 })
    expect(await statusOf(workspace.updateTodo('t-1', { prompt: 'y' }))).toBe(409)
    expect(() => workspace.deleteTodo('t-1')).toThrow(HttpError)
    expect(store.todo('t-1')?.prompt).toBe('x')
  })

  it('refuses an edit that would leave it with no prompt', async () => {
    store.addTodo({ id: 't-1', worktreeId, prompt: 'x', createdAt: 0 })
    expect(await statusOf(workspace.updateTodo('t-1', { prompt: '  ' }))).toBe(400)
  })

  it('moves a todo to another worktree', async () => {
    const other = await workspace.createWorktree({ projectId, branch: 'elsewhere' })
    store.addTodo({ id: 't-1', worktreeId, prompt: 'x', createdAt: 0 })
    await workspace.updateTodo('t-1', { worktreeId: other.id })
    expect(store.todo('t-1')?.worktreeId).toBe(other.id)
  })

  it('gives a queued todo a new place at the end of the queue it moved into', async () => {
    /*
     * A place in a queue is only meaningful within one worktree. Keeping the
     * old timestamp would let a todo moved in overtake everything already
     * waiting there -- this one was queued at 5, before the one it joins.
     */
    const other = await workspace.createWorktree({ projectId, branch: 'elsewhere' })
    store.addTodo({ id: 't-there', worktreeId: other.id, prompt: 'first', createdAt: 0 })
    await workspace.updateTodo('t-there', { queued: true })
    store.addTodo({ id: 't-1', worktreeId, prompt: 'x', createdAt: 0, queuedAt: 5 })

    await workspace.updateTodo('t-1', { worktreeId: other.id })

    expect(store.todo('t-1')!.queuedAt!).toBeGreaterThan(store.todo('t-there')!.queuedAt!)
  })

  it('refuses a move to a worktree that is not there, leaving the todo where it was', async () => {
    // Otherwise the todo is stranded somewhere nothing lists, and
    // `removeTodosFor` never sees the id again.
    store.addTodo({ id: 't-1', worktreeId, prompt: 'x', createdAt: 0 })
    expect(await statusOf(workspace.updateTodo('t-1', { worktreeId: 'wt-nope' }))).toBe(404)
    expect(store.todo('t-1')?.worktreeId).toBe(worktreeId)
  })

  it('says so for a todo that is not there', async () => {
    expect(await statusOf(workspace.updateTodo('nope', { queued: true }))).toBe(404)
    expect(() => workspace.deleteTodo('nope')).toThrow(HttpError)
  })
})

describe('the worktree listing', () => {
  it('carries the dirty and unmerged counts a window needs', async () => {
    const projectId = (await workspace.openProject(repo.path)).id
    const created = await workspace.createWorktree({ projectId, branch: 'feature' })
    await writeFile(join(created.path, 'scratch.txt'), 'work\n')
    await repo.git('-C', created.path, 'commit', '--allow-empty', '-m', 'committed work')

    workspace.invalidate()
    const worktree = (await workspace.worktrees()).find((w) => w.id === created.id)
    expect(worktree?.dirty).toBe(1)
    expect(worktree?.unmerged).toBe(1)
  })

  it('says undefined, not zero, when git could not count the changes', async () => {
    // A zero would tell `removeWorktree` the worktree is clean.
    const projectId = (await workspace.openProject(repo.path)).id
    const created = await workspace.createWorktree({ projectId, branch: 'feature' })
    await rm(created.path, { recursive: true, force: true })
    workspace.invalidate()
    expect((await workspace.worktrees()).find((w) => w.id === created.id)?.dirty).toBeUndefined()
  })

  it('contributes nothing rather than breaking the snapshot when a project has moved', async () => {
    const gone = await makeRepoWithCommit()
    await workspace.openProject(gone.path)
    await workspace.openProject(repo.path)
    await gone.cleanup()
    workspace.invalidate()
    const worktrees = await workspace.worktrees()
    expect(worktrees.every((w) => w.path.startsWith(resolve(repo.path)))).toBe(true)
    expect(worktrees).not.toHaveLength(0)
  })

  it('says whether anything a client can see moved', async () => {
    await workspace.openProject(repo.path)
    // The first poll only establishes the baseline; there is nothing to
    // compare it against yet.
    expect(await workspace.pollChanged()).toBe(false)
    expect(await workspace.pollChanged()).toBe(false)
    await repo.write('scratch.txt', 'work\n')
    expect(await workspace.pollChanged()).toBe(true)
    expect(await workspace.pollChanged()).toBe(false)
  })

  it('notices a commit, which leaves the working tree as clean as it found it', async () => {
    // An agent committing its work moves HEAD and leaves `dirty` at zero, and
    // without the head in the signature that looks like nothing happened.
    await workspace.openProject(repo.path)
    await workspace.pollChanged()
    await repo.git('commit', '--allow-empty', '-m', 'agent work')
    expect(await workspace.pollChanged()).toBe(true)
  })

  it('does not let a read that began before an invalidate cache its stale answer', async () => {
    /*
     * The 4s poll takes a git status per worktree; a mutation landing mid-flight
     * used to be overwritten by that older listing, so the invalidate that
     * followed sent every client to refetch a snapshot that still had the old
     * worktrees in it, until the TTL lapsed.
     */
    /*
     * The worktree is added behind the Workspace's back on purpose: going
     * through `createWorktree` would invalidate again afterwards and hide the
     * very thing being tested.
     */
    await workspace.openProject(repo.path)
    const inFlight = workspace.worktrees()
    workspace.invalidate()
    await inFlight

    await repo.git('worktree', 'add', '-b', 'feature', join(repo.path, 'feature'))
    // Well inside the 2s cache TTL, so a stale entry would still be served.
    expect((await workspace.worktrees()).map((w) => w.branch)).toContain('feature')
  })
})

describe('browse', () => {
  it('lists directories, marking the ones that are repositories', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swb-browse-'))
    try {
      await mkdir(join(parent, 'plain'), { recursive: true })
      const inner = await makeRepoWithCommit()
      const { rename } = await import('node:fs/promises')
      await rename(inner.path, join(parent, 'a-repo'))
      await mkdir(join(parent, '.hidden'), { recursive: true })

      const listing = await workspace.browse(parent)
      expect(listing.entries.map((e) => e.name)).toEqual(['a-repo', 'plain'])
      expect(listing.entries[0]?.isRepo).toBe(true)
      expect(listing.entries[1]?.isRepo).toBe(false)
      expect(listing.parent).toBe(resolve(parent, '..'))
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('refuses a path that is not a directory', async () => {
    expect(await statusOf(workspace.browse(join(repo.path, 'README.md')))).toBe(400)
  })

  it('has no parent at the root of the filesystem', async () => {
    expect((await workspace.browse('/')).parent).toBeNull()
  })

  it('expands ~, because the picker has to roam the filesystem', async () => {
    // Deliberately the opposite of `containedPath`, which refuses anything
    // absolute. Do not "fix" it to use that.
    const { homedir } = await import('node:os')
    expect((await workspace.browse('~')).path).toBe(homedir())
  })
})
