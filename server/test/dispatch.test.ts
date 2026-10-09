import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session, WorktreeTodo } from '@switchboard/shared'
import { SETTLE_MS } from '../src/session/readiness.js'

/* See state.test.ts: `stateFile` is derived from config at import time. */
const stateDir = await mkdtemp(join(tmpdir(), 'swb-dispatch-'))
process.env.SWB_STATE_DIR = stateDir
const { StateStore } = await import('../src/state.js')
const { startDispatcher } = await import('../src/session/dispatch.js')
type SessionEngine = Parameters<typeof startDispatcher>[0]['engine']

const WORKTREE = 'wt-1'
const SESSION = 's-1'

/** A resting Claude: no dialog, no timer, an empty input box. */
const AT_REST = ['● Did the thing', '✻ Baked for 2s · done 3:01 PM', '❯ '].join('\n')

/**
 * A stand-in engine that records what was typed.
 *
 * The real one owns a pty. Everything the dispatcher asks of it is in these
 * three methods, and what matters here is the *decision* -- whether a byte goes
 * out at all, and whether the Return follows it -- so the bytes are collected
 * rather than delivered.
 */
const fakeEngine = (over: {
  screen?: string
  sessions?: Partial<Session>[]
  lastOutputAt?: number
  lastUserInputAt?: number
  writable?: boolean
  /**
   * What the screen does when the paste arrives.
   *
   * The default is what a real Claude does: the prompt appears in the input
   * box. That is not incidental -- the Return is withheld unless the box is
   * showing this prompt's opening -- so a test that wants the paste to go
   * astray says so here.
   */
  onPaste?: (pasted: string) => void
}) => {
  const typed: string[] = []
  let screen = over.screen ?? AT_REST
  const engine = {
    listForWorktree: (worktreeId: string): Session[] =>
      worktreeId !== WORKTREE
        ? []
        : ((over.sessions ?? [{ id: SESSION, kind: 'claude', liveness: 'live' }]) as Session[]),
    inspect: async (sessionId: string) =>
      sessionId !== SESSION
        ? undefined
        : {
            kind: 'claude' as const,
            dead: false,
            hasPty: true,
            lastOutputAt: over.lastOutputAt ?? Date.now() - SETTLE_MS - 1,
            lastUserInputAt: over.lastUserInputAt ?? 0,
            tail: screen,
            brightTail: screen,
          },
    typeInto: (_sessionId: string, data: string): boolean => {
      if (over.writable === false) return false
      typed.push(data)
      const pasted = /\x1b\[200~([\s\S]*)\x1b\[201~/.exec(data)?.[1]
      if (pasted === undefined) return true
      if (over.onPaste) over.onPaste(pasted)
      else screen = `● work\n❯ ${pasted.split('\n')[0] ?? ''}`
      return true
    },
  }
  return {
    engine: engine as unknown as SessionEngine,
    typed,
    setScreen: (next: string) => {
      screen = next
    },
  }
}

const todo = (over: Partial<WorktreeTodo> & Pick<WorktreeTodo, 'id'>): WorktreeTodo => ({
  worktreeId: WORKTREE,
  prompt: 'do the thing',
  createdAt: 1,
  ...over,
})

let store: InstanceType<typeof StateStore>
let stop: (() => void) | undefined

/**
 * Wait for real work to finish while the clock is frozen.
 *
 * A dispatch is not only timers: the claim is flushed to disk before the first
 * byte goes out, and that is genuine file I/O which no amount of advancing a
 * fake clock completes. `node:timers/promises` is not patched by the fake
 * clock, so this is real time.
 *
 * It waits on a condition rather than for a fixed number of yields. A fixed
 * count failed about once per full parallel run: the write had not landed, so
 * the next tick found the first send still in flight, dropped itself on the
 * re-entry guard, and decided nothing.
 */
const settle = async (done: () => boolean): Promise<void> => {
  for (let n = 0; n < 400 && !done(); n++) await sleep(1)
}

/**
 * Nothing is in flight and the tick has said what it decided.
 *
 * A claim is written synchronously with the `sent` verdict, so a todo carrying
 * `dispatchingAt` means a send is still running.
 */
const atRest = (dispatcher: ReturnType<typeof startDispatcher>): boolean => {
  if (store.todos.some((todo) => todo.dispatchingAt !== undefined)) return false
  if (!store.todos.some((todo) => todo.queuedAt !== undefined)) return true
  return dispatcher.lastReason(WORKTREE) !== undefined
}

/** One second of the dispatcher's clock, plus the submit delay inside a send. */
const tick = async (dispatcher: ReturnType<typeof startDispatcher>): Promise<void> => {
  await vi.advanceTimersByTimeAsync(1000)
  /*
   * Either the send got as far as arming its submit delay -- a second fake
   * timer beside the dispatcher's own interval -- or the tick finished without
   * sending anything.
   */
  await settle(() => vi.getTimerCount() > 1 || atRest(dispatcher))
  await vi.advanceTimersByTimeAsync(400)
  await settle(() => atRest(dispatcher))
}

const run = async (engine: SessionEngine): Promise<ReturnType<typeof startDispatcher>> => {
  const dispatcher = startDispatcher({
    store,
    engine,
    onChange: () => {},
    // No worktree path, so the transcript says `unknown` and the screen tests
    // in readiness.ts are what have to carry the decision.
    pathFor: async () => undefined,
  })
  stop = dispatcher.stop
  // Twice, so a worktree that sent on the first tick is reconsidered on the
  // second -- which is where the cooldown shows up.
  await tick(dispatcher)
  await tick(dispatcher)
  return dispatcher
}

beforeEach(async () => {
  /*
   * Date is faked so the readiness clocks are deterministic; `setImmediate` and
   * `queueMicrotask` are not, so `settle()` above can wait for real file I/O.
   */
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  await rm(join(stateDir, 'state.json'), { force: true })
  store = new StateStore()
  await store.load()
})

afterEach(async () => {
  stop?.()
  stop = undefined
  await store.flush()
  vi.useRealTimers()
})

describe('the dispatcher', () => {
  it('types a queued prompt into a resting Claude, then submits it', async () => {
    store.addTodo(todo({ id: 't-1', prompt: 'do the thing', queuedAt: 1 }))
    const { engine, typed } = fakeEngine({})
    await run(engine)
    /*
     * The Return is a separate write on purpose. Concatenated onto the paste it
     * is a Return you cannot take back if the screen turns out not to be what
     * you thought; sent separately it can be withheld, and a paste sitting
     * unsent in the box is recoverable by a human.
     */
    expect(typed).toEqual(['\x1b[200~do the thing\x1b[201~', '\r'])
    // Sent means gone: the todo is not left to be sent again.
    expect(store.todo('t-1')).toBeUndefined()
  })

  it('sends a multi-line prompt as one prompt', async () => {
    store.addTodo(todo({ id: 't-1', prompt: 'line one\nline two', queuedAt: 1 }))
    const { engine, typed } = fakeEngine({})
    await run(engine)
    // Bracketed paste, or Claude submits on the first newline.
    expect(typed[0]).toBe('\x1b[200~line one\nline two\x1b[201~')
  })

  it('leaves an unqueued todo alone', async () => {
    store.addTodo(todo({ id: 't-1' }))
    const { engine, typed } = fakeEngine({})
    await run(engine)
    expect(typed).toEqual([])
    expect(store.todo('t-1')).toBeDefined()
  })

  it('sends the one whose RUN NEXT was pressed first', async () => {
    store.addTodo(todo({ id: 't-late', prompt: 'second', createdAt: 1, queuedAt: 200 }))
    store.addTodo(todo({ id: 't-early', prompt: 'first', createdAt: 2, queuedAt: 100 }))
    const { engine, typed } = fakeEngine({})
    await run(engine)
    expect(typed[0]).toContain('first')
    expect(store.todo('t-early')).toBeUndefined()
    expect(store.todo('t-late')).toBeDefined()
  })

  it('waits rather than typing into a Claude that is mid-turn', async () => {
    store.addTodo(todo({ id: 't-1', queuedAt: 1 }))
    const { engine, typed } = fakeEngine({ screen: '✽ Grooving… (3m 34s · ↓ 81 tokens)\n❯ ' })
    const dispatcher = await run(engine)
    expect(typed).toEqual([])
    expect(dispatcher.lastReason(WORKTREE)).toBe('busy')
    expect(store.todo('t-1')?.queuedAt).toBe(1)
  })

  it('waits rather than answering a dialog nobody has seen', async () => {
    /*
     * Measured against a real Claude: the trust-folder dialog sits with "No,
     * exit" selected, so a stray Return there quits the agent.
     */
    store.addTodo(todo({ id: 't-1', queuedAt: 1 }))
    const { engine, typed } = fakeEngine({
      // v2.1.270, verbatim; its options are not numbered.
      screen: [
        '✻ Baked for 2s · done 3:01 PM',
        ' Quick safety check: Is this a project you created or one you trust?',
        ' ❯ No, exit',
        '   Yes, I trust this folder',
        '',
        ' Enter to confirm · Esc to cancel',
      ].join('\n'),
    })
    const dispatcher = await run(engine)
    expect(typed).toEqual([])
    expect(dispatcher.lastReason(WORKTREE)).toBe('needs-you')
  })

  it('sends on the next tick when the human typed just before queueing', async () => {
    const typedAt = Date.now() - SETTLE_MS - 10
    store.addTodo(todo({ id: 't-1', queuedAt: typedAt + 1 }))
    const { engine, typed } = fakeEngine({ lastUserInputAt: typedAt })
    await run(engine)
    expect(typed).toHaveLength(2)
  })

  it('hands back every todo queued before the human typed, and keeps later ones', async () => {
    const typedAt = Date.now()
    store.addTodo(todo({ id: 't-1', queuedAt: typedAt - 20 }))
    store.addTodo(todo({ id: 't-2', queuedAt: typedAt - 10 }))
    store.addTodo(todo({ id: 't-3', queuedAt: typedAt + 10, prompt: 'later' }))
    const { engine, typed } = fakeEngine({ lastUserInputAt: typedAt })
    await run(engine)
    for (const id of ['t-1', 't-2']) {
      expect(store.todo(id)?.queuedAt).toBeUndefined()
      expect(store.todo(id)?.lastError).toMatch(/typed into Claude/)
    }
    // Only the one queued after the keystroke went out.
    expect(typed).toHaveLength(2)
    expect(typed[0]).toContain('later')
    expect(store.todo('t-3')).toBeUndefined()
  })

  it('picks a live Claude over a dead one in the same worktree', async () => {
    /*
     * A session that died on its own stays in the engine's list, and picking by
     * map order pinned the queue on `why: 'dead'` while a working Claude sat
     * beside it.
     */
    store.addTodo(todo({ id: 't-1', queuedAt: 1 }))
    const { engine, typed } = fakeEngine({
      sessions: [
        { id: 's-dead', kind: 'claude', liveness: 'dead' },
        { id: SESSION, kind: 'claude', liveness: 'live' },
      ],
    })
    await run(engine)
    expect(typed).toHaveLength(2)
  })

  it('says so, rather than typing, when the worktree has no Claude', async () => {
    store.addTodo(todo({ id: 't-1', queuedAt: 1 }))
    const { engine, typed } = fakeEngine({ sessions: [] })
    const dispatcher = await run(engine)
    expect(typed).toEqual([])
    expect(dispatcher.lastReason(WORKTREE)).toBe('no-session')
  })

  it('puts a todo back when the pty refuses the write', async () => {
    // Nothing was written, so nothing was sent.
    store.addTodo(todo({ id: 't-1', queuedAt: 7 }))
    const { engine } = fakeEngine({ writable: false })
    await run(engine)
    expect(store.todo('t-1')).toMatchObject({ queuedAt: 7 })
    expect(store.todo('t-1')?.dispatchingAt).toBeUndefined()
  })

  it('withholds the Return when the paste did not land in the box', async () => {
    /*
     * The paste is in the box or it is not; if the screen does not show it,
     * Return would submit whatever *is* there. A paste left sitting in a box is
     * recoverable by a human, and a Return is not.
     */
    store.addTodo(todo({ id: 't-1', prompt: 'do the thing', queuedAt: 1 }))
    const fake = fakeEngine({ onPaste: () => fake.setScreen(AT_REST) })
    const { engine, typed } = fake
    await run(engine)
    expect(typed).toEqual(['\x1b[200~do the thing\x1b[201~'])
    expect(store.todo('t-1')?.lastError).toContain('did not appear in Claude')
    // Handed back rather than retried: it is never queued again on its own.
    expect(store.todo('t-1')?.queuedAt).toBeUndefined()
  })

  it('withholds the Return when a dialog arrived while the paste was landing', async () => {
    /*
     * The check used to be "the box is not empty", which a dialog's selected
     * row satisfies exactly as well as a filled box does -- `❯ 1. Yes` reads as
     * a box containing "1. Yes". A permission or trust dialog arriving inside
     * the submit delay swallowed the paste, and the Return answered the dialog
     * with whatever was preselected. The trust dialog preselects "No, exit".
     */
    store.addTodo(todo({ id: 't-1', prompt: 'do the thing', queuedAt: 1 }))
    const fake = fakeEngine({
      onPaste: () =>
        fake.setScreen(
          [
            '✻ Baked for 2s · done 3:01 PM',
            'Do you want to proceed?',
            '❯ 1. Yes',
            '  2. No',
          ].join('\n'),
        ),
    })
    await run(fake.engine)
    expect(fake.typed).toEqual(['\x1b[200~do the thing\x1b[201~'])
    expect(store.todo('t-1')?.lastError).toBeDefined()
  })

  it('submits when the box shows the beginning of this prompt', async () => {
    store.addTodo(todo({ id: 't-1', prompt: 'rework the bar', queuedAt: 1 }))
    const fake = fakeEngine({ onPaste: () => fake.setScreen('● work\n❯ rework the bar') })
    await run(fake.engine)
    expect(fake.typed).toEqual(['\x1b[200~rework the bar\x1b[201~', '\r'])
  })

  it('accepts the summary Claude collapses a long paste to', async () => {
    // Verified as "the box is showing this prompt's opening", and Claude Code
    // renders a long paste as `[Pasted text +N lines]` -- so the opening is
    // matched against a box that may be showing either.
    const prompt = `${'a'.repeat(40)}\nand more`
    store.addTodo(todo({ id: 't-1', prompt, queuedAt: 1 }))
    const fake = fakeEngine({
      onPaste: () => fake.setScreen(`● work\n❯ ${'a'.repeat(40)}`),
    })
    await run(fake.engine)
    expect(fake.typed).toHaveLength(2)
  })

  it('keeps the todo when the Return itself goes nowhere', async () => {
    /*
     * The prompt is then sitting unsubmitted in the box, and deleting the todo
     * would hide that: the next Return a human presses -- possibly hours later,
     * after typing something else in front of it -- would send it.
     */
    store.addTodo(todo({ id: 't-1', prompt: 'do the thing', queuedAt: 1 }))
    let writes = 0
    const fake = fakeEngine({ onPaste: () => fake.setScreen('● work\n❯ do the thing') })
    const engine = {
      ...(fake.engine as unknown as Record<string, unknown>),
      typeInto: (id: string, data: string) =>
        ++writes === 1 ? (fake.engine as SessionEngine).typeInto(id, data) : false,
    } as unknown as SessionEngine
    await run(engine)
    expect(store.todo('t-1')?.lastError).toContain('the Return did not')
    expect(store.todo('t-1')?.queuedAt).toBeUndefined()
  })

  it('never re-sends a todo that was in flight when the process died', async () => {
    /*
     * The claim is written to disk before the first byte goes out, so "we may
     * have sent it" can only be read as "we did". Typing the same instruction
     * into an agent twice is worse than not typing it.
     */
    store.addTodo(todo({ id: 't-1', queuedAt: 1, dispatchingAt: 5 }))
    const { engine, typed } = fakeEngine({})
    await run(engine)
    expect(typed).toEqual([])
    const recovered = store.todo('t-1')
    expect(recovered?.queuedAt).toBeUndefined()
    expect(recovered?.dispatchingAt).toBeUndefined()
    expect(recovered?.lastError).toContain('queue it again')
  })

  it('claims the todo on disk before typing a single byte', async () => {
    let claimAtFirstWrite: number | undefined
    store.addTodo(todo({ id: 't-1', queuedAt: 1 }))
    const fake = fakeEngine({
      onPaste: () => {
        claimAtFirstWrite = store.todo('t-1')?.dispatchingAt
        fake.setScreen('● work\n❯ do the thing')
      },
    })
    await run(fake.engine)
    expect(claimAtFirstWrite).toBeTypeOf('number')
  })

  it('does not consider the same worktree again straight away', async () => {
    // The cooldown after a send; without it the next todo goes out into a
    // Claude that has not begun the turn it was just given.
    store.addTodo(todo({ id: 't-1', prompt: 'first', queuedAt: 1 }))
    store.addTodo(todo({ id: 't-2', prompt: 'second', queuedAt: 2 }))
    const { engine, typed } = fakeEngine({})
    const dispatcher = await run(engine)
    expect(typed.filter((data) => data.includes('\x1b[200~'))).toHaveLength(1)
    expect(dispatcher.lastReason(WORKTREE)).toBe('cooling-down')
  })
})
