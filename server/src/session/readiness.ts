import type { SessionKind } from '@ide-n-dream/shared'
import { INPUT_BOX, looksBusy, looksLikePrompt } from './attention.js'
import type { TurnState } from './claude.js'

/**
 * Is it safe to type a queued prompt into this session right now?
 *
 * Deliberately a separate question from `attention.ts`, which answers "what
 * label goes on the tile". That one is tuned so tiles do not flicker and so a
 * false "needs you" never happens; this one drives an actuator, and its failure
 * is not a wrong label but a paragraph typed into a running agent -- or, worse,
 * into a dialog, where the trailing Return answers a question the human never
 * saw. Measured against a real Claude in a scratch instance, the trust-folder
 * dialog sits with "No, exit" selected: a stray Return there quits the agent.
 *
 * So this is a whitelist. Every test below must positively pass; anything this
 * module does not recognise counts as "not ready", and the queue simply waits.
 */

/**
 * How long everything here must hold before the first byte is typed.
 *
 * Not WORKING_WINDOW_MS: 900ms is tuned for a label that must not flicker, and
 * borrowing a label's tolerance for something irreversible is a category error.
 * Any output at all restarts this clock.
 */
export const SETTLE_MS = 2500

/** Silence from the human before the keyboard is taken from them. */
export const USER_QUIET_MS = 10_000

/** After sending, before this session is considered again. */
export const COOLDOWN_MS = 5000

export type NotReady =
  | 'not-claude'
  | 'dead'
  | 'no-pty'
  | 'cooling-down'
  | 'output-recent'
  | 'user-typing'
  | 'mid-turn'
  | 'busy'
  | 'needs-you'
  | 'no-input-box'
  | 'draft-in-box'

export type Readiness = { ready: true } | { ready: false; why: NotReady }

export interface ReadinessInput {
  kind: SessionKind
  dead: boolean
  hasPty: boolean
  /** Epoch ms of the last byte the session produced. */
  lastOutputAt: number
  /** Epoch ms of the last byte a browser sent to it. */
  lastUserInputAt: number
  /** The rendered screen, as-is. */
  tail: string
  /** The rendered screen with dim (hint) cells blanked out. */
  brightTail: string
  /** What the transcript says about the last turn. */
  turn: TurnState
  /** Nothing is dispatched to this session before this time. */
  notBefore: number
  now?: number
}

/**
 * The box's contents, or null when no box is on screen.
 *
 * Searched from the bottom, because the transcript above can contain anything,
 * a pasted chevron included. Line by line on purpose: a regex run over the whole
 * tail matches a chevron at the end of one line against the first character of
 * the next -- measured, and it made "did the paste land in the box" answer yes
 * to an empty box sitting above a rule.
 */
export const inputBox = (brightTail: string): string | null => {
  const lines = brightTail.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = INPUT_BOX.exec(lines[index] ?? '')
    if (match) return (match[1] ?? '').trim()
  }
  return null
}

export const readiness = (input: ReadinessInput): Readiness => {
  const now = input.now ?? Date.now()
  const no = (why: NotReady): Readiness => ({ ready: false, why })

  // Never a shell: a queued prompt is for an agent.
  if (input.kind !== 'claude') return no('not-claude')
  if (input.dead) return no('dead')
  // Null during a reattach, where a write is silently dropped.
  if (!input.hasPty) return no('no-pty')
  if (now < input.notBefore) return no('cooling-down')
  if (now - input.lastOutputAt < SETTLE_MS) return no('output-recent')
  // Someone is at this keyboard. Their draft may be in the box, or on its way.
  if (now - input.lastUserInputAt < USER_QUIET_MS) return no('user-typing')

  /*
   * The transcript is the precise signal: it says whether the last thing asked
   * has been answered. `unknown` -- no transcript, or a Claude that does not
   * write turn ends -- is not treated as finished; the screen tests below are
   * what has to carry it then, which is why none of them are skipped when this
   * one passes.
   */
  if (input.turn === 'in-turn') return no('mid-turn')
  if (input.turn === 'unknown' && looksBusy(input.tail)) return no('busy')
  if (input.turn === 'between-turns' && looksBusy(input.tail)) {
    // The transcript says the turn ended but the screen still shows a running
    // timer: a second turn has started, or the repaint has not landed.
    return no('busy')
  }

  // A modal, on the narrow definition attention.ts uses. Its Return is an
  // answer, not a submission.
  if (looksLikePrompt(input.tail)) return no('needs-you')

  const box = inputBox(input.brightTail)
  if (box === null) return no('no-input-box')
  if (box !== '') return no('draft-in-box')
  return { ready: true }
}
