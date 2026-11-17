import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { autoDecision, behindOrigin, nodeReplaced, nodeRestartDecision } from '../src/update.js'
import { makeRepoWithRemote, type TempRemoteRepo } from './helpers/repo.js'

/*
 * Real git against a real remote, because what is being asked is what git and
 * a remote say to each other: which commits origin has that a build does not,
 * and whether `swb pull` would take them.
 */
let repo: TempRemoteRepo | undefined
afterEach(async () => {
  await repo?.cleanup()
  repo = undefined
})

/** Land commits on origin's main from another clone, then fetch them here. */
const landOnOrigin = async (r: TempRemoteRepo, ...subjects: string[]): Promise<void> => {
  const other = await r.elsewhere()
  await other.git('checkout', '-b', 'main', 'origin/main')
  for (const subject of subjects) await other.commit(subject)
  await other.git('push', 'origin', 'main')
  await r.git('fetch', 'origin')
}

const head = async (r: TempRemoteRepo): Promise<string> => (await r.git('rev-parse', 'HEAD')).trim()

describe('behindOrigin', () => {
  it('says nothing when the build is what origin has', async () => {
    repo = await makeRepoWithRemote()
    const result = await behindOrigin(repo.path, await head(repo))
    expect(result).toEqual({ branch: 'main', commits: [], behind: 0, blocked: null })
  })

  it('lists what origin has that the build does not, newest first', async () => {
    repo = await makeRepoWithRemote()
    await landOnOrigin(repo, 'First fix', 'Second fix')
    const result = await behindOrigin(repo.path, await head(repo))
    expect(result.behind).toBe(2)
    expect(result.commits.map((c) => c.subject)).toEqual(['Second fix', 'First fix'])
    expect(result.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.blocked).toBeNull()
  })

  /*
   * After a `git pull` by hand the checkout is current and the process is not
   * -- exactly the case `pnpm pull` restarts for. Measured from HEAD, this
   * said there was nothing to do.
   */
  it('measures from the build, not from the checkout', async () => {
    repo = await makeRepoWithRemote()
    const built = await head(repo)
    await landOnOrigin(repo, 'Merged while it ran')
    await repo.git('merge', '--ff-only', 'origin/main')
    expect((await behindOrigin(repo.path, built)).behind).toBe(1)
    expect((await behindOrigin(repo.path, null)).behind).toBe(0)
  })

  it('names what would make pull refuse, before anyone clicks', async () => {
    repo = await makeRepoWithRemote()
    await landOnOrigin(repo, 'Upstream')
    const built = await head(repo)

    await repo.write('README.md', 'edited\n')
    expect((await behindOrigin(repo.path, built)).blocked).toMatch(/uncommitted changes$/)
    await repo.git('checkout', '--', 'README.md')

    await repo.git('checkout', '-b', 'feature')
    expect((await behindOrigin(repo.path, built)).blocked).toMatch(/is on "feature", not "main"$/)
    await repo.git('checkout', 'main')

    await repo.commit('Local only')
    expect((await behindOrigin(repo.path, built)).blocked).toMatch(/has commits that origin\/main does not$/)
  })

  it('does not count from a build this clone has never seen', async () => {
    repo = await makeRepoWithRemote()
    await landOnOrigin(repo, 'Upstream')
    const result = await behindOrigin(repo.path, 'f'.repeat(40))
    expect(result.behind).toBe(0)
  })
})

/*
 * A machine updates itself once a page has found origin ahead, or a linked
 * machine has said so -- but never under somebody typing, never into a pull
 * that would refuse, and never again into the commit it had to roll back
 * from, which would otherwise be pulled and rolled back on every poll.
 */
describe('autoDecision', () => {
  const MIN = 60_000
  const base = {
    behind: 2,
    blocked: null,
    updating: false,
    head: 'abc',
    failed: null,
    lastTypedAt: 0,
    now: 60 * MIN,
  }

  it('goes once nobody has typed for five minutes', () => {
    expect(autoDecision(base)).toBe('now')
    expect(autoDecision({ ...base, lastTypedAt: base.now - 5 * MIN })).toBe('now')
  })

  it('waits while somebody is typing', () => {
    expect(autoDecision({ ...base, lastTypedAt: base.now - 4 * MIN })).toBe('wait')
  })

  it('does nothing with nothing to pull, a pull that would refuse, or one running', () => {
    expect(autoDecision({ ...base, behind: 0 })).toBe('none')
    expect(autoDecision({ ...base, blocked: 'on "ui", not "master"' })).toBe('none')
    expect(autoDecision({ ...base, updating: true })).toBe('none')
  })

  it('skips the commit it went back from, and tries the next one', () => {
    expect(autoDecision({ ...base, failed: 'abc' })).toBe('skipped')
    expect(autoDecision({ ...base, failed: 'older' })).toBe('now')
  })
})

/*
 * Unattended upgrades replace /usr/bin/node under a running IDE, which goes on
 * running the old one -- unpatched -- until it restarts.
 */
describe('nodeRestartDecision', () => {
  const MIN = 60_000
  const base = { replaced: true, updating: false, lastTypedAt: 0, now: 60 * MIN }

  it('restarts once nobody has typed for five minutes, and not before', () => {
    expect(nodeRestartDecision(base)).toBe('now')
    expect(nodeRestartDecision({ ...base, lastTypedAt: base.now - 4 * MIN })).toBe('wait')
  })

  it('does nothing while Node is the one it started with, or while an update runs', () => {
    expect(nodeRestartDecision({ ...base, replaced: false })).toBe('none')
    expect(nodeRestartDecision({ ...base, updating: true })).toBe('none')
  })
})

describe.runIf(existsSync('/proc/self/exe'))('nodeReplaced', () => {
  it('sees a running binary replaced the way dpkg replaces one, by rename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swb-exe-'))
    const binary = join(dir, 'sleep')
    copyFileSync(execFileSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim(), binary)
    chmodSync(binary, 0o755)
    const running = spawn(binary, ['30'], { stdio: 'ignore' })
    try {
      await new Promise((resolve) => running.once('spawn', resolve))
      expect(nodeReplaced(`/proc/${String(running.pid)}/exe`)).toBe(false)
      copyFileSync(binary, `${binary}.new`)
      renameSync(`${binary}.new`, binary)
      expect(nodeReplaced(`/proc/${String(running.pid)}/exe`)).toBe(true)
    } finally {
      running.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is false where there is nothing to read', () => {
    expect(nodeReplaced('/nonexistent/exe')).toBe(false)
  })
})
