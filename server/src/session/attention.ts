import type { AttentionState, SessionKind } from '@ide-n-dream/shared'
import type { TurnState } from './claude.js'

/** Output newer than this means the agent is actively producing. */
export const WORKING_WINDOW_MS = 900

/**
 * How long after a resize we caused that output is read as a repaint rather
 * than as the agent doing something.
 *
 * Long enough for a full-screen TUI redraw to land through tmux, short enough
 * that an agent genuinely producing output is marked working again on its next
 * chunk. Erring long only delays a "working" label; erring short puts that
 * label on a session that has been resting all along, which is the failure that
 * is actually visible.
 */
export const REPAINT_QUIET_MS = 500

/**
 * Patterns that mean Claude Code is blocked on a human answer.
 *
 * Deliberately narrow. The idle input box also draws a `❯`, so matching a bare
 * chevron would mark every resting session as needing attention -- which would
 * make the overview useless, since a wrong "needs you" is worse than a missing
 * one. These match numbered choice menus and explicit questions only.
 */
/**
 * Patterns that can be looked for across the whole visible screen.
 *
 * Safe there because none of them appear in what Claude *prints*: it bullets
 * its own output with `●` and `⎿`, and the `❯` glyph belongs to the input box
 * and to a dialog's selected row. That matters because a dialog is not
 * bottom-anchored the way it looks -- measured, the option list of a plan
 * approval sat 5 rows up, and a question dialog's sat 11, each option carrying
 * a paragraph. A window of the last 12 rows caught both by luck, and one more
 * line of option text loses them.
 */
const PROMPT_PATTERNS: RegExp[] = [
  // Claude Code's modal dialogs (tool permission, trust folder, /login, ...)
  // all render this footer. Observed verbatim on the trust-folder dialog; the
  // resting input box shows the mode hint instead, so it does not collide.
  /Enter to (?:confirm|select|continue)\b/i,
  /Do you (?:want to|trust)\b/i,
  // Plan approval, verbatim from the dialog ExitPlanMode raises.
  /Would you like to proceed\?/i,
  /shift\+tab to approve\b/i,
  // A numbered choice menu, e.g. "❯ 1. Yes".
  /❯\s*\d+\.\s/,
  /\(y\/n\)/i,
  /Waiting for your input/i,
  /Press\s+(?:enter|y)\b/i,
]

/**
 * Patterns believed only on the last few lines, where a dialog's footer lives.
 *
 * `^1. Yes` used to be in the list above and is gone: it is the kind of line
 * Claude itself writes when it explains options in prose, and it made a
 * finished worktree that had listed "1. Yes, do it that way" read as waiting
 * for an answer. `❯ N.` covers the dialogs it was meant to catch -- every one
 * measured marks its selected row that way -- and the chevron is a glyph Claude
 * never prints.
 */
const PROMPT_FOOTERS: RegExp[] = [/to navigate\b/i, /Esc to cancel\b/i]

/** How many lines from the bottom count as the footer. */
const FOOTER_ROWS = 3

/**
 * Whether Claude is showing something a person has to answer.
 *
 * Give it the whole visible screen: the strong patterns are safe anywhere on
 * it, and the weak ones are only consulted near the bottom.
 */
export const looksLikePrompt = (screen: string): boolean => {
  if (PROMPT_PATTERNS.some((re) => re.test(screen))) return true
  const footer = screen.split('\n').slice(-FOOTER_ROWS).join('\n')
  return PROMPT_FOOTERS.some((re) => re.test(footer))
}

/**
 * The spinner's live timer, which is what a running turn looks like.
 *
 * `✽ Grooving… (8s · ↓ 81 tokens · thinking)` while it works, and when the turn
 * ends the timer leaves the parentheses and gains a clock time:
 * `✻ Cogitated for 3m 34s · done 2:02 PM`. So the parenthesised timer means
 * "still going" -- the obvious guess, an "esc to interrupt" hint, does not
 * exist in this version at all.
 *
 * The minute and hour forms are not decoration. This was `\(\d+s` and so
 * matched `(8s ·` but not `(3m 34s ·`, which made every turn longer than a
 * minute -- most of them, for an agent -- invisible to this check.
 */
const BUSY_TIMER = /\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*·/g

/**
 * The line a finished turn leaves behind: `· done 2:02 PM`.
 *
 * Kept because the screen is a scrollback: every turn Claude has ever finished
 * is still up there, so "is there a timer on screen" has to mean "is there one
 * *after* the last thing that said it had finished".
 */
const DONE_MARKER_G = /·\s*done\s+\d{1,2}:\d{2}/gi
/** The same, without /g: `test` on a global regex carries lastIndex between calls. */
const DONE_MARKER = /·\s*done\s+\d{1,2}:\d{2}/i

/** Where a pattern last matches in `text`, or -1. */
const lastIndexOf = (text: string, re: RegExp): number => {
  let at = -1
  for (const match of text.matchAll(re)) at = match.index
  return at
}

export const looksBusy = (text: string): boolean => {
  const busy = lastIndexOf(text, BUSY_TIMER)
  if (busy === -1) return false
  return busy > lastIndexOf(text, DONE_MARKER_G)
}

/**
 * Claude Code's input box, as a line: the chevron and whatever is in it.
 *
 * The one piece of chrome that is always at the bottom when a session is not
 * showing a dialog, which makes it the boundary between the conversation and
 * the furniture below it.
 */
export const INPUT_BOX = /^\s*[❯>]\s?(.*)$/

/**
 * Lines that are furniture rather than something Claude said.
 *
 * Kept short and named on purpose: everything not listed here counts as a
 * message, and an unrecognised line therefore reads as "something happened
 * after the turn ended" -- which errs towards *working*. That is the safe
 * direction for a queue that types into the agent, and the reason this is a
 * list of what to ignore rather than a list of what to believe.
 */
const CHROME: RegExp[] = [
  // The startup banner and the version line beside it.
  /^\s*[▐▝▜█▛]/,
  /Claude Code v\d/,
  // Standing warnings and hints, which sit above the conversation.
  /^\s*⚠/,
  /\bTip:/,
  // The box's own rules, and the mode hint under it.
  /^[─╌\s]*$/,
  /shift\+tab to cycle/,
]

/**
 * Has Claude finished, on the evidence of the screen alone?
 *
 * `done` -- the last thing above the input box is the line a finished turn
 * leaves behind, `✻ Baked for 2s · done 3:01 PM`.
 * `nothing` -- nothing has been printed at all: a session that has not been
 * asked anything yet, or one just after /clear. Also at rest.
 * `busy` -- something was printed after that line, so a turn is under way.
 *
 * This replaces asking whether the session has been *quiet* for a moment, which
 * is a question about the clock rather than about the agent: a silent stretch
 * inside a turn -- a slow tool, a long think -- answered it "finished".
 */
export const screenState = (screen: string): 'done' | 'nothing' | 'busy' => {
  const lines = screen.split('\n')
  // Everything from the input box down is chrome; the conversation is above it.
  let end = -1
  for (let index = lines.length - 1; index >= 0; index--) {
    if (INPUT_BOX.test(lines[index] ?? '')) {
      end = index
      break
    }
  }
  /*
   * No input box at all is not "nothing has been printed" -- it is "this screen
   * cannot be read", which is what an empty mirror looks like. Answering `done`
   * there is how a session whose repaint never arrived came to show as finished,
   * so it answers `busy` instead and lets the transcript decide.
   */
  if (end === -1) return 'busy'
  for (let index = end - 1; index >= 0; index--) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    if (CHROME.some((re) => re.test(line))) continue
    return DONE_MARKER.test(line) ? 'done' : 'busy'
  }
  return 'nothing'
}

/**
 * Classify a session for the overview grid.
 *
 * Three things, in order of how much they can be trusted: the rendered text in
 * the server-side mirror, Claude's own transcript, and when output last
 * arrived. No hooks are installed and nothing is written into the user's Claude
 * settings.
 *
 * The transcript is the one that used to be missing. It records
 * `{type:"system", subtype:"turn_duration"}` when a turn ends, so "still
 * working" can be a fact rather than an inference from silence -- see
 * `turnState()` in claude.ts. It is read lazily: only a session that looks idle
 * without it costs a file read, so a session that is plainly producing output
 * pays nothing.
 */
export const classify = (opts: {
  kind: SessionKind
  lastOutputAt: number
  dead: boolean
  tailText: () => string
  /**
   * What Claude's transcript says about the last turn, when it has been read.
   *
   * `unknown` for a shell, for a Claude that has never written one, and on the
   * fast path where the answer was obvious without touching the disk.
   */
  turn?: TurnState
  now?: number
}): AttentionState => {
  if (opts.dead) return 'idle'
  const now = opts.now ?? Date.now()
  /*
   * Waiting for a human is decided FIRST, and on the screen rather than on the
   * clock.
   *
   * It used to be reached only after the output had gone quiet, which put it
   * behind the one thing that is never quiet -- a repainting TUI. A dialog is
   * up or it is not; whether Claude happened to redraw a spinner in the last
   * 900ms says nothing about that, and getting it wrong is the failure that
   * costs a person their afternoon.
   */
  // A shell sitting at its prompt is simply idle; only agents "need you".
  if (opts.kind === 'claude' && looksLikePrompt(opts.tailText())) return 'needs-you'
  if (now - opts.lastOutputAt < WORKING_WINDOW_MS) return 'working'
  /*
   * Done is claimed, not assumed.
   *
   * A shell has no turns, so it is idle whenever it is quiet -- that is what a
   * prompt sitting there means. An agent has to have said so: the last thing
   * above its input box is the line a finished turn leaves behind, or it has
   * printed nothing at all yet. Anything else on that line means something
   * happened after the last turn ended, and a session in the middle of a turn
   * is quiet all the time -- a slow tool, a long think, a subagent -- which is
   * exactly what used to read as "finished".
   *
   * The transcript is consulted only to break the remaining tie: a screen this
   * cannot read (an empty mirror, an unfamiliar layout) says `busy`, and the
   * turn record is what stops that from being permanent.
   */
  if (opts.kind !== 'claude') return 'idle'
  /*
   * The transcript wins where it is definite. `in-turn` means a prompt was
   * submitted and no turn end has been written since, which no reading of the
   * screen should be allowed to argue with.
   */
  if (opts.turn === 'in-turn') return 'working'
  const screen = opts.tailText()
  if (looksBusy(screen)) return 'working'
  switch (screenState(screen)) {
    case 'done':
    case 'nothing':
      return 'idle'
    case 'busy':
      // Something came after the last turn ended, or the screen could not be
      // read. Only the turn record can call that finished.
      return opts.turn === 'between-turns' ? 'idle' : 'working'
  }
}
