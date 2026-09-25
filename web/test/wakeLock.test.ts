import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { shouldHoldWake, useWakeLock } from '../src/wakeLock.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/*
 * A phone blanks its screen after about fifteen seconds of not being touched,
 * and watching an agent work is exactly fifteen seconds of not touching
 * anything. A laptop has its own idea of when to sleep, and a page you are not
 * looking at has no business holding a screen awake at all.
 */
describe('shouldHoldWake', () => {
  it('holds only on a touch screen, visible and focused', () => {
    expect(shouldHoldWake({ soft: true, visible: true, focused: true })).toBe(true)
  })

  it('lets go where the keyboard is a real one', () => {
    expect(shouldHoldWake({ soft: false, visible: true, focused: true })).toBe(false)
  })

  it('lets go when the page is hidden or unfocused', () => {
    expect(shouldHoldWake({ soft: true, visible: false, focused: true })).toBe(false)
    expect(shouldHoldWake({ soft: true, visible: true, focused: false })).toBe(false)
  })
})

/** A stand-in for the browser's lock, which records what was asked of it. */
const stubLock = () => {
  const held: { releases: number; listeners: (() => void)[] }[] = []
  let deny = false
  const request = vi.fn(async () => {
    if (deny) throw new Error('denied')
    const lock = { releases: 0, listeners: [] as (() => void)[] }
    held.push(lock)
    return {
      released: false,
      release: async () => {
        lock.releases++
      },
      addEventListener: (_type: 'release', run: () => void) => lock.listeners.push(run),
    }
  })
  vi.stubGlobal('navigator', { ...navigator, wakeLock: { request } })
  return {
    request,
    held,
    deny: (value: boolean) => {
      deny = value
    },
  }
}

const setPage = (opts: { coarse?: boolean; hidden?: boolean; focused?: boolean }): void => {
  if (opts.coarse !== undefined) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: opts.coarse === true && query.includes('coarse'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
  }
  if (opts.hidden !== undefined) {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (opts.hidden === true ? 'hidden' : 'visible'),
    })
  }
  if (opts.focused !== undefined) {
    vi.spyOn(document, 'hasFocus').mockReturnValue(opts.focused)
  }
}

const Probe = (): null => {
  useWakeLock()
  return null
}

describe('useWakeLock', () => {
  it('takes a lock on a touch screen and gives it back when the page hides', async () => {
    const lock = stubLock()
    setPage({ coarse: true, hidden: false, focused: true })
    render(createElement(Probe))
    await act(async () => undefined)
    expect(lock.request).toHaveBeenCalledTimes(1)

    setPage({ hidden: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(lock.held[0]?.releases).toBe(1)
  })

  it('asks again when the page comes back', async () => {
    const lock = stubLock()
    setPage({ coarse: true, hidden: false, focused: true })
    render(createElement(Probe))
    await act(async () => undefined)

    // The browser releases the lock itself on hide, and says so.
    setPage({ hidden: true })
    await act(async () => {
      lock.held[0]?.listeners.forEach((run) => run())
      document.dispatchEvent(new Event('visibilitychange'))
    })
    setPage({ hidden: false })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(lock.request).toHaveBeenCalledTimes(2)
  })

  it('never asks where the keyboard is a real one', async () => {
    const lock = stubLock()
    setPage({ coarse: false, hidden: false, focused: true })
    render(createElement(Probe))
    await act(async () => undefined)
    expect(lock.request).not.toHaveBeenCalled()
  })

  it('gives the lock back when the window loses focus, and takes it again', async () => {
    const lock = stubLock()
    setPage({ coarse: true, hidden: false, focused: true })
    render(createElement(Probe))
    await act(async () => undefined)

    setPage({ focused: false })
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(lock.held[0]?.releases).toBe(1)

    setPage({ focused: true })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(lock.request).toHaveBeenCalledTimes(2)
  })

  it('releases a lock that arrives after the reason for it has gone', async () => {
    /*
     * The request is a promise: a page hidden while it was in flight is handed
     * a lock nobody wants, and keeping it would hold the screen awake behind
     * another app.
     */
    const lock = stubLock()
    setPage({ coarse: true, hidden: false, focused: true })
    render(createElement(Probe))
    setPage({ hidden: true })
    await act(async () => undefined)
    expect(lock.held[0]?.releases).toBe(1)
  })

  it('survives a browser that refuses, or has no wake lock at all', async () => {
    const lock = stubLock()
    lock.deny(true)
    setPage({ coarse: true, hidden: false, focused: true })
    render(createElement(Probe))
    await act(async () => undefined)
    expect(lock.request).toHaveBeenCalledTimes(1)

    cleanup()
    vi.stubGlobal('navigator', { ...navigator, wakeLock: undefined })
    render(createElement(Probe))
    await act(async () => undefined)
  })

  it('gives the lock back when the page goes', async () => {
    const lock = stubLock()
    setPage({ coarse: true, hidden: false, focused: true })
    render(createElement(Probe))
    await act(async () => undefined)
    cleanup()
    await act(async () => undefined)
    expect(lock.held[0]?.releases).toBe(1)
  })
})
