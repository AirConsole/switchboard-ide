import { describe, expect, it } from 'vitest'
import { terminalSocket } from '../src/socket.js'

/**
 * The private shape `handleJson` works on. Reached deliberately rather than
 * through a real WebSocket: what is under test is one branch of the frame
 * handler, and standing up a socket to reach it would test the socket.
 */
interface Reachable {
  handleJson(msg: unknown): void
  consumers: Map<string, Set<{ painted: boolean; onSnapshot: (s: string) => void }>>
  streamToSession: Map<number, string>
}

const inner = terminalSocket as unknown as Reachable

describe('a re-attach repaints the pane', () => {
  /*
   * When a remote worktree's machine restarts, the gateway re-attaches on our
   * behalf and this socket never closes -- so nothing else ever resets
   * `painted`. Without this the pane went on showing the screen from before the
   * restart, and everything the agent printed in the gap was dropped. Claude
   * runs on the alternate screen, where a serialized repaint is the only thing
   * that means anything.
   */
  it('paints again when the same session comes back on a new stream', () => {
    const painted: string[] = []
    const consumer = {
      painted: false,
      onSnapshot: (snapshot: string) => painted.push(snapshot),
    }
    inner.consumers.set('s-1', new Set([consumer]))

    inner.handleJson({ t: 'attached', sessionId: 's-1', streamId: 7, cols: 80, rows: 24, snapshot: 'first' })
    expect(painted).toEqual(['first'])

    // The peer restarted: same session, a stream number we have not seen.
    inner.handleJson({ t: 'attached', sessionId: 's-1', streamId: 8, cols: 80, rows: 24, snapshot: 'after restart' })
    expect(painted).toEqual(['first', 'after restart'])

    // And the number that will never carry anything again is not left mapped.
    expect(inner.streamToSession.has(7)).toBe(false)
    expect(inner.streamToSession.get(8)).toBe('s-1')

    inner.consumers.delete('s-1')
  })

  it('does not repaint on the frame that first attached it', () => {
    const painted: string[] = []
    const first = { painted: false, onSnapshot: (s: string) => painted.push(s) }
    const second = { painted: false, onSnapshot: (s: string) => painted.push(s) }
    inner.consumers.set('s-2', new Set([first, second]))

    inner.handleJson({ t: 'attached', sessionId: 's-2', streamId: 9, cols: 80, rows: 24, snapshot: 'once' })
    // Both consumers paint once; neither is repainted by the other's arrival.
    expect(painted).toEqual(['once', 'once'])

    inner.consumers.delete('s-2')
  })
})
