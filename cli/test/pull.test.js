import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fastForward } from '../src/pull.js'

/*
 * Real git against throwaway repositories, like the server's git tests: every
 * answer here is git's, and a fixture would only be what we think git prints.
 * Identity is set per command because CI has no global git config.
 */
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim()

/** @type {string} */
let root
/** @type {string} */
let upstream
/** @type {string} */
let here

/** @param {string} dir @param {string} file @param {string} text */
const commit = (dir, file, text) => {
  writeFileSync(join(dir, file), text)
  git(dir, ['add', file])
  git(dir, ['commit', '-q', '-m', `${file}: ${text}`])
}

/** Somebody else's push: a second clone commits and pushes. */
const pushFromElsewhere = (/** @type {string} */ file, /** @type {string} */ text) => {
  const other = join(root, `other-${Math.random().toString(36).slice(2)}`)
  git(root, ['clone', '-q', upstream, other])
  commit(other, file, text)
  git(other, ['push', '-q', 'origin', 'master'])
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swb-pull-'))
  upstream = join(root, 'origin.git')
  const seed = join(root, 'seed')
  git(root, ['init', '-q', '--bare', '-b', 'master', upstream])
  git(root, ['init', '-q', '-b', 'master', seed])
  commit(seed, 'README', 'one')
  commit(seed, 'pnpm-lock.yaml', 'lock one')
  git(seed, ['push', '-q', upstream, 'master'])
  here = join(root, 'here')
  git(root, ['clone', '-q', upstream, here])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('fastForward', () => {
  it('moves to what origin has, and says the dependencies did not change', () => {
    const before = git(here, ['rev-parse', 'HEAD'])
    pushFromElsewhere('README', 'two')
    const result = fastForward(here)
    expect(result).toMatchObject({ ok: true, before, lockChanged: false })
    expect(git(here, ['rev-parse', 'HEAD'])).toBe(git(upstream, ['rev-parse', 'master']))
  })

  // What decides whether `pnpm install` runs. A Mac that skipped it after the
  // node-pty fix would have kept a helper it cannot execute.
  it('notices the lockfile changing', () => {
    pushFromElsewhere('pnpm-lock.yaml', 'lock two')
    expect(fastForward(here)).toMatchObject({ ok: true, lockChanged: true })
  })

  it('reports nothing new as the same commit on both sides', () => {
    const result = fastForward(here)
    expect(result.ok && result.before === result.after).toBe(true)
  })

  it('refuses a checkout on another branch, and touches nothing', () => {
    git(here, ['switch', '-q', '-c', 'feature'])
    pushFromElsewhere('README', 'two')
    const result = fastForward(here)
    expect(result).toMatchObject({ ok: false, problem: expect.stringContaining('"feature"') })
    expect(git(here, ['rev-parse', 'master'])).not.toBe(git(upstream, ['rev-parse', 'master']))
  })

  it('refuses uncommitted changes, and touches nothing', () => {
    const before = git(here, ['rev-parse', 'HEAD'])
    pushFromElsewhere('README', 'two')
    writeFileSync(join(here, 'README'), 'edited here')
    expect(fastForward(here)).toMatchObject({ ok: false, problem: expect.stringContaining('uncommitted') })
    expect(git(here, ['rev-parse', 'HEAD'])).toBe(before)
  })

  // `.claude/worktrees` is untracked in every checkout that has worktrees.
  it('is not stopped by an untracked file', () => {
    writeFileSync(join(here, 'scratch.txt'), 'mine')
    pushFromElsewhere('README', 'two')
    expect(fastForward(here)).toMatchObject({ ok: true })
  })

  /*
   * A Mac's clone predated a rewrite of origin's history. For that, git 2.39's
   * `pull --ff-only` says `fatal: Not possible to fast-forward, aborting.` and
   * nothing about what to do.
   */
  it('names a rewritten history and says how to recover from it', () => {
    const rewriter = join(root, 'rewriter')
    git(root, ['clone', '-q', upstream, rewriter])
    git(rewriter, ['commit', '-q', '--amend', '-m', 'rewritten'])
    git(rewriter, ['push', '-q', '--force', 'origin', 'master'])
    const before = git(here, ['rev-parse', 'HEAD'])
    const result = fastForward(here)
    expect(result).toMatchObject({
      ok: false,
      problem: expect.stringContaining('rewritten'),
      hint: 'if nothing here is yours to keep: git reset --hard origin/master, then pnpm pull',
    })
    expect(git(here, ['rev-parse', 'HEAD'])).toBe(before)
  })
})
