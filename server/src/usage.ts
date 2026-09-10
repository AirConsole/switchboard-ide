import { execFile } from 'node:child_process'
import type { Usage, UsageLimit } from '@ide-n-dream/shared'
import { config } from './config.js'

/**
 * How long a reading stays good.
 *
 * The numbers move in single percent steps over minutes, and asking costs a
 * `claude` process (measured 4.3-4.6s), so a request inside the window is
 * answered from the last reading rather than starting another. Nothing runs on
 * a timer: no client asking means no process spawned, which is the same rule
 * the git polling follows.
 */
const TTL_MS = 5 * 60 * 1000

/** Longer than the 4.6s measured, short enough that a hung `claude` clears. */
const TIMEOUT_MS = 60 * 1000

/** A misparse should not fill the bar with a hundred rows. */
const MAX_LIMITS = 8

/**
 * The lines we want out of `/usage`:
 *
 *     Current session: 68% used · resets Sep 9, 4:50pm (UTC)
 *     Current week (all models): 18% used · resets Sep 15, 9am (UTC)
 *     Current week (Fable): 0% used · resets Sep 15, 9am (UTC)
 *
 * `% used` is what makes this safe to run over the whole output: the rest of
 * the report is full of percentages ("96% of your usage came from subagent-heavy
 * sessions") and none of them is a limit. The reset clause is optional because
 * it is prose, and prose is the first thing to change.
 */
const LIMIT = /^\s*(.{1,60}?):\s*(\d{1,3})%\s+used(?:\s*·\s*resets\s+(.{1,60}?))?\s*$/

/**
 * What to call a limit in a bar 40 pixels wide.
 *
 * Claude names them in a sentence ("Current week (all models)"); the bar has
 * room for a word. Anything unrecognised keeps its own name, lower-cased, so a
 * limit we have never seen still appears with a label rather than being
 * dropped.
 */
const shorten = (name: string): string => {
  const lower = name.toLowerCase()
  if (lower === 'current session') return 'session'
  if (lower === 'current week (all models)') return 'week'
  const model = /^current week \((.+)\)$/.exec(lower)
  if (model?.[1] !== undefined) return model[1]
  return lower.replace(/^current\s+/, '')
}

/** Every limit `/usage` reported, in the order it reported them. */
export const parseUsage = (text: string): UsageLimit[] => {
  const limits: UsageLimit[] = []
  for (const line of text.split('\n')) {
    const match = LIMIT.exec(line)
    if (!match) continue
    const [, name, percent, resets] = match
    if (name === undefined || percent === undefined) continue
    const value = Number(percent)
    if (!Number.isFinite(value)) continue
    limits.push({
      label: shorten(name),
      percent: Math.min(100, Math.max(0, value)),
      resets: resets ?? null,
    })
    if (limits.length >= MAX_LIMITS) break
  }
  return limits
}

const run = (): Promise<string> =>
  new Promise((resolve, reject) => {
    /*
     * `-p` and nothing else. Print mode answers a slash command as plain text,
     * which is why this needs no pty and no screen scraping -- and `--bare`
     * does NOT work: it skips whatever handles the command and prints a cost
     * summary instead. Run in the state directory, which is ours and holds no
     * project settings or hooks to inherit.
     *
     * `config.usageCommand` rather than `claudeCommand`, because that one is
     * the stand-in a scratch instance replaces with vim or bash.
     */
    execFile(
      config.usageCommand,
      ['-p', '/usage'],
      { cwd: config.stateDir, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error instanceof Error ? error : new Error(String(error)))
        else resolve(stdout)
      },
    )
  })

let cached: Usage | null = null
/** The read in flight, so two clients asking at once spawn one process. */
let reading: Promise<Usage> | null = null

const read = async (): Promise<Usage> => {
  try {
    const limits = parseUsage(await run())
    // An empty parse is a failure, not a reading: `/usage` says something else
    // entirely when it cannot answer (not signed in, or on the API rather than
    // a subscription), and blank bars would look like a limit of zero.
    if (limits.length === 0) throw new Error('no usage limits in the output')
    cached = { limits, fetchedAt: Date.now() }
    return cached
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Keep the last good numbers and say they are stale. The alternative --
    // dropping them -- loses the only information there is over a failure the
    // next attempt may well clear.
    // Stamped now, so the TTL applies to the failure as well: keeping the old
    // timestamp is what made an error re-enter read() on every single poll.
    cached = { limits: cached?.limits ?? [], fetchedAt: Date.now(), error: message }
    return cached
  } finally {
    reading = null
  }
}

/** The current reading, taken now if the last one has expired. */
export const usage = async (): Promise<Usage> => {
  // An error is a reading too. Excluding it here meant a `claude` that could
  // not answer was re-spawned on every poll of every open tab -- the opposite
  // of what the TTL is for, and each attempt costs seconds.
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached
  reading ??= read()
  return reading
}
