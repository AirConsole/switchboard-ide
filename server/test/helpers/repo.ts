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

export const makeRepo = async (prefix = 'swb-test-'): Promise<TempRepo> =>
  makeRepoAt(await mkdtemp(join(tmpdir(), prefix)))

/** `makeRepo` into a directory that already exists -- see `makeFolderOfRepos`. */
export const makeRepoAt = async (path: string): Promise<TempRepo> => {
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

/**
 * A directory that is not a repository and holds some, plus a loose file.
 *
 * The shape a folder project is for, built with real git for the reason the
 * rest of this file is: what matters about it is what git says when asked from
 * the folder itself -- `worktree list`, `status`, `ls-files` and `grep` all
 * exit 128 there -- and no fixture can stand in for that.
 */
export interface TempFolder {
  path: string
  /** The checkouts inside it, by directory name. */
  repos: TempRepo[]
  cleanup: () => Promise<void>
}

export const makeFolderOfRepos = async (
  names: string[] = ['alpha', 'beta'],
  prefix = 'swb-folder-',
): Promise<TempFolder> => {
  const path = await mkdtemp(join(tmpdir(), prefix))
  const repos: TempRepo[] = []
  for (const name of names) {
    const inner = join(path, name)
    await mkdir(inner, { recursive: true })
    const repo = await makeRepoAt(inner)
    await repo.write('README.md', `${name}\n`)
    await repo.commit('Initial commit')
    repos.push(repo)
  }
  // Something that belongs to the folder rather than to any repository in it,
  // because that is the case a per-repository answer would miss.
  await mkdir(join(path, 'notes'), { recursive: true })
  await writeFile(join(path, 'notes', 'todo.txt'), 'spans both\n', 'utf8')
  return {
    path,
    repos,
    cleanup: () => rm(path, { recursive: true, force: true }),
  }
}

/**
 * A repository with a real remote: a bare origin on disk, `main` pushed to it.
 *
 * A fixture cannot answer what these tests ask. Whether a remote-tracking ref
 * survives the branch being deleted on the remote, and whether a lease refuses
 * a delete pushed from a stale clone, are facts about what git and a remote do
 * to each other -- neither is visible in a repository that has no remote, and
 * neither is what you would guess.
 *
 * `protocol.file.allow=always` in ISOLATED is what lets a path be a remote at
 * all: git refuses `file://` for clones by default since CVE-2022-39253.
 */
export interface TempRemoteRepo extends TempRepo {
  /** The bare repository `origin` points at. */
  origin: string
  /** A second clone of the same origin, for pushing behind this one's back. */
  elsewhere: () => Promise<TempRepo>
}

export const makeRepoWithRemote = async (prefix = 'swb-remote-'): Promise<TempRemoteRepo> => {
  const bare = await mkdtemp(join(tmpdir(), `${prefix}origin-`))
  const repo = await makeRepoWithCommit(prefix)
  await repo.git('init', '--bare', bare)
  await repo.git('remote', 'add', 'origin', bare)
  await repo.git('push', '-u', 'origin', 'main')
  const clones: TempRepo[] = []
  return {
    ...repo,
    origin: bare,
    elsewhere: async () => {
      const clone = await makeRepo(`${prefix}other-`)
      await clone.git('remote', 'add', 'origin', bare)
      await clone.git('fetch', 'origin')
      clones.push(clone)
      return clone
    },
    cleanup: async () => {
      await Promise.all(clones.map((clone) => clone.cleanup()))
      await rm(bare, { recursive: true, force: true })
      await repo.cleanup()
    },
  }
}
