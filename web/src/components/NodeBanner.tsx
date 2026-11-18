import { useEffect, useState } from 'react'
import type { MachineNode } from '@switchboard/shared'
import { api } from '../api.js'

/**
 * How often the page asks. The server reads nodejs.org's release list at most
 * once an hour whoever asks, so this is only how soon a page notices.
 */
const POLL_MS = 10 * 60 * 1000

/** The notice somebody said "Later" to, so the banner stays away until the next security release. */
const LATER_KEY = 'swb.node.later'

const recall = (): string | null => {
  try {
    return window.localStorage.getItem(LATER_KEY)
  } catch {
    return null
  }
}

const remember = (value: string): void => {
  try {
    window.localStorage.setItem(LATER_KEY, value)
  } catch {
    // Private mode: it lasts as long as the page does.
  }
}

/**
 * The machines behind on a Node security release, and what each should run.
 * Its identity is every pair of the two, so "Later" lasts exactly until a
 * machine's advice changes -- a newer release, or another machine falling
 * behind -- and never hides a fix it was not shown.
 */
export const nodeNotice = (
  machines: MachineNode[],
): { key: string; lines: { name: string; running: string; update: string }[] } | null => {
  const lines = machines.flatMap((machine) =>
    machine.node.update === null ? [] : [{ name: machine.name, running: machine.node.running, update: machine.node.update }],
  )
  if (lines.length === 0) return null
  return { key: lines.map((line) => `${line.name}@${line.update}`).join(' '), lines }
}

/**
 * A Node security release a machine here has not installed.
 *
 * Only for the machines nothing patches by itself: Node from nvm or fnm goes
 * in beside the old one, so it changes when a person changes it. About six
 * times a year -- the security releases each Node line had in 2026 -- and
 * until the machine runs the release, since "Later" lasts only to the next.
 * Greyscale like the update banner: it is about the machine, not an agent.
 */
export const NodeBanner = (): React.ReactElement | null => {
  const [machines, setMachines] = useState<MachineNode[]>([])
  const [later, setLater] = useState<string | null>(recall)

  useEffect(() => {
    const tick = (): void => {
      if (document.hidden) return
      api.nodeMachines().then(setMachines, () => {})
    }
    tick()
    const timer = window.setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [])

  const notice = nodeNotice(machines)
  if (notice === null || notice.key === later) return null
  const one = notice.lines.length === 1
  return (
    <div className="banner banner--update">
      <span className="banner__text">
        A Node security release is out.{' '}
        {notice.lines.map((line, index) => (
          <span key={line.name}>
            {index > 0 && '; '}
            {one ? `${line.name} runs ${line.running}: install ${line.update}` : `${line.name}: ${line.running} → ${line.update}`}
          </span>
        ))}
        , then <code>pnpm restart</code> there. Agents keep running.
      </span>
      <button
        className="banner__dismiss"
        onClick={() => {
          remember(notice.key)
          setLater(notice.key)
        }}
      >
        Later
      </button>
    </div>
  )
}
