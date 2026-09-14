import { describe, expect, it } from 'vitest'
import { terminalLabels } from '../src/views/terminalLabels.js'

const running = (...commands: (string | undefined)[]): { command?: string }[] =>
  commands.map((command) => (command === undefined ? {} : { command }))

describe('terminalLabels', () => {
  it('labels each terminal with what it is running', () => {
    // `bash`, `vim`, `npm` says something; a position in a list does not.
    expect(terminalLabels(running('bash', 'vim', 'npm'))).toEqual(['bash', 'vim', 'npm'])
  })

  it('numbers only the ones a label no longer tells apart', () => {
    expect(terminalLabels(running('bash', 'vim', 'bash'))).toEqual(['bash 1', 'vim', 'bash 2'])
  })

  it('numbers in the order they appear', () => {
    expect(terminalLabels(running('bash', 'bash', 'bash'))).toEqual(['bash 1', 'bash 2', 'bash 3'])
  })

  it('falls back to `shell` where tmux has not said', () => {
    expect(terminalLabels(running(undefined, '   ', 'shell'))).toEqual([
      'shell 1',
      'shell 2',
      'shell 3',
    ])
  })

  it('trims what tmux reports', () => {
    expect(terminalLabels(running(' vim '))).toEqual(['vim'])
  })

  it('has nothing to say about no terminals', () => {
    expect(terminalLabels([])).toEqual([])
  })
})
