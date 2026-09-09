import { readdir } from 'node:fs/promises'
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
