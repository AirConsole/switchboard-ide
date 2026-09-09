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

/** The newest transcript in a directory, or null if there is none. */
const newestTranscript = async (dir: string): Promise<string | null> => {
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
  return newest?.path ?? null
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
export const lastPrompt = async (cwd: string): Promise<string | undefined> => {
  const path = await newestTranscript(transcriptDir(cwd))
  if (path === null) return undefined
  let text: string
  try {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const start = Math.max(0, size - TAIL_BYTES)
      const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))
      await handle.read(buffer, 0, buffer.length, start)
      text = buffer.toString('utf8')
      // A tail cuts the first line in half, and half a line is not JSON.
      if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    // Cheap reject before parsing: most lines are assistant messages.
    if (line === undefined || !line.includes('"last-prompt"')) continue
    try {
      const row: unknown = JSON.parse(line)
      if (typeof row !== 'object' || row === null) continue
      const record = row as { type?: unknown; lastPrompt?: unknown }
      if (record.type !== 'last-prompt' || typeof record.lastPrompt !== 'string') continue
      const prompt = record.lastPrompt.replace(/\s+/g, ' ').trim()
      if (prompt === '') continue
      return prompt.length > PROMPT_MAX ? `${prompt.slice(0, PROMPT_MAX)}\u2026` : prompt
    } catch {
      // A half-written line at the end of a live transcript: keep looking back.
    }
  }
  return undefined
}
