import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useDialogKeys } from '../src/components/useDialogKeys.js'

/** A dialog shaped like the open dialog: a form, and answers in the foot. */
const dialog = () => {
  document.body.innerHTML = `
    <div class="dialog">
      <div class="addserver" data-own-enter><input id="own" type="password" /></div>
      <input id="path" type="text" />
      <div class="dialog__foot">
        <button id="aside" class="btn btn--quiet dialog__aside">Sign out</button>
        <button id="cancel" class="btn btn--quiet">Cancel</button>
        <button id="open" class="btn">Open project</button>
      </div>
    </div>`
  const box = document.querySelector<HTMLElement>('.dialog')
  const clicked: string[] = []
  for (const button of document.querySelectorAll('button')) {
    button.addEventListener('click', () => clicked.push(button.id))
  }
  renderHook(() => useDialogKeys({ current: box }, { focus: false }))
  return clicked
}

const enterOn = (id: string): void => {
  const target = document.getElementById(id) as HTMLElement
  target.focus()
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('dialog keys', () => {
  /*
   * Measured in a browser before this: Enter in the link-a-machine form pressed
   * "Open project" on the listed folder instead, never linked anything, and
   * offered to initialise the home directory as a repository.
   */
  it('leaves a form that owns its Enter alone', () => {
    const clicked = dialog()
    enterOn('own')
    expect(clicked).toEqual([])
  })

  it('still takes the answer from an ordinary field', () => {
    const clicked = dialog()
    enterOn('path')
    expect(clicked).toEqual(['open'])
  })

  it('never lands on an aside with the arrows', () => {
    dialog()
    const focused: string[] = []
    for (let i = 0; i < 4; i++) {
      // From the body, as a real keypress with nothing focused would be; a
      // window target is not an element and the handler rightly ignores it.
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      focused.push(document.activeElement?.id ?? '')
    }
    expect(focused).not.toContain('aside')
  })
})
