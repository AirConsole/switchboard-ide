import type { WorktreeTodo } from '@ide-n-dream/shared'
import type { StateStore } from '../state.js'
import type { SessionEngine } from './engine.js'
import { turnState } from './claude.js'
import { looksLikePrompt } from './attention.js'
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

  /** The first line of the prompt, which is what the box should be showing. */
  const opening = (prompt: string): string =>
    (prompt.split('\n')[0] ?? '').trim().slice(0, 24)

  const send = async (todo: WorktreeTodo, sessionId: string): Promise<void> => {
    // Its own place in the queue, read before the claim below deletes it: the
    // store hands out the live object, so `todo.queuedAt` is gone by the time
    // the restore path wants to put it back.
    const wasQueuedAt = todo.queuedAt
    const prompt = todo.prompt
    /*
     * Claimed and written to disk BEFORE a single byte goes out, and that
     * ordering is the at-most-once decision. A crash between the flush and the
     * write loses the prompt; the other order would send it twice on restart.
     * Typing the same instruction into an agent twice is worse than not typing
     * it, so the loss is the side to err on.
     */
    store.patchTodo(todo.id, { dispatchingAt: Date.now(), queuedAt: undefined })
    /*
     * A failed flush means the claim is not on disk, so nothing may be sent:
     * the whole at-most-once argument rests on the claim outliving a crash.
     */
    try {
      await store.flush()
    } catch {
      store.patchTodo(todo.id, { dispatchingAt: undefined, queuedAt: wasQueuedAt })
      return
    }

    // The human may have deleted it while that write was in flight -- the
    // route is served on this same event loop.
    if (store.todo(todo.id) === undefined) return

    if (!engine.typeInto(sessionId, `${PASTE_START}${prompt}${PASTE_END}`)) {
      // Nothing was written, so nothing was sent: put it back where it was.
      store.patchTodo(todo.id, { dispatchingAt: undefined, queuedAt: wasQueuedAt })
      onChange()
      return
    }

    await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS))

    /*
     * Look before submitting. The paste is in the box or it is not; if the
     * screen does not show it, sending Return would submit whatever *is* there.
     * Verified as "the box is no longer empty" rather than by matching the text,
     * because Claude Code collapses a long paste to `[Pasted text +N lines]`.
     */
    /*
     * Look again before pressing Return, and look harder than "is something
     * there".
     *
     * The check used to be "the box is not empty", which a dialog's selected
     * row satisfies exactly as well as a filled input box does: `❯ 1. Yes`
     * reads as a box containing "1. Yes". So if a permission or trust dialog
     * arrived inside SUBMIT_DELAY_MS -- the paste going into it and vanishing
     * -- the Return answered the dialog, with whatever was preselected. The
     * trust dialog preselects **No, exit**.
     *
     * Now: no dialog on screen, and the box is showing the beginning of this
     * prompt. Anything else and the Return is withheld, which leaves a paste
     * sitting in a box for a human to deal with -- recoverable, unlike a
     * Return.
     */
    const after = await engine.inspect(sessionId)
    const box = after === undefined ? null : inputBox(after.brightTail)
    const start = opening(prompt)
    const landed =
      after !== undefined &&
      !looksLikePrompt(after.tail) &&
      box !== null &&
      (start === '' ? box !== '' : box.includes(start))
    if (!landed) {
      store.patchTodo(todo.id, {
        dispatchingAt: undefined,
        lastError: 'The prompt did not appear in Claude, so it was not submitted. Queue it again?',
      })
      onChange()
      return
    }

    /*
     * If the Return went nowhere the prompt is sitting unsubmitted in the box,
     * and deleting the todo would hide that: the next Return a human presses,
     * possibly hours later and after typing something else in front of it,
     * would send it.
     */
    if (!engine.typeInto(sessionId, SUBMIT)) {
      store.patchTodo(todo.id, {
        dispatchingAt: undefined,
        lastError:
          'The prompt reached Claude but the Return did not. Check its input box before queueing it again.',
      })
      onChange()
      return
    }
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

      // Live, not merely first: a session that died on its own stays in the
      // engine's list, and picking it by map order pinned the queue on
      // `why: 'dead'` while a working Claude sat beside it.
      const session = engine
        .listForWorktree(worktreeId)
        .find((s) => s.kind === 'claude' && s.liveness !== 'dead')
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
      const turn = path === undefined ? 'unknown' : await turnState(path)
      const verdict = readiness({
        ...state,
        turn,
        notBefore: notBefore.get(worktreeId) ?? 0,
      })
      if (!verdict.ready) {
        if (reasons.get(worktreeId) !== verdict.why) {
          // The turn is read from the verdict's own inputs rather than fetched
          // again: as an argument to debug() it was a transcript read on every
          // verdict change, whether or not IDN_DEBUG_DISPATCH was set.
          debug(
            worktreeId,
            `${verdict.why} (quiet ${Date.now() - state.lastOutputAt}ms, human ${
              Date.now() - state.lastUserInputAt
            }ms, turn ${turn})`,
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
