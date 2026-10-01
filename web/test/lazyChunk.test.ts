import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadOrReload } from '../src/lazyChunk.js'

/*
 * A page left open across a deploy asks for a chunk the rebuild deleted, and
 * the failed import unmounted the whole app: the screen went black on opening
 * a Markdown file. Measured on a scratch instance by answering the chunk the
 * way the server did, and `#root` was left empty. The page is what is stale,
 * so it reloads -- once.
 */
describe('a chunk that will not load', () => {
  const reload = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
    reload.mockReset()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const gone = (): Promise<never> =>
    Promise.reject(new TypeError('Failed to fetch dynamically imported module'))

  it('reloads the page rather than throwing', async () => {
    let settled = false
    void loadOrReload(gone).then(
      () => (settled = true),
      () => (settled = true),
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(reload).toHaveBeenCalledTimes(1)
    // Nothing for React to throw meanwhile: the page is going.
    expect(settled).toBe(false)
  })

  it('throws instead the second time, for an error boundary to say so', async () => {
    void loadOrReload(gone)
    await vi.advanceTimersByTimeAsync(1000)
    // The page reloaded and the chunk is still not there: that is real.
    await expect(loadOrReload(gone)).rejects.toThrow('Failed to fetch')
    await vi.advanceTimersByTimeAsync(1000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('leaves a chunk that loads alone', async () => {
    await expect(loadOrReload(() => Promise.resolve('ok'))).resolves.toBe('ok')
    expect(reload).not.toHaveBeenCalled()
  })
})
