/**
 * When anyone last typed into any terminal through this server.
 *
 * What a server that updates itself waits on (`update.ts`): a restart drops
 * every socket for a few seconds, and that is nothing to an agent -- it lives
 * in tmux -- and a lot to somebody mid-sentence. Marked where every keystroke
 * arrives, `routes/ws.ts`, before the frame is routed: typing into a linked
 * machine's terminal goes through this server too, and its restart would cut
 * that off as surely as one of its own.
 *
 * Keystrokes only. xterm.js answers the app's terminal queries on the same
 * input channel, and an open page would otherwise count as somebody typing
 * for as long as it was open -- see `looksTyped` in the engine.
 */
let last = 0

export const markTyped = (): void => {
  last = Date.now()
}

export const lastTypedAt = (): number => last
