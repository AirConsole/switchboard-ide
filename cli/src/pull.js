/**
 * `pnpm pull`: get the newest version of this checkout, and run it.
 *
 * Its own verb rather than a flag on `restart`, because a restart that quietly
 * fetches code is not a restart. And not `update` or `upgrade`: those are
 * pnpm's own commands, which pnpm runs *instead of* a script of the same name --
 * so `pnpm update` would have upgraded dependencies and said nothing about it.
 *
 * The work is git's and `restart`'s. What this file adds is refusing to do
 * either to a checkout it should not touch, and saying exactly why.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { inLinkedWorktree, repoRoot } from './instance.js'

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const gitOk = (cwd, args) => {
  try {
    git(cwd, args)
    return true
  } catch {
    return false
  }
}

/**
 * The branch this checkout should be on to be updated, as `origin` names it.
 *
 * `origin/HEAD` first, since that is what the remote says its default is; it
 * is only written at clone time, so `main` and `master` are tried after it.
 * @param {string} cwd
 * @returns {string | undefined}
 */
const defaultBranch = (cwd) => {
  try {
    return git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '')
  } catch {
    for (const name of ['main', 'master']) {
      if (gitOk(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`])) return name
    }
    return undefined
  }
}

/**
 * Bring a checkout up to date with its remote, or say why not.
 *
 * Fast-forward only. Anything else is somebody's work or a rewritten history,
 * and neither is something to resolve on their behalf.
 *
 * @param {string} cwd
 * @returns {{ ok: true, before: string, after: string, lockChanged: boolean } | { ok: false, problem: string, hint?: string }}
 */
export const fastForward = (cwd) => {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  git(cwd, ['fetch', '--quiet', 'origin'])
  const target = defaultBranch(cwd)
  if (target === undefined) {
    return { ok: false, problem: 'origin has no default branch this could update to' }
  }
  if (branch !== target) {
    return {
      ok: false,
      problem: `this checkout is on "${branch}", not "${target}"`,
      hint: `only ${target} is updated; \`git switch ${target}\` first if that is what you meant`,
    }
  }
  // Untracked files are not a reason to stop -- git refuses by itself if one
  // is in the way -- and `.claude/worktrees` would otherwise always count.
  if (git(cwd, ['status', '--porcelain', '--untracked-files=no']) !== '') {
    return {
      ok: false,
      problem: 'there are uncommitted changes here',
      hint: 'commit or discard them first; nothing was changed',
    }
  }
  const before = git(cwd, ['rev-parse', 'HEAD'])
  const upstream = `origin/${target}`
  /*
   * Behind is fine and equal is fine; anything else cannot be fast-forwarded.
   * A Mac's clone predated a rewrite of origin's history, and for that git
   * 2.39 says only `fatal: Not possible to fast-forward, aborting.` --
   * measured -- which says nothing about what to do.
   */
  if (!gitOk(cwd, ['merge-base', '--is-ancestor', 'HEAD', upstream])) {
    const mine = git(cwd, ['rev-list', '--count', `${upstream}..HEAD`])
    return {
      ok: false,
      problem: `${target} has ${mine} commit${mine === '1' ? '' : 's'} that ${upstream} does not -- local work, or the history on origin was rewritten`,
      hint: `if nothing here is yours to keep: git reset --hard ${upstream}, then pnpm pull`,
    }
  }
  const lockBefore = lockOf(cwd, before)
  git(cwd, ['merge', '--ff-only', '--quiet', upstream])
  const after = git(cwd, ['rev-parse', 'HEAD'])
  return { ok: true, before, after, lockChanged: lockOf(cwd, after) !== lockBefore }
}

/**
 * The lockfile's blob at a commit, so "did the dependencies change" is a
 * comparison of two hashes rather than of two files.
 * @param {string} cwd
 * @param {string} commit
 */
const lockOf = (cwd, commit) => {
  try {
    return git(cwd, ['rev-parse', `${commit}:pnpm-lock.yaml`])
  } catch {
    return ''
  }
}

/** @param {string} message @param {string} [hint] */
const fail = (message, hint) => {
  console.error(`swb pull: ${message}`)
  if (hint !== undefined) console.error(`  ${hint}`)
  process.exit(1)
}

/**
 * @param {string} cmd
 * @param {string[]} args
 */
const run = (cmd, args) => spawnSync(cmd, args, { cwd: repoRoot, stdio: 'inherit' }).status ?? 1

/**
 * @param {{ host?: string, force?: boolean, runningCommit?: string, running: boolean }} opts
 */
export const pull = (opts) => {
  if (!opts.force && inLinkedWorktree()) {
    fail(
      'this is a worktree. Worktrees develop, master deploys.',
      'pull and restart from the main checkout (--force overrides)',
    )
  }
  let result
  try {
    result = fastForward(repoRoot)
  } catch (err) {
    const stderr = /** @type {{ stderr?: unknown }} */ (err).stderr
    fail(typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : String(err))
    return
  }
  if (!result.ok) {
    fail(result.problem, result.hint)
    return
  }
  const { before, after, lockChanged } = result
  const short = (/** @type {string} */ sha) => sha.slice(0, 7)

  if (before === after) {
    console.log(`already up to date at ${short(after)}`)
    // Nothing new, but what is running may still be older than what is here --
    // somebody ran `git pull` by hand. Restart only then.
    if (opts.running && opts.runningCommit === after) {
      console.log('and that is what is running')
      return
    }
  } else {
    const log = git(repoRoot, ['log', '--oneline', '--no-decorate', `${before}..${after}`]).split('\n')
    console.log(`${short(before)} -> ${short(after)}, ${log.length} commit${log.length === 1 ? '' : 's'}:`)
    for (const line of log.slice(0, 15)) console.log(`  ${line}`)
    if (log.length > 15) console.log(`  ... and ${log.length - 15} more`)
  }

  // Also when node_modules is missing entirely, which no lockfile diff shows.
  if (lockChanged || !existsSync(join(repoRoot, 'node_modules'))) {
    console.log('dependencies changed; installing...')
    if (run('pnpm', ['install', '--frozen-lockfile']) !== 0) {
      fail('pnpm install failed -- nothing was restarted', `the code is at ${short(after)}; fix the install and run pnpm restart`)
    }
  }

  /*
   * A fresh process for the restart, not this one: this process is still
   * running the CLI as it was *before* the pull, and the restart it would do
   * is the old version's. The new one is on disk now.
   */
  const args = [join(repoRoot, 'cli', 'bin', 'swb.js'), 'restart']
  if (opts.host !== undefined) args.push('--host', opts.host)
  process.exit(run(process.execPath, args))
}
