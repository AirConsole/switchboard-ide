import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { CodeEditor, type EditorFile } from '../src/editor/CodeEditor.js'

afterEach(cleanup)

const mount = (
  file: EditorFile,
  draft: string | null,
): { text: () => string; onChange: ReturnType<typeof vi.fn> } => {
  const onChange = vi.fn()
  const { container } = render(
    createElement(CodeEditor, {
      file,
      draft: () => draft,
      onChange,
      onSave: () => undefined,
    }),
  )
  return {
    text: () => container.querySelector('.cm-content')?.textContent ?? '',
    onChange,
  }
}

describe('CodeEditor', () => {
  it('opens with the file as it is on disk', () => {
    const { text } = mount({ path: 'a.md', text: 'on disk' }, null)
    expect(text()).toBe('on disk')
  })

  it('keeps an unsaved buffer through a remount', () => {
    /*
     * An editor can be unmounted while it is dirty: flipping a Markdown file to
     * Preview and back does exactly that. Both effects run on the mount that
     * follows, and the second one used to find the same file the first had just
     * built from and dispatch the disk text into it -- which threw the restored
     * draft away, and then reported the document as matching disk, so the edit
     * was gone and nothing said so.
     */
    const { text, onChange } = mount({ path: 'a.md', text: 'on disk' }, 'my edit')
    expect(text()).toBe('my edit')
    // Nothing was dispatched, so nothing was reported: a restored draft is not
    // a change, and telling the hook otherwise is what cleared it.
    expect(onChange).not.toHaveBeenCalled()
  })
})
