import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isTask } from '@switchboard/shared'

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
  /* `steer`: said mid-turn, so it follows the task and never replaces it. */
  | { kind: 'prompt'; text: string; steer?: true }
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

/**
 * Machinery around a turn rather than something asked.
 *
 * The harness records several kinds of its own business as `user` records with
 * ordinary string content, each opening with a tag of its own. This used to be
 * a list of three of them and a `startsWith`, and it went stale the way such a
 * list does: a `<task-notification>` -- what arrives when a background task
 * finishes -- was read as a prompt, so a worktree's bar showed 453 characters
 * of `<task-id>`/`<tool-use-id>` XML instead of the "do step 3" its person had
 * typed two minutes earlier.
 *
 * So the test is the shape rather than the names. Surveyed over 120 live
 * transcripts, the tags that reach here are `task-notification`,
 * `local-command-stdout`, `bash-input` and `bash-stdout` (the `!` prefix's own
 * echo, which continues into `<bash-stderr>` and so does not close at the end
 * -- which is why this matches the opening tag and not a whole wrapped block),
 * plus `system-reminder` and `attachment` from before. A slash command opens
 * with a tag too and must survive: `readCommand` runs first and returns it.
 *
 * The cost is a paste that opens with markup -- `<div>...</div>` and a question
 * after it -- which reads as machinery and leaves the previous prompt in the
 * bar. A stale line for one turn, against a bar full of XML.
 */
const INJECTED = /^\s*<[a-z][a-z0-9-]*>/i

/**
 * The words a person types when they turn a tool use down.
 *
 * They do not arrive as a user record at all: the feedback comes back as the
 * rejected tool's own result, phrased for Claude -- "The user doesn't want to
 * proceed with this tool use. The tool use was rejected ... To tell you how to
 * proceed, the user said: <words>". Most often that tool is `ExitPlanMode`, so
 * the newest thing a person said during a planning session is invisible to
 * anything that reads user records only, which is half of why a window showed
 * an instruction two turns old.
 *
 * Anchored at the start of the tool result, and that is the whole of the guard.
 * It used to be the bare phrase anywhere in one, and a tool result is whatever
 * a tool printed: this very file quotes the sentence in the comment above, so
 * an agent that so much as read `claude.ts` had `<words>". So the 197- * newest
 * thing a person said...` in its window -- measured, in the worktree the fix
 * was written in.
 */
const PLAN_FEEDBACK =
  /^The user doesn['\u2019]t want to proceed with this tool use\.[\s\S]*?\bthe user said:\s*([\s\S]+)$/i

/**
 * The wrapper Claude Code puts around a paste, which is not something anyone
 * typed.
 *
 * A pasted prompt is recorded as `<pasted_content id="7b6d">` ... `</pasted_content
 * id="7b6d">` -- the closing tag carries the id too -- while its `last-prompt`
 * beside it is the bare text. The user record is what this reads, so a window
 * showed the tags around the words; measured in the worktree the fix was
 * written in. Only the tags go: the paste is the prompt, and anything typed
 * around it is part of it. `INJECTED` would not have caught it either way,
 * because `_` and the attribute are both outside the shape it tests.
 */
const PASTE_TAG = /<\/?pasted_content(?:\s+id="[^"]*")?\s*>/g

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
const INTERESTING = /"(?:last-prompt|turn_duration|queued_command)"|"type"\s*:\s*"user"/

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
    attachment?: { type?: unknown; commandMode?: unknown; prompt?: unknown }
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
  /*
   * A message sent while Claude was working.
   *
   * It is not a `user` record at all: Claude folds it into the running turn
   * and records it as a `queued_command` attachment, so every "also make it
   * italic" said mid-turn was missing from under the task -- measured in the
   * worktree this was written in. Surveyed over every local transcript: 289 of
   * these in `prompt` mode, none of them also written as a user record, so
   * reading both cannot count one twice. `task-notification` is the other
   * mode, and is machinery like its tag below.
   *
   * Never a task, however long: it was said about the work already running,
   * so it steers that task rather than setting a new one. By the word count
   * alone "the last prompt display should strip the text so newlines at the
   * end are ignored" would have replaced the task it was a remark on.
   */
  if (record.type === 'attachment') {
    const queued = record.attachment
    if (record.isSidechain === true || queued?.type !== 'queued_command') return null
    if (queued.commandMode !== 'prompt' || typeof queued.prompt !== 'string') return null
    const said = queued.prompt.replace(PASTE_TAG, '')
    return said.trim() === '' ? null : { kind: 'prompt', text: said, steer: true }
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
    // The rarer half of the sentence, so a tool result that merely says "the
    // user said" is not parsed at all.
    if (!line.includes('want to proceed with this tool use')) return null
    for (const part of content) {
      const said = (part as { content?: unknown } | null)?.content
      if (typeof said !== 'string') continue
      const words = PLAN_FEEDBACK.exec(said.trim())?.[1]?.trim()
      if (words !== undefined && words !== '') return { kind: 'prompt', text: words }
    }
    return null
  }
  if (typeof content !== 'string') return null
  const said = content.replace(PASTE_TAG, '')
  if (said.trim() === '') return null
  const command = readCommand(said)
  if (command !== null) return { kind: 'prompt', text: command }
  if (INJECTED.test(said)) return null
  return { kind: 'prompt', text: said }
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
 * The whole lines between two offsets, and where the last of them ends.
 *
 * The next incremental read starts exactly there, which is what lets a prompt
 * be counted once. The prompt used to be a single "newest", and re-reading a
 * 64KB overlap to catch a record straddling the boundary cost nothing; with a
 * list of follow-ups the overlap reads every one of them twice. So the read
 * stops at the last newline instead, and a line still being written is left for
 * the next look to read whole. `from` must be the start of a line.
 */
const readLines = async (
  path: string,
  from: number,
  to: number,
): Promise<{ text: string; end: number } | null> => {
  if (to <= from) return { text: '', end: from }
  try {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(to - from)
      await handle.read(buffer, 0, buffer.length, from)
      // Found on the bytes, not the decoded text: a line cut mid-character
      // decodes to a replacement character of a different length.
      const whole = buffer.lastIndexOf(0x0a) + 1
      return { text: buffer.subarray(0, whole).toString('utf8'), end: from + whole }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/** What a worktree's transcript says it was asked. */
export interface PromptSummary {
  /** The newest prompt, whatever it was. */
  prompt?: string
  /** The newest prompt that set a task -- `isTask` -- or the oldest there is. */
  task?: string
  /** The prompts since `task`, oldest first. */
  followUps: string[]
  /**
   * Whether `followUps` had older ones dropped from its front. Always written
   * by `fold`, false included: the incremental read spreads a fold over what
   * it had, and a key left out kept the old `true` after a new task.
   */
  earlierFollowUps?: boolean
}

/**
 * How many follow-ups are kept: the newest three. Runs of them between two
 * tasks, measured over 1,151 prompts: none 318 times, one 155, two 61, three
 * 22, four or more 26. It was six, every ordinary run whole -- but the strip
 * is a reminder of where the work is, not its history, and past three the
 * older ones were only pushing the line onto a second row.
 */
const FOLLOW_UPS_MAX = 3

interface Seen extends PromptSummary {
  path: string
  /** Where the last whole line ends: the next read starts here. */
  size: number
  /** The newest `last-prompt` record, for a session with no real prompt. */
  recorded?: string
}

/**
 * What has already been read, per working directory.
 *
 * Remembered rather than re-derived because a transcript only grows:
 * everything before `size` has been looked at, so the next look reads the new
 * bytes and nothing else. That is what makes this affordable at one poll every
 * couple of seconds per worktree, and it is also what makes it correct -- a
 * prompt is picked up when it is written and kept until a newer task arrives,
 * rather than having to still be inside a window by the time anybody asks.
 */
const prompts = new Map<string, Seen>()

/** A prompt tidied for the few lines a window has for it. */
const tidy = (text: string): string => {
  const prompt = text.replace(/\s+/g, ' ').trim()
  if (prompt === '') return ''
  return prompt.length > PROMPT_MAX ? `${prompt.slice(0, PROMPT_MAX)}…` : prompt
}

/**
 * Every prompt in a block of transcript, oldest first, and separately the
 * newest `last-prompt` record in it.
 *
 * They are kept apart because the second is not to be trusted over the first.
 * `last-prompt` is Claude's own bookkeeping and it is re-stamped every turn with
 * the same prose: measured on one worktree, five copies of "merge and deploy"
 * inside the last 256KB, written long after the `/plan ...` the person had
 * actually typed -- which Claude records as a user message and never writes a
 * `last-prompt` for. So a real record wins whenever there is one, and the
 * bookkeeping is the fallback for a session that has none in reach.
 */
/** A prompt, and whether it was said mid-turn -- see `Mark`. */
interface Said {
  text: string
  steer?: true
}

const setsTask = (said: Said): boolean => said.steer !== true && isTask(said.text)

const promptsIn = (text: string): { real: Said[]; recorded?: string } => {
  const found: { real: Said[]; recorded?: string } = { real: [] }
  for (const line of text.split('\n')) {
    const mark = markOf(line)
    if (mark === null || mark.kind === 'turn-end') continue
    const prompt = tidy(mark.text)
    if (prompt === '') continue
    if (mark.kind === 'prompt') {
      found.real.push(mark.steer ? { text: prompt, steer: true } : { text: prompt })
    }
    else found.recorded = prompt
  }
  return found
}

/**
 * Prompts folded onto what is already known, oldest first.
 *
 * A task replaces the one before it and clears its follow-ups; anything else
 * follows the task it came after. With no task yet the first prompt stands in
 * for one, so a session that opened with `merge origin master` still has a
 * line saying so.
 */
const fold = (into: PromptSummary, real: Said[]): PromptSummary => {
  let { task, followUps } = into
  // Carried across folds, since what was dropped last time is not in `into`.
  let earlier = into.earlierFollowUps === true
  for (const said of real) {
    if (task === undefined || setsTask(said)) {
      task = said.text
      followUps = []
      earlier = false
    } else {
      followUps = [...followUps, said.text]
    }
  }
  if (followUps.length > FOLLOW_UPS_MAX) earlier = true
  return {
    prompt: real.at(-1)?.text ?? into.prompt,
    task,
    earlierFollowUps: earlier,
    followUps: followUps.slice(-FOLLOW_UPS_MAX),
  }
}

const summaryOf = (seen: Seen): PromptSummary => ({
  prompt: seen.prompt ?? seen.recorded,
  task: seen.task ?? seen.recorded,
  followUps: seen.followUps,
  // Only when true, so a worktree without any says nothing on the wire.
  ...(seen.earlierFollowUps === true ? { earlierFollowUps: true } : {}),
})

/**
 * What the user asked Claude in this worktree: the task, what followed it, and
 * the newest prompt of all.
 *
 * Not `ai-title`, which is Claude's own name for the conversation: it is written
 * from the opening subject and does not track where the work went -- measured
 * across six live transcripts, including one titled "Worktree topbar project
 * name" whose last prompt was about mouse-wheel phantom typing an hour later. A
 * title quietly an hour out of date is worse than none in a dispatcher.
 *
 * Nothing here costs a token: it is all already on disk.
 */
export const promptSummary = async (cwd: string): Promise<PromptSummary | undefined> => {
  const newest = await newestTranscript(transcriptDir(cwd))
  if (newest === null) return undefined
  const seen = prompts.get(cwd)

  // The same file, longer than last time: read only what has been added.
  if (seen !== undefined && seen.path === newest.path && newest.size >= seen.size) {
    const read = await readLines(newest.path, seen.size, newest.size)
    if (read === null) return summaryOf(seen)
    const found = promptsIn(read.text)
    const next: Seen = {
      ...seen,
      ...fold(seen, found.real),
      size: read.end,
      recorded: found.recorded ?? seen.recorded,
    }
    prompts.set(cwd, next)
    return summaryOf(next)
  }

  /*
   * A file this has not seen before -- a fresh server, a new conversation, or
   * one that was truncated. Widen the window back from the end until a task
   * turns up, since only one can say what the prompts after it follow.
   */
  let next: Seen = { path: newest.path, size: 0, followUps: [] }
  for (let window = SEED_CHUNK_BYTES; ; window *= 4) {
    const from = Math.max(0, newest.size - window)
    const read = await readLines(newest.path, from, newest.size)
    if (read === null) break
    // Everything up to the first newline is the tail of a line cut in half.
    const text = from > 0 ? read.text.slice(read.text.indexOf('\n') + 1) : read.text
    const found = promptsIn(text)
    next = { ...next, ...fold({ followUps: [] }, found.real), size: read.end, recorded: found.recorded }
    if (found.real.some(setsTask) || from === 0 || window >= SEED_MAX_BYTES) break
  }
  prompts.set(cwd, next)
  return summaryOf(next)
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
const marks = new Map<
  string,
  { path: string; at: number; kind: 'prompt' | 'turn-end' | 'none' }
>()

export const turnState = async (cwd: string, now = Date.now()): Promise<TurnState> => {
  const newest = await newestTranscript(transcriptDir(cwd))
  if (newest === null) return 'unknown'
  const cached = marks.get(cwd)
  let kind: 'prompt' | 'turn-end' | 'none'
  if (cached !== undefined && cached.path === newest.path && cached.at === newest.at) {
    kind = cached.kind
  } else {
    const text = await readTail(newest.path)
    if (text === null) return 'unknown'
    // 'none' is cached too. A tool result bigger than the tail leaves no mark in
    // the window, and not caching that answer meant a full 256KB read plus a
    // directory listing every second, for as long as that transcript stood.
    kind = newestMark(text)?.kind ?? 'none'
    marks.set(cwd, { path: newest.path, at: newest.at, kind })
  }
  if (kind === 'none') return 'unknown'
  if (kind === 'turn-end') return 'between-turns'
  // Nothing has written here in half a minute, so whatever this prompt started
  // is not still going; let the screen answer instead.
  return now - newest.at > IN_TURN_STALE_MS ? 'unknown' : 'in-turn'
}
