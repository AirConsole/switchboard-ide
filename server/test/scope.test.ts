import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ID_FIELDS, scopeId, scopeTree, unscopeId, unscopeTree, withoutToken } from '../src/remote/scope.js'
import type { Project } from '@switchboard/shared'

describe('scoping a peer', () => {
  it('leaves a local id exactly as it was', () => {
    // Local ids are recorded inside tmux's own metadata, so a scoped one would
    // orphan every running session. The empty key is the whole of that promise.
    expect(scopeId('', 'wt-abc123')).toBe('wt-abc123')
    expect(unscopeId('wt-abc123')).toBeNull()
  })

  it('splits from the right, because a base URL may contain the separator', () => {
    // A peer behind a proxy subpath: the naive split takes the wrong half and
    // every id it produces addresses nothing.
    const scoped = scopeId('https://box/ide|v2', 'wt-abc123')
    expect(unscopeId(scoped)).toEqual({ host: 'https://box/ide|v2', id: 'wt-abc123' })
  })

  it('rewrites ids anywhere in a reply, and nothing else', () => {
    const reply = {
      worktrees: [{ id: 'wt-1', projectId: 'p-1', name: 'x', path: '/p' }],
      sessions: [{ id: 's-1', worktreeId: 'wt-1' }],
      commits: [{ hash: 'deadbeef', subject: 'id: not an id' }],
    }
    const scoped = scopeTree('http://peer:8300', reply)
    expect(scoped.worktrees[0]).toMatchObject({
      id: 'http://peer:8300|wt-1',
      projectId: 'http://peer:8300|p-1',
      path: '/p',
    })
    expect(scoped.sessions[0]).toEqual({
      id: 'http://peer:8300|s-1',
      worktreeId: 'http://peer:8300|wt-1',
    })
    // A commit's hash is not an id, and prose that happens to say "id" is prose.
    expect(scoped.commits[0]).toEqual({ hash: 'deadbeef', subject: 'id: not an id' })
    expect(unscopeTree(scoped)).toEqual(reply)
  })

  /*
   * The load-bearing assumption of the whole proxy.
   *
   * Ids are rewritten by field *name* over the peer's JSON, which is what lets
   * one function serve every route instead of each route being mirrored by
   * hand. That is only sound while no other type reuses these names. If someone
   * adds an `id` to a value type -- or a fifth id-bearing field -- this fails
   * here rather than by shipping an unscoped id that addresses another
   * machine's worktree.
   */
  /*
   * Which *types* carry an id, not merely which names exist.
   *
   * Comparing the set of names was not enough, and the difference is the whole
   * danger: adding `id` to `Commit` -- a value type whose id would then be
   * rewritten as though it addressed a worktree -- left the name set unchanged
   * and the test green. Measured; this is the version that fails.
   */
  it('still covers exactly the types that carry an id', () => {
    // Both files, because both are rewritten: the model is what REST replies
    // are made of, and the protocol is what the socket relay carries.
    const carriers = ['model', 'protocol'].flatMap((file) => {
      const src = readFileSync(new URL(`../../shared/src/${file}.ts`, import.meta.url), 'utf8')
      return [...src.matchAll(/^export interface (\w+) \{([\s\S]*?)^\}/gm)].flatMap(
        (match) => {
          const [, name, body] = match as unknown as [string, string, string]
          const ids = [...body.matchAll(/^ {2}([a-zA-Z]*[iI]d)\??: string/gm)].map((m) => m[1])
          return ids.length === 0 ? [] : [`${name}: ${ids.join(',')}`]
        },
      )
    })
    expect(carriers).toEqual([
      'Project: id',
      'Worktree: id,projectId',
      'WorktreeTodo: id,worktreeId',
      'Session: id,worktreeId',
      'WorktreeChanges: worktreeId',
      // Every socket frame, each carrying the one session it is about.
      'AttachMsg: sessionId',
      'InputMsg: sessionId',
      'ResizeMsg: sessionId',
      'DetachMsg: sessionId',
      'FocusMsg: sessionId',
      'AttachedMsg: sessionId',
      'SizeMsg: sessionId',
      'SessionStateMsg: sessionId',
      'ErrorMsg: sessionId',
    ])
    // And every name above is one the rewriter actually knows.
    for (const entry of carriers) {
      for (const field of (entry.split(': ')[1] ?? '').split(',')) {
        expect(ID_FIELDS).toContain(field)
      }
    }
  })

  it('never lets a peer credential reach the browser', () => {
    // The snapshot goes to the client, and `Project.host` is persisted with the
    // token in it. Dropped rather than blanked, so a client that round-trips
    // what it was given cannot write one back.
    const project = {
      id: 'p-1',
      host: { kind: 'remote', baseUrl: 'http://peer:8300', token: 'hunter2' },
    } as Project
    const safe = withoutToken(project)
    expect(JSON.stringify(safe)).not.toContain('hunter2')
    expect(safe.host).toEqual({ kind: 'remote', baseUrl: 'http://peer:8300' })
  })
})
