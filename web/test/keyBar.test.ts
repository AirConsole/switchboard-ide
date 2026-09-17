import { describe, expect, it } from 'vitest'
import { BAR_KEYS, arrowBytes, ctrlByte } from '../src/terminal/keyBar.js'

describe('arrowBytes', () => {
  it('sends the application form to an app that asked for it', () => {
    // Every full-screen app here turns DECCKM on, and one that did does not
    // recognise the normal form: ESC [ A does nothing in Claude's menus.
    expect(arrowBytes('up', true)).toBe('\x1bOA')
    expect(arrowBytes('down', true)).toBe('\x1bOB')
    expect(arrowBytes('right', true)).toBe('\x1bOC')
    expect(arrowBytes('left', true)).toBe('\x1bOD')
  })

  it('sends the normal form otherwise', () => {
    expect(arrowBytes('up', false)).toBe('\x1b[A')
    expect(arrowBytes('down', false)).toBe('\x1b[B')
    expect(arrowBytes('right', false)).toBe('\x1b[C')
    expect(arrowBytes('left', false)).toBe('\x1b[D')
  })
})

describe('ctrlByte', () => {
  it('clears the two high bits, which is what Ctrl does', () => {
    expect(ctrlByte('c')).toBe('\x03')
    expect(ctrlByte('a')).toBe('\x01')
    expect(ctrlByte('z')).toBe('\x1a')
  })

  it('does not care about case, because Shift never reaches a control byte', () => {
    expect(ctrlByte('C')).toBe('\x03')
  })

  it('answers nothing for what is not a letter', () => {
    expect(ctrlByte('1')).toBe(null)
    expect(ctrlByte('[')).toBe(null)
    expect(ctrlByte('Enter')).toBe(null)
    expect(ctrlByte('')).toBe(null)
  })
})

describe('BAR_KEYS', () => {
  it('sends Escape and Tab as the single bytes they are', () => {
    const bytes = (name: string): string =>
      BAR_KEYS.find((k) => k.name === name)!.bytes(false)
    expect(bytes('Escape')).toBe('\x1b')
    expect(bytes('Tab')).toBe('\t')
  })

  it('is the six keys a soft keyboard leaves out', () => {
    expect(BAR_KEYS.map((k) => k.name)).toEqual(['Escape', 'Tab', 'Left', 'Up', 'Down', 'Right'])
  })
})
