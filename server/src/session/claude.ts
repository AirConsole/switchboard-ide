import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The directory Claude Code keeps a working directory's transcripts in.
 *
 * Claude encodes the absolute path by replacing every `/` and every `.` with
 * `-`, so `/home/a/src/x/.claude/worktrees/y` becomes
 * `-home-a-src-x--claude-worktrees-y`. The mapping is lossy -- a path that
 * already contains `-` is indistinguishable from one that had a `/` there --
 * but it is deterministic, which is all an existence check needs.
 */
export const transcriptDir = (cwd: string): string =>
  join(homedir(), '.claude', 'projects', resolve(cwd).replace(/[/.]/g, '-'))

/**
 * Whether Claude has ever held a conversation in this directory.
 *
 * Asked so that a worktree being woken can be handed `--continue` only when
 * there is something to continue. Passing it blindly would make Claude exit
 * immediately in a worktree it has never run in, and the tile would come back
 * from sleep already dead.
 */
export const hasTranscript = async (cwd: string): Promise<boolean> => {
  try {
    const entries = await readdir(transcriptDir(cwd))
    return entries.some((entry) => entry.endsWith('.jsonl'))
  } catch {
    // No directory at all: Claude has never run here.
    return false
  }
}

/**
 * Arguments for starting Claude in a worktree.
 *
 * `--continue` is "continue the most recent conversation in the current
 * directory", which is exactly what waking a sleeping worktree means: the
 * conversation was not abandoned, its process was stopped to give back the
 * machine. There is no session id to remember -- sleeping kills the tmux
 * session and tmux is where session metadata lives -- so the transcript on
 * disk is what carries the fact that there is anything to resume.
 */
export const claudeArgs = async (cwd: string, resumeIfPossible: boolean): Promise<string[]> =>
  resumeIfPossible && (await hasTranscript(cwd)) ? ['--continue'] : []

/**
 * How much of a transcript's tail to read looking for the last prompt.
 *
 * Transcripts run to megabytes -- every assistant message, every tool result --
 * and this is read for every worktree on every poll, so it reads the end of the
 * file rather than the file. Claude writes a `last-prompt` line after each turn,
 * so the newest one is within the last turn's worth of output; 256KB is several
 * turns even when they are full of tool results.
 */
const TAIL_BYTES = 256 * 1024

/** Longer than any tile can show, short enough that the wire stays small. */
const PROMPT_MAX = 300

/** The newest transcript in a directory, with its mtime and size, or null. */
const newestTranscript = async (
  dir: string,
): Promise<{ path: string; at: number; size: number } | null> => {
  let newest: { path: string; at: number; size: number } | null = null
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue
    const path = join(dir, entry)
    try {
      const info = await stat(path)
      if (newest === null || info.mtimeMs > newest.at) {
        newest = { path, at: info.mtimeMs, size: info.size }
      }
    } catch {
      // Vanished between the listing and the stat; there is nothing to compare.
    }
  }
  return newest
}

/**
 * The last thing the user asked Claude in this worktree.
 *
 * Claude Code writes two candidates into the transcript, and this is
 * deliberately the second of them. `ai-title` is Claude's own name for the
 * conversation, but it is written from its opening subject and does not track
 * where the work went -- measured across six live transcripts, including one
 * titled "Worktree topbar project name" whose last prompt was about mouse-wheel
 * phantom typing an hour later. A title that is quietly an hour out of date is
 * worse than none in a dispatcher. `last-prompt` is rewritten every turn, and
 * it is in the user's own words, which is what you recognise fastest.
 *
 * Neither costs anything to read: both are already on disk, so nothing here
 * asks Claude a question or spends a token.
 *
 * Whitespace is collapsed because this lands on one line of a window's bar, and
 * a prompt is often several paragraphs.
 */
/**
 * A byte range of a file as text, whole lines only, or null.
 *
 * A range that does not start at the beginning starts mid-line, and half a line
 * is not JSON, so the first partial line is dropped.
 */
const readRange = async (path: string, from: number, to: number): Promise<string | null> => {
  if (to <= from) return ''
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(to - from)
      await handle.read(buffer, 0, buffer.length, from)
      const text = buffer.toString('utf8')
      return from > 0 ? text.slice(text.indexOf('\n') + 1) : text
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/** The last TAIL_BYTES of a file as text, whole lines only, or null. */
const readTail = async (path: string): Promise<string | null> => {
  try {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const start = Math.max(0, size - TAIL_BYTES)
      const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))
      await handle.read(buffer, 0, buffer.length, start)
      const text = buffer.toString('utf8')
      // A tail cuts the first line in half, and half a line is not JSON.
      return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * One transcript line, as far as "what is this conversation doing" cares.
 *
 * `prompt` is a human turn beginning, `turn-end` is Claude finishing one, and
 * everything else -- assistant messages, tool results, attachments, mode
 * records -- is neither.
 */
/**
 * Something in a transcript that says where a turn stands, or what was asked.
 *
 * `recorded-prompt` is the `{"type":"last-prompt"}` bookkeeping record, and it
 * is a separate kind from `prompt` because it does not mean what it looks like:
 * it carries the text of the last prompt, which is exactly what the tile's bar
 * wants, but it is *not* evidence that a turn is running. Measured on the files
 * worktree: coming back after being away wrote one seven records after that
 * turn's `turn_duration`, so a detector that took it for a submission had the
 * agent mid-turn forever. Only a real `user` record means someone asked
 * something.
 */
type Mark =
  | { kind: 'prompt'; text: string }
  | { kind: 'recorded-prompt'; text: string }
  | { kind: 'turn-end' }
  | null

/**
 * A slash command, written back the way it was typed.
 *
 * Claude records `/plan foo` as an XML block rather than as prose, and -- this
 * is the part that matters -- writes **no `last-prompt` entry for it at all**.
 * Measured in a live transcript: `last-prompt` read "commit and merge", then
 * the `/plan` arrived as a user message, and the next `last-prompt` was already
 * the prompt after it. So a window showed the previous instruction for the
 * whole of a plan, and the turn looked, to anything reading turn boundaries,
 * like it had never started.
 */
const COMMAND = /<command-name>([^<]*)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

/** Wrappers that are machinery around a turn rather than something asked. */
const NOT_A_PROMPT = ['<local-command-stdout>', '<system-reminder>', '<attachment>']

/**
 * The words a person types into a plan-mode dialog.
 *
 * They do not arrive as a user record at all: plan feedback comes back as the
 * `ExitPlanMode` tool's own result, phrased for Claude -- "The user doesn't want
 * to proceed ... To tell you how to proceed, the user said: <words>". So the
 * newest thing a person said during a planning session is invisible to anything
 * that reads user records only, which is half of why a window showed an
 * instruction two turns old.
 */
const PLAN_FEEDBACK = /the user said:\s*([\s\S]+)$/i

const readCommand = (content: string): string | null => {
  const name = COMMAND.exec(content)
  if (!name) return null
  const args = COMMAND_ARGS.exec(content)?.[1]?.trim() ?? ''
  const label = (name[1] ?? '').trim()
  if (label === '') return null
  return args === '' ? label : `${label} ${args}`
}

/*
 * Cheap rejects before parsing: most lines are assistant messages or tool
 * results, and this runs for every worktree on every poll.
 *
 * Tolerant of whitespace rather than matching `"type":"user"` literally. Claude
 * writes compact JSON, so the literal worked -- and then failed on the first
 * fixture written by anything else, which is a poor way to find out that a
 * pre-filter is really a parser.
 */
const INTERESTING = /"(?:last-prompt|turn_duration)"|"type"\s*:\s*"user"/

const markOf = (line: string): Mark => {
  if (!INTERESTING.test(line)) return null
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    // A half-written last line in a live transcript.
    return null
  }
  if (typeof row !== 'object' || row === null) return null
  const record = row as {
    type?: unknown
    subtype?: unknown
    lastPrompt?: unknown
    isMeta?: unknown
    isSidechain?: unknown
    message?: { content?: unknown }
  }
  if (record.subtype === 'turn_duration') return { kind: 'turn-end' }
  if (record.type === 'last-prompt') {
    if (typeof record.lastPrompt !== 'string' || record.lastPrompt === '') return null
    return { kind: 'recorded-prompt', text: record.lastPrompt }
  }
  if (record.type !== 'user') return null
  // A subagent's own transcript, or something the harness injected.
  if (record.isMeta === true || record.isSidechain === true) return null
  const content = record.message?.content
  /*
   * An array is tool results -- with one exception worth digging out, which is
   * a person's answer to a plan. The substring test comes first because a tool
   * result can be hundreds of kilobytes and this runs over every line of a
   * megabyte-scale scan.
   */
  if (Array.isArray(content)) {
    if (!line.includes('the user said')) return null
    for (const part of content) {
      const said = (part as { content?: unknown } | null)?.content
      if (typeof said !== 'string') continue
      const words = PLAN_FEEDBACK.exec(said)?.[1]?.trim()
      if (words !== undefined && words !== '') return { kind: 'prompt', text: words }
    }
    return null
  }
  if (typeof content !== 'string' || content.trim() === '') return null
  const command = readCommand(content)
  if (command !== null) return { kind: 'prompt', text: command }
  if (NOT_A_PROMPT.some((wrapper) => content.startsWith(wrapper))) return null
  return { kind: 'prompt', text: content }
}

/**
 * The newest thing in a transcript tail that says what the turn is doing.
 *
 * `recorded-prompt` is skipped: see `Mark`. It is written when a prompt is
 * submitted *and* on other occasions -- returning from away, at least -- so as
 * a turn marker it is only ever a chance to be wrong.
 */
const newestMark = (text: string): { kind: 'prompt' | 'turn-end' } | null => {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (line === undefined) continue
    const mark = markOf(line)
    if (mark === null || mark.kind === 'recorded-prompt') continue
    return mark
  }
  return null
}

/**
 * How much of a transcript a first look reads at a time, and how far back it is
 * willing to go before giving up.
 *
 * Both are about one measured session: a worktree 857KB of tool output past the
 * last thing its human had said. The window doubles out from the end until a
 * real prompt turns up, so an ordinary session pays one 256KB read and a busy
 * one pays a few, once.
 */
const SEED_CHUNK_BYTES = 256 * 1024
const SEED_MAX_BYTES = 8 * 1024 * 1024

/**
 * Enough overlap that a record straddling the last read is not lost.
 *
 * The incremental read starts where the previous one stopped, and a range that
 * starts mid-line drops that line -- so without an overlap a prompt written
 * across the boundary would be skipped once and then never looked at again.
 */
const OVERLAP_BYTES = 64 * 1024

/**
 * What has already been read, per working directory.
 *
 * The prompt is remembered rather than re-derived because a transcript only
 * grows: everything before `size` has been looked at, so the next look reads
 * the new bytes and nothing else. That is what makes this affordable at one
 * poll every couple of seconds per worktree, and it is also what makes it
 * correct -- a prompt is picked up when it is written and kept until a newer
 * one arrives, rather than having to still be inside a window by the time
 * anybody asks.
 */
const prompts = new Map<string, { path: string; size: number; prompt: string | undefined }>()

/** A prompt tidied for the one line of a window's bar that shows it. */
const tidy = (text: string): string => {
  const prompt = text.replace(/\s+/g, ' ').trim()
  if (prompt === '') return ''
  return prompt.length > PROMPT_MAX ? `${prompt.slice(0, PROMPT_MAX)}\u2026` : prompt
}

/**
 * The newest prompt in a block of transcript, and separately the newest
 * `last-prompt` record in it.
 *
 * They are kept apart because the second is not to be trusted over the first.
 * `last-prompt` is Claude's own bookkeeping and it is re-stamped every turn with
 * the same prose: measured on one worktree, five copies of "merge and deploy"
 * inside the last 256KB, written long after the `/plan ...` the person had
 * actually typed -- which Claude records as a user message and never writes a
 * `last-prompt` for. So a real record wins whenever there is one, and the
 * bookkeeping is the fallback for a session that has none in reach.
 */
const promptsIn = (text: string): { real?: string; recorded?: string } => {
  const lines = text.split('\n')
  const found: { real?: string; recorded?: string } = {}
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (line === undefined) continue
    const mark = markOf(line)
    if (mark === null || mark.kind === 'turn-end') continue
    const prompt = tidy(mark.text)
    if (prompt === '') continue
    if (mark.kind === 'prompt') return { ...found, real: prompt }
    found.recorded ??= prompt
  }
  return found
}

/**
 * The last thing the user asked Claude in this worktree.
 *
 * Not `ai-title`, which is Claude's own name for the conversation: it is written
 * from the opening subject and does not track where the work went -- measured
 * across six live transcripts, including one titled "Worktree topbar project
 * name" whose last prompt was about mouse-wheel phantom typing an hour later. A
 * title quietly an hour out of date is worse than none in a dispatcher.
 *
 * Nothing here costs a token: it is all already on disk.
 */
export const lastPrompt = async (cwd: string): Promise<string | undefined> => {
  const newest = await newestTranscript(transcriptDir(cwd))
  if (newest === null) return undefined
  const seen = prompts.get(cwd)

  // The same file, longer than last time: read only what has been added.
  if (seen !== undefined && seen.path === newest.path && newest.size >= seen.size) {
    const from = Math.max(0, seen.size - OVERLAP_BYTES)
    const text = await readRange(newest.path, from, newest.size)
    const found = text === null ? {} : promptsIn(text)
    const prompt = found.real ?? seen.prompt ?? found.recorded
    prompts.set(cwd, { path: newest.path, size: newest.size, prompt })
    return prompt
  }

  /*
   * A file this has not seen before -- a fresh server, a new conversation, or
   * one that was truncated. Walk backwards until a real prompt turns up.
   */
  let real: string | undefined
  let recorded: string | undefined
  for (let window = SEED_CHUNK_BYTES; ; window *= 4) {
    const from = Math.max(0, newest.size - window)
    const text = await readRange(newest.path, from, newest.size)
    if (text === null) break
    const found = promptsIn(text)
    recorded ??= found.recorded
    if (found.real !== undefined) {
      real = found.real
      break
    }
    if (from === 0 || window >= SEED_MAX_BYTES) break
  }
  const prompt = real ?? recorded
  prompts.set(cwd, { path: newest.path, size: newest.size, prompt })
  return prompt
}


/**
 * Where a worktree's conversation stands: has the last thing asked been
 * answered?
 *
 * A `user` record with prose in it is someone asking something, and
 * `{"type":"system","subtype":"turn_duration",...}` is the turn it started
 * ending. Whichever is nearer the end of the transcript says which side of a
 * turn the agent is on. `last-prompt` is deliberately not consulted here -- see
 * `Mark` for the measurement that took it out -- a precise "it has finished" rather than the
 * silence-based guess `attention.ts` makes for the tile's label, and exactly the
 * refinement that file's own comment names.
 *
 * Measured against a live session: two turns for one prompt (a background shell
 * finished and produced a second turn) each closed with their own
 * `turn_duration`, and both landed after the prompt that caused them.
 *
 * `unknown` means the transcript cannot answer -- no file, or one from a Claude
 * that does not write those entries -- and the caller must fall back to
 * something it can see for itself rather than treating it as "finished".
 */
export type TurnState = 'between-turns' | 'in-turn' | 'unknown'

/**
 * How recently the transcript must have been written for "a turn is running" to
 * still be believable.
 *
 * A turn in progress writes constantly -- every assistant message and every
 * tool result -- so a file untouched for this long is not describing anything
 * that is still happening. Without this, a transcript left behind by a Claude
 * that was killed mid-turn says "in-turn" forever and the queue behind it never
 * moves: measured, on a worktree whose previous session had been killed.
 */
const IN_TURN_STALE_MS = 30_000

/**
 * The last mark read from a transcript, by directory.
 *
 * The tail read is skipped while the file has not moved, which is most of the
 * time: this is asked of every quiet agent every couple of seconds, and a
 * transcript only grows when something happens. The staleness rule below is
 * still applied fresh each time, since that depends on the clock rather than on
 * the file.
 */
const marks = new Map<string, { path: string; at: number; kind: 'prompt' | 'turn-end' }>()

export const turnState = async (cwd: string, now = Date.now()): Promise<TurnState> => {
  const newest = await newestTranscript(transcriptDir(cwd))
  if (newest === null) return 'unknown'
  const cached = marks.get(cwd)
  let kind: 'prompt' | 'turn-end'
  if (cached !== undefined && cached.path === newest.path && cached.at === newest.at) {
    kind = cached.kind
  } else {
    const text = await readTail(newest.path)
    if (text === null) return 'unknown'
    const mark = newestMark(text)
    if (mark === null) return 'unknown'
    kind = mark.kind
    marks.set(cwd, { path: newest.path, at: newest.at, kind })
  }
  if (kind === 'turn-end') return 'between-turns'
  // Nothing has written here in half a minute, so whatever this prompt started
  // is not still going; let the screen answer instead.
  return now - newest.at > IN_TURN_STALE_MS ? 'unknown' : 'in-turn'
}
