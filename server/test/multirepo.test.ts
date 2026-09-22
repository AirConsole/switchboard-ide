import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Worktree } from '@switchboard/shared'
import { HttpError } from '../src/http-error.js'
import { gitIn } from './helpers/repo.js'

/* See state.test.ts: `stateFile` is derived from config at import time. */
const stateDir = await mkdtemp(join(tmpdir(), 'swb-multirepo-'))
process.env.SWB_STATE_DIR = stateDir
const { StateStore } = await import('../src/state.js')
const { Workspace } = await import('../src/workspace.js')
const { memberOf, workspaceChanges } = await import('../src/git/changes.js')
const { findFiles, listDirectory } = await import('../src/files.js')
const { membersOf } = await import('../src/git/multirepo.js')
type SessionEngine = ConstructorParameters<typeof Workspace>[1]

const engine = {
  list: () => [],
  listForWorktree: () => [],
  killForWorktree: async () => {},
  killForProject: async () => {},
} as unknown as SessionEngine

const failure = async (promise: Promise<unknown>): Promise<{ status?: number; code?: string } | string> => {
  try {
    await promise
    return 'did not throw'
  } catch (err) {
    return err instanceof HttpError ? { status: err.status, code: err.code } : String(err)
  }
}

/**
 * A folder holding repositories, the shape a workspace is: `alpha` and `beta`
 * with a commit each, and a plain directory beside them that is not one.
 * Real, so the ids the workspace derives from its realpath agree with ours.
 */
let folder: string
let store: InstanceType<typeof StateStore>
let workspace: InstanceType<typeof Workspace>

const addRepo = async (name: string): Promise<(...args: string[]) => Promise<string>> => {
  const path = join(folder, name)
  await mkdir(path)
  const git = gitIn(path)
  await git('init')
  await writeFile(join(path, 'README.md'), `${name}\n`)
  await git('add', '-A')
  await git('commit', '-m', 'Initial commit')
  return git
}

beforeEach(async () => {
  await rm(join(stateDir, 'state.json'), { force: true })
  store = new StateStore()
  await store.load()
  workspace = new Workspace(store, engine)
  folder = await realpath(await mkdtemp(join(tmpdir(), 'swb-folder-')))
  await addRepo('alpha')
  await addRepo('beta')
  await mkdir(join(folder, 'notes'))
})

afterEach(async () => {
  await store.flush()
  await rm(folder, { recursive: true, force: true })
})

const open = (): Promise<Project> => workspace.openProject(folder, { workspace: true })

const listed = async (project: Project): Promise<Worktree[]> => {
  workspace.invalidate()
  return (await workspace.worktrees()).filter((w) => w.projectId === project.id)
}

describe('opening a folder of repositories', () => {
  it('says what is inside a folder that is not a repository, so it can be offered as a workspace', async () => {
    const err = await workspace.openProject(folder).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).code).toBe('not-a-repo')
    // The plain directory and the dot-directories are not repositories.
    expect((err as HttpError).details?.repos).toEqual(['alpha', 'beta'])
  })

  it('opens it as one project whose main worktree is the folder and spans every repository', async () => {
    const project = await open()
    expect(project.kind).toBe('workspace')
    expect(project.repos).toEqual(['alpha', 'beta'])
    const [main, ...rest] = await listed(project)
    expect(rest).toEqual([])
    expect(main).toMatchObject({ path: folder, isMain: true, branch: null, repos: ['alpha', 'beta'], dirty: 0 })
  })

  it('refuses a folder with no repository in it, and one inside a repository', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'swb-empty-'))
    expect(await failure(workspace.openProject(empty, { workspace: true }))).toMatchObject({
      code: 'workspace-empty',
    })
    await rm(empty, { recursive: true, force: true })
    expect(await failure(workspace.openProject(join(folder, 'alpha'), { workspace: true }))).toMatchObject({
      code: 'workspace-in-repo',
    })
  })

  it('reopens as a workspace from its recent, which is where the kind is kept', async () => {
    const project = await open()
    await workspace.closeProject(project.id)
    expect((await workspace.recentProjects())[0]).toMatchObject({ root: folder, kind: 'workspace' })
  })
})

describe('a workspace worktree', () => {
  it('is one git worktree per picked repository, all on the branch, and only those', async () => {
    const project = await open()
    const made = await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha'] })
    expect(made).toMatchObject({ branch: 'feat', repos: ['alpha'], isMain: false })
    expect(made.path).toBe(join(folder, '.claude', 'worktrees', 'feat'))
    expect((await gitIn(join(made.path, 'alpha'))('branch', '--show-current')).trim()).toBe('feat')
    expect(await readdir(made.path)).toEqual(['alpha'])
  })

  it('takes a repository more when the same name is made again, and says it extended it', async () => {
    const project = await open()
    await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha'] })
    const again = await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha', 'beta'] })
    expect(again).toMatchObject({ repos: ['alpha', 'beta'], extended: true })
    // Nothing new to add is a refusal, not a silent success.
    expect(
      await failure(workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['beta'] })),
    ).toMatchObject({ status: 409 })
  })

  it('refuses a repository that is not one of the workspace’s, before making anything', async () => {
    const project = await open()
    for (const repos of [['notes'], ['../alpha'], []]) {
      expect(
        await failure(workspace.createWorktree({ projectId: project.id, branch: 'feat', repos })),
      ).toMatchObject({ status: 400 })
    }
    expect(await readdir(join(folder, '.claude')).catch(() => [])).toEqual([])
  })

  it('takes back what it made when git refuses a later repository', async () => {
    // `beta` has `feat` checked out already, so git refuses a second checkout of it.
    await gitIn(join(folder, 'beta'))('checkout', '-b', 'feat')
    const project = await open()
    const result = await failure(
      workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha', 'beta'] }),
    )
    expect(result).toMatchObject({ status: 400 })
    // alpha's worktree, the branch cut for it, and the folder: all gone.
    expect(await readdir(join(folder, '.claude', 'worktrees'))).toEqual([])
    expect((await gitIn(join(folder, 'alpha'))('branch', '--list', 'feat')).trim()).toBe('')
    expect((await gitIn(join(folder, 'alpha'))('worktree', 'list')).trim().split('\n')).toHaveLength(1)
  })

  it('says a name is checked out elsewhere in a picked repository, and that an existing one is added to', async () => {
    await gitIn(join(folder, 'beta'))('branch', 'taken')
    const project = await open()
    expect(await workspace.describeBranch(project.id, 'taken', ['alpha', 'beta'])).toMatchObject({
      valid: true,
      exists: true,
    })
    await gitIn(join(folder, 'beta'))('checkout', 'taken')
    expect((await workspace.describeBranch(project.id, 'taken', ['beta'])).usedBy).toBe(join(folder, 'beta'))
    // Not over alpha, which does not have it.
    expect((await workspace.describeBranch(project.id, 'taken', ['alpha'])).usedBy).toBeUndefined()
    await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha'] })
    const again = await workspace.describeBranch(project.id, 'feat', ['alpha', 'beta'])
    expect(again.worktree).toBe(join(folder, '.claude', 'worktrees', 'feat'))
    // Its own checkout of the branch is not "somewhere else".
    expect(again.usedBy).toBeUndefined()
  })
})

describe('removing a workspace worktree', () => {
  const make = async (): Promise<{ project: Project; worktree: Worktree }> => {
    const project = await open()
    const worktree = await workspace.createWorktree({
      projectId: project.id,
      branch: 'feat',
      repos: ['alpha', 'beta'],
    })
    return { project, worktree }
  }

  it('counts a file beside the repositories as uncommitted, and refuses over it', async () => {
    // Nothing tracks it, so removing the folder would be the only copy gone.
    const { project, worktree } = await make()
    await writeFile(join(worktree.path, 'PLAN.md'), 'the plan\n')
    expect((await listed(project)).find((w) => w.id === worktree.id)?.dirty).toBe(1)
    expect(
      await failure(workspace.removeWorktree({ worktreeId: worktree.id, force: false, alsoDeleteBranch: false, alsoDeleteRemoteBranch: false })),
    ).toMatchObject({ code: 'worktree-dirty' })
    expect(await readdir(worktree.path)).toContain('alpha')
  })

  it('refuses over a change in any one repository, before anything goes', async () => {
    const { worktree } = await make()
    await writeFile(join(worktree.path, 'beta', 'README.md'), 'edited\n')
    expect(
      await failure(workspace.removeWorktree({ worktreeId: worktree.id, force: false, alsoDeleteBranch: false, alsoDeleteRemoteBranch: false })),
    ).toMatchObject({ code: 'worktree-dirty' })
    expect(await readdir(worktree.path)).toEqual(['alpha', 'beta'])
  })

  it('removes every repository’s worktree, the folder, and the branches when asked', async () => {
    const { project, worktree } = await make()
    await workspace.removeWorktree({ worktreeId: worktree.id, force: false, alsoDeleteBranch: true, alsoDeleteRemoteBranch: false })
    expect(await readdir(join(folder, '.claude', 'worktrees'))).toEqual([])
    for (const repo of ['alpha', 'beta']) {
      expect((await gitIn(join(folder, repo))('branch', '--list', 'feat')).trim()).toBe('')
    }
    expect((await listed(project)).map((w) => w.path)).toEqual([folder])
  })

  it('refuses the main worktree, which is the folder itself', async () => {
    const project = await open()
    const [main] = await listed(project)
    expect(
      await failure(workspace.removeWorktree({ worktreeId: main!.id, force: true, alsoDeleteBranch: false, alsoDeleteRemoteBranch: false })),
    ).toMatchObject({ status: 400 })
  })
})

describe('what a workspace worktree has done', () => {
  it('prefixes each change with its repository, and says which repository a commit is in', async () => {
    const project = await open()
    const worktree = await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha', 'beta'] })
    await writeFile(join(worktree.path, 'alpha', 'new.txt'), 'new\n')
    const beta = gitIn(join(worktree.path, 'beta'))
    await writeFile(join(worktree.path, 'beta', 'README.md'), 'changed\n')
    await beta('commit', '-am', 'beta work')
    const changes = await workspaceChanges({ worktreeId: worktree.id, branch: 'feat', members: membersOf(worktree) })
    expect(changes.uncommitted).toEqual([{ path: 'alpha/new.txt', status: '??' }])
    // No remote, so each repository measures against its main checkout's branch:
    // beta is ahead by one, alpha by none -- and ahead is what is listed.
    expect(changes.commitScope).toBe('ahead')
    expect(changes.commits.map((c) => [c.repo, c.subject])).toEqual([['beta', 'beta work']])
  })

  it('reads a worktree-relative path as a repository and the path inside it, and nothing else', async () => {
    const members = [
      { name: 'alpha', path: '/w/alpha' },
      { name: 'beta', path: '/w/beta' },
    ]
    expect(memberOf(members, 'beta/src/x.ts')).toEqual({ member: members[1], inner: 'src/x.ts' })
    for (const path of ['../alpha/x', 'gamma/x', 'alpha', '/w/alpha/x']) {
      expect(() => memberOf(members, path)).toThrow(HttpError)
    }
  })
})

describe('a workspace worktree’s files', () => {
  it('marks a repository with changes at the top, and honours each repository’s own ignore rules inside it', async () => {
    const project = await open()
    const [main] = await listed(project)
    await writeFile(join(folder, 'alpha', '.gitignore'), 'build/\n')
    await mkdir(join(folder, 'alpha', 'build'))
    await writeFile(join(folder, 'alpha', 'build', 'out.js'), 'x\n')
    const top = await listDirectory(folder, '', main!.repos)
    expect(top.entries.find((e) => e.name === 'alpha')?.changed).toBe(true)
    expect(top.entries.find((e) => e.name === 'beta')?.changed).toBeUndefined()
    const inside = await listDirectory(folder, 'alpha', main!.repos)
    expect(inside.entries.map((e) => e.name)).toEqual(['.gitignore', 'README.md'])
    expect(inside.entries.find((e) => e.name === '.gitignore')?.changed).toBe(true)
  })

  it('finds files in every repository, by the path the tree opens them at', async () => {
    const project = await open()
    const [main] = await listed(project)
    const found = await findFiles(folder, 'readme', main!.repos)
    expect(found.hits.map((h) => h.path).sort()).toEqual(['alpha/README.md', 'beta/README.md'])
  })
})

describe('what the first review found', () => {
  it('keeps the workspace in the row when one checkout in it cannot be read', async () => {
    // A `.git` pointing at a repository that is gone: a worktree whose repo moved.
    await mkdir(join(folder, 'stale'))
    await writeFile(join(folder, 'stale', '.git'), 'gitdir: /nonexistent/repo/.git/worktrees/stale\n')
    const project = await open()
    const [main] = await listed(project)
    expect(main?.repos).toEqual(['alpha', 'beta', 'stale'])
  })

  it('does not list a workspace worktree’s checkout under an ordinary project for that repository', async () => {
    const project = await open()
    const made = await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha'] })
    const alpha = await workspace.openProject(join(folder, 'alpha'))
    expect((await listed(alpha)).map((w) => w.path)).toEqual([join(folder, 'alpha')])
    expect((await listed(project)).map((w) => w.id)).toContain(made.id)
  })

  it('refuses to open a workspace worktree as a workspace of its own', async () => {
    const project = await open()
    const made = await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha'] })
    expect(await failure(workspace.openProject(made.path, { workspace: true }))).toMatchObject({
      code: 'workspace-nested',
    })
  })

  it('removes a worktree by force when one of its repositories has gone', async () => {
    const project = await open()
    const made = await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha', 'beta'] })
    await rm(join(folder, 'beta'), { recursive: true, force: true })
    const fresh = new Workspace(store, engine)
    fresh.invalidate()
    expect(
      await failure(fresh.removeWorktree({ worktreeId: made.id, force: false, alsoDeleteBranch: false, alsoDeleteRemoteBranch: false })),
    ).toMatchObject({ status: 400 })
    await fresh.removeWorktree({ worktreeId: made.id, force: true, alsoDeleteBranch: true, alsoDeleteRemoteBranch: false })
    expect(await readdir(join(folder, '.claude', 'worktrees'))).toEqual([])
  })

  it('applies the ignore rules of the repository a path resolves into, however it is spelled', async () => {
    const project = await open()
    const [main] = await listed(project)
    await writeFile(join(folder, 'beta', '.gitignore'), 'secret/\n')
    await mkdir(join(folder, 'beta', 'secret'))
    const names = (rel: string): Promise<string[]> =>
      listDirectory(folder, rel, main!.repos).then((l) => l.entries.map((e) => e.name))
    expect(await names('beta')).not.toContain('secret')
    expect(await names('alpha/../beta')).not.toContain('secret')
  })

  it('leaves its own worktrees out of the folder’s tree, where nothing would filter them', async () => {
    const project = await open()
    await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha'] })
    await mkdir(join(folder, '.claude', 'agent-memory'), { recursive: true })
    const [main] = await listed(project)
    expect((await listDirectory(folder, '.claude', main!.repos)).entries.map((e) => e.name)).toEqual([
      'agent-memory',
    ])
  })

  it('refuses a folder whose repositories are on another branch as the one to add to', async () => {
    const project = await open()
    await workspace.createWorktree({ projectId: project.id, branch: 'a/b', repos: ['alpha'] })
    const answer = await workspace.describeBranch(project.id, 'a-b', ['beta'])
    expect(answer.worktree).toBeUndefined()
    expect(answer.usedBy).toBe(join(folder, '.claude', 'worktrees', 'a-b'))
  })

  it('keeps the kind across a restart, and only that value', async () => {
    const project = await open()
    await store.flush()
    const again = new StateStore()
    await again.load()
    expect(again.project(project.id)?.kind).toBe('workspace')
  })
})

describe('what the second review found', () => {
  it('counts a repository cloned into a worktree as work, since its history goes with the folder', async () => {
    const project = await open()
    const made = await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha'] })
    const clone = join(made.path, 'gamma')
    await mkdir(clone)
    const git = gitIn(clone)
    await git('init')
    await git('commit', '--allow-empty', '-m', 'only copy')
    expect((await listed(project)).find((w) => w.id === made.id)?.dirty).toBe(1)
    expect(
      await failure(workspace.removeWorktree({ worktreeId: made.id, force: false, alsoDeleteBranch: false, alsoDeleteRemoteBranch: false })),
    ).toMatchObject({ code: 'worktree-dirty' })
    expect(await readdir(made.path)).toEqual(['alpha', 'gamma'])
  })

  it('does not delete a locked worktree git refuses to remove, even forced', async () => {
    const project = await open()
    const made = await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha'] })
    await gitIn(join(folder, 'alpha'))('worktree', 'lock', join(made.path, 'alpha'))
    expect(
      await failure(workspace.removeWorktree({ worktreeId: made.id, force: true, alsoDeleteBranch: true, alsoDeleteRemoteBranch: false })),
    ).toMatchObject({ status: 400 })
    expect(await readdir(join(made.path, 'alpha'))).toContain('README.md')
  })

  it('refuses nesting in the other order too: a worktree open as a workspace, then its own workspace', async () => {
    const project = await open()
    const made = await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha'] })
    await workspace.closeProject(project.id)
    await workspace.openProject(made.path, { workspace: true })
    expect(await failure(open())).toMatchObject({ code: 'workspace-nested' })
  })

  it('does not offer to initialise a repository around a workspace worktree', async () => {
    const project = await open()
    const made = await workspace.createWorktree({ projectId: project.id, branch: 'feat', repos: ['alpha'] })
    expect(await failure(workspace.openProject(made.path))).toMatchObject({ code: 'workspace-nested' })
    expect(await failure(workspace.openProject(made.path, { create: true }))).toMatchObject({
      code: 'workspace-nested',
    })
  })
})
