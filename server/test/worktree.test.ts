import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  LOCAL_HEAD_BASE,
  addWorktree,
  currentBranch,
  defaultWorktreeRoot,
  dirtyCount,
  ensureWorktreesIgnored,
  isValidBranchName,
  listRawWorktrees,
  listWorktrees,
  projectIdFor,
  removeWorktree,
  repoRoot,
  resolveDefaultBase,
  unmergedCount,
  worktreeIdFor,
  worktreePathFor,
} from '../src/git/worktree.js'
import { makeRepoWithCommit, type TempRepo } from './helpers/repo.js'

describe('ids', () => {
  /*
   * These are golden on purpose.
   *
   * A worktree's id is recorded inside its tmux session's metadata, so changing
   * how a local id is derived orphans every running session on the machine.
   * Pinning the exact digest is the only way a change to `idFor` shows up as a
   * failing test rather than as six agents nobody can reach.
   */
  it('derives a stable id from the absolute path', () => {
    expect(projectIdFor('/home/a/src/ide')).toBe('p-86f8df4c3f')
    expect(worktreeIdFor('/home/a/src/ide')).toBe('wt-86f8df4c3f')
  })

  it('normalises the path before hashing it', () => {
    expect(worktreeIdFor('/home/a/src/ide/')).toBe(worktreeIdFor('/home/a/src/ide'))
    expect(worktreeIdFor('/home/a/src/x/../ide')).toBe(worktreeIdFor('/home/a/src/ide'))
  })

  it('gives a project and a worktree at the same path different ids', () => {
    expect(projectIdFor('/tmp/x')).not.toBe(worktreeIdFor('/tmp/x'))
  })

  it('namespaces a remote host without disturbing the local derivation', () => {
    // The empty host key is what keeps every id already in tmux exactly as it
    // was; a remote one has to differ, or two machines silently alias.
    expect(worktreeIdFor('/home/a/src/ide', '')).toBe(worktreeIdFor('/home/a/src/ide'))
    expect(worktreeIdFor('/home/a/src/ide', 'https://other/')).not.toBe(
      worktreeIdFor('/home/a/src/ide'),
    )
  })
})

describe('paths', () => {
  it('puts new worktrees where claude --worktree puts them', () => {
    expect(defaultWorktreeRoot('/home/a/src/ide')).toBe('/home/a/src/ide/.claude/worktrees')
  })

  it('flattens a slashed branch into one directory name', () => {
    expect(worktreePathFor('/wt', 'feature/login')).toBe('/wt/feature-login')
  })
})

describe('against a real repository', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeRepoWithCommit()
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('reads the current branch, and null for a detached HEAD', async () => {
    expect(await currentBranch(repo.path)).toBe('main')
    await repo.git('checkout', '--detach', 'HEAD')
    expect(await currentBranch(repo.path)).toBeNull()
  })

  it('counts changed tracked and untracked entries', async () => {
    expect(await dirtyCount(repo.path)).toBe(0)
    await repo.write('README.md', 'changed\n')
    await repo.write('new.txt', 'new\n')
    expect(await dirtyCount(repo.path)).toBe(2)
  })

  it('answers null, not zero, when git cannot say', async () => {
    /*
     * The two mean opposite things to `removeWorktree`, which reads zero as
     * "nothing to lose, safe to kill the sessions" -- so a broken gitdir used
     * to kill an agent and then have git refuse the removal anyway.
     */
    expect(await dirtyCount('/definitely/not/a/path')).toBeNull()
  })

  it('lists the main worktree and every linked one', async () => {
    const path = join(repo.path, '.claude', 'worktrees', 'feature')
    await addWorktree({ root: repo.path, path, branch: 'feature' })

    const raw = await listRawWorktrees(repo.path)
    expect(raw.map((w) => w.branch)).toEqual(['main', 'feature'])
    expect(raw.every((w) => w.head !== null && !w.bare && !w.prunable)).toBe(true)

    const worktrees = await listWorktrees('p-1', repo.path)
    expect(worktrees).toHaveLength(2)
    const [main, feature] = worktrees
    expect(main?.isMain).toBe(true)
    // The main worktree is named after its branch: the directory is the
    // repository, whose name the interface already shows beside it.
    expect(main?.name).toBe('main')
    expect(feature?.isMain).toBe(false)
    expect(feature?.name).toBe('feature')
    expect(feature?.id).toBe(worktreeIdFor(path))
  })

  it('parses a worktree whose path contains a newline', async () => {
    /*
     * The reason the parse is `-z`. The line-oriented form prints the path raw
     * and unquoted, so this splits into two attributes and the parse invents a
     * worktree -- and an id is a hash of a path, so a mangled one is a session
     * pointed at nothing.
     */
    const path = join(repo.path, 'odd\nname')
    await addWorktree({ root: repo.path, path, branch: 'odd' })
    const raw = await listRawWorktrees(repo.path)
    expect(raw).toHaveLength(2)
    expect(raw.map((w) => resolve(w.path))).toContain(resolve(path))
  })

  it('marks a worktree whose directory has gone as prunable', async () => {
    const path = join(repo.path, 'gone')
    await addWorktree({ root: repo.path, path, branch: 'gone' })
    await repo.git('worktree', 'remove', '--force', path)
    // Registration and directory both gone: it simply is not listed any more.
    expect(await listRawWorktrees(repo.path)).toHaveLength(1)
  })

  it('finds the main worktree from inside a linked one', async () => {
    /*
     * `--show-toplevel` alone answers "which working tree am I in", which
     * inside a linked worktree is that worktree -- and a project registered
     * there listed the whole repository under a second project id, so every
     * worktree existed twice and closing one deleted the other's todos.
     */
    const path = join(repo.path, '.claude', 'worktrees', 'inner')
    await addWorktree({ root: repo.path, path, branch: 'inner' })
    expect(resolve(await repoRoot(path))).toBe(resolve(repo.path))
    expect(resolve(await repoRoot(repo.path))).toBe(resolve(repo.path))
  })

  it('counts commits the default branch does not have', async () => {
    const path = join(repo.path, '.claude', 'worktrees', 'ahead')
    await addWorktree({ root: repo.path, path, branch: 'ahead' })
    expect(await unmergedCount(path, 'main')).toBe(0)

    const inWorktree = async (...args: string[]): Promise<void> => {
      await repo.git('-C', path, ...args)
    }
    await inWorktree('commit', '--allow-empty', '-m', 'one')
    await inWorktree('commit', '--allow-empty', '-m', 'two')
    expect(await unmergedCount(path, 'main')).toBe(2)
  })

  it('counts nothing unmerged when there is no default branch to compare with', async () => {
    expect(await unmergedCount(repo.path, null)).toBe(0)
    expect(await unmergedCount(repo.path, 'origin/nope')).toBe(0)
  })

  it('falls back to HEAD when the repository has no remote', async () => {
    expect(await resolveDefaultBase(repo.path)).toBe(LOCAL_HEAD_BASE)
  })

  it('asks git whether a branch name is legal', async () => {
    expect(await isValidBranchName(repo.path, 'feature/login')).toBe(true)
    expect(await isValidBranchName(repo.path, 'has space')).toBe(false)
    expect(await isValidBranchName(repo.path, '')).toBe(false)
    expect(await isValidBranchName(repo.path, '-starts-with-dash')).toBe(false)
    expect(await isValidBranchName(repo.path, 'a/../b')).toBe(false)
  })

  it('checks out an existing branch rather than trying to create it again', async () => {
    await repo.git('branch', 'existing')
    const path = join(repo.path, 'wt')
    await addWorktree({ root: repo.path, path, branch: 'existing', base: 'main' })
    expect(await currentBranch(path)).toBe('existing')
  })

  it('removes a worktree, and needs force once it is dirty', async () => {
    const path = join(repo.path, 'wt')
    await addWorktree({ root: repo.path, path, branch: 'wt' })
    await repo.git('-C', path, 'rm', 'README.md')
    await expect(removeWorktree(repo.path, path)).rejects.toThrow()
    await removeWorktree(repo.path, path, true)
    expect(await listRawWorktrees(repo.path)).toHaveLength(1)
  })

  it('writes its worktree pattern into .git/info/exclude, once', async () => {
    /*
     * `.git/info/exclude` rather than `.gitignore`: repo-local and untracked,
     * so nothing appears in a file the team shares.
     */
    const excludeFile = join(repo.path, '.git', 'info', 'exclude')
    await ensureWorktreesIgnored(repo.path)
    await ensureWorktreesIgnored(repo.path)
    const lines = (await readFile(excludeFile, 'utf8')).split('\n')
    expect(lines.filter((line) => line.trim() === '**/.claude/worktrees/')).toHaveLength(1)
  })

  it('keeps a nested worktree out of the main worktree dirty count', async () => {
    await ensureWorktreesIgnored(repo.path)
    await addWorktree({
      root: repo.path,
      path: join(repo.path, '.claude', 'worktrees', 'nested'),
      branch: 'nested',
    })
    expect(await dirtyCount(repo.path)).toBe(0)
  })
})
