import type { NodeAdvice } from '@switchboard/shared'

/**
 * Whether the Node running this server has a security release waiting.
 *
 * A machine whose Node comes from nvm or fnm is never patched by anything but
 * a person: those install a new version beside the old one, so nothing on the
 * machine changes until somebody does it (`cloud/setup.sh` covers the cloud
 * machines, whose Node is a package). This is what tells that person.
 *
 * Security releases only. nodejs.org marks them, and they are what matters:
 * 26 had 21 releases in 2026 and 4 of them were security releases, so counting
 * every release would be a banner every two weeks for fixes nobody needs. The
 * advice is the newest release of the running major, since it carries every
 * earlier fix -- a security fix ships on every supported major at once, so a
 * machine on 24 is told about 24, never sent to 26.
 */

const INDEX_URL = 'https://nodejs.org/dist/index.json'

/**
 * How long the release list is trusted. An hour is soon enough for something
 * released a few times a year, and it is a 250KB download, which every page's
 * ten-minute poll would otherwise repeat.
 */
const TTL_MS = 60 * 60 * 1000

const FETCH_TIMEOUT_MS = 10_000

export interface NodeRelease {
  version: string
  security: boolean
}

type Triple = [number, number, number]

/** `v26.13.1` as numbers, or null for anything else -- pre-releases included. */
const parse = (version: string): Triple | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
}

const newer = (a: Triple, b: Triple): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]

/**
 * What to say about `running` given the release list: the newest release of
 * its major when a security release on that major is newer than it, and null
 * when there is nothing to do or nothing to compare.
 */
export const securityUpdate = (releases: NodeRelease[], running: string): string | null => {
  const here = parse(running)
  if (here === null) return null
  let newest: Triple | null = null
  let fixed = false
  for (const release of releases) {
    const version = parse(release.version)
    if (version === null || version[0] !== here[0] || !newer(version, here)) continue
    if (release.security) fixed = true
    if (newest === null || newer(version, newest)) newest = version
  }
  return fixed && newest !== null ? newest.join('.') : null
}

let cached: { at: number; releases: NodeRelease[] } | null = null
let fetching: Promise<void> | null = null

const refresh = async (): Promise<void> => {
  const response = await fetch(INDEX_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`nodejs.org answered ${String(response.status)}`)
  const body = (await response.json()) as unknown
  if (!Array.isArray(body)) throw new Error('nodejs.org sent something other than a release list')
  const releases: NodeRelease[] = []
  for (const row of body as { version?: unknown; security?: unknown }[]) {
    if (typeof row?.version === 'string') releases.push({ version: row.version, security: row.security === true })
  }
  cached = { at: Date.now(), releases }
}

/**
 * This server's Node and the release it should be on. Offline, the last list
 * that arrived answers, and with none at all there is simply no advice: a
 * banner that cannot know is a banner that says nothing.
 */
export const nodeAdvice = async (): Promise<NodeAdvice> => {
  if (cached === null || Date.now() - cached.at > TTL_MS) {
    fetching ??= refresh()
      .catch(() => {})
      .finally(() => {
        fetching = null
      })
    await fetching
  }
  return {
    running: process.version.replace(/^v/, ''),
    update: cached === null ? null : securityUpdate(cached.releases, process.version),
  }
}
