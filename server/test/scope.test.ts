import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ID_FIELDS,
  hostKeyFor,
  scopeId,
  scopeTree,
  unscopeId,
  unscopeTree,
} from '../src/remote/scope.js'

describe('scoping a peer', () => {
  it('leaves a local id exactly as it was', () => {
    // Local ids are recorded inside tmux's own metadata, so a scoped one would
    // orphan every running session. The empty key is the whole of that promise.
    expect(scopeId('', 'wt-abc123')).toBe('wt-abc123')
    expect(unscopeId('wt-abc123')).toBeNull()
  })

  /*
   * A scoped id travels in a URL path, so it has to survive the proxies in
   * front of this server byte for byte. This was the base URL and `|`, which
   * put `%2F` and `%3A` into a path segment -- and Caddy normalizes encoded
   * slashes, so the request arrived split into segments matching no route.
   */
  it('stays URL-safe: nothing in a scoped id needs encoding', () => {
    const scoped = scopeId(hostKeyFor('https://box.example/ide'), 'wt-abc123')
    expect(scoped).toMatch(/^h[0-9a-f]{8}~wt-abc123$/)
    expect(encodeURIComponent(scoped)).toBe(scoped)
    expect(unscopeId(scoped)).toEqual({
      host: hostKeyFor('https://box.example/ide'),
      id: 'wt-abc123',
    })
  })

  it('gives two peers two keys, and one peer the same key every time', () => {
    expect(hostKeyFor('http://a:1')).not.toBe(hostKeyFor('http://b:1'))
    expect(hostKeyFor('http://a:1')).toBe(hostKeyFor('http://a:1'))
  })

  it('rewrites ids anywhere in a reply, and nothing else', () => {
    const reply = {
      worktrees: [{ id: 'wt-1', projectId: 'p-1', name: 'x', path: '/p' }],
      sessions: [{ id: 's-1', worktreeId: 'wt-1' }],
      commits: [{ hash: 'deadbeef', subject: 'id: not an id' }],
    }
    const scoped = scopeTree('h1234abcd', reply)
    expect(scoped.worktrees[0]).toMatchObject({
      id: 'h1234abcd~wt-1',
      projectId: 'h1234abcd~p-1',
      path: '/p',
    })
    expect(scoped.sessions[0]).toEqual({
      id: 'h1234abcd~s-1',
      worktreeId: 'h1234abcd~wt-1',
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

  /*
   * Which machine a request is for is decided by looking for a scoped id in it,
   * so "looks like a scoped id" has to be narrow. It was `includes('~')` over
   * every string in the body, and a todo's prompt is a string: `rm -rf ~` read
   * as a peer reference and routed a perfectly ordinary prompt to a machine
   * that does not exist.
   */
  it('does not mistake ordinary text for a peer reference', () => {
    for (const text of ['rm -rf ~', '~/src/ide', 'use ~ for home', 'a~b', 'wt-abc~def']) {
      expect(unscopeId(text)).toBeNull()
    }
    // And the real thing still reads, including an id with a separator after
    // the host key, which only the first one may split.
    expect(unscopeId('h1234abcd~wt-1')).toEqual({ host: 'h1234abcd', id: 'wt-1' })
    expect(unscopeId('h1234abcd~wt~1')).toEqual({ host: 'h1234abcd', id: 'wt~1' })
  })
})

describe('a machine behind a password', () => {
  /*
   * `https://user:pw@machine` is the syntax people reach for, and every layer
   * below refuses it: `new URL().origin` drops it silently, and `fetch()`
   * throws outright on a URL carrying credentials. So it used to mean "type a
   * password, watch it vanish, and get a bare 401 from the proxy with no hint
   * why" -- the worst of the three possible behaviours.
   */
  it('takes the password out of the address and leaves the address alone', async () => {
    const { basicFrom, normalizeBaseUrl } = await import('../src/remote/peer.js')
    expect(basicFrom('https://andrin:secret@box:84')).toBe(
      Buffer.from('andrin:secret').toString('base64'),
    )
    // The base URL is hashed into the key that scopes every id from that
    // machine, shown in the picker and written into log lines. None of those is
    // a place for a password.
    expect(normalizeBaseUrl('https://andrin:secret@box:84')).toBe('https://box:84')
    expect(basicFrom('https://box:84')).toBeUndefined()
  })

  it('decodes what the URL had to encode', async () => {
    const { basicFrom } = await import('../src/remote/peer.js')
    // A password with a `@` or a `:` in it has to arrive percent-encoded, and
    // the proxy expects the real bytes.
    expect(basicFrom('https://a%40b:p%3Aw@box')).toBe(
      Buffer.from('a@b:p:w').toString('base64'),
    )
  })
})
