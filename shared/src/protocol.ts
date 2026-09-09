import type { AttentionState, SessionLiveness } from './model.js'

/**
 * Terminal traffic rides one WebSocket for the whole app. Control messages are
 * JSON; terminal output is binary, because it is the only high-volume direction
 * and JSON-encoding it would double the bytes and cost a parse per frame.
 *
 * Binary output frame layout:
 *   byte 0      = FRAME_OUTPUT
 *   bytes 1..4  = streamId, uint32 little-endian
 *   bytes 5..   = raw pty bytes
 *
 * `streamId` is a small integer the server assigns per attachment, so the hot
 * path never carries a string session id.
 */
export const FRAME_OUTPUT = 0x01
export const OUTPUT_HEADER_BYTES = 5

export interface AttachMsg {
  t: 'attach'
  sessionId: string
  cols: number
  rows: number
  /**
   * Primary attachments own the pty size (the focused detail view). Secondary
   * attachments (overview tiles) render whatever size the pty already is and
   * scale it in CSS, so glancing at the overview never reflows a running TUI.
   */
  primary: boolean
}

export interface InputMsg {
  t: 'input'
  sessionId: string
  data: string
}

export interface ResizeMsg {
  t: 'resize'
  sessionId: string
  cols: number
  rows: number
}

export interface DetachMsg {
  t: 'detach'
  sessionId: string
}

/**
 * Claim sole input authority for a session.
 *
 * Exactly one attachment may write to a session at a time. This is not just
 * about stray keystrokes: terminal apps send queries (DA1, DSR, XTVERSION) and
 * xterm.js answers them automatically, so two attached browsers would inject two
 * identical replies into the app's stdin and corrupt its input stream.
 *
 * Size authority (`primary`) is separate: the detail view owns the pty size,
 * while any focused tile may own input.
 */
export interface FocusMsg {
  t: 'focus'
  sessionId: string
}

export type ClientMsg = AttachMsg | InputMsg | ResizeMsg | DetachMsg | FocusMsg

export interface AttachedMsg {
  t: 'attached'
  sessionId: string
  streamId: number
  cols: number
  rows: number
  /**
   * A serialized repaint of the terminal's current screen and scrollback,
   * produced from the server-side emulator. Claude Code runs on the alternate
   * screen, so replaying raw bytes would garble it; this restores actual state.
   */
  snapshot: string
}

export interface SizeMsg {
  t: 'size'
  sessionId: string
  cols: number
  rows: number
}

export interface SessionStateMsg {
  t: 'session-state'
  sessionId: string
  liveness: SessionLiveness
  /**
   * Set when `liveness` is dead. Carried here and not left to the next REST
   * snapshot: death is pushed, and a client that only heard "dead" could say
   * that a session had stopped but never why, which is the one thing worth
   * saying about a Claude that would not start.
   */
  exitStatus?: number | null
  attention: AttentionState
  lastOutputAt: number
  /** What the pane is running; changes as you use the terminal. */
  command?: string
}

/** Something changed that invalidates the REST snapshot (session/worktree CRUD). */
export interface InvalidateMsg {
  t: 'invalidate'
}

export interface ErrorMsg {
  t: 'error'
  sessionId?: string
  message: string
}

export type ServerMsg = AttachedMsg | SizeMsg | SessionStateMsg | InvalidateMsg | ErrorMsg

export const encodeOutputFrame = (streamId: number, payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(OUTPUT_HEADER_BYTES + payload.length)
  frame[0] = FRAME_OUTPUT
  new DataView(frame.buffer).setUint32(1, streamId, true)
  frame.set(payload, OUTPUT_HEADER_BYTES)
  return frame
}

export const decodeOutputFrame = (
  frame: Uint8Array,
): { streamId: number; payload: Uint8Array } | null => {
  if (frame.length < OUTPUT_HEADER_BYTES || frame[0] !== FRAME_OUTPUT) return null
  const streamId = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, true)
  return { streamId, payload: frame.subarray(OUTPUT_HEADER_BYTES) }
}
