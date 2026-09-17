import { describe, expect, it } from 'vitest'
import {
  COOLDOWN_MS,
  SETTLE_MS,
  inputBox,
  readiness,
  type ReadinessInput,
} from '../src/session/readiness.js'

const NOW = 5_000_000

/** A session that every test below passes, so each one can break exactly one. */
const resting: ReadinessInput = {
  kind: 'claude',
  dead: false,
  hasPty: true,
  lastOutputAt: NOW - SETTLE_MS - 1,
  lastUserInputAt: NOW - 60_000,
  queuedAt: NOW - 30_000,
  tail: ['● Did the thing', '✻ Baked for 2s · done 3:01 PM', '❯ ', '  shift+tab to cycle'].join(
    '\n',
  ),
  brightTail: ['● Did the thing', '✻ Baked for 2s · done 3:01 PM', '❯ '].join('\n'),
  turn: 'between-turns',
  notBefore: 0,
  now: NOW,
}

const why = (input: ReadinessInput): string | true => {
  const result = readiness(input)
  return result.ready ? true : result.why
}

describe('inputBox', () => {
  it('finds an empty box', () => {
    expect(inputBox('● work\n❯ ')).toBe('')
  })

  it('finds a draft in the box', () => {
    expect(inputBox('● work\n❯ half a sentence')).toBe('half a sentence')
  })

  it('answers null when there is no box', () => {
    expect(inputBox('● work\n  more work')).toBeNull()
  })

  it('reads the lowest box, not one pasted into the transcript above', () => {
    expect(inputBox('● the user pasted:\n❯ an old prompt\n──────\n❯ ')).toBe('')
  })

  it('does not match a chevron at the end of one line against the next', () => {
    /*
     * A regex run over the whole tail did exactly that, and it made "did the
     * paste land in the box" answer yes to an empty box sitting above a rule.
     * Line by line is the fix, and this is the shape that catches a relapse.
     */
    expect(inputBox('● a line ending in ❯\nsome following text')).toBeNull()
  })
})

describe('readiness', () => {
  it('is ready when everything holds', () => {
    expect(why(resting)).toBe(true)
  })

  it('refuses a shell', () => {
    expect(why({ ...resting, kind: 'shell' })).toBe('not-claude')
  })

  it('refuses a dead session, and one with no pty', () => {
    expect(why({ ...resting, dead: true })).toBe('dead')
    expect(why({ ...resting, hasPty: false })).toBe('no-pty')
  })

  it('refuses inside the cooldown after a send', () => {
    expect(why({ ...resting, notBefore: NOW + COOLDOWN_MS })).toBe('cooling-down')
    expect(why({ ...resting, notBefore: NOW })).toBe(true)
  })

  it('refuses while output is still arriving', () => {
    expect(why({ ...resting, lastOutputAt: NOW - SETTLE_MS + 1 })).toBe('output-recent')
    expect(why({ ...resting, lastOutputAt: NOW - SETTLE_MS })).toBe(true)
  })

  it('does not make a RUN NEXT pressed straight after typing wait', () => {
    // A ten-second hold on the last keystroke kept an idle Claude waiting for
    // exactly that long after RUN NEXT. Pressing it is the human finishing.
    const typedAt = NOW - SETTLE_MS - 2
    expect(why({ ...resting, lastUserInputAt: typedAt, queuedAt: typedAt + 1 })).toBe(true)
  })

  it('refuses a todo the human has typed past', () => {
    expect(why({ ...resting, lastUserInputAt: NOW - 29_999 })).toBe('typed-after-queue')
    expect(why({ ...resting, lastUserInputAt: NOW - 30_000 })).toBe(true)
    // Ahead of the settle clock, which the typing's own echo keeps resetting.
    expect(why({ ...resting, lastUserInputAt: NOW, lastOutputAt: NOW })).toBe('typed-after-queue')
  })

  it('refuses mid-turn on the transcript alone', () => {
    expect(why({ ...resting, turn: 'in-turn' })).toBe('mid-turn')
  })

  it('refuses a running timer whether or not the transcript agrees', () => {
    const busy = `✽ Grooving… (3m 34s · ↓ 81 tokens)\n❯ `
    expect(why({ ...resting, turn: 'unknown', tail: busy })).toBe('busy')
    // The transcript says the turn ended and the screen still shows a timer: a
    // second turn started, or the repaint has not landed. Either way, wait.
    expect(why({ ...resting, turn: 'between-turns', tail: busy })).toBe('busy')
  })

  it('refuses a modal, whose Return is an answer rather than a submission', () => {
    /*
     * Measured against a real Claude, v2.1.270, verbatim: the trust-folder
     * dialog sits with "No, exit" selected, so a stray Return there quits the
     * agent. Its options are not numbered, so what holds it up is the footer
     * wording rather than the menu -- the fixture used to say `❯ 1. Yes`, which
     * is not what that dialog has ever looked like.
     */
    const dialog = [
      '✻ Baked for 2s · done 3:01 PM',
      ' Quick safety check: Is this a project you created or one you trust?',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      '',
      ' Enter to confirm · Esc to cancel',
    ].join('\n')
    expect(why({ ...resting, tail: dialog })).toBe('needs-you')
  })

  it('refuses a screen with no input box on it', () => {
    expect(why({ ...resting, brightTail: '● work\n  no box here' })).toBe('no-input-box')
  })

  it('refuses to type on top of a draft someone left in the box', () => {
    expect(why({ ...resting, brightTail: '● work\n❯ half a sentence' })).toBe('draft-in-box')
  })

  it('reads the box from the bright tail, so a dim hint is not a draft', () => {
    // The placeholder Claude greys into an empty box is exactly what
    // `brightTail` exists to blank out.
    expect(why({ ...resting, tail: `${resting.tail}\n❯ Try "fix the bug"` })).toBe(true)
  })

  it('is a whitelist: an unknown transcript still has to pass every screen test', () => {
    expect(why({ ...resting, turn: 'unknown' })).toBe(true)
    expect(why({ ...resting, turn: 'unknown', brightTail: '● work' })).toBe('no-input-box')
  })
})
