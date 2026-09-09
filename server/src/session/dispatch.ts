import type { WorktreeTodo } from '@ide-n-dream/shared'
import type { StateStore } from '../state.js'
import type { SessionEngine } from './engine.js'
import { turnState } from './claude.js'
import { COOLDOWN_MS, inputBox, readiness, type NotReady } from './readiness.js'

/**
 * Types queued todos into the Claude they are queued against.
 *
 * A clock, not an event: a session that goes quiet and stays quiet emits
 * nothing further, so there is no change to subscribe to. It runs whether or
 * not a browser is connected -- that is the whole point of the queue being
 * here rather than in the client -- so it must be cheap, and it is: a tick with
 * nothing queued does no work at all beyond a map lookup.
 */
const TICK_MS = 1000

/**
 * How long the prompt is given to appear in the box before the Return is sent.
 *
 * Split on purpose. A Return concatenated onto the paste is a Return you cannot
 * take back if the screen turns out not to be what you thought; sent
 * separately, it can be withheld -- a paste sitting unsent in the input box is
 * recoverable by a human, and a Return on the wrong screen is not.
 */
const SUBMIT_DELAY_MS = 250

/** Bracketed paste, so a multi-line prompt arrives as one prompt. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** What xterm.js sends for Enter, and therefore what Claude Code submits on. */
const SUBMIT = '\r'

export interface Dispatcher {
  stop(): void
  /** For tests and logging: why each queued todo did not go on the last tick. */
  lastReason(worktreeId: string): NotReady | 'no-session' | 'sent' | undefined
}

/**
 * `IDN_DEBUG_DISPATCH=1` prints every verdict change, which is how the
 * predicate was checked against a real Claude before it was allowed to type.
 * Only on a change, so a session waiting five minutes prints one line.
 */
const debug = (worktreeId: string, verdict: string): void => {
  if (process.env.IDN_DEBUG_DISPATCH) {
    // eslint-disable-next-line no-console
    console.log(`[dispatch] ${new Date().toISOString()} ${worktreeId} ${verdict}`)
  }
}

export const startDispatcher = (opts: {
  store: StateStore
  engine: SessionEngine
  onChange: () => void
  /** Absolute path of a worktree, for reading its transcript. */
  pathFor: (worktreeId: string) => Promise<string | undefined>
}): Dispatcher => {
  const { store, engine, onChange, pathFor } = opts

  /*
   * A todo that was in flight when the process died.
   *
   * It is never re-queued: the claim is written to disk before the first byte
   * goes out, so "we may have sent it" can only be read as "we did". It is
   * handed back to the human with the reason instead, since they can see
   * whether Claude got it and press RUN NEXT again if it did not.
   */
  for (const todo of store.todos) {
    if (todo.dispatchingAt === undefined) continue
    store.patchTodo(todo.id, {
      dispatchingAt: undefined,
      queuedAt: undefined,
      lastError:
        'This was being sent to Claude when the server stopped, so it was left alone. Check Claude, then queue it again if it never arrived.',
    })
  }
  /** One dispatch at a time per worktree; a slow tick must not overlap itself. */
  const inFlight = new Set<string>()
  const notBefore = new Map<string, number>()
  const reasons = new Map<string, NotReady | 'no-session' | 'sent'>()

  /** The head of a worktree's queue: the todo whose RUN NEXT was pressed first. */
  const head = (worktreeId: string): WorktreeTodo | undefined =>
    store.todos
      .filter(
        (t) =>
          t.worktreeId === worktreeId && t.queuedAt !== undefined && t.dispatchingAt === undefined,
      )
      .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))[0]

  const send = async (todo: WorktreeTodo, sessionId: string): Promise<void> => {
    /*
     * Claimed and written to disk BEFORE a single byte goes out, and that
     * ordering is the at-most-once decision. A crash between the flush and the
     * write loses the prompt; the other order would send it twice on restart.
     * Typing the same instruction into an agent twice is worse than not typing
     * it, so the loss is the side to err on.
     */
    store.patchTodo(todo.id, { dispatchingAt: Date.now(), queuedAt: undefined })
    await store.flush()

    if (!engine.typeInto(sessionId, `${PASTE_START}${todo.prompt}${PASTE_END}`)) {
      // Nothing was written, so nothing was sent: put it back where it was.
      store.patchTodo(todo.id, { dispatchingAt: undefined, queuedAt: todo.queuedAt })
      return
    }

    await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS))

    /*
     * Look before submitting. The paste is in the box or it is not; if the
     * screen does not show it, sending Return would submit whatever *is* there.
     * Verified as "the box is no longer empty" rather than by matching the text,
     * because Claude Code collapses a long paste to `[Pasted text +N lines]`.
     */
    const after = await engine.inspect(sessionId)
    const box = after === undefined ? null : inputBox(after.brightTail)
    if (box === null || box === '') {
      store.patchTodo(todo.id, {
        dispatchingAt: undefined,
        lastError: 'The prompt did not appear in Claude, so it was not submitted. Queue it again?',
      })
      onChange()
      return
    }

    engine.typeInto(sessionId, SUBMIT)
    store.removeTodo(todo.id)
    notBefore.set(todo.worktreeId, Date.now() + COOLDOWN_MS)
    onChange()
  }

  const tick = async (): Promise<void> => {
    const queued = new Set(
      store.todos.filter((t) => t.queuedAt !== undefined).map((t) => t.worktreeId),
    )
    for (const worktreeId of queued) {
      if (inFlight.has(worktreeId)) continue
      const todo = head(worktreeId)
      if (!todo) continue

      const session = engine.listForWorktree(worktreeId).find((s) => s.kind === 'claude')
      if (!session) {
        if (reasons.get(worktreeId) !== 'no-session') debug(worktreeId, 'no-session')
        reasons.set(worktreeId, 'no-session')
        continue
      }
      const state = await engine.inspect(session.id)
      if (!state) {
        reasons.set(worktreeId, 'no-session')
        continue
      }
      const path = await pathFor(worktreeId)
      const verdict = readiness({
        ...state,
        turn: path === undefined ? 'unknown' : await turnState(path),
        notBefore: notBefore.get(worktreeId) ?? 0,
      })
      if (!verdict.ready) {
        if (reasons.get(worktreeId) !== verdict.why) {
          debug(
            worktreeId,
            `${verdict.why} (quiet ${Date.now() - state.lastOutputAt}ms, human ${
              Date.now() - state.lastUserInputAt
            }ms, turn ${path === undefined ? 'no-path' : await turnState(path)})`,
          )
        }
        reasons.set(worktreeId, verdict.why)
        continue
      }
      debug(worktreeId, 'ready')

      inFlight.add(worktreeId)
      reasons.set(worktreeId, 'sent')
      try {
        await send(todo, session.id)
      } finally {
        inFlight.delete(worktreeId)
      }
    }
  }

  let running = false
  const timer = setInterval(() => {
    // Overlapping runs are dropped rather than queued: a tick that reads five
    // transcripts can outlast the interval, and piling up would only make the
    // next one slower.
    if (running) return
    running = true
    void tick()
      .catch(() => {
        // A todo that could not be considered this second is considered next
        // second; nothing here is worth taking the server down for.
      })
      .finally(() => {
        running = false
      })
  }, TICK_MS)
  timer.unref()

  return {
    stop: () => clearInterval(timer),
    lastReason: (worktreeId) => reasons.get(worktreeId),
  }
}
