import type { Session } from '@ide-n-dream/shared'

/**
 * Label each terminal with what it is running.
 *
 * `bash`, `vim`, `npm` says something; a position in a list does not. When two
 * terminals are running the same thing the label alone stops distinguishing
 * them, so those -- and only those -- get a counter appended.
 */
export const terminalLabels = (terminals: Pick<Session, 'command'>[]): string[] => {
  const names = terminals.map((terminal) => terminal.command?.trim() || 'shell')
  const totals = new Map<string, number>()
  for (const name of names) totals.set(name, (totals.get(name) ?? 0) + 1)
  const seen = new Map<string, number>()
  return names.map((name) => {
    if ((totals.get(name) ?? 0) < 2) return name
    const nth = (seen.get(name) ?? 0) + 1
    seen.set(name, nth)
    return `${name} ${nth}`
  })
}
