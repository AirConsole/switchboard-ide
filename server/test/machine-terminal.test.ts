import { describe, expect, it } from 'vitest'
import { MACHINE_WORKTREE_ID } from '@switchboard/shared'
import { parseMeta } from '../src/session/tmux.js'
import { worktreeIdFor } from '../src/git/worktree.js'

/*
 * The machine's own terminal belongs to no worktree, and carries a reserved
 * worktree id rather than none. These are the two properties that choice is
 * for: a session whose metadata `parseMeta` refuses is never adopted after a
 * restart -- its tmux session runs on, unreachable, for the life of the machine
 * -- and an id that could collide with a real worktree's would put a shell in
 * somebody's window.
 */
describe('the machine terminal id', () => {
  const meta = {
    sessionId: 'abc123',
    worktreeId: MACHINE_WORKTREE_ID,
    projectId: '',
    kind: 'shell' as const,
    title: 'shell',
    cwd: '/home/someone',
    createdAt: 1,
  }

  it('survives a restart: its metadata is adopted', () => {
    expect(parseMeta(JSON.stringify(meta))).toEqual(meta)
  })

  it('is what an absent worktree id would have cost', () => {
    // The same session with no worktree id is refused, and a refused session is
    // one tmux keeps and nothing can reach.
    expect(parseMeta(JSON.stringify({ ...meta, worktreeId: '' }))).toBe(null)
    const { worktreeId: _gone, ...without } = meta
    expect(parseMeta(JSON.stringify(without))).toBe(null)
  })

  it('cannot collide with a worktree of that name', () => {
    // Worktree ids are a hash behind a prefix, whatever the path says.
    for (const path of ['/machine', '/home/someone/machine', '/srv/machine/']) {
      expect(worktreeIdFor(path)).not.toBe(MACHINE_WORKTREE_ID)
      expect(worktreeIdFor(path)).toMatch(/^wt-[0-9a-f]+$/)
    }
  })

  it('has an empty project, so closing a project cannot take it', () => {
    // `killForProject` matches on the recorded project id.
    expect(meta.projectId).toBe('')
  })
})
