import { describe, expect, it } from 'vitest'
import { parsePanes, parseSessions } from '../src/session/tmux.js'

/*
 * What tmux hands back, from two tmux versions, measured on real machines.
 *
 * The separator asked for is 0x1f. tmux 3.3a returns that byte; tmux 3.4
 * escapes non-printable characters in format output and returns the four
 * characters `\037` instead. Same command, same session:
 *
 *   3.3a (Debian 12)  o d t e s t 037 b a s h
 *   3.4  (Ubuntu 24)  o d t e s t  \  0  3  7  b a s h
 *
 * Splitting on the byte alone gave one field on 3.4 -- every session name read
 * as the whole line -- so the poller matched nothing, marked every session
 * dead and reaped it within two seconds. Terminals appeared and vanished,
 * Claude sessions with them, and a restarted server adopted nothing. Every
 * cloud machine is Ubuntu; the machine this repository is developed on is
 * Debian, which is why it cost nothing here and everything there.
 */
const BYTE = '\x1f'
const ESCAPED = '\\037'

describe.each([
  ['tmux 3.3a, the raw byte', BYTE],
  ['tmux 3.4, the escape it prints instead', ESCAPED],
])('%s', (_name, sep) => {
  it('reads a pane as its fields, not as one string', () => {
    const line = ['swb-abc123', '/home/switchboard', 'bash', '80', '24', '0', '', '1789740113'].join(sep)
    const [pane] = parsePanes(line)
    expect(pane?.sessionName).toBe('swb-abc123')
    expect(pane?.cwd).toBe('/home/switchboard')
    expect(pane?.command).toBe('bash')
    expect(pane?.cols).toBe(80)
    expect(pane?.rows).toBe(24)
    expect(pane?.dead).toBe(false)
    expect(pane?.activity).toBe(1789740113)
  })

  it('reads a dead pane as dead, with its status', () => {
    const line = ['swb-abc123', '/tmp', 'bash', '80', '24', '1', '130', '1789740113'].join(sep)
    const [pane] = parsePanes(line)
    expect(pane?.dead).toBe(true)
    expect(pane?.deadStatus).toBe(130)
  })

  it('reads a session and the metadata a restart adopts it by', () => {
    // Every field parseMeta insists on: a session a restart cannot identify
    // is one it will not adopt.
    const meta = JSON.stringify({
      sessionId: 's1',
      worktreeId: 'w1',
      projectId: 'p1',
      kind: 'shell',
      cwd: '/home/switchboard',
    })
    const line = ['swb-abc123', meta, '/home/switchboard', '80', '24'].join(sep)
    const [session] = parseSessions(line)
    expect(session?.name).toBe('swb-abc123')
    expect(session?.cwd).toBe('/home/switchboard')
    expect(session?.meta?.worktreeId).toBe('w1')
  })
})
