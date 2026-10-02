import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Session } from '@switchboard/shared'
import { HttpError } from '../src/http-error.js'
import { containedRepos, worktreeIdFor } from '../src/git/worktree.js'
import { findFiles, grepFiles } from '../src/files.js'
import { worktreeChanges } from '../src/git/changes.js'
import {
  makeFolderOfRepos,
  makeRepoWithCommit,
  type TempFolder,
  type TempRepo,
} from './helpers/repo.js'

/* See state.test.ts: `stateFile` is derived from config at import time. */
const stateDir = await mkdtemp(join(tmpdir(), 'swb-folder-project-'))
process.env.SWB_STATE_DIR = stateDir
const { StateStore } = await import('../src/state.js')
const { Workspace } = await import('../src/workspace.js')
type SessionEngine = ConstructorParameters<typeof Workspace>[1]

const fakeEngine = (): SessionEngine => {
  const sessions: Session[] = []
  return {
    list: () => sessions,
    listForWorktree: () => [],
    killForWorktree: async () => {},
    killForProject: async () => {},
  } as unknown as SessionEngine
}

const statusOf = async (promise: Promise<unknown>): Promise<number | string | unknown> => {
  try {
    await promise
    return 'did not throw'
  } catch (err) {
    return err instanceof HttpError ? err.status : err
  }
}

let store: InstanceType<typeof StateStore>
let workspace: InstanceType<typeof Workspace>
let folder: TempFolder

beforeEach(async () => {
  await rm(join(stateDir, 'state.json'), { force: true })
  store = new StateStore()
  await store.load()
  workspace = new Workspace(store, fakeEngine())
  folder = await makeFolderOfRepos()
})

afterEach(async () => {
  await store.flush()
  await folder.cleanup()
})

describe('containedRepos', () => {
  it('names the checkouts directly inside, and nothing else', async () => {
    // `notes/` is a plain directory, and the repos' own contents are a level
    // deeper: this answers "is this a folder of repositories", not a search.
    expect(await containedRepos(folder.path)).toEqual(['alpha', 'beta'])
  })

  it('is empty for a directory holding none', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'swb-plain-'))
    await mkdir(join(plain, 'sub'), { recursive: true })
    expect(await containedRepos(plain)).toEqual([])
    await rm(plain, { recursive: true, force: true })
  })
})

describe('opening a folder', () => {
  it('refuses it as a repository, and says what it holds', async () => {
    // The `repos` detail is what turns the dialog's offer from "initialise a
    // repository here" -- which would commit each checkout as a gitlink -- into
    // "open it as a folder".
    const err = await workspace.openProject(folder.path).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).code).toBe('not-a-repo')
    expect((err as HttpError).details?.repos).toEqual(['alpha', 'beta'])
  })

  it('opens as a folder project with exactly one unit', async () => {
    const project = await workspace.openProject(folder.path, { folder: true })
    expect(project.kind).toBe('folder')
    expect(project.root).toBe(resolve(folder.path))

    const units = (await workspace.worktrees()).filter((w) => w.projectId === project.id)
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({
      id: worktreeIdFor(resolve(folder.path)),
      path: resolve(folder.path),
      branch: null,
      isMain: true,
    })
  })

  it('advertises no base ref to branch from', async () => {
    /*
     * `resolveDefaultBase` is the one git helper that does not throw outside a
     * repository -- it falls through to `HEAD` -- so this is suppressed rather
     * than merely absent. Left alone the UI names a base for branches that
     * cannot be cut.
     */
    const project = await workspace.openProject(folder.path, { folder: true })
    const described = (await workspace.snapshot()).projects.find((p) => p.id === project.id)
    expect(described?.defaultBase).toBeUndefined()
  })

  it('registers the folder itself when it sits inside a repository', async () => {
    /*
     * The ancestor trap. `isGitRepo` walks up, so a folder inside a checkout
     * answers true, and `repoRoot` then normalises to that ancestor -- asking
     * for `<repo>/games` would quietly register `<repo>`. The folder path must
     * skip both.
     */
    const outer: TempRepo = await makeRepoWithCommit()
    const inner = join(outer.path, 'games')
    await mkdir(join(inner, 'one'), { recursive: true })
    await writeFile(join(inner, 'one', 'f.txt'), 'x\n', 'utf8')

    const project = await workspace.openProject(inner, { folder: true })
    expect(project.root).toBe(resolve(inner))
    expect(project.root).not.toBe(resolve(outer.path))
    await outer.cleanup()
  })
})

describe('a folder has no branches', () => {
  it('refuses a new worktree, saying so rather than blaming the name', async () => {
    // It used to reach `isValidBranchName`, which returns false outside a
    // repository, so the form was told "invalid branch name" about a name that
    // was fine.
    const project = await workspace.openProject(folder.path, { folder: true })
    const err = await workspace
      .createWorktree({ projectId: project.id, branch: 'feature' })
      .catch((e: unknown) => e)
    expect((err as HttpError).status).toBe(400)
    expect((err as HttpError).message).toMatch(/no branches/)
  })

  it('refuses to describe a branch', async () => {
    const project = await workspace.openProject(folder.path, { folder: true })
    expect(await statusOf(workspace.describeBranch(project.id, 'feature'))).toBe(400)
  })

  it('refuses to remove its one unit', async () => {
    // `isMain` is what does this, and it is the right guard: a folder project
    // with its session removed would have no window and no way to make one.
    const project = await workspace.openProject(folder.path, { folder: true })
    const unit = (await workspace.worktrees()).find((w) => w.projectId === project.id)
    expect(
      await statusOf(
        workspace.removeWorktree({
          worktreeId: unit!.id,
          force: false,
          alsoDeleteBranch: false,
          alsoDeleteRemoteBranch: false,
        }),
      ),
    ).toBe(400)
  })
})

describe('the panels a folder unit does have', () => {
  it('lists its tree, repositories and loose files alike', async () => {
    const project = await workspace.openProject(folder.path, { folder: true })
    const unit = (await workspace.worktrees()).find((w) => w.projectId === project.id)
    const listing = await workspace.fileTree(unit!.id, '')
    expect(listing.entries.map((e) => e.name).sort()).toEqual(['alpha', 'beta', 'notes'])
  })

  it('answers Changes with an empty panel instead of a git fatal', async () => {
    /*
     * `git status` exits 128 at a folder's root, and this was the one
     * unwrapped git call in `changes.ts` -- so the panel answered a 500 with a
     * fatal in the body, every three seconds, because it polls.
     */
    const changes = await worktreeChanges({
      worktreeId: 'wt-x',
      root: folder.path,
      path: folder.path,
    })
    expect(changes).toMatchObject({ uncommitted: [], commits: [], behind: 0, base: null })
  })

  it('finds files by name without git', async () => {
    // `git ls-files` exits 128 here, and the search box is where the keyboard
    // lands when the panel opens -- so this answered a 500 on arrival.
    const { hits } = await findFiles(folder.path, 'README')
    expect(hits.map((h) => h.path).sort()).toEqual(['alpha/README.md', 'beta/README.md'])
  })

  it('finds the folder’s own files, which no repository holds', async () => {
    const { hits } = await findFiles(folder.path, 'todo')
    expect(hits.some((h) => h.path === 'notes/todo.txt')).toBe(true)
  })

  it('greps file contents without git', async () => {
    const { hits } = await grepFiles(folder.path, 'spans both')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ path: 'notes/todo.txt', line: 1 })
  })

  it('does not walk into node_modules', async () => {
    /*
     * The measurement the skip list exists for: the folder this was written
     * for is 476MB, and three of its four checkouts carry a `node_modules`.
     * Without this, every keystroke in the search box reads a third of a
     * gigabyte -- git's `--exclude-standard` is what used to prevent it, and
     * there is no git here to do it.
     */
    await mkdir(join(folder.path, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(folder.path, 'node_modules', 'pkg', 'README.md'), 'nope\n', 'utf8')
    const { hits } = await findFiles(folder.path, 'README')
    expect(hits.some((h) => h.path.startsWith('node_modules/'))).toBe(false)
  })
})

describe('the kind survives', () => {
  it('round-trips through the state file, on the project and the recent', async () => {
    /*
     * The one fact about a project that cannot be rediscovered: a repository
     * announces itself, a folder of them looks like any directory. A row that
     * lost this would come back as a repository and every git read against it
     * would fail. `reviveRecent` builds a fresh literal, so the recent needed
     * naming too -- a key nobody copies is dropped on read.
     */
    const project = await workspace.openProject(folder.path, { folder: true })
    await workspace.closeProject(project.id, { sleep: false })
    await store.flush()

    const reloaded = new StateStore()
    await reloaded.load()
    expect(reloaded.recents.find((r) => r.root === resolve(folder.path))?.kind).toBe('folder')

    const second = new Workspace(reloaded, fakeEngine())
    const reopened = await second.openProject(folder.path, { folder: true })
    await reloaded.flush()

    const third = new StateStore()
    await third.load()
    expect(third.project(reopened.id)?.kind).toBe('folder')
  })
})
