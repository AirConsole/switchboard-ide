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
    expect(looksLikePrompt(dialog('Do you want to run this command?', '❯ 1. Yes'))).toBe(true)
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
    expect(looksLikePrompt(dialog('❯ 1. Yes', ...options, INPUT))).toBe(true)
  })

  it('ignores the same words above the last done marker', () => {
    /*
     * Measured on a live worktree: Claude wrote "Which way do you want to go?"
     * in prose, that matched the tool-permission dialog's wording, and the
     * window stayed amber while the agent worked two rows from the bottom.
     */
    const prose = screen(
      '● Which way do you want to go?',
      '✻ Baked for 2s · done 3:01 PM',
      '● Reading files',
      INPUT,
    )
    expect(looksLikePrompt(prose)).toBe(false)
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
    expect(classify({ ...base, dead: true, tailText: () => 'Do you want to proceed? ❯ 1. Yes' }))
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
          screen('✻ Baked for 2s · done 3:01 PM', 'Do you want to proceed?', '❯ 1. Yes'),
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
