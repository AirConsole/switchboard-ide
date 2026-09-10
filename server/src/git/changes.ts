import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Commit, FileChange, WorktreeChanges } from '@ide-n-dream/shared'
import { LOCAL_HEAD_BASE, currentBranch, resolveDefaultBase } from './worktree.js'

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
    try {
      return await git(
        cwd,
        ['diff', '--no-index', '--no-color', '--', '/dev/null', file],
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
export const commitDiff = async (cwd: string, hash: string): Promise<string> =>
  git(cwd, ['show', '--no-color', '--format=', '--patch', '--first-parent', hash], MAX_DIFF_BYTES)
