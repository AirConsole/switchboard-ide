import { describe, expect, it } from 'vitest'
import { defaultUiState } from '@switchboard/shared'
import { uiShape } from '../src/routes/api.js'

describe('the ui patch shape', () => {
  /*
   * Zod strips what it does not declare, silently and with a 200. So a field
   * added to `UiState` and not to this schema is accepted by the route, dropped
   * on the way to the store, and read back as its default -- which is how the
   * legend's counter reached 10 in one browser and came back 0 on the next
   * load, with nothing in any log to say so. Measured before this test existed:
   * `PATCH /api/ui {"stepsTaken":40}` answered `stepsTaken: 0`.
   *
   * Every key the model declares, in the value the model itself gives it, so a
   * new field fails here until the route knows about it too.
   */
  it('accepts every key the shared UiState declares', () => {
    const parsed = uiShape.parse(defaultUiState())
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(defaultUiState()).sort())
  })

  it('refuses a step count that is not a count', () => {
    expect(uiShape.safeParse({ stepsTaken: -1 }).success).toBe(false)
    expect(uiShape.safeParse({ stepsTaken: 1.5 }).success).toBe(false)
    expect(uiShape.safeParse({ stepsTaken: 'lots' }).success).toBe(false)
  })
})
