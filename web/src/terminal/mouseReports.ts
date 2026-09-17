/**
 * Whether `data` is an SGR mouse report for a move with no button held.
 *
 * `CSI < Pb ; Px ; Py M`. In `Pb`, 32 is "this is a move", the low two bits are
 * the button with 3 meaning none, 64 marks the wheel, and 4, 8 and 16 are
 * Shift, Alt and Ctrl -- so a hover is 32 set, both low bits set and 64 clear,
 * whatever keys are held. A drag is 32 with a real button (32-34), and a wheel
 * notch is 64 plus a direction and never 32. Read off xterm's own `eventCode`
 * in `CoreMouseService`. `SGR_PIXELS` (1016) has the same shape, so it is
 * covered too; the legacy form is refused outright in `send`.
 */
export const isHoverReport = (data: string): boolean => {
  const match = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data)
  if (match === null) return false
  const code = Number(match[1])
  return (code & 32) !== 0 && (code & 3) === 3 && (code & 64) === 0
}
