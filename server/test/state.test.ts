import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, WorktreeTodo } from '@switchboard/shared'

/*
 * `stateFile` is derived from `config` at import time, so the state directory
 * has to be set before the module is pulled in -- which is what the dynamic
 * import below is for. One directory for the whole file; each test clears the
 * file and builds a fresh store.
 */
const stateDir = await mkdtemp(join(tmpdir(), 'swb-state-'))
process.env.SWB_STATE_DIR = stateDir
const { StateStore } = await import('../src/state.js')

const stateFile = join(stateDir, 'state.json')

const project = (over: Partial<Project> & Pick<Project, 'id' | 'root'>): Project => ({
  name: 'repo',
  host: { kind: 'local' },
  worktreeRoot: `${over.root}/.claude/worktrees`,
  addedAt: 0,
  ...over,
})

const todo = (over: Partial<WorktreeTodo> & Pick<WorktreeTodo, 'id'>): WorktreeTodo => ({
  worktreeId: 'wt-1',
  prompt: 'do the thing',
  createdAt: 1,
  ...over,
})

/** Whatever is on disk right now. */
const onDisk = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>

/*
 * Every store made by a test, so its debounced save can be settled before the
 * next one runs.
 *
 * `stateFile` is one path for the whole module -- it is derived from config at
 * import time -- so a 250ms save armed by one test would otherwise land in the
 * middle of another and be read as that test's own write. `flush()` is what
 * cancels the timer, which is exactly the guarantee the last test here asserts.
 */
const stores: InstanceType<typeof StateStore>[] = []

const newStore = async (): Promise<InstanceType<typeof StateStore>> => {
  const store = new StateStore()
  stores.push(store)
  await store.load()
  return store
}

const loadedFrom = async (raw: string): Promise<InstanceType<typeof StateStore>> => {
  await writeFile(stateFile, raw, 'utf8')
  return newStore()
}

beforeEach(async () => {
  await rm(stateFile, { force: true })
})
afterEach(async () => {
  for (const store of stores.splice(0)) await store.flush()
  await rm(stateFile, { force: true })
})

describe('loading', () => {
  it('starts clean when there is no state file yet', async () => {
    const store = await newStore()
    expect(store.projects).toEqual([])
    expect(store.todos).toEqual([])
    expect(store.recents).toEqual([])
  })

  it('starts clean rather than refusing to boot on a corrupt file', async () => {
    const store = await loadedFrom('{ this is not json')
    expect(store.projects).toEqual([])
  })

  it('drops one unusable project row without losing the rest of the file', async () => {
    /*
     * This used to be a bare `.map()` inside the same `try` as `JSON.parse`, so
     * one row missing `root` threw -- `resolve(undefined)` is a TypeError --
     * the whole load fell into the catch, and `emptyState()` was written over
     * the file 250ms later by the first UI patch. That takes the queue with it,
     * and a queue of prompts is not rebuildable by the user.
     */
    const store = await loadedFrom(
      JSON.stringify({
        version: 1,
        projects: [{ id: 'p-1', name: 'broken' }, project({ id: 'p-2', root: '/repo' })],
        todos: [todo({ id: 't-1' })],
        recents: [],
        ui: {},
      }),
    )
    expect(store.projects.map((p) => p.id)).toEqual(['p-2'])
    expect(store.todos.map((t) => t.id)).toEqual(['t-1'])
  })

  it('re-derives the worktree root rather than trusting the stored one', async () => {
    // Recomputing migrates a project registered under an older convention
    // instead of leaving it pointed at a directory nothing else uses.
    const store = await loadedFrom(
      JSON.stringify({
        version: 1,
        projects: [{ ...project({ id: 'p-1', root: '/repo' }), worktreeRoot: '/somewhere/old' }],
        todos: [],
        recents: [],
        ui: {},
      }),
    )
    expect(store.projects[0]?.worktreeRoot).toBe('/repo/.claude/worktrees')
  })

  it('reads a project registered before hosts existed as a local one', async () => {
    const store = await loadedFrom(
      JSON.stringify({ version: 1, projects: [{ id: 'p-1', root: '/repo', name: 'r' }], todos: [], recents: [], ui: {} }),
    )
    expect(store.projects[0]?.host).toEqual({ kind: 'local' })
  })

  it('drops a malformed todo rather than carrying it to a terminal', async () => {
    // A prompt ends up typed into a terminal, so a hand-edited record is
    // dropped here rather than dealt with later.
    const store = await loadedFrom(
      JSON.stringify({
        version: 1,
        projects: [],
        todos: [
          { id: 't-1', worktreeId: 'wt-1' },
          { id: 't-2', prompt: 'no worktree' },
          { worktreeId: 'wt-1', prompt: 'no id' },
          todo({ id: 't-4' }),
        ],
        recents: [],
        ui: {},
      }),
    )
    expect(store.todos.map((t) => t.id)).toEqual(['t-4'])
  })

  it('keeps an empty prompt, which is a todo someone is still writing', async () => {
    const store = await loadedFrom(
      JSON.stringify({
        version: 1,
        projects: [],
        todos: [{ id: 't-1', worktreeId: 'wt-1', prompt: '' }],
        recents: [],
        ui: {},
      }),
    )
    expect(store.todos[0]?.prompt).toBe('')
  })

  it('drops a retired ui key and fills in one the stored file predates', async () => {
    const store = await loadedFrom(
      JSON.stringify({
        version: 1,
        projects: [],
        todos: [],
        recents: [],
        ui: { awake: ['wt-1'], retiredThing: 'x' },
      }),
    )
    expect(store.ui.awake).toEqual(['wt-1'])
    expect(store.ui.openFilesByWorktree).toEqual({})
    expect('retiredThing' in store.ui).toBe(false)
  })

  it('names a recent after its directory when the stored name is gone', async () => {
    const store = await loadedFrom(
      JSON.stringify({ version: 1, projects: [], todos: [], recents: [{ root: '/src/ide' }], ui: {} }),
    )
    expect(store.recents[0]).toEqual({ root: '/src/ide', name: 'ide', closedAt: 0 })
  })

  it('keeps only the twelve newest recents', async () => {
    const recents = Array.from({ length: 20 }, (_, n) => ({ root: `/r${n}`, name: `r${n}`, closedAt: n }))
    const store = await loadedFrom(
      JSON.stringify({ version: 1, projects: [], todos: [], recents, ui: {} }),
    )
    expect(store.recents).toHaveLength(12)
  })
})

describe('projects', () => {
  it('keeps the order they were added, and replaces rather than duplicates', async () => {
    /*
     * Every registered project is open, so there is nothing to switch to --
     * forcing an active project is exactly what made opening a second one hide
     * the first.
     */
    const store = await newStore()
    store.addProject(project({ id: 'p-1', root: '/a' }))
    store.addProject(project({ id: 'p-2', root: '/b' }))
    store.addProject(project({ id: 'p-1', root: '/a', name: 'renamed' }))
    expect(store.projects.map((p) => p.id)).toEqual(['p-1', 'p-2'])
    expect(store.project('p-1')?.name).toBe('renamed')
  })

  it('remembers a closed project by root, newest first, without duplicating it', async () => {
    // Keyed by root because the id is derived from it, and what the picker does
    // with a recent is hand the path back to `openProject`.
    const store = await newStore()
    store.rememberRecent(project({ id: 'p-1', root: '/a', name: 'a' }))
    store.rememberRecent(project({ id: 'p-2', root: '/b', name: 'b' }))
    store.rememberRecent(project({ id: 'p-1', root: '/a', name: 'a' }))
    expect(store.recents.map((r) => r.root)).toEqual(['/a', '/b'])
  })

  it('forgets a recent when its project is opened again', async () => {
    const store = await newStore()
    store.rememberRecent(project({ id: 'p-1', root: '/a' }))
    store.forgetRecent('/a')
    expect(store.recents).toEqual([])
  })
})

describe('todos', () => {
  let store: InstanceType<typeof StateStore>

  beforeEach(async () => {
    store = await newStore()
    store.addTodo(todo({ id: 't-1' }))
  })

  it('merges present keys only, so two requests in flight cannot undo each other', () => {
    /*
     * A blur saving an edited prompt and a click queueing the same todo are two
     * requests at once; whichever lands second must not undo the other.
     */
    store.patchTodo('t-1', { prompt: 'edited' })
    store.patchTodo('t-1', { queuedAt: 99 })
    expect(store.todo('t-1')).toMatchObject({ prompt: 'edited', queuedAt: 99 })
  })

  it('deletes a key patched to undefined, rather than storing undefined', () => {
    store.patchTodo('t-1', { queuedAt: 99 })
    store.patchTodo('t-1', { queuedAt: undefined })
    expect('queuedAt' in (store.todo('t-1') ?? {})).toBe(false)
  })

  it('says nothing changed for a todo that is not there', () => {
    expect(store.patchTodo('nope', { prompt: 'x' })).toBeUndefined()
  })

  it('removes the todos of every worktree that goes', () => {
    store.addTodo(todo({ id: 't-2', worktreeId: 'wt-2' }))
    store.addTodo(todo({ id: 't-3', worktreeId: 'wt-3' }))
    store.removeTodosFor(['wt-1', 'wt-3'])
    expect(store.todos.map((t) => t.id)).toEqual(['t-2'])
  })
})

describe('saving', () => {
  it('writes everything back, and reads it again identically', async () => {
    const store = await newStore()
    store.addProject(project({ id: 'p-1', root: '/repo' }))
    store.addTodo(todo({ id: 't-1', queuedAt: 5 }))
    store.patchUi({ awake: ['wt-1'] })
    await store.flush()

    const reloaded = await newStore()
    expect(reloaded.projects.map((p) => p.id)).toEqual(['p-1'])
    expect(reloaded.todos).toEqual(store.todos)
    expect(reloaded.ui.awake).toEqual(['wt-1'])
  })

  it('leaves no temp file behind, because the write is a rename', async () => {
    const store = await newStore()
    store.addTodo(todo({ id: 't-1' }))
    await store.flush()
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(stateDir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('stamps the version, so a future migration has something to read', async () => {
    const store = await newStore()
    await store.flush()
    expect((await onDisk()).version).toBe(1)
  })

  it('flushing cancels the debounce rather than writing again behind it', async () => {
    /*
     * Identity rather than contents: a second write of the same state produces
     * the same bytes, so only the file itself can say whether it happened. The
     * write is a rename over the target, so a fresh one lands a new inode.
     */
    const store = await newStore()
    store.addTodo(todo({ id: 't-1' }))
    await store.flush()
    const before = await stat(stateFile, { bigint: true })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const after = await stat(stateFile, { bigint: true })
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs])
  })
})
