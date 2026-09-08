import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Project, UiState } from '@ide-n-dream/shared'
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
  ui: UiState
}

const emptyState = (): PersistedState => ({ version: 1, projects: [], ui: defaultUiState() })

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
          projects: (Array.isArray(candidate.projects) ? candidate.projects : []).map(
            (project) => ({ ...project, worktreeRoot: defaultWorktreeRoot(project.root) }),
          ),
          ui: { ...defaultUiState(), ...(candidate.ui ?? {}) },
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

  addProject(project: Project): void {
    const existing = this.state.projects.findIndex((p) => p.id === project.id)
    if (existing === -1) this.state.projects.push(project)
    else this.state.projects[existing] = project
    this.state.ui.activeProjectId = project.id
    this.scheduleSave()
  }

  removeProject(id: string): void {
    this.state.projects = this.state.projects.filter((p) => p.id !== id)
    if (this.state.ui.activeProjectId === id) {
      this.state.ui.activeProjectId = this.state.projects[0]?.id ?? null
    }
    this.scheduleSave()
  }

  patchUi(patch: Partial<UiState>): UiState {
    this.state.ui = { ...this.state.ui, ...patch }
    this.scheduleSave()
    return this.state.ui
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
