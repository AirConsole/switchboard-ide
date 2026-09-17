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
      // The two that are not per-worktree maps: `awake` is a set as a list and
      // null until seeded, and `markdownPreview` is one switch for the whole
      // IDE rather than a fact about any worktree.
      if (key === 'awake' || typeof value === 'boolean') continue
      expect(value, key).toEqual({})
    }
  })

  it('opens Markdown rendered', () => {
    /*
     * The panel is eighty columns of a file you are looking at, and prose is
     * what a Markdown file mostly is. The toggle is in the bar above it and
     * the first flip is remembered, so this is a starting point rather than a
     * policy -- but a stored state written before the switch existed arrives
     * without the key, and it has to mean something.
     */
    expect(defaultUiState().markdownPreview).toBe(true)
  })

  it('hands out a fresh object each time, not one shared instance', () => {
    const first = defaultUiState()
    first.panels['wt-1'] = ['files']
    expect(defaultUiState().panels).toEqual({})
  })
})
