import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { MOTION_MS, useTileMotion, type Slot } from '../src/views/tileMotion.js'

const slot = (key: string, data = key): Slot<string> => ({ key, width: 2, data })

/** The keys as rendered, and which of them are on their way out. */
const shown = (slots: { key: string; leaving: boolean }[]): string[] =>
  slots.map((s) => (s.leaving ? `${s.key}!` : s.key))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useTileMotion', () => {
  it('renders what it is given when nothing is moving', () => {
    const { result } = renderHook(() => useTileMotion([slot('a'), slot('b')]))
    expect(shown(result.current)).toEqual(['a', 'b'])
  })

  it('keeps a removed window mounted long enough to close', () => {
    // React would unmount the node the moment a worktree goes to sleep, and an
    // element that is gone cannot animate.
    const { result, rerender } = renderHook((slots: Slot<string>[]) => useTileMotion(slots), {
      initialProps: [slot('a'), slot('b')],
    })
    rerender([slot('a')])
    expect(shown(result.current)).toEqual(['a', 'b!'])
  })

  it('renders it back into the place it held, not on the end', () => {
    /*
     * Not cosmetic. React reorders by moving DOM nodes, and moving a node
     * cancels the CSS transition running on it -- so a window appended to the
     * end of the list snapped to zero width instead of closing.
     */
    const { result, rerender } = renderHook((slots: Slot<string>[]) => useTileMotion(slots), {
      initialProps: [slot('a'), slot('b'), slot('c')],
    })
    rerender([slot('a'), slot('c')])
    expect(shown(result.current)).toEqual(['a', 'b!', 'c'])
  })

  it('drops it for real once the movement is over', () => {
    const { result, rerender } = renderHook((slots: Slot<string>[]) => useTileMotion(slots), {
      initialProps: [slot('a'), slot('b')],
    })
    rerender([slot('a')])
    act(() => {
      vi.advanceTimersByTime(MOTION_MS + 200)
    })
    expect(shown(result.current)).toEqual(['a'])
  })

  it('carries the contents out with the window', () => {
    /*
     * A sleeping worktree is no longer in the list that produced the slot, so
     * looking it up again would find nothing and the window you are watching
     * close would empty out halfway.
     */
    const { result, rerender } = renderHook((slots: Slot<string>[]) => useTileMotion(slots), {
      initialProps: [slot('a', 'the contents')],
    })
    rerender([])
    expect(result.current[0]?.data).toBe('the contents')
  })

  it('makes a window woken again while it was closing a live one', () => {
    const { result, rerender } = renderHook((slots: Slot<string>[]) => useTileMotion(slots), {
      initialProps: [slot('a'), slot('b')],
    })
    rerender([slot('a')])
    expect(shown(result.current)).toEqual(['a', 'b!'])
    rerender([slot('a'), slot('b')])
    expect(shown(result.current)).toEqual(['a', 'b'])
  })

  it('cleans up every leaver, not only those whose key came back', () => {
    /*
     * The regression this exists for. The removal used to be one timer per
     * batch, cancelled whenever the set changed again, and the "nothing left"
     * branch only dropped entries whose key had come *back*. A window whose
     * timer was cancelled was in neither set, so it stayed mounted for the life
     * of the page -- invisible at zero width, but still holding a WebGL
     * context, polling a worktree you had put away, and in the tab order. Two
     * projects open and "Stop everything" on one of them was enough.
     */
    const { result, rerender } = renderHook((slots: Slot<string>[]) => useTileMotion(slots), {
      initialProps: [slot('a'), slot('b'), slot('c')],
    })
    rerender([slot('a'), slot('b')])
    act(() => {
      vi.advanceTimersByTime(40)
    })
    // A second removal lands while the first is still animating, which is what
    // used to cancel the first one's timer.
    rerender([slot('a')])
    act(() => {
      vi.advanceTimersByTime(MOTION_MS + 200)
    })
    expect(shown(result.current)).toEqual(['a'])
  })

  it('lets everything go when the whole row is put to sleep', () => {
    const { result, rerender } = renderHook((slots: Slot<string>[]) => useTileMotion(slots), {
      initialProps: [slot('a'), slot('b'), slot('c')],
    })
    rerender([])
    expect(shown(result.current)).toEqual(['a!', 'b!', 'c!'])
    act(() => {
      vi.advanceTimersByTime(MOTION_MS + 200)
    })
    expect(result.current).toEqual([])
  })

  it('does not churn when the same set is rendered again', () => {
    const { result, rerender } = renderHook((slots: Slot<string>[]) => useTileMotion(slots), {
      initialProps: [slot('a'), slot('b')],
    })
    const before = result.current
    rerender([slot('a'), slot('b')])
    expect(shown(result.current)).toEqual(shown(before))
  })
})
