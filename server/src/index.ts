import { existsSync } from 'node:fs'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { config, tmuxSocketPath } from './config.js'
import { SessionEngine } from './session/engine.js'
import { StateStore } from './state.js'
import { Workspace } from './workspace.js'
import { registerApi } from './routes/api.js'
import { registerWs } from './routes/ws.js'

const app = Fastify({
  logger: {
    level: process.env.IDN_LOG_LEVEL ?? 'info',
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

const { broadcastInvalidate } = registerWs(app, engine)
registerApi(app, { store, engine, workspace, broadcastInvalidate })

// Session changes alter the snapshot (a session dying, for instance), so drop
// the worktree cache when they happen.
engine.onSessionChange(() => workspace.invalidate())

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

await app.listen({ host: config.host, port: config.port })
app.log.info(`ide-n-dream on http://${config.host}:${config.port} (tmux socket ${tmuxSocketPath})`)
