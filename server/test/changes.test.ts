import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { commitDiff, fileDiff, parseCommits, parseStatus, worktreeChanges } from '../src/git/changes.js'
import { HttpError } from '../src/http-error.js'
import { addWorktree } from '../src/git/worktree.js'
import { makeRepoWithCommit, type TempRepo } from './helpers/repo.js'

describe('parseStatus', () => {
  it('reads a NUL-framed porcelain record', () => {
    expect(parseStatus('?? new.txt\0 M src/a.ts\0')).toEqual([
      { path: 'new.txt', status: '??' },
      { path: 'src/a.ts', status: ' M' },
    ])
  })

  it('keeps git’s two-letter code verbatim', () => {
    // The pair says things a single label cannot, like "staged as added, then
    // modified again".
    expect(parseStatus('AM a\0')[0]?.status).toBe('AM')
  })

  it('takes the second record of a rename as where the file came from', () => {
    expect(parseStatus('R  new.ts\0old.ts\0')).toEqual([
      { path: 'new.ts', status: 'R ', from: 'old.ts' },
    ])
    expect(parseStatus('C  copy.ts\0orig.ts\0')[0]?.from).toBe('orig.ts')
  })

  it('does not split a path that contains a newline', () => {
    // The whole reason for `-z`: the line format escapes these into a quoted
    // form that then has to be unescaped.
    expect(parseStatus('?? odd\nname.txt\0')).toEqual([{ path: 'odd\nname.txt', status: '??' }])
  })

  it('reads nothing out of a clean repository', () => {
    expect(parseStatus('')).toEqual([])
    expect(parseStatus('\0')).toEqual([])
  })
})

describe('parseCommits', () => {
  const record = (...fields: string[]): string => `${fields.join('\x1f')}\x1e`

  it('reads the fields the format asks for, seconds into epoch ms', () => {
    const out = record('abcdef0', 'abcdef', 'Do the thing', 'Ada', '1700000000')
    expect(parseCommits(out)).toEqual([
      { hash: 'abcdef0', short: 'abcdef', subject: 'Do the thing', author: 'Ada', at: 1_700_000_000_000 },
    ])
  })

  it('reads several commits and drops the empty trailing record', () => {
    const out = record('a', 'a', 'one', 'Ada', '1') + record('b', 'b', 'two', 'Bob', '2')
    expect(parseCommits(out).map((c) => c.subject)).toEqual(['one', 'two'])
  })

  it('keeps a subject that contains a newline', () => {
    // The separators are chosen precisely so a subject cannot contain them.
    expect(parseCommits(record('a', 'a', 'one\ntwo', 'Ada', '1'))[0]?.subject).toBe('one\ntwo')
  })

  it('reads nothing out of an empty log', () => {
    expect(parseCommits('')).toEqual([])
    expect(parseCommits('\n')).toEqual([])
  })
})

describe('commitDiff', () => {
  it('refuses a revision that could be read as an option', async () => {
    /*
     * `?commit=--output=/home/you/.bashrc` truncated that file and wrote a
     * patch into it, on a GET with no auth: `git show` has `--output=<file>`,
     * and `--` separates paths from revisions, not options from them.
     */
    await expect(commitDiff('/tmp', '--output=/tmp/pwned')).rejects.toBeInstanceOf(HttpError)
    await expect(commitDiff('/tmp', '-x')).rejects.toBeInstanceOf(HttpError)
  })

  it('refuses a revision with characters a revision cannot contain', async () => {
    await expect(commitDiff('/tmp', 'HEAD; rm -rf /')).rejects.toBeInstanceOf(HttpError)
    await expect(commitDiff('/tmp', '')).rejects.toBeInstanceOf(HttpError)
  })

  it('accepts the shapes a real revision takes', async () => {
    const repo = await makeRepoWithCommit()
    try {
      for (const rev of ['HEAD', 'HEAD~0', 'main', 'main^{}', 'refs/heads/main']) {
        await expect(commitDiff(repo.path, rev)).resolves.toBeTypeOf('string')
      }
    } finally {
      await repo.cleanup()
    }
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

  it('renders an untracked file as an all-additions patch', async () => {
    await repo.write('new.txt', 'one\ntwo\n')
    const patch = await fileDiff(repo.path, 'new.txt', true)
    expect(patch).toContain('+++ b/new.txt')
    expect(patch).toContain('+one')
    expect(patch).toContain('+two')
  })

  it('refuses to diff an untracked path outside the worktree', async () => {
    /*
     * `--no-index` is designed to work outside a repository, which is exactly
     * what made it dangerous: `?file=/etc/passwd&untracked=true` came back as
     * an all-additions patch of that file, bypassing every containment
     * guarantee in files.ts.
     */
    await expect(fileDiff(repo.path, '../../../etc/passwd', true)).rejects.toBeInstanceOf(HttpError)
    await expect(fileDiff(repo.path, '/etc/passwd', true)).rejects.toBeInstanceOf(HttpError)
  })

  it('shows staged and unstaged edits of one file together', async () => {
    // The question is "what does this file look like now compared with the last
    // commit"; whether the agent staged half of it is not part of it.
    await repo.write('README.md', 'hello\nstaged\n')
    await repo.git('add', 'README.md')
    await repo.write('README.md', 'hello\nstaged\nunstaged\n')
    const patch = await fileDiff(repo.path, 'README.md', false)
    expect(patch).toContain('+staged')
    expect(patch).toContain('+unstaged')
  })

  it('renders a rename as a move rather than as a whole new file', async () => {
    /*
     * `git diff HEAD -- <new>` alone sees a file that did not exist before and
     * renders the whole thing as additions, which for a moved file of any size
     * buries the actual change.
     */
    await repo.write('big.txt', Array.from({ length: 50 }, (_, n) => `line ${n}`).join('\n'))
    await repo.commit('add big')
    await rename(join(repo.path, 'big.txt'), join(repo.path, 'moved.txt'))
    await repo.git('add', '-A')
    const patch = await fileDiff(repo.path, 'moved.txt', false, 'big.txt')
    expect(patch).toContain('rename from big.txt')
    expect(patch).toContain('rename to moved.txt')
    expect(patch).not.toContain('+line 25')
  })

  it('shows what a merge brought in rather than nothing at all', async () => {
    /*
     * `git show` prints nothing for a merge -- it has no single parent to diff
     * against, so it declines to choose -- and "no textual difference" is a lie
     * about a merge.
     */
    await repo.git('checkout', '-b', 'side')
    await repo.write('side.txt', 'from the side\n')
    await repo.commit('side work')
    await repo.git('checkout', 'main')
    await repo.git('merge', '--no-ff', '-m', 'Merge side', 'side')
    const patch = await commitDiff(repo.path, 'HEAD')
    expect(patch).toContain('side.txt')
    expect(patch).toContain('+from the side')
  })

  it('reports a worktree’s own commits as ahead of its base', async () => {
    const path = join(repo.path, 'wt')
    await addWorktree({ root: repo.path, path, branch: 'wt' })
    await repo.git('-C', path, 'commit', '--allow-empty', '-m', 'agent work')

    const changes = await worktreeChanges({ worktreeId: 'wt-1', root: repo.path, path })
    expect(changes.branch).toBe('wt')
    expect(changes.base).toBe('main')
    expect(changes.commitScope).toBe('ahead')
    expect(changes.commits.map((c) => c.subject)).toEqual(['agent work'])
    expect(changes.behind).toBe(0)
  })

  it('falls back to recent history when a worktree has committed nothing', async () => {
    // A panel that answers "what happened here" with nothing at all is no use,
    // and `commitScope` is what keeps the fallback honest.
    const path = join(repo.path, 'wt')
    await addWorktree({ root: repo.path, path, branch: 'wt' })
    const changes = await worktreeChanges({ worktreeId: 'wt-1', root: repo.path, path })
    expect(changes.commitScope).toBe('recent')
    expect(changes.commits.map((c) => c.subject)).toEqual(['Initial commit'])
  })

  it('has no sensible base for the main worktree', async () => {
    const changes = await worktreeChanges({ worktreeId: 'wt-0', root: repo.path, path: repo.path })
    expect(changes.base).toBeNull()
    expect(changes.commitScope).toBe('recent')
  })

  it('counts how far behind its base a worktree is', async () => {
    const path = join(repo.path, 'wt')
    await addWorktree({ root: repo.path, path, branch: 'wt' })
    await repo.git('commit', '--allow-empty', '-m', 'moved on')
    await repo.git('commit', '--allow-empty', '-m', 'moved on again')
    const changes = await worktreeChanges({ worktreeId: 'wt-1', root: repo.path, path })
    expect(changes.behind).toBe(2)
  })

  it('lists uncommitted work alongside the commits', async () => {
    const path = join(repo.path, 'wt')
    await addWorktree({ root: repo.path, path, branch: 'wt' })
    await rm(join(path, 'README.md'))
    const changes = await worktreeChanges({ worktreeId: 'wt-1', root: repo.path, path })
    expect(changes.uncommitted).toEqual([{ path: 'README.md', status: ' D' }])
  })
})
