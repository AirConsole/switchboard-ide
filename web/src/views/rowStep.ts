import { createContext } from 'react'

/**
 * One step along the row, handed to whatever is deep enough to need it.
 *
 * The Cmd+arrow walk is a document listener in `Overview`, which is where the
 * row's arithmetic is; the soft key row is inside a terminal, four components
 * down, and a phone has no Cmd for it to use instead. Rather than thread a
 * callback through `WorktreeTile`, `TerminalsPane` and `TerminalView` -- three
 * components that have nothing to do with walking the row -- the walk is put
 * where anything under the row can reach it.
 *
 * Null outside the row, which is what makes a terminal drawn anywhere else
 * (there is none today) simply not offer the step rather than break.
 */
export const RowStep = createContext<((dir: 'left' | 'right') => void) | null>(null)
