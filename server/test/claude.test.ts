import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeArgs,
  hasTranscript,
  promptSummary,
  transcriptDir,
  turnState,
} from '../src/session/claude.js'

/** The newest prompt, which is what most of these were written about. */
const lastPrompt = async (cwd: string): Promise<string | undefined> =>
  (await promptSummary(cwd))?.prompt

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
 * `promptSummary` and `turnState` both memoise by cwd for the life of the process,
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

  it('reads a paste without the tags Claude Code wraps it in', async () => {
    /*
     * The user record carries `<pasted_content id="…">` around the paste, with
     * the id on the closing tag too; a window showed the tags. Verbatim from a
     * live transcript, and a second paste with words typed around it.
     */
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays(
        '\n\n<pasted_content id="7b6d">\nPressing on the top bar should collapse the panels\n</pasted_content id="7b6d">\n',
      ),
    ])
    expect(await lastPrompt(cwd)).toBe('Pressing on the top bar should collapse the panels')
    const typed = freshCwd()
    await writeTranscript(typed, 'a.jsonl', [
      userSays('fix this: <pasted_content id="a1">TypeError: x</pasted_content id="a1"> please'),
    ])
    expect(await lastPrompt(typed)).toBe('fix this: TypeError: x please')
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
  it('keeps the newest task and what followed it apart', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays('the topbar of a worktree shows the last prompt but not the task it was given'),
      TURN_END,
      userSays('yes'),
      TURN_END,
      userSays('merge and deploy'),
    ])
    expect(await promptSummary(cwd)).toEqual({
      prompt: 'merge and deploy',
      task: 'the topbar of a worktree shows the last prompt but not the task it was given',
      followUps: ['yes', 'merge and deploy'],
    })
  })

  it('reads a message sent mid-turn as a follow-up, however long', async () => {
    /*
     * Claude records one as a `queued_command` attachment, not a user record,
     * so none of them reached the strip. Shaped as measured in a live
     * transcript; the second is long enough that `isTask` alone would have
     * made it the task, and the task-notification is machinery.
     */
    const cwd = freshCwd()
    const queued = (prompt: string, commandMode = 'prompt'): unknown => ({
      type: 'attachment',
      isSidechain: false,
      attachment: { type: 'queued_command', prompt, commandMode, humanTurn: true },
    })
    await writeTranscript(cwd, 'a.jsonl', [
      userSays('the files search should have a switch between file name and content'),
      queued('also italic'),
      queued('the last prompt display should strip the text so newlines at the end are ignored'),
      queued('<task-notification>done</task-notification>', 'task-notification'),
    ])
    expect(await promptSummary(cwd)).toEqual({
      prompt: 'the last prompt display should strip the text so newlines at the end are ignored',
      task: 'the files search should have a switch between file name and content',
      followUps: [
        'also italic',
        'the last prompt display should strip the text so newlines at the end are ignored',
      ],
    })
  })

  it('keeps the newest three follow-ups', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays('the topbar of a worktree shows the last prompt but not the task it was given'),
      ...['one', 'two', 'three', 'four', 'five'].map(userSays),
    ])
    expect((await promptSummary(cwd))?.followUps).toEqual(['three', 'four', 'five'])
  })

  it('lets a new task clear the follow-ups of the last one as it is written', async () => {
    // The incremental path, which folds onto what it had rather than rescanning.
    const cwd = freshCwd()
    const path = await writeTranscript(cwd, 'a.jsonl', [
      userSays('make the usage bars in the top bar turn amber above seventy five percent'),
      userSays('deploy'),
    ])
    expect((await promptSummary(cwd))?.followUps).toEqual(['deploy'])

    await appendFile(
      path,
      `${JSON.stringify(userSays('hovering over a panel should not remove the status colour on the left'))}\n` +
        `${JSON.stringify(userSays('commit'))}\n`,
      'utf8',
    )
    expect(await promptSummary(cwd)).toEqual({
      prompt: 'commit',
      task: 'hovering over a panel should not remove the status colour on the left',
      followUps: ['commit'],
    })
  })

  it('counts a follow-up once, however many looks it straddles', async () => {
    /*
     * The incremental read used to re-read a 64KB overlap, harmless while it
     * kept one newest prompt and a duplicate in every list once it kept
     * several. A line caught half-written is read whole on the next look.
     */
    const cwd = freshCwd()
    const path = await writeTranscript(cwd, 'a.jsonl', [
      userSays('the files list seems to be broken when a directory is renamed underneath it'),
      // Past the old overlap, so a re-read sees the follow-up and not the task.
      ...Array.from({ length: 100 }, () => ({ type: 'assistant', message: { content: 'x'.repeat(1000) } })),
      userSays('yes'),
    ])
    await promptSummary(cwd)
    const line = JSON.stringify(userSays('try again'))
    await appendFile(path, line.slice(0, 10), 'utf8')
    expect((await promptSummary(cwd))?.followUps).toEqual(['yes'])
    await appendFile(path, `${line.slice(10)}\n`, 'utf8')
    expect((await promptSummary(cwd))?.followUps).toEqual(['yes', 'try again'])
    expect((await promptSummary(cwd))?.followUps).toEqual(['yes', 'try again'])
  })

  it('makes the first prompt the task when none reads as one', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [userSays('merge origin master'), userSays('deploy')])
    expect(await promptSummary(cwd)).toEqual({
      prompt: 'deploy',
      task: 'merge origin master',
      followUps: ['deploy'],
    })
  })

  it('reads a planning answer as a follow-up to the plan', async () => {
    const cwd = freshCwd()
    await writeTranscript(cwd, 'a.jsonl', [
      userSays(
        '<command-name>/plan</command-name><command-args>show the task above claude instead of in the bar</command-args>',
      ),
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content:
                "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said: keep it greyscale",
            },
          ],
        },
      },
    ])
    expect(await promptSummary(cwd)).toMatchObject({
      task: '/plan show the task above claude instead of in the bar',
      followUps: ['keep it greyscale'],
    })
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
