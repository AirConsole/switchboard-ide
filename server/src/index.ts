import { existsSync } from 'node:fs'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { config, tmuxSocketPath } from './config.js'
import { SessionEngine } from './session/engine.js'
import { StateStore } from './state.js'
import { Workspace } from './workspace.js'
import { registerApi } from './routes/api.js'
import { startDispatcher } from './session/dispatch.js'
import { registerWs } from './routes/ws.js'
import { allowRequest, isLoopback } from './gate.js'
import { registerProxy } from './remote/proxy.js'
import { PROTOCOL_HEADER } from './remote/peer.js'
import { PROTOCOL_VERSION } from '@switchboard/shared'

const app = Fastify({
  logger: {
    level: process.env.SWB_LOG_LEVEL ?? 'info',
    transport: config.isDev ? { target: 'pino-pretty' } : undefined,
  },
})

const store = new StateStore()
const engine = new SessionEngine()
const workspace = new Workspace(store, engine)

await store.load()
await engine.start()

await app.register(fastifyWebsocket, {
  options: {
    // Terminal output frames are small; the default 100MB limit is pointless
    // here, and a lower cap bounds the damage from a malformed frame.
    maxPayload: 8 * 1024 * 1024,
  },
})

/*
 * The IDE outliving a bug in itself.
 *
 * Everything valuable here lives in tmux, not in this process, so a crash costs
 * only the fan-out -- but it costs it for every open browser at once, and the
 * sessions it was watching keep running unattended until someone notices. A
 * malformed WebSocket frame used to do exactly that (see parseClientMsg), and
 * the frame is validated now; this is the floor under whatever the next one
 * turns out to be. Logged loudly rather than swallowed: a server that hides its
 * own faults is worse than one that falls over.
 */
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaught exception; the server is staying up')
})
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled rejection; the server is staying up')
})

/*
 * The API's gate, which does nothing at all unless this instance is somebody's
 * peer (`SWB_TOKEN`). See gate.ts for the two callers it recognises.
 *
 * **Keyed on the route Fastify matched, never on the URL text.** `request.url`
 * is the raw request target and the router matches the decoded path, so the two
 * disagree and every spelling of that disagreement was a way through: measured
 * against a real peer with a token set and none supplied, `GET /%61pi/snapshot`
 * returned the full snapshot, `/ap%69/...` likewise, an absolute-form target
 * (`GET http://evil/api/snapshot`) did not start with `/api` at all, and
 * `POST /%61pi/sessions` spawned a live shell in one of the peer's worktrees.
 * `routeOptions.url` is what actually answered -- `/api/sessions` -- and it is
 * the same string however the client spelled it.
 *
 * Registered before the routes so a route added later is covered by it without
 * anyone remembering to. `/ws` runs the same rule at its upgrade, where a hook
 * cannot reach.
 */
/*
 * Every reply says which protocol this server speaks, so a gateway compares it
 * on every read rather than only when the machine was added -- the other side
 * is upgraded on its own schedule, and a version skew is otherwise silent.
 */
app.addHook('onSend', async (_request, reply, payload) => {
  void reply.header(PROTOCOL_HEADER, String(PROTOCOL_VERSION))
  return payload
})

app.addHook('onRequest', async (request, reply) => {
  const route = request.routeOptions.url
  if (route === undefined || !route.startsWith('/api')) {
    /*
     * Not an API route: the built page and its assets. On a peer they are
     * served to this machine only, which is what makes "serves only this
     * machine" true of the process rather than only of `/api` and `/ws`. A
     * peer's own UI is unusable from anywhere else anyway -- its fetches back
     * here are refused -- so this serves nobody a page that could work, and it
     * stops a peer bound to the network advertising an IDE at all.
     *
     * 404 rather than 401: there is nothing here to authenticate *to*.
     */
    if (config.token !== undefined && route !== undefined && !isLoopback(request)) {
      await reply.status(404).send({ error: 'not found' })
    }
    return
  }
  // `/api/health` says `{ok:true}` and nothing else, and it is what `deploy.sh`
  // and `scratch.sh` poll with curl -- neither a browser nor a gateway. An
  // exact match, not a prefix: `startsWith` also exempted `/api/healthz` and
  // anything else someone might later add under that stem.
  if (route === '/api/health') return
  if (allowRequest(request)) return
  await reply.status(401).send({ error: 'not allowed' })
})

registerProxy(app, workspace)

const { broadcastInvalidate, clientCount } = registerWs(app, engine, workspace)
registerApi(app, { store, engine, workspace, broadcastInvalidate })

// Session changes alter the snapshot (a session dying, for instance), so drop
// the worktree cache when they happen.
engine.onSessionChange(() => workspace.invalidate())

/*
 * Hand queued todos to Claude as it comes to rest.
 *
 * Started unconditionally, and on its own clock: unlike the worktree poll
 * below, this must keep working with every browser closed -- a queue that only
 * drains while someone is watching it is a queue you have to watch.
 */
startDispatcher({
  store,
  engine,
  onChange: () => {
    workspace.invalidate()
    broadcastInvalidate()
  },
  pathFor: async (worktreeId) => {
    try {
      return (await workspace.resolve(worktreeId)).worktree.path
    } catch {
      // The worktree is gone or its project is unreadable; its queue waits.
      return undefined
    }
  },
})

/**
 * Notice when an agent changes the repository.
 *
 * Worktree state -- branch, HEAD, dirty count -- was only computed when a
 * client asked for a snapshot, and snapshots are only asked for after a
 * mutation or on reconnect. So the dirty count was whatever it had been at page
 * load, and an agent editing or committing changed nothing on screen: the point
 * of the files panel's Changes mode is precisely to see that.
 *
 * Polled rather than watched, because a watcher would not remove the work. The
 * only reliable answer to "what changed" comes from git itself, so a filesystem
 * watch decides *when* to run `git status`, not whether -- and the recursive
 * watch it would need is the expensive, fragile half (an inotify watch per
 * directory, node_modules exhausting the limit, an exclude list to maintain).
 * Watching each worktree's `.git` would be cheap and would catch commits
 * instantly, but it sees nothing when a file is merely edited, which is most of
 * what an agent does.
 *
 * What it does avoid is spending anything when nobody is looking: with no
 * client connected there is no snapshot to keep fresh, so the poll does not run
 * at all.
 */
const WORKTREE_POLL_MS = 4000
setInterval(() => {
  if (clientCount() === 0) return
  void workspace.pollChanged().then((changed) => {
    if (changed) broadcastInvalidate()
  })
}, WORKTREE_POLL_MS).unref()

/**
 * In dev the Vite server serves the UI and proxies here, so there is no build to
 * serve. In production the built SPA is served from disk with a catch-all so
 * client-side routes survive a reload.
 */
if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist })
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
      void reply.status(404).send({ error: 'not found' })
      return
    }
    void reply.sendFile('index.html')
  })
} else {
  app.log.warn(`web build not found at ${config.webDist}; run the Vite dev server`)
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`${signal} received, shutting down`)
  try {
    // Only our own pty clients and the HTTP server go away. tmux sessions are
    // deliberately left running so Claude keeps working across a restart.
    await engine.stop()
    await store.flush()
    await app.close()
  } finally {
    process.exit(0)
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal))
}

/*
 * Failing to listen is fatal, and has to say so here.
 *
 * The `uncaughtException` handler above deliberately keeps the process alive
 * through a fault, and a top-level await that rejects reaches it -- so a second
 * server started on a port already in use logged EADDRINUSE, stayed up, and
 * answered nothing at all, which is worse than the crash it replaced. Measured
 * while starting a scratch instance twice. Everything else may be survivable;
 * a server with no socket is not.
 */
try {
  await app.listen({ host: config.host, port: config.port })
} catch (err) {
  app.log.error({ err }, `cannot listen on ${config.host}:${config.port}`)
  process.exit(1)
}
app.log.info(`Switchboard on http://${config.host}:${config.port} (tmux socket ${tmuxSocketPath})`)
