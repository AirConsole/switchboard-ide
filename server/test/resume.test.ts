import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LimitStop } from '../src/session/claude.js'

/* See state.test.ts: `stateFile` is derived from config at import time. */
const stateDir = await mkdtemp(join(tmpdir(), 'swb-resume-'))
process.env.SWB_STATE_DIR = stateDir
const { StateStore } = await import('../src/state.js')
const { RESUME_PROMPT, resumeAt, startResumeWatcher } = await import('../src/session/resume.js')

const STOP: LimitStop = {
  id: 'stop-1',
  text: "You've hit your session limit · resets 4:10pm (UTC)",
  at: Date.UTC(2026, 6, 7, 15, 42, 17),
}

let store: InstanceType<typeof StateStore>
let watcher: ReturnType<typeof startResumeWatcher> | undefined

const watch = (stops: Record<string, LimitStop | null>, notBefore = 1_000_000) => {
  watcher = startResumeWatcher({
    store,
    engine: {
      claudeDirs: () => Object.keys(stops).map((cwd) => ({ worktreeId: `wt-${cwd}`, cwd })),
    },
    onChange: () => {},
    limitStop: async (cwd) => stops[cwd] ?? null,
    when: async () => notBefore,
  })
  return watcher
}

beforeEach(async () => {
  await rm(join(stateDir, 'state.json'), { force: true })
  store = new StateStore()
  await store.load()
})

afterEach(async () => {
  watcher?.stop()
  watcher = undefined
  await store.flush()
})

describe('the resume watcher', () => {
  it('parks a queued continue, held until the reset, behind a stopped Claude', async () => {
    await watch({ a: STOP }).look()
    expect(store.todos).toHaveLength(1)
    expect(store.todos[0]).toMatchObject({
      worktreeId: 'wt-a',
      prompt: RESUME_PROMPT,
      notBefore: 1_000_000,
      limitStop: 'stop-1',
    })
    expect(store.todos[0]?.queuedAt).toBeTypeOf('number')
  })

  it('parks one per stop, however many times it looks', async () => {
    const w = watch({ a: STOP })
    await w.look()
    await w.look()
    expect(store.todos).toHaveLength(1)
  })

  it('does not bring a deleted one back, nor park a second after a restart', async () => {
    // The stop is still the last thing in the transcript after either, so
    // only the remembered answer stands between it and another todo.
    await watch({ a: STOP }).look()
    store.removeTodo(store.todos[0]?.id ?? '')
    await store.flush()
    store = new StateStore()
    await store.load()
    await watch({ a: STOP }).look()
    expect(store.todos).toEqual([])
  })

  it('answers a new stop in the same worktree with a new todo', async () => {
    // A continue that arrived early is stopped again, with a record of its own.
    await watch({ a: STOP }).look()
    await watch({ a: { ...STOP, id: 'stop-2' } }).look()
    expect(store.todos.map((t) => t.limitStop)).toEqual(['stop-1', 'stop-2'])
  })

  it('leaves a Claude that has not stopped alone', async () => {
    await watch({ a: null }).look()
    expect(store.todos).toEqual([])
  })
})

describe('resumeAt', () => {
  const MIN = 60_000

  it('waits for the stated reset, plus a margin for the rounding', async () => {
    const now = STOP.at
    expect(await resumeAt(STOP, now)).toBe(Date.UTC(2026, 6, 7, 16, 12))
  })

  it('never resumes sooner than five minutes after the stop', async () => {
    // A stop whose reset has already passed is an early resume stopped again;
    // without the floor it would be continued every fifteen seconds.
    const early = { ...STOP, at: Date.UTC(2026, 6, 7, 16, 30) }
    expect(await resumeAt(early, early.at)).toBe(early.at + 5 * MIN)
  })

  it('continues at once when the server comes back after the reset', async () => {
    // Down at 4:10, back at 6pm: the agent has waited long enough already.
    const now = Date.UTC(2026, 6, 7, 18, 0)
    expect(await resumeAt(STOP, now)).toBeLessThan(now)
  })

  it('asks /usage when the sentence says nothing it can read', async () => {
    const vague = { ...STOP, text: "You've hit your limit" }
    expect(await resumeAt(vague, STOP.at, async () => ({ until: STOP.at + 60 * MIN }))).toBe(
      STOP.at + 62 * MIN,
    )
  })

  it('looks again in half an hour when nothing can say', async () => {
    const vague = { ...STOP, text: "You've hit your limit" }
    expect(await resumeAt(vague, STOP.at, async () => ({ until: null }))).toBe(STOP.at + 30 * MIN)
    expect(
      await resumeAt(vague, STOP.at, async () => {
        throw new Error('claude not found')
      }),
    ).toBe(STOP.at + 30 * MIN)
  })
})

describe('switching auto-continue off', () => {
  it('parks nothing while off, and answers the stop once it is on again', async () => {
    store.setAutoContinue(false)
    await watch({ a: STOP }).look()
    expect(store.todos).toEqual([])
    store.setAutoContinue(true)
    await watch({ a: STOP }).look()
    expect(store.todos).toHaveLength(1)
  })

  it('withdraws a waiting continue, and parks it again when switched back on', async () => {
    await watch({ a: STOP }).look()
    store.setAutoContinue(false)
    expect(store.todos).toEqual([])
    store.setAutoContinue(true)
    await watch({ a: STOP }).look()
    expect(store.todos.map((t) => t.limitStop)).toEqual(['stop-1'])
  })

  it('leaves a person’s own todos alone, and is remembered across a restart', async () => {
    store.addTodo({ id: 'mine', worktreeId: 'wt-a', prompt: 'next task', createdAt: 1, queuedAt: 1 })
    store.setAutoContinue(false)
    expect(store.todos.map((t) => t.id)).toEqual(['mine'])
    await store.flush()
    store = new StateStore()
    await store.load()
    expect(store.autoContinue).toBe(false)
  })
})
