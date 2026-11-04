import { afterEach, describe, expect, it } from 'vitest'
import type { ServerMsg } from '@switchboard/shared'
import { LiveSession, SessionEngine, type Sink } from '../src/session/engine.js'

/*
 * Who sets a session's size when it is open in two places.
 *
 * Measured as a bug: Claude open on a laptop and on a larger MacBook, the
 * MacBook the last to resize. Clicking into the laptop's window and typing
 * there left the pty at the MacBook's geometry, so the laptop drew more
 * columns and rows than its pane had and the right side and input box were
 * cut off -- until its window happened to change size. Focus claimed the
 * keyboard and nothing else.
 */

const sink = (): Sink & { sizes: string[] } => {
  const sizes: string[] = []
  return {
    open: true,
    sizes,
    sendBinary: () => {},
    sendJson: (msg: ServerMsg) => {
      if (msg.t === 'size') sizes.push(`${msg.cols}x${msg.rows}`)
    },
  }
}

const sessions: LiveSession[] = []

const engineWith = (): { engine: SessionEngine; live: LiveSession } => {
  const live = new LiveSession(
    {
      id: 's1',
      worktreeId: 'wt-1',
      kind: 'claude',
      tmuxName: 'swb-s1',
      title: 'claude',
      cols: 100,
      rows: 30,
      liveness: 'live',
      attention: 'idle',
      lastOutputAt: 0,
      createdAt: 0,
      attachCommand: '',
    },
    { sessionId: 's1', worktreeId: 'wt-1', projectId: 'p', kind: 'claude', title: 'claude', cwd: '/', createdAt: 0 },
    () => {},
  )
  sessions.push(live)
  const engine = new SessionEngine()
  ;(engine as unknown as { sessions: Map<string, LiveSession> }).sessions.set('s1', live)
  return { engine, live }
}

afterEach(() => {
  for (const live of sessions.splice(0)) live.mirror.dispose()
})

describe('the size of a session open in two places', () => {
  it('follows the view you click into, not the last one to resize', async () => {
    const { engine, live } = engineWith()
    const laptop = sink()
    const macbook = sink()
    await engine.attach(laptop, 's1', 90, 25, true)
    await engine.attach(macbook, 's1', 160, 45, true)
    expect(`${live.record.cols}x${live.record.rows}`).toBe('160x45')

    engine.focus(laptop, 's1')
    expect(`${live.record.cols}x${live.record.rows}`).toBe('90x25')
    // And the MacBook is told, so it draws at the size the pty now is.
    expect(macbook.sizes.at(-1)).toBe('90x25')

    engine.focus(macbook, 's1')
    expect(`${live.record.cols}x${live.record.rows}`).toBe('160x45')
  })

  it('is not taken by a view that only previews it', async () => {
    const { engine, live } = engineWith()
    const window = sink()
    const preview = sink()
    await engine.attach(window, 's1', 120, 40, true)
    await engine.attach(preview, 's1', 60, 15, false)
    engine.focus(preview, 's1')
    expect(`${live.record.cols}x${live.record.rows}`).toBe('120x40')
  })
})
