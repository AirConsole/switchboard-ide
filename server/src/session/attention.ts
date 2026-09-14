import type { AttentionState, SessionKind } from '@switchboard/shared'
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
 * Patterns that can be looked for anywhere in the turn now under way.
 *
 * Read over the turn's whole height, because a dialog is not bottom-anchored
 * the way it looks -- measured, the option list of a plan approval sat 5 rows
 * up, and a question dialog's sat 11, each option carrying a paragraph. A
 * window of the last 12 rows caught both by luck, and one more line of option
 * text loses them.
 *
 * They are *not* safe over the whole screen, which is where they used to be
 * read. Some of them are ordinary English -- `thisTurn` below has the measured
 * case -- and a screen is a scrollback, so every turn Claude has finished is
 * still on it. The `❯` glyph is the exception either way: it belongs to the
 * input box and to a dialog's selected row, and Claude never prints it.
 *
 * `Do you (want to|trust)` used to head this list and is gone, because scoping
 * to the turn was not enough for it: a dialog that has been *answered* stays on
 * screen inside the same turn, and the phrase is one Claude itself writes.
 * Measured on a live worktree -- an AskUserQuestion reading `How do you want to
 * play the service worker?` was answered at 07:56:33 and the window stayed
 * amber until the turn's done line landed at 07:59:21, three minutes of "needs
 * you" over an agent that was deploying.
 *
 * Deleting it costs nothing, which was measured too, on Claude Code v2.1.270:
 *   - the write-permission dialog says `Do you want to create b.txt?` *and*
 *     draws `❯ 1. Yes`, so `❯ N.` already has it;
 *   - the trust-folder dialog no longer contains the phrase at all -- it asks
 *     `Is this a project you created or one you trust?` over `❯ No, exit`,
 *     which is not even numbered, and is caught by `Enter to confirm`;
 *   - an AskUserQuestion draws `❯ 1. ...` under
 *     `Enter to select · ↑/↓ to navigate · Esc to cancel`, so three of these
 *     patterns hold it up while it is live and none once it is answered.
 */
const PROMPT_PATTERNS: RegExp[] = [
  // Claude Code's modal dialogs (tool permission, trust folder, /login, ...)
  // all render this footer. Observed verbatim on the trust-folder dialog; the
  // resting input box shows the mode hint instead, so it does not collide.
  /Enter to (?:confirm|select|continue)\b/i,
  // Plan approval, verbatim from the dialog ExitPlanMode raises.
  /Would you like to proceed\?/i,
  /shift\+tab to approve\b/i,
  /\(y\/n\)/i,
  /Waiting for your input/i,
  /Press\s+(?:enter|y)\b/i,
]

/**
 * A numbered choice menu's selected row, and one of its other options.
 *
 * `❯ N.` alone used to be the whole test, and it was wrong for a reason the
 * chevron was supposed to rule out: the mirror draws a *submitted user message*
 * as `❯ <text>` too, so a prompt that opens with a numbered item -- "1. fix the
 * parser, 2. then the tests" -- is a chevron, a digit and a full stop, and it
 * sits at the top of the turn, which held the window amber for the whole of it.
 *
 * So a menu has to be more than its selected row: it has to have another option
 * beside it, numbered one away. Measured on Claude Code v2.1.270, all three of
 * the menus this has to catch put that option on the very next line --
 *
 *   permission:  ` ❯ 1. Yes` / `   2. Yes, and switch to accept edits ...`
 *   plan:        ` ❯ 1. Yes, and use auto mode` / `   2. Yes, manually approve`
 *   question:    `❯ 1. Drop the phrase pattern` / `  2. Demote it to a footer`
 *
 * -- and a window of a few lines either side is what makes it tolerant of a
 * description under an option (the plan dialog puts `shift+tab to approve with
 * this feedback` under its third) and of the chevron sitting on the last option
 * rather than the first, without becoming "a numbered line anywhere in the
 * turn". That was tried, as `^1. Yes`, and Claude's own prose about options
 * made a finished worktree read as waiting.
 */
const MENU_ROW = /^\s*❯\s*(\d+)\.\s/
const OPTION_ROW = /^\s*(\d+)\.\s/

/** How far either side of the selected row its siblings are looked for. */
const MENU_SIBLING_ROWS = 4

const hasChevronMenu = (turn: string): boolean => {
  const lines = turn.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const selected = MENU_ROW.exec(lines[index] ?? '')
    if (!selected) continue
    const chosen = Number(selected[1])
    for (let near = index - MENU_SIBLING_ROWS; near <= index + MENU_SIBLING_ROWS; near++) {
      if (near === index) continue
      const option = OPTION_ROW.exec(lines[near] ?? '')
      if (option && Math.abs(Number(option[1]) - chosen) === 1) return true
    }
  }
  return false
}

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
 * The part of the screen belonging to the turn now under way.
 *
 * Everything above the last `· done HH:MM` is a turn that has already ended,
 * and the screen is a scrollback: every turn Claude has ever finished is still
 * up there. That matters because Claude writes prose about what it is doing,
 * and prose collides with the dialogs' wording -- measured on a live worktree,
 * `Which way do you want to go?` matched the tool-permission dialog's
 * `Do you want to ...` and left the tile amber while the agent was visibly
 * working two rows from the bottom, twenty rows below that line. (That pattern
 * is gone now, for a second measured reason the scoping could not fix; the
 * remaining ones are ordinary English too, and this is what keeps them honest.)
 *
 * A dialog Claude is showing *now* is always under the marker, so nothing has
 * to be given up to exclude the text above it -- in particular not the breadth
 * within the turn, which a plan approval's option list needs: measured 11 rows
 * up, with each option carrying a paragraph.
 */
const thisTurn = (screen: string): string => {
  const at = lastIndexOf(screen, DONE_MARKER_G)
  if (at === -1) return screen
  const lineEnd = screen.indexOf('\n', at)
  // A marker with nothing under it: the turn ended and nothing has happened
  // since, so there is nothing here for a person to answer.
  return lineEnd === -1 ? '' : screen.slice(lineEnd + 1)
}

/**
 * Whether Claude is showing something a person has to answer.
 *
 * Give it the whole visible screen: it reads the current turn's whole height,
 * where the strong patterns are safe, and consults the weak ones only near the
 * bottom.
 */
export const looksLikePrompt = (screen: string): boolean => {
  const turn = thisTurn(screen)
  if (hasChevronMenu(turn)) return true
  if (PROMPT_PATTERNS.some((re) => re.test(turn))) return true
  const footer = turn.split('\n').slice(-FOOTER_ROWS).join('\n')
  return PROMPT_FOOTERS.some((re) => re.test(footer))
}

/**
 * Claude Code's input box, as a line: the chevron and whatever is in it.
 *
 * The one piece of chrome that is always at the bottom when a session is not
 * showing a dialog, which makes it the boundary between the conversation and
 * the furniture below it.
 */
export const INPUT_BOX = /^\s*[❯>]\s?(.*)$/

/*
 * Known gap, left open deliberately: a dialog whose options are NOT numbered
 * and which carries none of the footer wordings reads as *finished*, which is
 * the green light rather than merely a grey one. `INPUT_BOX` matches a dialog's
 * selected row (` ❯ Yes, I trust this folder`) exactly as readily as the real
 * box, so `screenState` takes that row for the boundary and reports the done
 * marker above it.
 *
 * Two things were measured trying to close it, and both say not to:
 *
 *   - "a menu row has a sibling indented two columns further" is true of every
 *     dialog measured, and also of a draft too long for one line: at 90 columns
 *     a wrapped draft continues at exactly +2. There is a test for that.
 *   - "the input box is bracketed by `─` rules" is true in every capture, but
 *     the queued-message display (`  ❯ and then deploy`) has no rule above it
 *     either, so treating "no rule" as "menu" trades this gap for a false amber
 *     on every queued prompt.
 *
 * And tightening `screenState` alone would change nothing: `busy` there is
 * settled by the transcript, which says `between-turns` for a session sitting
 * on a picker -- the turn really did end -- so the answer comes back idle
 * regardless. Closing this needs `looksLikePrompt` to recognise an unnumbered
 * menu, and nothing measured so far separates one from the input box. Every
 * unnumbered dialog seen in the wild is held up by its footer instead.
 */

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
 * The glyph that opens one of Claude's blocks: a message, a tool result, or the
 * line a finished turn leaves behind.
 *
 * What follows an opener is its own continuation -- prose wrapped over several
 * indented lines -- and a continuation says nothing about whose block it is.
 * So the opener is what gets read, and the lines under it are skipped until one
 * is found.
 */
const BLOCK_START = /^\s*[●⎿✻✽]/

/**
 * The recap Claude prints when you come back after being away.
 *
 * Furniture, not work: it summarises a turn that has already finished, and it
 * arrives *after* that turn's done line -- so the last thing above the input
 * box is this rather than the marker, and the session read as busy for good.
 * The transcript writes a `{"type":"system","subtype":"away_summary"}` for the
 * same event.
 */
const RECAP = /^\s*●\s*recap:/i

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
  /*
   * Walk up to the nearest block *opener* and let that decide. Reading the
   * nearest non-blank line instead put the verdict on whichever line of prose
   * happened to be last, which is a line that belongs to a block either way --
   * and it is the block that says whether anything happened after the turn.
   */
  let printed = false
  for (let index = end - 1; index >= 0; index--) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    if (CHROME.some((re) => re.test(line))) continue
    printed = true
    // The recap and everything under it is furniture; keep looking above it.
    if (RECAP.test(line)) {
      printed = false
      continue
    }
    if (!BLOCK_START.test(line)) continue
    return DONE_MARKER.test(line) ? 'done' : 'busy'
  }
  // Lines that are neither chrome nor part of any block: a screen this cannot
  // read, which is `busy` for the same reason a missing input box is.
  return printed ? 'busy' : 'nothing'
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
