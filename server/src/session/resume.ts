import { randomUUID } from 'node:crypto'
import type { StateStore } from '../state.js'
import type { SessionEngine } from './engine.js'
import { limitStop as readLimitStop, type LimitStop } from './claude.js'
import { fullUntil, stopResetsAt, usage } from '../usage.js'

/**
 * Continues an agent that stopped on a usage limit, once the limit has reset.
 *
 * Claude Code ends the turn when a limit runs out and then waits for a person,
 * so an agent working on its own simply stops, and stays stopped after the
 * limit resets. Nothing inside Claude can undo that -- its `StopFailure` hook
 * fires, and its output is ignored -- which is why it is done from here.
 *
 * It does not type anything itself. It parks a todo, `continue`, queued and
 * held until the reset, and the dispatcher types it the way it types any todo:
 * only into a Claude at rest with an empty input box, claimed on disk first.
 * So the safety argument is the one `readiness.ts` already makes, and the
 * human can see what is going to happen -- the todo is in the worktree's list,
 * saying when -- and delete it.
 */

/**
 * How often each Claude's transcript is looked at.
 *
 * A wait is minutes to days, so a stop noticed fifteen seconds late costs
 * nothing, and a look at every Claude every second -- the dispatcher's own
 * clock -- would be a directory listing per agent per second for an event
 * that happens a few times a week.
 */
const LOOK_MS = 15_000

/**
 * How long after the stated reset the todo waits.
 *
 * The time Claude states is rounded for reading ("resets 4:10pm"), and a
 * `continue` typed a moment early is a second stop rather than a resumed agent.
 */
const MARGIN_MS = 2 * 60 * 1000

/**
 * The shortest wait after a stop, whatever its sentence said.
 *
 * A resume can arrive early -- the rounding above, a clock that disagrees, a
 * reset that is stated but not yet true -- and is then answered with another
 * stop. That stop's reset is in the past, and without a floor it would be
 * continued on the next look, every fifteen seconds, for as long as the limit
 * held. Counted from the stop rather than from now, so a server that was down
 * when the limit reset continues its agents as soon as it is back.
 */
const MIN_WAIT_MS = 5 * 60 * 1000

/** When neither the sentence nor `/usage` says when: look again in this long. */
const UNKNOWN_WAIT_MS = 30 * 60 * 1000

/** What is typed. Claude reads it against the conversation it was in. */
export const RESUME_PROMPT = 'continue'

/**
 * When a stop's limit resets: its own sentence first, `/usage` second.
 *
 * The sentence is the stop's own account and costs nothing. `/usage` costs a
 * `claude` process and describes the account now rather than the stop, which
 * is why it is the fallback; the limit that is full is the one to wait for.
 */
export const resumeAt = async (
  stop: LimitStop,
  now: number,
  readUsage: () => Promise<{ until: number | null }> = async () => ({
    until: fullUntil(await usage()),
  }),
): Promise<number> => {
  let reset = stopResetsAt(stop.text, stop.at)
  if (reset === null) {
    try {
      reset = (await readUsage()).until
    } catch {
      reset = null
    }
  }
  if (reset === null) return now + UNKNOWN_WAIT_MS
  return Math.max(reset + MARGIN_MS, stop.at + MIN_WAIT_MS)
}

export interface ResumeWatcher {
  stop(): void
  /** One look, now; for tests. */
  look(): Promise<void>
}

export const startResumeWatcher = (opts: {
  store: StateStore
  engine: Pick<SessionEngine, 'claudeDirs'>
  onChange: () => void
  /** Seams for tests; both default to the real thing. */
  limitStop?: (cwd: string) => Promise<LimitStop | null>
  when?: (stop: LimitStop, now: number) => Promise<number>
}): ResumeWatcher => {
  const { store, engine, onChange } = opts
  const limitStop = opts.limitStop ?? readLimitStop
  const when = opts.when ?? ((stop, now) => resumeAt(stop, now))

  const look = async (): Promise<void> => {
    // Off parks nothing, and remembers nothing either: a stop seen while off
    // is answered when it is switched on, if the agent is still sitting there.
    if (!store.autoContinue) return
    // The engine is this machine's own, so a linked machine's worktrees are
    // left to that machine, whose own watcher reads its own transcripts.
    for (const { worktreeId, cwd } of engine.claudeDirs()) {
      const stop = await limitStop(cwd)
      if (stop === null || store.hasAnsweredLimitStop(stop.id)) continue
      const now = Date.now()
      const notBefore = await when(stop, now)
      // Recorded in the same synchronous step as the todo, so no save can
      // hold the todo without the record that stops a second one.
      store.answerLimitStop(stop.id)
      store.addTodo({
        id: randomUUID(),
        worktreeId,
        prompt: RESUME_PROMPT,
        createdAt: now,
        queuedAt: now,
        notBefore,
        limitStop: stop.id,
      })
      onChange()
    }
  }

  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void look()
      .catch(() => {
        // Looked at again in fifteen seconds.
      })
      .finally(() => {
        running = false
      })
  }, LOOK_MS)
  timer.unref()

  return { stop: () => clearInterval(timer), look }
}
