import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MachineUsage, Usage, UsageLimit } from '@switchboard/shared'
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

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]

/**
 * `Sep 10, 5:29pm (UTC)` -> an epoch, so the bar can say how long is left.
 *
 * Written out rather than handed to `Date.parse`, which does not take `5:29pm`
 * and is free to guess at anything non-standard. Two things the report leaves
 * out have to be supplied:
 *
 * - **The year.** Whichever one puts the date nearest today, so a reset in
 *   January read in December lands next year rather than eleven months ago.
 * - **The zone**, when the trailing `(...)` is not one this understands. Local
 *   is the better guess than UTC there: a report that names a zone at all
 *   names the reader's own, and being wrong by the offset beats being wrong by
 *   a whole day.
 *
 * Anything that does not match is null, and the caller keeps the prose.
 */
const RESET = /^([a-z]{3,9})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/

const HALF_YEAR_MS = 182 * 24 * 60 * 60 * 1000

export const parseResetAt = (text: string, now = Date.now()): number | null => {
  const zoned = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(text.trim())
  const body = (zoned?.[1] ?? text).trim().toLowerCase()
  const zone = zoned?.[2]?.trim().toLowerCase()
  const utc = zone === undefined || zone === 'utc' || zone === 'gmt' || zone === 'z'
  const match = RESET.exec(body)
  if (!match) return null
  const [, monthName, day, hour, minute, meridiem] = match
  const month = MONTHS.indexOf((monthName ?? '').slice(0, 3))
  if (month === -1) return null
  const dayNumber = Number(day)
  const minuteNumber = minute === undefined ? 0 : Number(minute)
  let hourNumber = Number(hour)
  if (hourNumber === 12) hourNumber = 0
  if (meridiem === 'pm') hourNumber += 12
  if (dayNumber < 1 || dayNumber > 31 || hourNumber > 23 || minuteNumber > 59) return null

  const build = (year: number): number =>
    utc
      ? Date.UTC(year, month, dayNumber, hourNumber, minuteNumber)
      : new Date(year, month, dayNumber, hourNumber, minuteNumber).getTime()

  const thisYear = new Date(now).getFullYear()
  let at = build(thisYear)
  if (at - now > HALF_YEAR_MS) at = build(thisYear - 1)
  else if (now - at > HALF_YEAR_MS) at = build(thisYear + 1)
  // A day that does not exist (Feb 31) rolls over into the next month, which is
  // not a reading of anything.
  const check = new Date(at)
  const rolled = utc ? check.getUTCDate() : check.getDate()
  return rolled === dayNumber ? at : null
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
      resetsAt: resets === undefined ? null : parseResetAt(resets),
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

/**
 * Which Claude account `claude` is signed in to, as a short hash.
 *
 * Read from Claude Code's own config, `oauthAccount.accountUuid` in
 * `.claude.json` -- under `CLAUDE_CONFIG_DIR` when that is set, as Claude Code
 * itself does, and in the home directory otherwise. Hashed because this goes
 * to every machine linking this one and the id is all it needs to compare;
 * twelve hex digits make two accounts colliding a non-event. Null rather than
 * a guess when the file or the field is missing: an unknown account is one the
 * similarity of the numbers has to decide.
 */
const accountFingerprint = async (): Promise<string | null> => {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? homedir()
  try {
    const parsed = JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8')) as {
      oauthAccount?: { accountUuid?: unknown }
    }
    const id = parsed.oauthAccount?.accountUuid
    if (typeof id !== 'string' || id === '') return null
    return createHash('sha256').update(id).digest('hex').slice(0, 12)
  } catch {
    return null
  }
}

const read = async (): Promise<Usage> => {
  try {
    const limits = parseUsage(await run())
    // An empty parse is a failure, not a reading: `/usage` says something else
    // entirely when it cannot answer (not signed in, or on the API rather than
    // a subscription), and blank bars would look like a limit of zero.
    if (limits.length === 0) throw new Error('no usage limits in the output')
    const account = await accountFingerprint()
    cached = { limits, fetchedAt: Date.now(), ...(account === null ? {} : { account }) }
    return cached
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Keep the last good numbers and say they are stale. The alternative --
    // dropping them -- loses the only information there is over a failure the
    // next attempt may well clear.
    // Stamped now, so the TTL applies to the failure as well: keeping the old
    // timestamp is what made an error re-enter read() on every single poll.
    cached = {
      limits: cached?.limits ?? [],
      fetchedAt: Date.now(),
      error: message,
      ...(cached?.account === undefined ? {} : { account: cached.account }),
    }
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

/** How far apart two readings' percentages may be and still be the same account's. */
const SAME_PERCENT = 2
/** And their reset times, which `/usage` gives to the minute and each machine parses. */
const SAME_RESET_MS = 15 * 60 * 1000

/**
 * Whether two readings say the same thing: the same limits, each within two
 * points and its reset within a quarter of an hour.
 *
 * The test for a machine whose account is not known -- one older than the
 * `account` field, or whose `.claude.json` could not be read. The same account
 * read on two machines a few minutes apart differs by a point or so as one of
 * them works, and its resets are the same moments; two different accounts
 * almost never reset in the same quarter hour on every limit at once.
 */
export const sameReading = (a: Usage, b: Usage): boolean =>
  a.limits.length === b.limits.length &&
  a.limits.every((limit, index) => {
    const other = b.limits[index]
    if (other === undefined || other.label !== limit.label) return false
    if (Math.abs(other.percent - limit.percent) > SAME_PERCENT) return false
    if (limit.resetsAt === null || other.resetsAt === null) return limit.resetsAt === other.resetsAt
    return Math.abs(other.resetsAt - limit.resetsAt) <= SAME_RESET_MS
  })

/**
 * The machines whose usage is worth a ring of its own, in the order given.
 *
 * A machine is left out when an earlier one is signed in to the same Claude
 * account, or -- when either account is unknown -- reads the same numbers.
 * Linking machines that share one subscription is the common case, and two
 * sets of identical rings would say there were two allowances. A reading with
 * no limits at all says nothing and is left out too.
 */
export const distinctUsages = (machines: MachineUsage[]): MachineUsage[] => {
  const kept: MachineUsage[] = []
  for (const machine of machines) {
    if (machine.usage.limits.length === 0) continue
    const duplicate = kept.some(({ usage }) => {
      if (usage.account !== undefined && machine.usage.account !== undefined) {
        return usage.account === machine.usage.account
      }
      return sameReading(usage, machine.usage)
    })
    if (!duplicate) kept.push(machine)
  }
  return kept
}
