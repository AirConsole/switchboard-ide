import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  LOCAL_HEAD_BASE,
  addWorktree,
  currentBranch,
  defaultWorktreeRoot,
  deleteRemoteBranch,
  dirtyCount,
  ensureWorktreesIgnored,
  isValidBranchName,
  listRawWorktrees,
  listWorktrees,
  projectIdFor,
  remoteBranches,
  removeWorktree,
  repoRoot,
  resolveDefaultBase,
  unmergedCount,
  worktreeIdFor,
  worktreePathFor,
} from '../src/git/worktree.js'
import {
  makeRepoWithCommit,
  makeRepoWithRemote,
  type TempRemoteRepo,
  type TempRepo,
} from './helpers/repo.js'

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

  /*
   * The derivation is the path and nothing else, and it must stay that way:
   * these ids are recorded inside tmux's own metadata, so changing how they are
   * computed orphans every running session.
   *
   * It carried a `host` parameter for a while, against the day a project could
   * live on another machine. That day came, and the answer turned out to be one
   * layer up -- a linked machine's ids arrive already made and are namespaced by
   * `remote/scope.ts` -- so what this guards now is that nothing crept back in.
   */
  it('hashes the path and nothing else', () => {
    expect(worktreeIdFor('/home/a/src/ide')).toBe(worktreeIdFor('/home/a/src/ide/'))
    expect(worktreeIdFor('/home/a/src/ide')).not.toBe(worktreeIdFor('/home/a/src/other'))
    expect(worktreeIdFor('/home/a/src/ide')).toMatch(/^wt-[0-9a-f]{10}$/)
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
    /*
     * Real content, not `--allow-empty`. The count exists to answer "would
     * merging this bring anything", and two empty commits are two commits that
     * bring nothing -- a fixture that passes for the wrong reason.
     */
    await writeFile(join(path, 'one.txt'), 'one\n', 'utf8')
    await inWorktree('add', '-A')
    await inWorktree('commit', '-m', 'one')
    await writeFile(join(path, 'two.txt'), 'two\n', 'utf8')
    await inWorktree('add', '-A')
    await inWorktree('commit', '-m', 'two')
    expect(await unmergedCount(path, 'main')).toBe(2)
  })

  it('counts nothing once a squash merge has taken the work', async () => {
    /*
     * How everything lands in this repository, and the reason this check
     * exists: a squash merge puts one *new* commit on the default branch, so
     * the branch's own commits are never its ancestors and `rev-list` counts
     * them for as long as the worktree exists. Measured on the branch this was
     * written on: `rev-list --count master..HEAD` said 2 and `git diff master
     * HEAD` was empty, and every worktree in the row wore a fork glyph saying
     * it had work to contribute, having contributed it.
     */
    const path = join(repo.path, '.claude', 'worktrees', 'squashed')
    await addWorktree({ root: repo.path, path, branch: 'squashed' })
    await writeFile(join(path, 'work.txt'), 'work\n', 'utf8')
    await repo.git('-C', path, 'add', '-A')
    await repo.git('-C', path, 'commit', '-m', 'the work')
    expect(await unmergedCount(path, 'main')).toBe(1)

    await repo.git('merge', '--squash', 'squashed')
    await repo.git('commit', '-m', 'the work (#1)')
    // The commit is still not in main -- only what it did is.
    expect((await repo.git('rev-list', '--count', 'main..squashed')).trim()).toBe('1')
    expect(await unmergedCount(path, 'main')).toBe(0)
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

describe('against a real remote', () => {
  let repo: TempRemoteRepo

  beforeEach(async () => {
    repo = await makeRepoWithRemote()
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  /** A branch with `n` commits on it, pushed to origin with an upstream set. */
  const pushBranch = async (name: string, commits = 1): Promise<void> => {
    await repo.git('checkout', '-b', name, 'main')
    for (let i = 0; i < commits; i += 1) {
      await repo.git('commit', '--allow-empty', '-m', `${name} ${i}`)
    }
    await repo.git('push', '-u', 'origin', name)
    await repo.git('checkout', 'main')
  }

  it('finds a pushed branch, and says whether the default branch has it', async () => {
    await pushBranch('feature')
    const before = await remoteBranches(repo.path, 'origin/main')
    expect(before.get('feature')).toEqual({
      ref: 'origin/feature',
      remote: 'origin',
      remoteRef: 'refs/heads/feature',
      merged: false,
    })

    await repo.git('merge', '--no-ff', 'feature', '-m', 'merge feature')
    await repo.git('push', 'origin', 'main')
    expect((await remoteBranches(repo.path, 'origin/main')).get('feature')?.merged).toBe(true)
  })

  it('reads existence from the ref, because the upstream outlives the branch', async () => {
    /*
     * The measurement this whole design rests on. After the branch is deleted
     * on the remote, `%(upstream:short)` still answers `origin/feature` -- the
     * upstream is config, and deleting the branch does not unset it -- so a
     * dialog built on the upstream would offer to delete a branch that is
     * provably gone, and the delete would fail with "remote ref does not
     * exist".
     */
    await pushBranch('feature')
    await repo.git('push', 'origin', '--delete', 'feature')
    expect(await repo.git('for-each-ref', '--format=%(upstream:short)', 'refs/heads/feature')).toContain(
      'origin/feature',
    )
    expect((await remoteBranches(repo.path, 'origin/main')).has('feature')).toBe(false)
  })

  it('does not call the default branch the copy of a never-pushed branch', async () => {
    /*
     * The bug this records deleted the wrong branch on the remote, unasked.
     *
     * `git branch feat origin/main` sets `branch.feat.merge` to
     * `refs/heads/main` -- an upstream is the branch you merge *from*, not a
     * copy of yours -- and nothing has been pushed. Reading that as "feat's
     * copy on the remote is main" made the removal dialog report the copy as
     * spent (main is merged into itself), which is the path that goes without
     * being asked about, and the removal ran
     * `push --delete origin refs/heads/main`. Measured against GitHub, the only
     * thing that stopped it was the remote's own `! [remote rejected] master
     * (refusing to delete the current branch)`; a branch created from any
     * *deletable* origin ref would have gone.
     */
    await repo.git('branch', 'feat', 'origin/main')
    expect(
      (await repo.git('for-each-ref', '--format=%(upstream:remoteref)', 'refs/heads/feat')).trim(),
    ).toBe('refs/heads/main')
    expect((await remoteBranches(repo.path, 'origin/main')).has('feat')).toBe(false)
  })

  it('finds a branch pushed without an upstream, by its name on the one remote', async () => {
    // `git push origin <branch>` leaves a copy on the remote and no config
    // saying so, and that copy is still the one the human means.
    await repo.git('checkout', '-b', 'stray', 'main')
    await repo.git('commit', '--allow-empty', '-m', 'stray work')
    await repo.git('push', 'origin', 'stray')
    // Measured, and the reason the fallback is not hypothetical: a push with
    // no `-u` really does leave no upstream -- `git branch --unset-upstream
    // stray` here fails with "Branch 'stray' has no upstream information".
    expect(
      (await repo.git('for-each-ref', '--format=[%(upstream:short)]', 'refs/heads/stray')).trim(),
    ).toBe('[]')
    await repo.git('checkout', 'main')
    expect((await remoteBranches(repo.path, 'origin/main')).get('stray')).toEqual({
      ref: 'origin/stray',
      remote: 'origin',
      remoteRef: 'refs/heads/stray',
      merged: false,
    })
  })

  it('calls nothing spent when there is no default branch to compare with', async () => {
    await pushBranch('feature', 0)
    expect((await remoteBranches(repo.path, null)).get('feature')?.merged).toBe(false)
  })

  it('offers nothing in a repository with no remote', async () => {
    const alone = await makeRepoWithCommit()
    try {
      expect((await remoteBranches(alone.path, 'main')).size).toBe(0)
    } finally {
      await alone.cleanup()
    }
  })

  it('is content with a branch somebody else already deleted', async () => {
    /*
     * The lease cannot tell the two stale cases apart, and one of them is not a
     * failure. A deletion made in another checkout leaves this one's tracking
     * ref standing until something fetches or prunes, so git compares "I expect
     * <sha>" against a ref that is not there and answers `(stale info)` --
     * measured, the same words as a branch somebody pushed to. Reporting that
     * as a failure made a worktree unremovable because its branch had been
     * tidied up somewhere else, which is the outcome that was asked for.
     */
    await pushBranch('feature')
    const target = (await remoteBranches(repo.path, 'origin/main')).get('feature')!

    const theirs = await repo.elsewhere()
    await theirs.git('push', 'origin', '--delete', 'feature')
    expect(await repo.git('for-each-ref', '--format=x', 'refs/remotes/origin/feature')).toContain('x')

    await expect(deleteRemoteBranch(repo.path, target)).resolves.toBeUndefined()
  })

  it('deletes the branch on the remote', async () => {
    await pushBranch('feature')
    const target = (await remoteBranches(repo.path, 'origin/main')).get('feature')!
    await deleteRemoteBranch(repo.path, target)
    expect(await repo.git('ls-remote', '--heads', 'origin', 'feature')).toBe('')
  })

  it('refuses to delete a remote branch that moved since the last fetch', async () => {
    /*
     * The lease, which is the whole safety of deleting a merged branch
     * unasked. Merged-ness is read from `refs/remotes/...` on disk and nothing
     * here fetches, so a colleague's push is invisible -- and without the lease
     * this would delete their commits. Measured: git answers
     * `! [rejected] (delete) -> feature (stale info)` and exits non-zero.
     */
    await pushBranch('feature')
    const target = (await remoteBranches(repo.path, 'origin/main')).get('feature')!

    const theirs = await repo.elsewhere()
    await theirs.git('checkout', '-b', 'feature', 'origin/feature')
    await theirs.git('commit', '--allow-empty', '-m', 'work this clone has not seen')
    await theirs.git('push', 'origin', 'feature')

    await expect(deleteRemoteBranch(repo.path, target)).rejects.toThrow(/stale info/)
    expect(await repo.git('ls-remote', '--heads', 'origin', 'feature')).toContain('feature')
  })
})
