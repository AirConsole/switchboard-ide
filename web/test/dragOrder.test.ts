import { describe, expect, it } from 'vitest'
import { dropAt, moveIn } from '../src/components/useDragOrder.js'

const box = (left: number, top: number, width = 100, height = 30) => ({
  left,
  right: left + width,
  top,
  bottom: top + height,
})

describe('dropAt', () => {
  const row = [box(0, 0), box(110, 0), box(220, 0)]

  it('lands before the first tab whose middle is right of the pointer', () => {
    expect(dropAt(row, 40, 10)).toEqual({ index: 0, after: false })
    expect(dropAt(row, 60, 10)).toEqual({ index: 1, after: false })
    expect(dropAt(row, 400, 10)).toEqual({ index: 2, after: true })
  })

  /*
   * On a phone-width bar the project heads wrap onto rows of their own. By x
   * alone, a pointer at the left of the second row would land before the
   * first head of the first.
   */
  it('reads the row the pointer is on before its place along it', () => {
    const wrapped = [box(0, 0), box(110, 0), box(0, 40), box(110, 40)]
    expect(dropAt(wrapped, 20, 50)).toEqual({ index: 2, after: false })
    expect(dropAt(wrapped, 400, 50)).toEqual({ index: 3, after: true })
    // Between the rows: the nearer one.
    expect(dropAt(wrapped, 20, 36)).toEqual({ index: 2, after: false })
  })

  it('has nowhere to land among nothing', () => {
    expect(dropAt([], 0, 0)).toBeNull()
  })
})

describe('moveIn', () => {
  it('puts it before or after the one it was dropped beside', () => {
    expect(moveIn(['a', 'b', 'c', 'd'], 'a', 'c', false)).toEqual(['b', 'a', 'c', 'd'])
    expect(moveIn(['a', 'b', 'c', 'd'], 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveIn(['a', 'b', 'c', 'd'], 'd', 'a', false)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('changes nothing for itself or for an id it does not have', () => {
    expect(moveIn(['a', 'b'], 'a', 'a', true)).toEqual(['a', 'b'])
    expect(moveIn(['a', 'b'], 'x', 'a', true)).toEqual(['a', 'b'])
  })
})
