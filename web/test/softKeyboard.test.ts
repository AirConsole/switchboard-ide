import { describe, expect, it } from 'vitest'
import {
  SOFT_KEYBOARD_MIN,
  enterPutsKeyboardAway,
  keyboardShown,
} from '../src/terminal/softKeyboard.js'

/*
 * The keys bar shows only while the keyboard is up, and nothing reports that:
 * what is observable is the height the keyboard takes out of the visual
 * viewport. The threshold has to clear the browser's own chrome hiding on
 * scroll, which is tens of pixels, and stay well under a keyboard, which is a
 * third of the screen -- measured, 360px of a 780px viewport.
 */
describe('keyboardShown', () => {
  it('says yes to a keyboard-sized loss', () => {
    expect(keyboardShown(420, 780)).toBe(true)
  })

  it('says no to the browser chrome retracting', () => {
    // Chrome's address bar hiding as you scroll: measured in the tens.
    expect(keyboardShown(780 - 56, 780)).toBe(false)
  })

  it('says no at full height, and to a viewport that has grown', () => {
    expect(keyboardShown(780, 780)).toBe(false)
    // A viewport taller than anything seen is not a keyboard, and the caller
    // takes it as the new tallest.
    expect(keyboardShown(900, 780)).toBe(false)
  })

  it('draws the line at the threshold itself', () => {
    expect(keyboardShown(780 - SOFT_KEYBOARD_MIN, 780)).toBe(true)
    expect(keyboardShown(780 - SOFT_KEYBOARD_MIN + 1, 780)).toBe(false)
  })
})

/*
 * Enter in Claude sends the prompt, and the answer is what you read next -- with
 * half the screen under a keyboard. So on a touch screen it lets the keyboard
 * go; in a shell it must not, because Enter there is one command of several.
 */
describe('enterPutsKeyboardAway', () => {
  it('lets go on Enter in Claude on a touch screen', () => {
    expect(enterPutsKeyboardAway('\r', 'claude', true)).toBe(true)
  })

  it('keeps it in a terminal', () => {
    expect(enterPutsKeyboardAway('\r', 'shell', true)).toBe(false)
  })

  it('keeps it where the keyboard is a real one', () => {
    expect(enterPutsKeyboardAway('\r', 'claude', false)).toBe(false)
  })

  it('keeps it for anything but a lone Enter -- a letter, or a paste ending in one', () => {
    expect(enterPutsKeyboardAway('a', 'claude', true)).toBe(false)
    expect(enterPutsKeyboardAway('ls -la\r', 'claude', true)).toBe(false)
  })
})
