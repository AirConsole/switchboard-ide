import { describe, expect, it } from 'vitest'
import {
  WORKING_WINDOW_MS,
  classify,
  looksBusy,
  looksLikePrompt,
  screenState,
} from '../src/session/attention.js'

/**
 * Screens, as the mirror renders them.
 *
 * Every fixture here is shaped like the real thing: a conversation of `●` and
 * `⎿` blocks, then the input box, then the mode hint under it. The shape is
 * load-bearing -- `screenState` reads upwards from the input box and believes
 * only block openers -- so a fixture that skips the furniture would pass tests
 * the real screen fails.
 */
const screen = (...lines: string[]): string => lines.join('\n')

const INPUT = '❯ '
const HINT = '  ? for shortcuts                          shift+tab to cycle'

/**
 * A fresh session's screen, captured from the mirror of one that was showing
 * amber with nothing ever submitted to it.
 *
 * Two things here are furniture the parser did not know: the update notice
 * under the banner, and -- above the banner -- the wrapped tail of a permission
 * warning whose own `⚠` line had already scrolled off the top, which no
 * pattern anchored at the start of a line can catch.
 */
const SPLASH = [
  'Permission allow rule (../../settings.local.json): Bash(mv pipeline/tools/pipeline/tests/',
  'test_*.py pipeline/tests/tools/pipeline/) has a wildcard before the rest of the command,',
  'so it also matches any options inserted at that position and approves them without a prom',
  ' ▐▛███▛█   Claude Code v2.1.271',
  '▝▜██████▀  Opus 5 (1M context) · Claude Team',
  '  ▝▝ ▝▝    ~/src/mapplets/.claude/worktrees/porsche-ai',
  '                                                 ✔ Update installed · Restart to update',
  '─'.repeat(89),
  '❯ test message',
  '─'.repeat(89),
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
]

describe('looksBusy', () => {
  it('sees a running turn by its parenthesised timer', () => {
    expect(looksBusy('✽ Grooving… (8s · ↓ 81 tokens · thinking)')).toBe(true)
  })

  it('sees a timer that has run past a minute', () => {
    // This is the regression: `\(\d+s` matched `(8s ·` and missed `(3m 34s ·`,
    // so every turn longer than a minute -- most of an agent's -- read as idle.
    expect(looksBusy('✽ Grooving… (3m 34s · ↓ 2.1k tokens)')).toBe(true)
    expect(looksBusy('✽ Grooving… (1h 2m 3s · ↓ 9 tokens)')).toBe(true)
  })

  it('is not fooled by the timer a finished turn leaves behind', () => {
    expect(looksBusy('✻ Cogitated for 3m 34s · done 2:02 PM')).toBe(false)
  })

  it('reads the last timer, not the first', () => {
    const finished = screen('✽ Working… (8s · ↓ 4 tokens)', '✻ Baked for 8s · done 2:02 PM')
    expect(looksBusy(finished)).toBe(false)
    const restarted = screen('✻ Baked for 8s · done 2:02 PM', '✽ Working… (2s · ↓ 4 tokens)')
    expect(looksBusy(restarted)).toBe(true)
  })

  it('says nothing about a screen with no timer at all', () => {
    expect(looksBusy(screen('● hello', INPUT))).toBe(false)
  })
})

describe('looksLikePrompt', () => {
  const dialog = (...lines: string[]): string =>
    screen('✻ Baked for 2s · done 3:01 PM', '', ...lines)

  it('catches a tool-permission dialog', () => {
    // A menu is its selected row *and* a sibling option: the mirror draws a
    // submitted user message with a chevron too, so the row alone is not enough.
    expect(
      looksLikePrompt(dialog('Do you want to run this command?', '❯ 1. Yes', '  2. No')),
    ).toBe(true)
  })

  it('catches a plan approval', () => {
    expect(looksLikePrompt(dialog('Would you like to proceed?', '❯ 1. Yes, go ahead'))).toBe(true)
  })

  it('catches an option list eleven rows above the bottom', () => {
    /*
     * The window used to be the last 12 rows and a plan approval's options sat
     * 11 up, each carrying a paragraph -- so one more line of option text lost
     * them. The whole turn is read now, and this fixture is what says so.
     */
    const options = Array.from({ length: 11 }, (_, n) => `   some option prose, line ${n}`)
    expect(
      looksLikePrompt(dialog('❯ 1. Yes', '  2. No, keep planning', ...options, INPUT)),
    ).toBe(true)
  })

  it('ignores the same words above the last done marker', () => {
    /*
     * Measured on a live worktree: Claude wrote "Which way do you want to go?"
     * in prose, that matched the tool-permission dialog's wording, and the
     * window stayed amber while the agent worked two rows from the bottom.
     *
     * That exact phrase no longer matches anything -- `Do you (want to|trust)`
     * was deleted, for the second measured reason below -- so the fixture uses
     * a different line of ordinary English Claude writes, one a surviving
     * pattern does still catch. Otherwise this passes whether or not the turn
     * scoping is there, which is a test that guards nothing.
     */
    const prose = screen(
      '● Then press enter to continue, and it will pick up where it left off.',
      '✻ Baked for 2s · done 3:01 PM',
      '● Reading files',
      INPUT,
    )
    expect(looksLikePrompt(prose)).toBe(false)
  })

  it('tells a live question from the same question answered', () => {
    /*
     * The bug this whole deletion is for, measured twice on 2026-09-14.
     *
     * An AskUserQuestion stays on screen after it is answered, inside the same
     * turn -- so scoping to the turn, which fixed the prose case above, cannot
     * help here. In the name-and-app worktree the question below was answered
     * at 07:56:33 and the window stayed amber until the turn's done line landed
     * at 07:59:21: three minutes of "needs you" over an agent that was
     * deploying. `Do you (want to|trust)` was the only pattern that matched.
     *
     * Verbatim from the mirror, which renders the answered block as a `●`
     * opener and a `⎿` continuation carrying the question's own text.
     */
    const answered = screen(
      '✻ Baked for 2s · done 3:01 PM',
      '● User declined to answer questions',
      '  ⎿  · An answered AskUserQuestion leaves "How do you want to play the service',
      '     worker?" on screen. How should I narrow it? (Drop the phrase pattern /',
      '     Demote it to a footer / Require a menu with it)',
      '',
      '  Finding snapshots containing the dialog',
      '* Whirring… (3m 15s · ↓ 13.1k tokens · thinking)',
      INPUT,
      HINT,
    )
    expect(looksLikePrompt(answered)).toBe(false)

    /*
     * The same question while it is still up, measured in this IDE's own
     * window. This half is why the deletion is safe and the pair is why this
     * test is worth its runtime: the wording is identical in both screens, so
     * the only thing separating them is the menu -- a glyph Claude never
     * prints, which disappears the moment the question is answered.
     */
    const asking = screen(
      '✻ Baked for 2s · done 3:01 PM',
      '● An answered AskUserQuestion leaves "How do you want to play the service',
      '  worker?" on screen. How should I narrow it?',
      '',
      '❯ 1. Drop the phrase pattern',
      '  2. Demote it to a footer',
      '  3. Require a menu with it',
      '',
      'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
    )
    expect(looksLikePrompt(asking)).toBe(true)
  })

  it('still catches the write-permission dialog by its menu', () => {
    /*
     * Claude Code v2.1.270, verbatim: the phrase and the numbered menu are both
     * there, which is why deleting the phrase costs nothing here.
     */
    const permission = screen(
      '✻ Cooked for 3s · done 8:04 AM',
      '❯ create a file b.txt containing the word bye',
      '● Write(b.txt)',
      '─────────────────────────────',
      ' Create file',
      ' b.txt',
      ' Do you want to create b.txt?',
      ' ❯ 1. Yes',
      '   2. Yes, and switch to accept edits (auto-approve file edits) for this',
      '      session (shift+tab)',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
      '',
      '',
      '',
    )
    expect(looksLikePrompt(permission)).toBe(true)
  })

  it('still catches the trust-folder dialog, which no longer says "trust" first', () => {
    /*
     * Claude Code v2.1.270, verbatim, and written the way `tailText` delivers
     * it: the emulator pops trailing blank rows (mirror.ts), so the dialog's
     * own footer is the last line of the screen even though tmux's capture
     * shows twenty blank rows under it.
     *
     * The wording moved -- it asks "Is this a project you created or one you
     * trust?" now, so the deleted phrase would not have seen it either -- and
     * its options are not numbered, so `❯ N.` does not see it. What holds it up
     * is `Enter to confirm` and, because of that trimming, the `Esc to cancel`
     * footer as well. Two patterns, so this is a characterisation of a real
     * dialog rather than a guard on one line; it fails only if both go.
     */
    const trust = screen(
      ' Quick safety check: Is this a project you created or one you trust? (Like your own',
      " code, a well-known open source project, or work from your team).",
      '',
      " Claude Code'll be able to read, edit, and execute files here.",
      '',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      '',
      ' Enter to confirm · Esc to cancel',
    )
    expect(looksLikePrompt(trust)).toBe(true)
  })


  it('believes nothing while the input box is still on screen', () => {
    /*
     * The rule that retired four separate false positives at once, and the
     * measurement behind it: Claude Code takes the input box away while a modal
     * is up. Captured on v2.1.270 -- present on a session at rest and on one
     * mid-turn with its queue showing, absent on the permission dialog, the
     * plan approval and an AskUserQuestion.
     *
     * Each line of prose below was a measured amber over an agent that was
     * working. They are all things Claude writes or quotes, and the reason they
     * were believed is that the patterns were read without asking whether
     * anyone could still type. The box is drawn the way the mirror renders it:
     * a rule, the chevron, a rule. The rule is what identifies it -- the
     * chevron alone is on every submitted user message too.
     */
    const RULE = '──────────────────────────────────────────────'
    const working = (...body: string[]): string =>
      screen('✻ Baked for 2s · done 3:01 PM', ...body, RULE, INPUT, RULE, '', HINT)

    expect(looksLikePrompt(working('● The script asks: read -p "continue? (y/n)"'))).toBe(false)
    expect(looksLikePrompt(working('● Press enter in that pane and it will pick up.'))).toBe(false)
    expect(looksLikePrompt(working('● Would you like to proceed? I will assume yes.'))).toBe(false)
    expect(looksLikePrompt(working('● Ran a command', '  ⎿  use j/k to navigate'))).toBe(false)
    expect(looksLikePrompt(working('● Enter to confirm it, or Esc to cancel.'))).toBe(false)
    // And the chevron cases, which the sibling rule already handled -- kept here
    // because the gate is what holds them if that rule is ever loosened.
    expect(looksLikePrompt(working('❯ 1. fix the parser 2. then the tests'))).toBe(false)
  })

  it('does not read a numbered user prompt as a menu', () => {
    /*
     * The mirror draws a submitted user message as `❯ <text>` -- measured in
     * this IDE's own window, where "❯ the name-and-app worktree currently looks
     * like it needs attention" was the line above the work it started. So a
     * prompt that opens with a numbered item is a chevron, a digit and a full
     * stop, and `❯ N.` on its own called it a dialog. It sits at the top of the
     * turn, so the window stayed amber for the whole of it.
     */
    const prompt = screen(
      '✻ Baked for 2s · done 3:01 PM',
      '❯ 1. fix the parser 2. then the tests',
      '',
      '● Reading files',
      INPUT,
      HINT,
    )
    expect(looksLikePrompt(prompt)).toBe(false)
  })

  it('does not read a wrapped draft as a menu', () => {
    /*
     * Measured on Claude Code v2.1.270 at 90 columns: a draft too long for one
     * line wraps inside the input box with its continuations indented by
     * exactly two columns -- the same alignment a menu's unselected options
     * have. So "the next line is indented two further" cannot be what
     * identifies a menu, however much it looks like it on a dialog; the sibling
     * has to carry a number. This fixture is here to fail that idea if it is
     * tried again.
     */
    const draft = screen(
      '✻ Baked for 2s · done 3:01 PM',
      '─────────────────────────────────────────',
      '❯ 1. this is a deliberately long prompt whose only purpose is to wrap across',
      '  several lines of the input box so that the continuation indent can be seen',
      '─────────────────────────────────────────',
      HINT,
    )
    expect(looksLikePrompt(draft)).toBe(false)
  })

  it('catches a plan approval, verbatim', () => {
    /*
     * Claude Code v2.1.270, captured from a real `--permission-mode plan`
     * session. Three patterns hold it: the menu, "Would you like to proceed?"
     * and "shift+tab to approve". The menu's options are adjacent here, which
     * is what lets the sibling be looked for a few lines away rather than
     * anywhere in the turn.
     */
    const plan = screen(
      '  ──────────────────────────────────────────────────────────────',
      "   Claude has written up a plan and is ready to execute. Would you like to proceed?",
      '',
      '   ❯ 1. Yes, and use auto mode',
      '     2. Yes, manually approve edits',
      '     3. Tell Claude what to change',
      '        shift+tab to approve with this feedback',
      '',
      '   ctrl+g to edit in Vim · ~/.claude/plans/add-a-subtract-function.md',
    )
    expect(looksLikePrompt(plan)).toBe(true)
  })

  it('does not read a bare chevron as a question', () => {
    // The idle input box draws one too, and a wrong "needs you" is worse than
    // a missing one.
    expect(looksLikePrompt(screen('✻ Baked for 2s · done 3:01 PM', '', INPUT, HINT))).toBe(false)
  })

  it('believes a weak footer pattern only near the bottom', () => {
    expect(looksLikePrompt(dialog('Pick one', 'Esc to cancel'))).toBe(true)
    const buried = dialog('Esc to cancel', '● and then twenty lines of work', '● more', '● more')
    expect(looksLikePrompt(buried)).toBe(false)
  })

  it('finds nothing under a done marker that ends the screen', () => {
    expect(looksLikePrompt(screen('● work', '✻ Baked for 2s · done 3:01 PM'))).toBe(false)
  })
})

describe('screenState', () => {
  it('reads a finished turn as done', () => {
    expect(screenState(screen('● Did the thing', '✻ Baked for 2s · done 3:01 PM', INPUT, HINT)))
      .toBe('done')
  })

  it('reads a block after the done marker as busy', () => {
    expect(
      screenState(screen('✻ Baked for 2s · done 3:01 PM', '● Reading files', INPUT, HINT)),
    ).toBe('busy')
  })

  it('reads a screen with nothing printed as nothing', () => {
    expect(screenState(screen('▐▛ Claude Code v2.0', '', INPUT, HINT))).toBe('nothing')
  })

  it('reads a real fresh session as nothing printed', () => {
    // The measured screen, and the bug it caused: a Claude that had never been
    // given a turn showed as *working* for as long as it sat there. The update
    // notice and the warning above the banner counted as "something was
    // printed", `screenState` answered busy, and the transcript that would have
    // broken the tie does not exist until a turn is submitted -- so nothing
    // could ever take it back.
    expect(screenState(screen(...SPLASH))).toBe('nothing')
  })

  it('stops at the banner rather than reading what scrolled above it', () => {
    // Claude prints the banner once, before any turn, so prose above it is
    // startup output and not something Claude said. The ceiling must not hide a
    // real block *below* the banner, which is the direction it could be wrong.
    expect(screenState(screen('a stray line', '▛ Claude Code v2.1.271', INPUT, HINT)))
      .toBe('nothing')
    expect(
      screenState(screen('▛ Claude Code v2.1.271', '● Reading files', INPUT, HINT)),
    ).toBe('busy')
  })

  it('reads an unreadable screen as busy rather than finished', () => {
    // An empty mirror has no input box. Answering `done` there is how a session
    // whose repaint never arrived came to show as finished.
    expect(screenState('')).toBe('busy')
    expect(screenState(screen('some output', 'with no box'))).toBe('busy')
  })

  it('steps over the recap a return from away prints', () => {
    /*
     * The recap arrives *after* its turn's done line, so the last thing above
     * the box is the recap rather than the marker -- and the session read as
     * busy for good.
     */
    const away = screen(
      '● Did the thing',
      '✻ Baked for 2s · done 3:01 PM',
      '● recap: you were away, here is what happened',
      '  more recap prose',
      INPUT,
      HINT,
    )
    expect(screenState(away)).toBe('done')
  })

  it('steps over chrome above the box', () => {
    const withChrome = screen(
      '● Did the thing',
      '✻ Baked for 2s · done 3:01 PM',
      '⚠ a standing warning',
      ' Tip: try this',
      '────────────────',
      INPUT,
      HINT,
    )
    expect(screenState(withChrome)).toBe('done')
  })

  it('lets a block opener decide, not the last line of its prose', () => {
    const wrapped = screen(
      '✻ Baked for 2s · done 3:01 PM',
      '● Reading the file',
      '  and this is the continuation of that line',
      INPUT,
      HINT,
    )
    expect(screenState(wrapped)).toBe('busy')
  })
})

describe('classify', () => {
  const now = 1_000_000
  const base = {
    kind: 'claude' as const,
    lastOutputAt: now - 60_000,
    dead: false,
    tailText: () => screen('● Did the thing', '✻ Baked for 2s · done 3:01 PM', INPUT, HINT),
    now,
  }

  it('calls a dead session idle whatever is on its screen', () => {
    const menu = screen('Do you want to proceed?', '❯ 1. Yes', '  2. No')
    expect(classify({ ...base, dead: true, tailText: () => menu }))
      .toBe('idle')
  })

  it('decides needs-you on the screen, ahead of the clock', () => {
    /*
     * This used to be reached only once output had gone quiet, which put it
     * behind the one thing that is never quiet: a repainting TUI.
     */
    expect(
      classify({
        ...base,
        lastOutputAt: now,
        tailText: () =>
          screen(
            '✻ Baked for 2s · done 3:01 PM',
            'Do you want to proceed?',
            '❯ 1. Yes',
            '  2. No',
          ),
      }),
    ).toBe('needs-you')
  })

  it('never says needs-you about a shell', () => {
    expect(
      classify({
        ...base,
        kind: 'shell',
        tailText: () => '$ echo "Do you want to proceed?"\nDo you want to proceed?',
      }),
    ).toBe('idle')
  })

  it('calls recent output working', () => {
    expect(classify({ ...base, lastOutputAt: now - (WORKING_WINDOW_MS - 1) })).toBe('working')
  })

  it('calls a quiet shell idle', () => {
    expect(classify({ ...base, kind: 'shell', tailText: () => '$ ' })).toBe('idle')
  })

  it('lets an in-turn transcript overrule a screen that looks finished', () => {
    expect(classify({ ...base, turn: 'in-turn' })).toBe('working')
  })

  it('calls a fresh session with no transcript yet idle, not working', () => {
    // The whole failure, end to end: a brand-new session has written no
    // transcript, so `turn` is `unknown` and only the screen can speak for it.
    expect(classify({ ...base, turn: 'unknown', tailText: () => screen(...SPLASH) })).toBe('idle')
  })

  it('calls a finished turn idle', () => {
    expect(classify({ ...base, turn: 'between-turns' })).toBe('idle')
    expect(classify({ ...base, turn: 'unknown' })).toBe('idle')
  })

  it('calls an unreadable screen working unless the transcript says otherwise', () => {
    const unreadable = { ...base, tailText: () => '' }
    expect(classify({ ...unreadable, turn: 'unknown' })).toBe('working')
    expect(classify({ ...unreadable, turn: 'between-turns' })).toBe('idle')
  })

  it('trusts a running timer over a quiet clock', () => {
    expect(
      classify({
        ...base,
        turn: 'unknown',
        tailText: () => screen('✽ Grooving… (3m 34s · ↓ 81 tokens)', INPUT, HINT),
      }),
    ).toBe('working')
  })
})
