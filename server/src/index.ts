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
import { allowRequest } from './gate.js'

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
 * Registered before the routes so a route added later is covered by it without
 * anyone remembering to, and scoped to `/api` because the static SPA and its
 * assets are what a browser asks for before it can ask for anything else. `/ws`
 * runs the same rule at its upgrade, where a hook cannot reach.
 */
app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/api')) return
  // `/api/health` stays open: it says `{ok:true}` and nothing else, and it is
  // what `deploy.sh` and `scratch.sh` poll with curl -- which is neither a
  // browser nor a gateway, and would otherwise have to be handed the token to
  // ask whether the process had come back up.
  if (request.url.startsWith('/api/health')) return
  if (allowRequest(request)) return
  await reply.status(401).send({ error: 'not allowed' })
})

const { broadcastInvalidate, clientCount } = registerWs(app, engine)
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
