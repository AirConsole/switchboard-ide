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

/** The newest transcript in a directory, with its mtime, or null. */
const newestTranscript = async (dir: string): Promise<{ path: string; at: number } | null> => {
  let newest: { path: string; at: number } | null = null
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
      if (newest === null || info.mtimeMs > newest.at) newest = { path, at: info.mtimeMs }
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
  // An array is tool results; only a string is something a person sent.
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

export const lastPrompt = async (cwd: string): Promise<string | undefined> => {
  const newest = await newestTranscript(transcriptDir(cwd))
  if (newest === null) return undefined
  const text = await readTail(newest.path)
  if (text === null) return undefined
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (line === undefined) continue
    const mark = markOf(line)
    // Either kind carries the text; `last-prompt` is the record written for
    // exactly this purpose.
    if (mark === null || mark.kind === 'turn-end') continue
    const prompt = mark.text.replace(/\s+/g, ' ').trim()
    if (prompt === '') continue
    return prompt.length > PROMPT_MAX ? `${prompt.slice(0, PROMPT_MAX)}\u2026` : prompt
  }
  return undefined
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
