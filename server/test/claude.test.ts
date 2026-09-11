import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeArgs, hasTranscript, lastPrompt, transcriptDir, turnState } from '../src/session/claude.js'

/*
 * `transcriptDir` reads `homedir()`, which on POSIX is `$HOME`, so pointing
 * HOME at a temp directory is what lets these run against transcripts of our
 * own rather than the user's -- who has live ones in exactly this place.
 */
let home: string
let realHome: string | undefined

/**
 * A different working directory per test.
 *
 * `lastPrompt` and `turnState` both memoise by cwd for the life of the process,
 * which is the whole point of them -- a transcript only grows, so the next look
 * reads the new bytes and nothing else. Sharing a cwd between tests would mean
 * one test's cached answer deciding the next one's.
 */
let seq = 0
const freshCwd = (): string => `/work/tree-${++seq}`

const writeTranscript = async (cwd: string, name: string, lines: unknown[]): Promise<string> => {
  const dir = transcriptDir(cwd)
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
  return path
}

/** A user turn, as Claude Code records one. */
const userSays = (text: string): unknown => ({ type: 'user', message: { content: text } })

/** The record a turn ending writes. */
const TURN_END = { type: 'system', subtype: 'turn_duration', durationMs: 1234 }

beforeEach(async () => {
  realHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), 'swb-home-'))
  process.env.HOME = home
})

afterEach(async () => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  await rm(home, { recursive: true, force: true })
})

describe('transcriptDir', () => {
  it('encodes a path the way Claude Code does', () => {
    // Every `/` and every `.` becomes `-`, so
    // `/home/a/src/x/.claude/worktrees/y` -> `-home-a-src-x--claude-worktrees-y`.
    expect(transcriptDir('/home/a/src/x/.claude/worktrees/y')).toBe(
      join(home, '.claude', 'projects', '-home-a-src-x--claude-worktrees-y'),
    )
  })
})

describe('hasTranscript', () => {
  it('is false where Claude has never run', async () => {
    expect(await hasTranscript(freshCwd())).toBe(false)
  })

  it('is true once there is a .jsonl in the directory', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [userSays('hello')])
    expect(await hasTranscript(cwd)).toBe(true)
  })

  it('ignores a directory holding something that is not a transcript', async () => {
    const cwd = freshCwd()
    await mkdir(transcriptDir(cwd), { recursive: true })
    await writeFile(join(transcriptDir(cwd), 'notes.txt'), 'x')
    expect(await hasTranscript(cwd)).toBe(false)
  })
})

describe('claudeArgs', () => {
  it('passes --continue only where there is a conversation to continue', async () => {
    /*
     * Passing it blindly makes Claude exit immediately in a worktree it has
     * never run in, and the window comes back from sleep already dead.
     */
    const fresh = freshCwd()
    expect(await claudeArgs(fresh, true)).toEqual([])
    await writeTranscript(fresh, 'a.jsonl', [userSays('hello')])
    expect(await claudeArgs(fresh, true)).toEqual(['--continue'])
    expect(await claudeArgs(fresh, false)).toEqual([])
  })
})

describe('lastPrompt', () => {
  it('reads the newest thing the user asked', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays('the first thing'),
      TURN_END,
      userSays('the second thing'),
    ])
    expect(await lastPrompt(cwd)).toBe('the second thing')
  })

  it('collapses whitespace onto the one line a window has for it', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [userSays('do this\n\n  and   then that')])
    expect(await lastPrompt(cwd)).toBe('do this and then that')
  })

  it('truncates a prompt that runs past what a window can show', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [userSays('x'.repeat(500))])
    const prompt = await lastPrompt(cwd)
    expect(prompt).toHaveLength(301)
    expect(prompt?.endsWith('…')).toBe(true)
  })

  it('writes a slash command back the way it was typed', async () => {
    /*
     * Claude records `/plan foo` as an XML block and writes no `last-prompt`
     * for it at all, so a window showed the previous instruction for the whole
     * of a plan.
     */
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays('<command-name>/plan</command-name><command-args>rework the bar</command-args>'),
    ])
    expect(await lastPrompt(cwd)).toBe('/plan rework the bar')
  })

  it('writes a bare slash command back without trailing space', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays('<command-name>/clear</command-name><command-args></command-args>'),
    ])
    expect(await lastPrompt(cwd)).toBe('/clear')
  })

  it('skips the machinery the harness records as user records', async () => {
    /*
     * A `<task-notification>` was read as a prompt, so a worktree's bar showed
     * 453 characters of `<task-id>`/`<tool-use-id>` XML instead of the "do step
     * 3" its person had typed two minutes earlier. The test is the shape rather
     * than a list of names.
     */
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays('do step 3'),
      userSays('<task-notification><task-id>abc</task-id></task-notification>'),
      userSays('<system-reminder>be good</system-reminder>'),
      userSays('<local-command-stdout>ok</local-command-stdout>'),
      userSays('<bash-input>ls</bash-input>'),
    ])
    expect(await lastPrompt(cwd)).toBe('do step 3')
  })

  it('skips a subagent’s own records and the harness’s meta ones', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays('the real thing'),
      { type: 'user', isSidechain: true, message: { content: 'a subagent prompt' } },
      { type: 'user', isMeta: true, message: { content: 'some meta note' } },
    ])
    expect(await lastPrompt(cwd)).toBe('the real thing')
  })

  it('digs a plan rejection out of the tool result it comes back as', async () => {
    /*
     * Turning a tool use down does not arrive as a user record at all: the
     * feedback comes back as the rejected tool's own result, phrased for
     * Claude. Most often that tool is ExitPlanMode, so the newest thing a
     * person said during a planning session was invisible.
     */
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays('plan the work'),
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content:
                "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said: do it the other way instead",
            },
          ],
        },
      },
    ])
    expect(await lastPrompt(cwd)).toBe('do it the other way instead')
  })

  it('does not read the phrase quoted inside a tool result as a rejection', async () => {
    /*
     * It used to be the bare phrase anywhere in a tool result, and this very
     * file quotes the sentence -- so an agent that so much as read claude.ts
     * had the comment in its window. The match is anchored at the start now.
     */
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays('read claude.ts'),
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content:
                "   195\t * Claude: \"The user doesn't want to proceed with this tool use. The tool\n" +
                "   196\t * use was rejected ... To tell you how to proceed, the user said: <words>\".\n" +
                "   197\t * So the newest thing a person said during a planning session ...\n",
            },
          ],
        },
      },
    ])
    expect(await lastPrompt(cwd)).toBe('read claude.ts')
  })

  it('prefers a real prompt over the last-prompt bookkeeping beside it', async () => {
    /*
     * `last-prompt` is re-stamped every turn with the same prose: measured, five
     * copies of "merge and deploy" written long after the `/plan ...` the person
     * had actually typed, which Claude never writes a `last-prompt` for.
     */
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays('<command-name>/plan</command-name><command-args>the new thing</command-args>'),
      { type: 'last-prompt', lastPrompt: 'merge and deploy' },
      { type: 'last-prompt', lastPrompt: 'merge and deploy' },
    ])
    expect(await lastPrompt(cwd)).toBe('/plan the new thing')
  })

  it('falls back to the bookkeeping when no real prompt is in reach', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [{ type: 'last-prompt', lastPrompt: 'merge and deploy' }])
    expect(await lastPrompt(cwd)).toBe('merge and deploy')
  })

  it('keeps the prompt it found once the transcript grows past it', async () => {
    /*
     * This is what the incremental read buys, and what it has to preserve: a
     * measured worktree sat 857KB of tool output past the last thing its human
     * had said, and a window-based reader loses the prompt as soon as it falls
     * out of the window.
     */
    const cwd = freshCwd()
    const path = await writeTranscript(cwd, 'a.jsonl', [userSays('the thing to remember')])
    expect(await lastPrompt(cwd)).toBe('the thing to remember')

    const filler = Array.from({ length: 400 }, () =>
      JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(1000) } }),
    ).join('\n')
    await appendFile(path, `${filler}\n`, 'utf8')
    expect(await lastPrompt(cwd)).toBe('the thing to remember')
  })

  it('answers undefined where there is no transcript at all', async () => {
    expect(await lastPrompt(freshCwd())).toBeUndefined()
  })

  it('survives a half-written last line', async () => {
    const cwd = freshCwd()
    const dir = transcriptDir(cwd)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'a.jsonl'),
      `${JSON.stringify(userSays('a complete line'))}\n{"type":"user","messa`,
      'utf8',
    )
    expect(await lastPrompt(cwd)).toBe('a complete line')
  })

  it('reads the newest transcript when a directory holds several', async () => {
    const cwd = freshCwd()
    const old = await writeTranscript(cwd, 'old.jsonl', [userSays('the old conversation')])
    await writeTranscript(cwd, 'new.jsonl', [userSays('the new conversation')])
    const past = new Date(Date.now() - 60_000)
    await utimes(old, past, past)
    expect(await lastPrompt(cwd)).toBe('the new conversation')
  })
})

describe('turnState', () => {
  it('is in-turn while the newest mark is a prompt', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [TURN_END, userSays('do the thing')])
    expect(await turnState(cwd)).toBe('in-turn')
  })

  it('is between-turns once the turn end is the newest mark', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [userSays('do the thing'), TURN_END])
    expect(await turnState(cwd)).toBe('between-turns')
  })

  it('does not take a last-prompt record for a submission', async () => {
    /*
     * Measured: coming back after being away wrote one seven records after that
     * turn's `turn_duration`, so a detector that took it for a submission had
     * the agent mid-turn forever.
     */
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays('do the thing'),
      TURN_END,
      { type: 'last-prompt', lastPrompt: 'do the thing' },
    ])
    expect(await turnState(cwd)).toBe('between-turns')
  })

  it('stops believing a prompt from a transcript nothing has written to', async () => {
    /*
     * A turn in progress writes constantly. A transcript left behind by a
     * Claude killed mid-turn used to say in-turn forever, and the queue behind
     * it never moved.
     */
    const cwd = freshCwd()
    const path = await writeTranscript(cwd, 'a.jsonl', [userSays('do the thing')])
    const stale = new Date(Date.now() - 120_000)
    await utimes(path, stale, stale)
    expect(await turnState(cwd)).toBe('unknown')
  })

  it('is unknown with no transcript, and with one that carries no marks', async () => {
    expect(await turnState(freshCwd())).toBe('unknown')
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [{ type: 'assistant', message: { content: 'thinking' } }])
    expect(await turnState(cwd)).toBe('unknown')
  })

  it('tolerates whitespace in the JSON, rather than matching it literally', async () => {
    // The cheap pre-filter is really a parser; the literal `"type":"user"`
    // worked on Claude's compact output and failed on the first fixture
    // written by anything else.
    const cwd = freshCwd()
    const dir = transcriptDir(cwd)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.jsonl'), '{ "type" : "user", "message": { "content": "hi" } }\n')
    expect(await turnState(cwd)).toBe('in-turn')
  })
})
