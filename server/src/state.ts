import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Project, UiState, WorktreeTodo } from '@ide-n-dream/shared'
import { defaultUiState } from '@ide-n-dream/shared'
import { defaultWorktreeRoot } from './git/worktree.js'
import { stateFile } from './config.js'

/**
 * The only state worth persisting.
 *
 * Worktrees are not stored: `git worktree list` is the truth, and a stale copy
 * would just disagree with it. Sessions are not stored either: tmux holds them,
 * along with their metadata in user options. That leaves the registry of opened
 * projects and the UI's layout, neither of which is derivable from anything.
 */
export interface PersistedState {
  version: 1
  projects: Project[]
  /**
   * Required, not optional, and that is the whole defence for it.
   *
   * `load()` below builds a fresh object literal, so a key nobody copies is
   * dropped on read and then erased from disk by the next save. Declaring this
   * required makes forgetting the line a compile error instead of a silent loss
   * of everything the user queued. Anything added here from now on should be
   * required for the same reason.
   */
  todos: WorktreeTodo[]
  ui: UiState
}

const emptyState = (): PersistedState => ({
  version: 1,
  projects: [],
  todos: [],
  ui: defaultUiState(),
})

/**
 * A stored project, or nothing.
 *
 * Row by row, like the todos below, and for a sharper reason: this used to be a
 * bare `.map()` inside the same `try` as `JSON.parse`, so one row missing
 * `root` threw -- `resolve(undefined)` is a TypeError -- the whole load fell
 * into the catch, and `emptyState()` was then written over the file 250ms
 * later by the first UI patch. That takes the projects *and* the todo queue
 * with it. The catch's comment says everything here is rebuildable by the
 * user; a queue of prompts is not.
 */
const reviveProject = (value: unknown): Project | null => {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Partial<Project>
  if (typeof row.id !== 'string' || row.id === '') return null
  if (typeof row.root !== 'string' || row.root === '') return null
  return {
    ...(row as Project),
    // A project registered before hosts existed is a local one. Defaulting it
    // here keeps the type honest about a field the stored file has never
    // contained.
    host: row.host ?? { kind: 'local' as const },
    worktreeRoot: defaultWorktreeRoot(row.root),
  }
}

/**
 * A stored todo, or nothing.
 *
 * Stricter than the projects beside it because of what a todo feeds: a prompt
 * ends up typed into a terminal, so a malformed record from a hand-edited file
 * is dropped rather than carried along and dealt with later.
 */
const reviveTodo = (value: unknown): WorktreeTodo | null => {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const str = (key: string): string | undefined =>
    typeof row[key] === 'string' && row[key] !== '' ? (row[key] as string) : undefined
  const num = (key: string): number | undefined =>
    typeof row[key] === 'number' && Number.isFinite(row[key]) ? (row[key] as number) : undefined
  const id = str('id')
  const worktreeId = str('worktreeId')
  const prompt = typeof row.prompt === 'string' ? row.prompt : undefined
  if (id === undefined || worktreeId === undefined || prompt === undefined) return null
  return {
    id,
    worktreeId,
    prompt,
    createdAt: num('createdAt') ?? Date.now(),
    ...(num('queuedAt') === undefined ? {} : { queuedAt: num('queuedAt') }),
    ...(num('dispatchingAt') === undefined ? {} : { dispatchingAt: num('dispatchingAt') }),
    ...(str('lastError') === undefined ? {} : { lastError: str('lastError') }),
  }
}

/**
 * Merge stored UI state over the defaults, keeping only keys the current shape
 * declares. Retired fields then drop out of state.json on first load rather
 * than lingering there forever, confusing anyone who reads the file.
 */
const pickKnownUiKeys = (stored: unknown): UiState => {
  const defaults = defaultUiState()
  if (typeof stored !== 'object' || stored === null) return defaults
  const source = stored as Record<string, unknown>
  const result = { ...defaults }
  for (const key of Object.keys(defaults) as (keyof UiState)[]) {
    if (source[key] !== undefined) {
      // The shape is the authority on which keys exist; the values themselves
      // come from a file the user could have edited, so they stay unchecked
      // beyond being present.
      ;(result as Record<string, unknown>)[key] = source[key]
    }
  }
  return result
}

export class StateStore {
  private state: PersistedState = emptyState()
  private saveTimer: NodeJS.Timeout | null = null
  private saving: Promise<void> = Promise.resolve()

  async load(): Promise<void> {
    try {
      const raw = await readFile(stateFile, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const candidate = parsed as Partial<PersistedState>
        this.state = {
          version: 1,
          // The worktree location is derived, not remembered: recomputing it
          // migrates projects registered under an older convention instead of
          // leaving them pointed at a directory nothing else uses.
          projects: (Array.isArray(candidate.projects) ? candidate.projects : [])
            .map(reviveProject)
            .filter((project): project is Project => project !== null),
          todos: (Array.isArray(candidate.todos) ? candidate.todos : [])
            .map(reviveTodo)
            .filter((todo): todo is WorktreeTodo => todo !== null),
          ui: pickKnownUiKeys(candidate.ui),
        }
      }
    } catch {
      // A missing or corrupt state file is not fatal: start clean rather than
      // refusing to boot, since everything here is rebuildable by the user.
      this.state = emptyState()
    }
  }

  get projects(): Project[] {
    return this.state.projects
  }

  get ui(): UiState {
    return this.state.ui
  }

  project(id: string): Project | undefined {
    return this.state.projects.find((p) => p.id === id)
  }

  /**
   * Register a project. The order they are added is the order they appear.
   *
   * Opening one no longer makes it "the" project: every registered project is
   * open, so there is nothing to switch to. Forcing an active project here is
   * exactly what made opening a second one hide the first.
   */
  addProject(project: Project): void {
    const existing = this.state.projects.findIndex((p) => p.id === project.id)
    if (existing === -1) this.state.projects.push(project)
    else this.state.projects[existing] = project
    this.scheduleSave()
  }

  removeProject(id: string): void {
    this.state.projects = this.state.projects.filter((p) => p.id !== id)
    this.scheduleSave()
  }

  patchUi(patch: Partial<UiState>): UiState {
    this.state.ui = { ...this.state.ui, ...patch }
    this.scheduleSave()
    return this.state.ui
  }

  get todos(): WorktreeTodo[] {
    return this.state.todos
  }

  todo(id: string): WorktreeTodo | undefined {
    return this.state.todos.find((t) => t.id === id)
  }

  addTodo(todo: WorktreeTodo): void {
    this.state.todos.push(todo)
    this.scheduleSave()
  }

  /**
   * Merge a patch into one todo. Present keys only -- a blur saving an edited
   * prompt and a click queueing the same todo are two requests in flight at
   * once, and whichever lands second must not undo the other.
   */
  patchTodo(id: string, patch: Partial<WorktreeTodo>): WorktreeTodo | undefined {
    const todo = this.todo(id)
    if (!todo) return undefined
    Object.assign(todo, patch)
    for (const key of Object.keys(patch) as (keyof WorktreeTodo)[]) {
      if (patch[key] === undefined) delete todo[key]
    }
    this.scheduleSave()
    return todo
  }

  removeTodo(id: string): void {
    this.state.todos = this.state.todos.filter((t) => t.id !== id)
    this.scheduleSave()
  }

  removeTodosFor(worktreeIds: Iterable<string>): void {
    const doomed = new Set(worktreeIds)
    const before = this.state.todos.length
    this.state.todos = this.state.todos.filter((t) => !doomed.has(t.worktreeId))
    if (this.state.todos.length !== before) this.scheduleSave()
  }

  /**
   * Writes are debounced because UI state changes on every pane drag, and
   * coalesced into a single in-flight write so two saves cannot interleave.
   */
  scheduleSave(delayMs = 250): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saving = this.saving.then(() => this.write()).catch(() => {})
    }, delayMs)
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.saving = this.saving.then(() => this.write())
    await this.saving
  }

  /** Atomic: write a sibling temp file, then rename over the target. */
  private async write(): Promise<void> {
    await mkdir(dirname(stateFile), { recursive: true })
    const tmp = `${stateFile}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    await rename(tmp, stateFile)
  }
}
