import { describe, expect, it } from 'vitest'
import { repoChoices } from '../src/components/NewWorktreeForm.js'

describe('repoChoices', () => {
  const all = ['api', 'appengine', 'frontend', 'player']

  it('puts what is picked first, and keeps the folder order otherwise', () => {
    expect(repoChoices(all, new Set(['player']), '')).toEqual(['player', 'api', 'appengine', 'frontend'])
  })

  it('never filters a picked repository away, or it would read as unpicked', () => {
    expect(repoChoices(all, new Set(['frontend']), 'AP')).toEqual(['frontend', 'api', 'appengine'])
  })
})
