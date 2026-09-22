import { execFile } from 'node:child_process'
import { relative } from 'node:path'
import { promisify } from 'node:util'
import type { Commit, FileChange, WorktreeChanges } from '@switchboard/shared'
import { LOCAL_HEAD_BASE, currentBranch, resolveDefaultBase } from './worktree.js'
import { PARALLEL_GIT, mapLimit, memberRoot, type Member } from './multirepo.js'
import { containedPath } from '../files.js'
import { HttpError } from '../http-error.js'

const exec = promisify(execFile)

/**
 * A diff can be large, so the buffer is generous -- but a runaway one is capped
 * rather than allowed to become the server's memory problem.
 */
const MAX_DIFF_BYTES = 8 * 1024 * 1024

const git = async (cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> => {
  const { stdout } = await exec('git', args, { cwd, maxBuffer })
  return stdout
}

/**
 * The ref this worktree's commits are measured against.
 *
 * `origin/<default>` when there is a remote, because that is what the branch
 * will eventually be merged into and so what "what has this worktree done"
 * means. With no remote it falls back to whatever branch the main worktree has
 * checked out, which is the same question asked locally.
 *
 * Null when the answer would be degenerate: comparing a branch against itself
 * lists nothing, and saying so is better than showing an empty section as
 * though the agent had committed nothing.
 */
export const resolveReviewBase = async (
  root: string,
  worktreeBranch: string | null,
): Promise<string | null> => {
  const remote = await resolveDefaultBase(root)
  if (remote !== LOCAL_HEAD_BASE) {
    // origin/main is not the same ref as main, so this stays useful even when
    // the worktree is on the default branch.
    return remote
  }
  const local = await currentBranch(root)
  if (local === null || local === worktreeBranch) return null
  return local
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * NUL-separated rather than line-based because a path may contain anything at
 * all, including a newline, and git's line format escapes those into a quoted
 * form that then has to be unescaped. `-z` sidesteps the whole problem.
 *
 * A rename entry is two records: the status and new path, then the old path.
 */
export const parseStatus = (out: string): FileChange[] => {
  const records = out.split('\0')
  const changes: FileChange[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record === undefined || record.length < 4) continue
    const status = record.slice(0, 2)
    const path = record.slice(3)
    // R and C spend a second record on where the file came from.
    if (status[0] === 'R' || status[0] === 'C') {
      const from = records[++i]
      changes.push({ path, status, ...(from === undefined ? {} : { from }) })
      continue
    }
    changes.push({ path, status })
  }
  return changes
}

/**
 * How much history a worktree shows when it has nothing ahead.
 *
 * Enough to see what has been going on, not so much that the list becomes a
 * log viewer -- the panel is for reviewing a worktree, and `git log` in a
 * terminal is right there for the rest.
 */
const RECENT_COMMITS = 20

/** Field and record separators that cannot occur in a commit subject. */
const FIELD = '\x1f'
const RECORD = '\x1e'

export const parseCommits = (out: string): Commit[] =>
  out
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [hash = '', short = '', subject = '', author = '', at = '0'] = record.split(FIELD)
      return { hash, short, subject, author, at: Number(at) * 1000 }
    })

const FORMAT = `--format=%H${FIELD}%h${FIELD}%s${FIELD}%an${FIELD}%at${RECORD}`

/** The last few commits here, whatever branch this is. */
const recentCommits = async (cwd: string): Promise<Commit[]> => {
  try {
    return parseCommits(await git(cwd, ['log', FORMAT, '-n', String(RECENT_COMMITS), 'HEAD']))
  } catch {
    // A repository with no commits yet has no HEAD to log.
    return []
  }
}

export const worktreeChanges = async (opts: {
  worktreeId: string
  root: string
  path: string
}): Promise<WorktreeChanges> => {
  const branch = await currentBranch(opts.path)
  const base = await resolveReviewBase(opts.root, branch)

  const uncommitted = parseStatus(
    await git(opts.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  )
  const nothingAhead = async (withBase: string | null): Promise<WorktreeChanges> => ({
    worktreeId: opts.worktreeId,
    branch,
    base: withBase,
    uncommitted,
    /*
     * History, whatever worktree this is.
     *
     * Only the main worktree used to fall back to it, on the argument that a
     * branch with nothing ahead of its base has done nothing yet and the
     * history it would show is the base branch's, not its own. True, and the
     * conclusion was wrong: what it produced was an empty panel on every
     * worktree that had not committed yet, which answers nothing. `commitScope`
     * already exists to keep it honest -- these are labelled "Recent commits"
     * rather than as this branch's own work -- so showing them credits the
     * worktree with nothing, and knowing what the branch was cut from is worth
     * having.
     */
    commits: await recentCommits(opts.path),
    commitScope: 'recent',
    behind: 0,
  })

  // No sensible base: the main worktree, or a branch that is its own base.
  if (base === null) return nothingAhead(null)

  // A base that is not an ancestor would make `base..HEAD` misleading, so both
  // counts come from the symmetric difference, which is what ahead/behind mean.
  let ahead: Commit[]
  let behind: number
  try {
    ahead = parseCommits(await git(opts.path, ['log', FORMAT, `${base}..HEAD`]))
    behind = Number((await git(opts.path, ['rev-list', '--count', `HEAD..${base}`])).trim())
  } catch {
    // A base that no longer resolves (a deleted remote branch, say) is not a
    // reason to fail the whole panel: everything else is still the truth.
    return nothingAhead(null)
  }

  // Nothing of its own to show yet, so show what has happened here instead.
  if (ahead.length === 0) {
    return { ...(await nothingAhead(base)), behind }
  }

  return {
    worktreeId: opts.worktreeId,
    branch,
    base,
    uncommitted,
    commits: ahead,
    commitScope: 'ahead',
    behind,
  }
}

/**
 * A workspace worktree's changes: each repository's, as one list.
 *
 * Paths are prefixed with the repository's directory, which is what they are
 * relative to the worktree -- so the changed-files tree groups by repository
 * with no help, and a path picked in it is the same path the files tree opens.
 *
 * Commits cannot be merged that way: two repositories' histories have no order
 * between them but the clock. So each one carries its `repo`, and the list is
 * one question asked of all of them: the commits ahead of each repository's
 * base where any repository has some, and the newest history of all of them
 * otherwise -- mixing the two would put one repository's old history among
 * another's new work under a heading claiming it is all work. `base` and
 * `behind` have no single answer across repositories and are left out.
 *
 * A repository that cannot answer is left out rather than failing the rest:
 * the panel is for reading what the others did.
 */
export const workspaceChanges = async (opts: {
  worktreeId: string
  branch: string | null
  members: readonly Member[]
}): Promise<WorktreeChanges> => {
  const each = await mapLimit(opts.members, PARALLEL_GIT, async (member) => {
    try {
      const changes = await worktreeChanges({
        worktreeId: opts.worktreeId,
        root: await memberRoot(member.path),
        path: member.path,
      })
      return { member, changes }
    } catch {
      return null
    }
  })
  const answered = each.filter((e): e is NonNullable<typeof e> => e !== null)
  const tagged = (scope: 'ahead' | 'recent'): Commit[] =>
    answered
      .filter((e) => e.changes.commitScope === scope)
      .flatMap((e) => e.changes.commits.map((commit) => ({ ...commit, repo: e.member.name })))
      .sort((a, b) => b.at - a.at)
  const ahead = tagged('ahead')
  return {
    worktreeId: opts.worktreeId,
    branch: opts.branch,
    base: null,
    uncommitted: answered.flatMap((e) =>
      e.changes.uncommitted.map((change) => ({
        ...change,
        path: `${e.member.name}/${change.path}`,
        ...(change.from === undefined ? {} : { from: `${e.member.name}/${change.from}` }),
      })),
    ),
    commits: ahead.length > 0 ? ahead : tagged('recent').slice(0, RECENT_COMMITS),
    commitScope: ahead.length > 0 ? 'ahead' : 'recent',
    behind: 0,
  }
}

/**
 * Which repository of a workspace worktree a worktree-relative path is in, and
 * the path inside it.
 *
 * By the first segment and nothing else, so `../` or an absolute path cannot
 * name a repository; what is left is contained by `fileDiff` itself, the same
 * as in a single repository.
 */
export const memberOf = (
  members: readonly Member[],
  path: string,
): { member: Member; inner: string } => {
  const at = path.indexOf('/')
  const member = at > 0 ? members.find((m) => m.name === path.slice(0, at)) : undefined
  if (member === undefined) {
    throw new HttpError(400, `${path} is not inside any of this worktree's repositories`)
  }
  return { member, inner: path.slice(at + 1) }
}

/**
 * The unified diff for one uncommitted file.
 *
 * Against HEAD rather than the index, so staged and unstaged edits appear
 * together: the question being asked is "what does this file look like now
 * compared with the last commit", and whether the agent happened to stage part
 * of it is not part of that.
 *
 * An untracked file has nothing to diff against, so it is diffed against
 * /dev/null to render as an all-additions patch rather than as nothing.
 *
 * A rename is asked for by both paths, because `git diff HEAD -- <new>` alone
 * sees only a file that did not exist before and renders the whole thing as
 * additions -- which for a moved file of any size buries the actual change, and
 * misstates what the agent did.
 */
export const fileDiff = async (
  cwd: string,
  file: string,
  untracked: boolean,
  from?: string,
): Promise<string> => {
  if (untracked) {
    /*
     * `--no-index` is designed to work outside a repository, which is exactly
     * what makes it dangerous here: `?file=/etc/passwd&untracked=true` came
     * back as an all-additions patch of that file, and `?file=~/.claude.json`
     * returned 104KB of it. Every containment guarantee in files.ts was
     * bypassed by this one argument, so the path goes through the same gate.
     * The tracked branch below is safe only because git itself rejects a path
     * outside the repo after `--`.
     */
    // Validated as an absolute path, then handed to git as a relative one: the
    // patch header is the file's name in the worktree, and `a/tmp/swb-.../x`
    // is not what the panel means to show.
    const target = relative(cwd, await containedPath(cwd, file))
    try {
      return await git(
        cwd,
        ['diff', '--no-index', '--no-color', '--', '/dev/null', target],
        MAX_DIFF_BYTES,
      )
    } catch (err) {
      // `--no-index` exits 1 when the files differ, which is always. The patch
      // is on stdout regardless.
      const out = (err as { stdout?: string }).stdout
      if (typeof out === 'string') return out
      throw err
    }
  }
  const paths = from === undefined ? [file] : [from, file]
  return git(cwd, ['diff', '--no-color', '-M', 'HEAD', '--', ...paths], MAX_DIFF_BYTES)
}

/**
 * The unified diff a single commit introduced.
 *
 * `--first-parent` because `git show` prints nothing at all for a merge -- it
 * has no single parent to diff against, so it declines to choose -- and a merge
 * commit reading as "no textual difference" is a lie. Against the first parent
 * it says what the merge brought in, which is the question being asked. For an
 * ordinary commit with one parent it changes nothing.
 */
export const commitDiff = async (cwd: string, hash: string): Promise<string> => {
  /*
   * `--` and a shape check, because a commit-ish arrives from a query string.
   *
   * Without them git reads a leading dash as an option, and `git show` has
   * `--output=<file>`: `?commit=--output=/home/you/.bashrc` truncated that file
   * and wrote a patch into it, on a GET with no auth. Verified before the fix.
   * The `--` alone is not enough -- it separates paths from revisions, not
   * options from revisions -- so the value is also checked against the
   * characters a revision can actually contain.
   */
  if (!/^[0-9a-zA-Z._/^~@{}-]+$/.test(hash) || hash.startsWith('-')) {
    throw new HttpError(400, 'not a commit')
  }
  return git(
    cwd,
    ['show', '--no-color', '--format=', '--patch', '--first-parent', hash, '--'],
    MAX_DIFF_BYTES,
  )
}
