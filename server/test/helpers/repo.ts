import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * A throwaway repository on disk.
 *
 * These tests run git rather than mocking it, because every parser here exists
 * to read git's real output and a fixture string is only ever what we *think*
 * git prints -- the `-z` porcelain parsers in particular were written against
 * measured output and would pass a hand-written fixture while mis-reading the
 * real thing.
 *
 * `realpath` is not applied here on purpose: on macOS `$TMPDIR` is itself a
 * symlink, and the containment tests want a root that has one in it.
 */
export interface TempRepo {
  path: string
  git: (...args: string[]) => Promise<string>
  write: (rel: string, text: string) => Promise<void>
  commit: (message: string) => Promise<void>
  cleanup: () => Promise<void>
}

/** Identity and settings a fresh repo needs to commit without a user's config. */
const ISOLATED = [
  '-c',
  'user.name=Test',
  '-c',
  'user.email=test@example.com',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'protocol.file.allow=always',
]

export const makeRepo = async (prefix = 'swb-test-'): Promise<TempRepo> => {
  const path = await mkdtemp(join(tmpdir(), prefix))
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await exec('git', [...ISOLATED, ...args], {
      cwd: path,
      maxBuffer: 8 * 1024 * 1024,
      // A user's own config must not decide what these tests see.
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })
    return stdout
  }
  const write = async (rel: string, text: string): Promise<void> => {
    const file = join(path, rel)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text, 'utf8')
  }
  const commit = async (message: string): Promise<void> => {
    await git('add', '-A')
    await git('commit', '--allow-empty', '-m', message)
  }

  await git('init')
  return { path, git, write, commit, cleanup: () => rm(path, { recursive: true, force: true }) }
}

/** A repo with one commit on `main`, which is the least git needs to be usable. */
export const makeRepoWithCommit = async (prefix?: string): Promise<TempRepo> => {
  const repo = await makeRepo(prefix)
  await repo.write('README.md', 'hello\n')
  await repo.commit('Initial commit')
  return repo
}
