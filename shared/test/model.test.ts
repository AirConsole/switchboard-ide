import { describe, expect, it } from 'vitest'
import { defaultUiState, isTask } from '../src/model.js'

describe('defaultUiState', () => {
  it('gives every per-worktree map a record to index into', () => {
    // A missing one arrives as undefined where the code expects a record, which
    // is what `refresh()` spreads these under the server's stored copy for.
    const ui = defaultUiState()
    for (const [key, value] of Object.entries(ui)) {
      // The ones that are not per-worktree maps, named rather than detected by
      // their type: `markdownPreview` and `stepsTaken` are both about the
      // reader rather than about any worktree, and `activeWorktree` is where
      // the reader is. Another has to be added here on purpose.
      if (key === 'markdownPreview' || key === 'stepsTaken' || key === 'activeWorktree') continue
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

describe('isTask', () => {
  /*
   * Each of these is a prompt from a real transcript, and each was on the side
   * of the line it is asserted to be on when the rule was measured.
   */
  it('reads the short end as steering, typos and all', () => {
    for (const prompt of ['yes', 'merge and deploy', 'Metge and deploy', 'pr, merge and reload']) {
      expect(isTask(prompt), prompt).toBe(false)
    }
  })

  it('reads a short question as steering', () => {
    expect(isTask('will the dot also be shown in the chrome app?')).toBe(false)
  })

  it('reads ten words or more as a task', () => {
    expect(isTask('the active worktree in the top bar should be somewhat highlighted')).toBe(true)
  })

  it('reads a question long enough to be a brief as a task', () => {
    expect(
      isTask(
        'I have a video that i would like to add to the readme.md that is displayed on github.com. how do i do that?',
      ),
    ).toBe(true)
  })
})
