import { describe, expect, it } from 'vitest'
import { defaultUiState } from '../src/model.js'

describe('defaultUiState', () => {
  it('starts awake as null, which is not the same as empty', () => {
    /*
     * Empty means every worktree was put to sleep; null means this is a first
     * run, and a worktree is taken to be awake if it already has live sessions.
     * That is what lets the IDE be dropped on a repository with twenty
     * worktrees and start with all twenty asleep.
     */
    expect(defaultUiState().awake).toBeNull()
  })

  it('gives every per-worktree map a record to index into', () => {
    // A missing one arrives as undefined where the code expects a record, which
    // is what `refresh()` spreads these under the server's stored copy for.
    const ui = defaultUiState()
    for (const [key, value] of Object.entries(ui)) {
      if (key === 'awake') continue
      expect(value, key).toEqual({})
    }
  })

  it('hands out a fresh object each time, not one shared instance', () => {
    const first = defaultUiState()
    first.panels['wt-1'] = ['files']
    expect(defaultUiState().panels).toEqual({})
  })
})
