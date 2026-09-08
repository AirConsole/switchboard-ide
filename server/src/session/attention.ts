import type { AttentionState, SessionKind } from '@ide-n-dream/shared'

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
const PROMPT_PATTERNS: RegExp[] = [
  // Claude Code's modal dialogs (tool permission, trust folder, /login, ...)
  // all render this footer. Observed verbatim on the trust-folder dialog; the
  // resting input box shows the mode hint instead, so it does not collide.
  /Enter to confirm/i,
  /Do you (?:want to|trust)\b/i,
  // A numbered choice menu, e.g. "❯ 1. Yes".
  /❯\s*\d+\.\s/,
  /^\s*1\.\s*Yes\b/im,
  /\(y\/n\)/i,
  /Waiting for your input/i,
  /Press\s+(?:enter|y)\b/i,
]

export const looksLikePrompt = (text: string): boolean =>
  PROMPT_PATTERNS.some((re) => re.test(text))

/**
 * Classify a session for the overview grid.
 *
 * Derived from two things we already have: when output last arrived, and the
 * rendered text sitting in the server-side mirror. No hooks are installed and
 * nothing is written into the user's Claude settings.
 *
 * A future refinement is Claude's own transcript at
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, which records
 * `{type:"system", subtype:"turn_duration"|"stop_hook_summary"}` when a turn
 * ends -- a precise "done" signal rather than an inferred one. Not wired up yet;
 * `idle` is currently inferred from output silence.
 */
export const classify = (opts: {
  kind: SessionKind
  lastOutputAt: number
  dead: boolean
  tailText: () => string
  now?: number
}): AttentionState => {
  if (opts.dead) return 'idle'
  const now = opts.now ?? Date.now()
  if (now - opts.lastOutputAt < WORKING_WINDOW_MS) return 'working'
  // A shell sitting at its prompt is simply idle; only agents "need you".
  if (opts.kind === 'claude' && looksLikePrompt(opts.tailText())) return 'needs-you'
  return 'idle'
}
