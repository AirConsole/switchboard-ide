import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Worktree } from '@switchboard/shared'

const exec = promisify(execFile)

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

/**
 * Ids are derived from the absolute path rather than generated.
 *
 * Sessions record their worktree id inside tmux, so the id must be identical
 * after an IDE restart or those sessions would be orphaned. Hashing the path
 * makes that automatic and needs no persistence to be correct.
 *
 * **The path and nothing else**, byte for byte as it always has been. Adding
 * even a separator would change every id on this machine and orphan every
 * session tmux is holding, which is the one thing this must not do.
 *
 * A path is not unique across machines -- two with a checkout at the same path
 * hash identically, and that is the normal case rather than a coincidence --
 * but that is not this function's problem any more. These are the ids a machine
 * gives its *own* projects; a linked machine's arrive already made, and are
 * namespaced on the way in by `remote/scope.ts`. This took a `host` parameter
 * for a while, against the day a project could live elsewhere. The day came and
 * the answer turned out to be one layer up, so the parameter is gone rather
 * than kept for a caller that never existed.
 */
const idFor = (prefix: string, path: string): string =>
  `${prefix}-${createHash('sha1').update(resolve(path)).digest('hex').slice(0, 10)}`

export const projectIdFor = (root: string): string => idFor('p', root)
export const worktreeIdFor = (path: string): string => idFor('wt', path)

export const isGitRepo = async (path: string): Promise<boolean> => {
  try {
    const out = await git(path, 'rev-parse', '--is-inside-work-tree')
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/** Absolute root of the main worktree, given any path inside the repo. */
/**
 * The *main* worktree of whatever repository `path` belongs to.
 *
 * `--show-toplevel` alone answers "which working tree am I in", which inside a
 * linked worktree is that worktree -- and a project registered there listed the
 * whole repository's worktrees under a second project id. Since ids are derived
 * from paths, every worktree then existed twice, `resolve()` returned whichever
 * project was registered first, and closing the second one collected "its"
 * worktrees and deleted the *other, still-open* project's queued todos.
 * Measured here: from `.claude/worktrees/ui`, `--show-toplevel` returns that
 * directory and `worktree list` returns all four.
 *
 * `--git-common-dir` is shared by every worktree of a repository, so its parent
 * is the main worktree -- except for a bare repository, where there is no
 * working tree to speak of and the toplevel is the honest answer.
 */
export const repoRoot = async (path: string): Promise<string> => {
  // --path-format=absolute keeps this correct when called from a subdirectory.
  const top = (await git(path, 'rev-parse', '--path-format=absolute', '--show-toplevel')).trim()
  try {
    const common = (
      await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    ).trim()
    if (common === '' || basename(common) !== '.git') return top
    const main = dirname(common)
    // Only trust it if it is really a working tree; a bare repo's common dir
    // has no worktree above it.
    return (await isGitRepo(main)) ? main : top
  } catch {
    return top
  }
}

export interface RawWorktree {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}

/**
 * Parse `git worktree list --porcelain -z`: attributes terminated by NUL, each
 * a `key value` or a bare flag, with an empty attribute between records.
 *
 * `-z` rather than the line-oriented form because a worktree's path is printed
 * raw and unquoted, so a path containing a newline splits into two attributes
 * and the parse silently invents a worktree -- and an id is a hash of a path,
 * so a mangled one is a session pointed at nothing. Supported since git 2.36
 * (measured against 2.39.5 on this machine).
 */
export const listRawWorktrees = async (root: string): Promise<RawWorktree[]> => {
  const stdout = await git(root, 'worktree', 'list', '--porcelain', '-z')
  const out: RawWorktree[] = []
  let current: RawWorktree | null = null
  for (const line of stdout.split('\0')) {
    if (line === '') {
      if (current) out.push(current)
      current = null
      continue
    }
    const spaceAt = line.indexOf(' ')
    const key = spaceAt === -1 ? line : line.slice(0, spaceAt)
    const value = spaceAt === -1 ? '' : line.slice(spaceAt + 1)
    if (key === 'worktree') {
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      }
      continue
    }
    if (!current) continue
    if (key === 'HEAD') current.head = value
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'detached') current.detached = true
    else if (key === 'bare') current.bare = true
    else if (key === 'locked') current.locked = true
    else if (key === 'prunable') current.prunable = true
  }
  if (current) out.push(current)
  return out
}

export const listWorktrees = async (projectId: string, root: string): Promise<Worktree[]> => {
  const raw = await listRawWorktrees(root)
  const mainPath = resolve(root)
  return raw.map((w) => {
    const isMain = resolve(w.path) === mainPath
    return {
      id: worktreeIdFor(w.path),
      projectId,
      /*
       * The main worktree is named after its branch, not its directory: the
       * directory is the repository, whose name the interface already shows
       * beside it, so using it here just says the project twice. A detached
       * main worktree has no branch to use, so it falls back to the directory.
       */
      name: isMain ? (w.branch ?? basename(mainPath)) : basename(w.path),
      branch: w.branch,
      path: w.path,
      isMain,
      missing: w.prunable,
      ...(w.head === null ? {} : { head: w.head }),
    }
  })
}

/**
 * Where new worktrees go: `<repo>/.claude/worktrees/`.
 *
 * This is Claude Code's own convention -- `claude --worktree` and its
 * EnterWorktree tool both create worktrees inside `.claude/worktrees/` -- so a
 * worktree made here and one made by Claude itself land in the same place, and
 * neither litters the directory above the repository.
 */
export const defaultWorktreeRoot = (root: string): string =>
  join(resolve(root), '.claude', 'worktrees')

const WORKTREE_IGNORE_PATTERN = '**/.claude/worktrees/'

/**
 * Make sure git ignores the worktrees directory.
 *
 * Worktrees now live inside the repository, so without this the main worktree
 * reports `.claude/` as untracked: it would inflate the dirty count on every
 * tab, block removal behind the "uncommitted changes" guard, and risk being
 * committed by a careless `git add -A`.
 *
 * The pattern goes in `.git/info/exclude` rather than `.gitignore` because that
 * file is repo-local and untracked, so nothing appears in a file the team
 * shares. Claude Code writes the identical pattern to the identical place.
 */
export const ensureWorktreesIgnored = async (root: string): Promise<void> => {
  try {
    const gitDir = (
      await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    ).trim()
    const excludeFile = join(gitDir, 'info', 'exclude')
    const current = await readFile(excludeFile, 'utf8').catch(() => '')
    if (current.split('\n').some((line) => line.trim() === WORKTREE_IGNORE_PATTERN)) return
    await mkdir(dirname(excludeFile), { recursive: true })
    const separator = current === '' || current.endsWith('\n') ? '' : '\n'
    await appendFile(excludeFile, `${separator}${WORKTREE_IGNORE_PATTERN}\n`)
  } catch {
    // Not fatal: the worktree still works, the main repo just looks dirty.
  }
}

export const currentBranch = async (path: string): Promise<string | null> => {
  try {
    const out = (await git(path, 'branch', '--show-current')).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/**
 * The branch a worktree's commits are measured against, per repository.
 *
 * `origin/HEAD` first, because that is what the remote itself says its default
 * is and it survives a repository whose default is neither `main` nor `master`.
 * It is a local symbolic ref, so reading it costs no network -- but it is also
 * only written when the remote was cloned or `set-head` was run, which is why
 * there are fallbacks: the remote's own `main`/`master` if one exists, then the
 * local branch of that name.
 *
 * Cached for the life of the process. A repository's default branch changes
 * about never, and the alternative is three `git` calls per worktree per poll.
 */
const defaults = new Map<string, string | null>()

export const defaultBranchRef = async (root: string): Promise<string | null> => {
  const known = defaults.get(root)
  if (known !== undefined) return known
  const ref = await (async (): Promise<string | null> => {
    try {
      const head = (
        await git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
      ).trim()
      if (head !== '') return head
    } catch {
      // No origin, or a remote that was never given a HEAD.
    }
    for (const candidate of ['refs/remotes/origin/main', 'refs/remotes/origin/master']) {
      try {
        await git(root, 'show-ref', '--verify', '--quiet', candidate)
        return candidate.replace('refs/remotes/', '')
      } catch {
        // Try the next one.
      }
    }
    for (const candidate of ['main', 'master']) {
      if (await branchExists(root, candidate)) return candidate
    }
    return null
  })()
  defaults.set(root, ref)
  return ref
}

/**
 * How many commits this worktree has that the default branch has not, *and*
 * that would bring anything with them.
 *
 * The question this answers is "would merging this branch bring anything" --
 * that is what the fork glyph on a tab and on the Files toggle means -- and
 * `rev-list --count <default>..HEAD` answers a narrower one: are there commits
 * over there that are not over here, *by identity*. The two agree until
 * something lands by any route that rewrites history, and then they disagree
 * permanently.
 *
 * A **squash merge** is that route, and it is how everything lands in this
 * repository. Master gets one new commit holding the same changes; the
 * branch's own commits are not ancestors of it, so `rev-list` goes on counting
 * them for as long as the worktree exists. Measured on this very branch an hour
 * after its pull request was merged: `rev-list --count master..HEAD` said 2 and
 * `git diff master HEAD` was empty. Every worktree in the row wore a fork glyph
 * saying it had work to contribute, having contributed it.
 *
 * So the count is confirmed against the *content*: identical trees mean the
 * merge would bring nothing, whatever the commits say. A rebase-and-merge lies
 * the same way and is fixed by the same check.
 *
 * Zero for the default branch itself, and zero when there is nothing to compare
 * against -- a repository with no default branch cannot have anything unmerged
 * from it.
 *
 * Two things this deliberately does not do. It does not reach for
 * `merge-tree`, which would also catch a branch that is ahead *and* behind
 * where the ahead part is already in -- that costs a real merge of two trees
 * per worktree per refresh, and nothing has hit it yet. And it does not run the
 * diff unless the count is non-zero, so the common answer stays one `rev-list`.
 */
export const unmergedCount = async (path: string, defaultRef: string | null): Promise<number> => {
  if (defaultRef === null) return 0
  try {
    const out = await git(path, 'rev-list', '--count', `${defaultRef}..HEAD`)
    const count = Number(out.trim())
    if (!Number.isFinite(count) || count === 0) return 0
    return (await differs(path, defaultRef, 'HEAD')) ? count : 0
  } catch {
    // A detached HEAD, an unborn branch, or a default ref that has gone.
    return 0
  }
}

/**
 * Whether two revisions hold different content.
 *
 * `git diff --quiet` says so by exiting 1, which `execFile` reports as a
 * failure rather than as an answer -- so the throw is the answer. Any *other*
 * failure lands here too, and is answered "they differ": this decides whether
 * to show a mark saying there is work here, and git falling over is not a
 * reason to tell somebody their work is already merged.
 */
const differs = async (path: string, from: string, to: string): Promise<boolean> => {
  try {
    await git(path, 'diff', '--quiet', from, to)
    return false
  } catch {
    return true
  }
}

/** Count of changed tracked+untracked entries, for the tab's dirty indicator. */
/**
 * Changed tracked+untracked entries, or null when git could not say.
 *
 * Null rather than zero, because the two mean opposite things to the one caller
 * that acts on this: `removeWorktree` reads a count of zero as "nothing to
 * lose, safe to kill the sessions". A broken gitdir link, or a `git status`
 * over the exec buffer, used to answer zero -- so the sessions died, git then
 * refused the removal, and the comment promising that "a refusal costs nothing"
 * was no longer true of the agent that had just been killed.
 */
export const dirtyCount = async (path: string): Promise<number | null> => {
  try {
    const out = await git(path, 'status', '--porcelain=v1', '--untracked-files=normal')
    return out.split('\n').filter((l) => l.trim() !== '').length
  } catch {
    return null
  }
}

export const branchExists = async (root: string, branch: string): Promise<boolean> => {
  try {
    await git(root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`)
    return true
  } catch {
    return false
  }
}

/**
 * Git refuses many characters in branch names; validating up front turns a
 * confusing git error into a clear message. `check-ref-format` is the authority,
 * so we ask git rather than reimplementing its rules.
 */
export const isValidBranchName = async (root: string, branch: string): Promise<boolean> => {
  if (branch.trim() === '' || branch.includes('/../') || branch.startsWith('-')) return false
  try {
    await git(root, 'check-ref-format', '--branch', branch)
    return true
  } catch {
    return false
  }
}

export interface AddWorktreeOptions {
  root: string
  /** Directory to create. Must not exist. */
  path: string
  branch: string
  /** Ref to branch from; defaults to the repo's current HEAD. */
  base?: string
}

export const addWorktree = async (opts: AddWorktreeOptions): Promise<void> => {
  const exists = await branchExists(opts.root, opts.branch)
  const args = ['worktree', 'add']
  if (exists) {
    // Checking out an existing branch: no -b, and no base (git would reject it).
    args.push(opts.path, opts.branch)
  } else {
    args.push('-b', opts.branch, opts.path)
    if (opts.base) args.push(opts.base)
  }
  await git(opts.root, ...args)
}

export const removeWorktree = async (
  root: string,
  path: string,
  force = false,
): Promise<void> => {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(path)
  await git(root, ...args)
}

export const deleteBranch = async (root: string, branch: string, force = false): Promise<void> => {
  await git(root, 'branch', force ? '-D' : '-d', branch)
}

/** A branch's copy on a remote, as `refs/remotes/` records it. */
export interface RemoteBranch {
  /** What the remote-tracking ref is called here, e.g. `origin/ui`. */
  ref: string
  /** The remote a deletion is pushed to, e.g. `origin`. */
  remote: string
  /** What the branch is called *on* that remote, e.g. `refs/heads/ui`. */
  remoteRef: string
  /** `defaultRef` already contains its tip, so it holds nothing of its own. */
  merged: boolean
}

const refLines = (out: string): string[] =>
  out.split('\n').map((line) => line.trim()).filter((line) => line !== '')

/**
 * Every local branch's copy on a remote, keyed by the local branch name.
 *
 * Three `for-each-ref` calls for the whole repository rather than one per
 * worktree: this runs on every poll, and a repository has one answer for all of
 * its worktrees the same way its default branch does.
 *
 * Existence comes from `refs/remotes`, not from the configured upstream.
 * Measured: after `git push --delete origin feat`, `%(upstream:short)` still
 * answers `origin/feat` -- the upstream is config, and deleting the branch on
 * the remote does not unset it -- so trusting it would offer to delete a branch
 * that is already gone.
 *
 * The fallback below is for a branch pushed with a plain
 * `git push origin <branch>`, which leaves a remote copy and no config saying
 * so, and for the branch whose upstream names something other than itself. It
 * matches by name on exactly one remote; two remotes carrying the name is a
 * guess, and this feeds a delete.
 */
export const remoteBranches = async (
  root: string,
  defaultRef: string | null,
): Promise<Map<string, RemoteBranch>> => {
  const found = new Map<string, RemoteBranch>()
  try {
    const present = new Set(
      refLines(await git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes')),
    )
    if (present.size === 0) return found
    // `--merged <ref>` is git's own "this tip is already in there", which is the
    // same question `unmergedCount` asks with rev-list -- asked here of every
    // remote branch at once. No default ref to compare with means nothing can
    // be called spent.
    const merged =
      defaultRef === null
        ? new Set<string>()
        : new Set(
            refLines(
              await git(
                root,
                'for-each-ref',
                '--merged',
                defaultRef,
                '--format=%(refname:short)',
                'refs/remotes',
              ),
            ),
          )
    const heads = await git(
      root,
      'for-each-ref',
      '--format=%(refname:short)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)',
      'refs/heads',
    )
    for (const line of refLines(heads)) {
      const [branch, upstream, remote, remoteRef] = line.split('\0')
      if (branch === undefined || branch === '') continue
      // The upstream must carry this branch's own name to be its copy. An
      // upstream is a merge *target*, not a copy: `git branch feat
      // origin/master` sets `branch.feat.merge` to `refs/heads/master` and
      // nothing since has pushed, so trusting it names master as "feat's copy
      // on the remote" -- and master is merged into itself, so it was reported
      // spent and went without being asked about. Measured: removing a worktree
      // on a never-pushed branch ran `push --delete origin refs/heads/master`,
      // which only the remote's own refusal to delete its default branch
      // stopped. A branch pushed under a different name on purpose falls
      // through to the name match below and is simply not offered, which is the
      // direction this is allowed to be wrong in.
      if (
        upstream !== undefined &&
        upstream !== '' &&
        present.has(upstream) &&
        remoteRef === `refs/heads/${branch}`
      ) {
        found.set(branch, {
          ref: upstream,
          remote: remote ?? 'origin',
          remoteRef,
          merged: merged.has(upstream),
        })
        continue
      }
      // A remote name cannot contain a slash, so the first one splits
      // `origin/feature/login` into the remote and the branch on it.
      const named = [...present].filter((ref) => ref.slice(ref.indexOf('/') + 1) === branch)
      if (named.length !== 1) continue
      const ref = named[0]!
      found.set(branch, {
        ref,
        remote: ref.slice(0, ref.indexOf('/')),
        remoteRef: `refs/heads/${branch}`,
        merged: merged.has(ref),
      })
    }
  } catch {
    // A repository with no remotes, or a git that could not answer: no remote
    // branch to offer, which is the same as having none.
  }
  return found
}

/**
 * Delete a branch on its remote.
 *
 * `--force-with-lease` is load-bearing, not belt and braces. Whether the branch
 * is spent was decided from `refs/remotes/...` as it stands on disk and nothing
 * in this server fetches, so a push by somebody else since the last fetch is
 * invisible here -- and "merged, so it goes without asking" would throw their
 * commits away. The lease makes git compare the remote's real tip with the
 * remote-tracking ref we judged and refuse when they differ; measured against a
 * stale clone, that is `! [rejected] (delete) -> feat (stale info)` and a
 * non-zero exit, with the branch still on the remote.
 *
 * A lease can also be refused over a branch that is *already* gone, and that is
 * not a failure: the tracking ref outlives a deletion made in another checkout
 * until something fetches or prunes, so git compares "I expect <sha>" against a
 * ref that is not there and answers `(stale info)` for both cases alike --
 * measured. So a rejection is checked against the remote itself, and only a
 * branch that is still standing is reported as one. Asking the remote is one
 * more round trip on a path that has already failed, and it is the difference
 * between "somebody pushed to this, look again" and a worktree that cannot be
 * removed because its branch was tidied up somewhere else.
 *
 * `GIT_TERMINAL_PROMPT=0` and a timeout because these are the git calls here
 * that touch the network, inside an HTTP request: an https remote with no
 * cached credentials would otherwise wait forever for a username to be typed on
 * a terminal nobody is looking at.
 */
const NETWORK_GIT = {
  maxBuffer: 8 * 1024 * 1024,
  timeout: 30_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}

export const deleteRemoteBranch = async (root: string, target: RemoteBranch): Promise<void> => {
  try {
    await exec(
      'git',
      ['push', '--force-with-lease', target.remote, '--delete', target.remoteRef],
      { cwd: root, ...NETWORK_GIT },
    )
  } catch (err) {
    // Anything but an empty answer leaves the push's refusal standing, the
    // unreadable remote included: a question we could not ask is not an answer
    // of "gone", and the push's own words are the better thing to show either
    // way.
    const standing = await exec(
      'git',
      ['ls-remote', '--heads', target.remote, target.remoteRef],
      { cwd: root, ...NETWORK_GIT },
    )
      .then(({ stdout }) => stdout.trim() !== '')
      .catch(() => true)
    if (standing) throw err
  }
}

export const pruneWorktrees = async (root: string): Promise<void> => {
  await git(root, 'worktree', 'prune')
}

/**
 * Turn a directory into a usable project: `git init` plus a first commit.
 *
 * The commit is not optional. A repository with no commits has no HEAD, and
 * `git worktree add` refuses to run against it ("fatal: not a valid object
 * name: 'HEAD'"), so a freshly created project could not do the one thing this
 * IDE exists for.
 *
 * `commitExisting` decides whether files already in the directory go into that
 * commit. Including them matters more than it looks: a first commit with no
 * files means every new worktree checks out an empty tree, so the branch you
 * hand an agent would not contain the project. `git add -A` honours a
 * .gitignore if one is there.
 *
 * `--allow-empty` covers both an empty directory and an opt-out, so there is
 * one code path either way.
 */
export const initRepository = async (
  path: string,
  opts: { commitExisting?: boolean } = {},
): Promise<void> => {
  await git(path, 'init')
  if (opts.commitExisting ?? true) await git(path, 'add', '-A')
  try {
    await git(path, 'commit', '--allow-empty', '-m', 'Initial commit')
  } catch (err) {
    /*
     * git refuses to commit with no author configured, which is the state a
     * freshly installed machine is in -- and this is the first thing a new user
     * does, so it is the first thing that breaks. The commit lands in *their*
     * repository, so inventing an identity here would be worse than failing:
     * they would find a stranger's name on the first commit of their own
     * project. Say what to run instead.
     */
    const text = err instanceof Error ? `${err.message}` : String(err)
    if (/empty ident|Author identity unknown|Please tell me who you are/i.test(text)) {
      throw new Error(
        'git has no author identity on this machine, so the first commit could not be made. Set one:\n' +
          '  git config --global user.name "Your Name"\n' +
          '  git config --global user.email "you@example.com"',
      )
    }
    throw err
  }
}

/** Root of the repository containing `path`, or null when there is none. */
export const enclosingRepoRoot = async (path: string): Promise<string | null> => {
  try {
    const out = await git(path, 'rev-parse', '--path-format=absolute', '--show-toplevel')
    return out.trim() === '' ? null : out.trim()
  } catch {
    return null
  }
}

export const worktreePathFor = (worktreeRoot: string, branch: string): string =>
  join(worktreeRoot, branch.replace(/\//g, '-'))

/** Used when a repository has no remote to be fresh against. */
export const LOCAL_HEAD_BASE = 'HEAD'

/**
 * The ref new worktrees branch from when none is named.
 *
 * This matches Claude Code's `worktree.baseRef` default of `fresh`: branch from
 * origin/<default-branch> "for a clean tree", rather than carrying whatever
 * happens to be checked out locally. `head` -- the other setting -- is what
 * typing a base by hand gives you.
 *
 * No fetch is performed: the remote-tracking ref is used as it stands, so this
 * never blocks on the network.
 */
export const resolveDefaultBase = async (root: string): Promise<string> => {
  // What the remote itself calls its default branch, when git has recorded it.
  try {
    const head = (
      await git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
    ).trim()
    if (head !== '') return head
  } catch {
    // origin/HEAD is only set by clone, or by `git remote set-head`.
  }
  for (const candidate of ['origin/main', 'origin/master']) {
    try {
      await git(root, 'rev-parse', '--verify', '--quiet', candidate)
      return candidate
    } catch {
      // Not this one.
    }
  }
  return LOCAL_HEAD_BASE
}
