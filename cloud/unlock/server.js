/**
 * The page that opens the machine.
 *
 * After a boot, /home is a locked LUKS volume and the IDE is not running, so
 * Caddy's 502 falls through to here and `https://<ip>` shows this instead. The
 * password is the IDE's own -- there is exactly one secret on this machine --
 * and the key it derives is what cryptsetup takes.
 *
 * **There is no stored verifier, deliberately.** Whether a password is right is
 * decided by whether cryptsetup opens the volume with the key derived from it.
 * A verifier on the boot disk would be a second copy of the truth, and the
 * failure mode of two copies is a machine that accepts a password it cannot
 * open with -- after a password change that updated one of them.
 *
 * It is a password oracle on the public internet, so it follows the rules
 * `server/src/auth.ts` arrived at:
 *   - one attempt at a time, chained, because each is 64MB of scrypt and a
 *     handful in parallel is a way to exhaust the machine from outside;
 *   - every attempt waits the same floor whether it was right or wrong, so
 *     timing says nothing;
 *   - counted, never outcome-keyed: a ramp that resets on success answers the
 *     previous guess for the attacker.
 *
 * The count resets when this service does, which is once per boot -- and a
 * boot is also the only thing that makes it reachable again, since it answers
 * only while the volume is shut.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { deriveKey, volumeSalt } from './derive.js'

const run = promisify(execFile)

/**
 * Run a command with something on its stdin.
 *
 * `execFile`'s options have no `input` -- that belongs to `execFileSync`, and
 * passing it to the async one is silently ignored. Measured: the unlock page
 * hung for the whole of a 60-second timeout, because cryptsetup was waiting on
 * a stdin nobody was ever going to close.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} input
 * @returns {Promise<void>}
 */
const runWithInput = (cmd, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`)),
    )
    child.stdin.end(input)
  })
const PORT = Number(process.env.SWB_UNLOCK_PORT ?? 7998)
const DEVICE = process.env.SWB_DATA_DEV ?? '/dev/disk/by-id/google-switchboard-data'
const MAPPER = process.env.SWB_MAPPER ?? 'switchboard-data'
const MOUNT = process.env.SWB_MOUNT ?? '/home'

/** The floor every answer waits for, right or wrong. */
const FLOOR_MS = 1000

let queue = Promise.resolve()
let attempts = 0

const unlocked = () => existsSync(`/dev/mapper/${MAPPER}`)

const openVolume = async (password) => {
  const key = await deriveKey(password, volumeSalt(DEVICE))
  await runWithInput('cryptsetup', ['open', '--key-file=-', DEVICE, MAPPER], key)
  await run('mount', [`/dev/mapper/${MAPPER}`, MOUNT])
  // Everything that could not happen while the volume was shut: the user's
  // home, the IDE's settings, the packages an agent installed before the last
  // rebuild, and then the IDE itself.
  await run('systemctl', ['start', 'switchboard-unlocked.service'])
}

/*
 * Attempts are serialised, and the wait does not depend on the answer. The
 * ramp is on the *count*, so a correct password does not reset it -- that was
 * the measured mistake in the IDE's own login, where resetting on success let
 * the next reply answer for the previous guess.
 */
const attempt = (password) => {
  const mine = queue.then(async () => {
    attempts += 1
    const ramp = Math.min(attempts * 250, 10_000)
    const started = Date.now()
    let ok = false
    try {
      await openVolume(password)
      ok = true
    } catch {
      ok = false
    }
    const waited = Date.now() - started
    const floor = FLOOR_MS + ramp
    if (waited < floor) await new Promise((r) => setTimeout(r, floor - waited))
    return ok
  })
  queue = mine.then(
    () => undefined,
    () => undefined,
  )
  return mine
}

const PAGE = (message) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Switchboard</title>
<style>
  :root { color-scheme: dark; --ink: #e8e6e3; --dim: #a8a29b; --slab: #1a1a19; --line: #333230; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0e0e0d; color: var(--ink);
         font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
  form { background: var(--slab); border: 1px solid var(--line); border-radius: 6px;
         padding: 28px; width: min(360px, calc(100vw - 32px)); }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
  p { color: var(--dim); margin: 0 0 20px; font-size: 13px; }
  input { width: 100%; box-sizing: border-box; padding: 9px 10px; margin-bottom: 12px;
          background: #0e0e0d; border: 1px solid var(--line); border-radius: 4px;
          color: var(--ink); font: inherit; }
  button { width: 100%; padding: 9px; border: 1px solid var(--line); border-radius: 4px;
           background: #262624; color: var(--ink); font: inherit; cursor: pointer; }
  .msg { color: #d9a441; font-size: 13px; margin: 12px 0 0; }
</style></head>
<body>
  <form method="POST" action="/unlock">
    <h1>Switchboard is locked</h1>
    <p>This machine's data is encrypted. Your IDE password opens it.</p>
    <input type="password" name="password" autofocus autocomplete="current-password" aria-label="Password">
    <button type="submit">Unlock</button>
    ${message ? `<p class="msg">${message}</p>` : ''}
  </form>
</body></html>
`

const WAITING = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Switchboard</title>
<meta http-equiv="refresh" content="3;url=/">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0e0d;
color:#a8a29b;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}</style></head>
<body>Unlocked. Starting the IDE…</body></html>
`

const body = (req) =>
  new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      // A password is short. Anything larger is not one.
      if (data.length > 4096) reject(new Error('too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })

const server = createServer(async (req, res) => {
  const send = (code, html) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  }

  /*
   * This service answers every path Caddy could not reach the IDE on, so it
   * must not answer *as* the IDE. `/api/health` is what `provision.sh` and
   * anything else asks to find out whether the IDE is up, and a page saying
   * "locked" with a 200 on it is a machine reporting itself healthy while it
   * is shut. Everything under /api is 503 here, which is what it is.
   */
  if (req.url?.startsWith('/api/')) {
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    return res.end(JSON.stringify({ error: 'locked', message: 'the data volume is not open' }))
  }

  if (req.method === 'GET') {
    // Once it is open, this service has nothing to say; the IDE answers on its
    // own port and Caddy stops falling through to here.
    return send(200, unlocked() ? WAITING : PAGE(''))
  }

  if (req.method === 'POST' && req.url === '/unlock') {
    // Browser-set and unforgeable inside a browser, which is the only place a
    // cross-site guesser lives. It narrows; the throttle is what protects.
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin') return send(403, PAGE('Refused.'))
    if (unlocked()) return send(200, WAITING)

    let password = ''
    try {
      const raw = await body(req)
      password = new URLSearchParams(raw).get('password') ?? ''
    } catch {
      return send(413, PAGE('Too long.'))
    }
    if (password === '') return send(200, PAGE('Enter the password.'))

    const ok = await attempt(password)
    return send(200, ok ? WAITING : PAGE('That is not the password.'))
  }

  send(405, PAGE(''))
})

// Loopback only: Caddy holds the public address and terminates TLS. A password
// form reachable without TLS is the thing this whole machine is arranged to
// avoid.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`unlock listening on 127.0.0.1:${PORT}, device ${DEVICE}`)
})
