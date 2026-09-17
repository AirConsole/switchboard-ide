import { describe, expect, it } from 'vitest'
import { BAR_KEYS, arrowBytes, ctrlByte } from '../src/terminal/keyBar.js'

/** The app asked for the application form, and nothing is held. */
const app = { applicationCursorKeys: true, ctrl: false }
/** Neither. */
const plain = { applicationCursorKeys: false, ctrl: false }

describe('arrowBytes', () => {
  it('sends the application form to an app that asked for it', () => {
    // Every full-screen app here turns DECCKM on, and one that did does not
    // recognise the normal form: ESC [ A does nothing in Claude's menus.
    expect(arrowBytes('up', app)).toBe('\x1bOA')
    expect(arrowBytes('down', app)).toBe('\x1bOB')
    expect(arrowBytes('right', app)).toBe('\x1bOC')
    expect(arrowBytes('left', app)).toBe('\x1bOD')
  })

  it('sends the normal form otherwise', () => {
    expect(arrowBytes('up', plain)).toBe('\x1b[A')
    expect(arrowBytes('down', plain)).toBe('\x1b[B')
    expect(arrowBytes('right', plain)).toBe('\x1b[C')
    expect(arrowBytes('left', plain)).toBe('\x1b[D')
  })

  it('sends the modified form when Ctrl is latched, whatever the mode', () => {
    /*
     * A modified cursor key is always the parameterised CSI form -- there is no
     * room for a modifier in SS3 A -- and 5 is 1 plus Ctrl's bit. This is what
     * a shell reads as word-left and word-right.
     */
    for (const mode of [true, false]) {
      const held = { applicationCursorKeys: mode, ctrl: true }
      expect(arrowBytes('left', held)).toBe('\x1b[1;5D')
      expect(arrowBytes('right', held)).toBe('\x1b[1;5C')
      expect(arrowBytes('up', held)).toBe('\x1b[1;5A')
      expect(arrowBytes('down', held)).toBe('\x1b[1;5B')
    }
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
  const bytes = (name: string, held = plain): string =>
    BAR_KEYS.find((k) => k.name === name)!.bytes(held)

  it('sends Escape and Tab as the single bytes they are', () => {
    expect(bytes('Escape')).toBe('\x1b')
    expect(bytes('Tab')).toBe('\t')
  })

  it('carries the latch into the arrows', () => {
    const held = { applicationCursorKeys: true, ctrl: true }
    expect(bytes('Left', held)).toBe('\x1b[1;5D')
    expect(bytes('Up', held)).toBe('\x1b[1;5A')
  })

  it('sends Ctrl+Tab in the extended form, which tmux is configured to pass', () => {
    expect(bytes('Tab', { applicationCursorKeys: false, ctrl: true })).toBe('\x1b[9;5u')
  })

  it('leaves Escape alone, because Ctrl+[ is already Escape', () => {
    expect(bytes('Escape', { applicationCursorKeys: false, ctrl: true })).toBe('\x1b')
  })

  it('is the six keys a soft keyboard leaves out', () => {
    expect(BAR_KEYS.map((k) => k.name)).toEqual(['Escape', 'Tab', 'Left', 'Up', 'Down', 'Right'])
  })
})
