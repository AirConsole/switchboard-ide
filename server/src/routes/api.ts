import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SessionEngine } from '../session/engine.js'
import type { StateStore } from '../state.js'
import { HttpError, type Workspace } from '../workspace.js'

const openProjectBody = z.object({
  path: z.string().min(1),
  /** Create the directory and initialise a repository if it is not there yet. */
  create: z.boolean().default(false),
})
const createWorktreeBody = z.object({
  projectId: z.string().min(1),
  branch: z.string().min(1),
  base: z.string().optional(),
  /** Start a Claude session in the new worktree immediately. */
  startClaude: z.boolean().default(true),
})
const removeWorktreeQuery = z.object({
  force: z.coerce.boolean().default(false),
  deleteBranch: z.coerce.boolean().default(false),
})
const createSessionBody = z.object({
  worktreeId: z.string().min(1),
  kind: z.enum(['claude', 'shell']).default('shell'),
  title: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
})
const uiPatchBody = z.record(z.string(), z.unknown())
const browseQuery = z.object({ path: z.string().default('') })

export interface ApiDeps {
  store: StateStore
  engine: SessionEngine
  workspace: Workspace
  /** Tell every connected client the snapshot changed. */
  broadcastInvalidate: () => void
}

export const registerApi = (app: FastifyInstance, deps: ApiDeps): void => {
  const { store, engine, workspace, broadcastInvalidate } = deps

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      // `code` and `details` travel to the client so it can offer a specific
      // recovery (for example: create the missing directory) instead of just
      // showing the message.
      void reply
        .status(error.status)
        .send({ error: error.message, code: error.code, ...error.details })
      return
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({ error: error.issues.map((i) => i.message).join('; ') })
      return
    }
    app.log.error(error)
    const message = error instanceof Error ? error.message : 'internal error'
    void reply.status(500).send({ error: message })
  })

  app.get('/api/health', async () => ({ ok: true }))

  app.get('/api/snapshot', async () => workspace.snapshot())

  app.get('/api/browse', async (request) => {
    const { path } = browseQuery.parse(request.query)
    return workspace.browse(path)
  })

  app.post('/api/projects', async (request) => {
    const { path, create } = openProjectBody.parse(request.body)
    const project = await workspace.openProject(path, { create })
    broadcastInvalidate()
    return project
  })

  app.delete('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string }
    workspace.closeProject(id)
    broadcastInvalidate()
    return { ok: true }
  })

  app.patch('/api/ui', async (request) => {
    const patch = uiPatchBody.parse(request.body)
    return store.patchUi(patch)
  })

  app.post('/api/worktrees', async (request) => {
    const body = createWorktreeBody.parse(request.body)
    const worktree = await workspace.createWorktree(body)
    // The point of the feature is going from nothing to a working agent in one
    // click, so the session is created here rather than in a second round trip.
    if (body.startClaude) {
      await engine.create({
        worktreeId: worktree.id,
        projectId: worktree.projectId,
        kind: 'claude',
        cwd: worktree.path,
      })
    }
    broadcastInvalidate()
    return { worktree, sessions: engine.listForWorktree(worktree.id) }
  })

  app.delete('/api/worktrees/:id', async (request) => {
    const { id } = request.params as { id: string }
    const { force, deleteBranch } = removeWorktreeQuery.parse(request.query)
    await workspace.removeWorktree({
      worktreeId: id,
      force,
      alsoDeleteBranch: deleteBranch,
    })
    broadcastInvalidate()
    return { ok: true }
  })

  app.post('/api/sessions', async (request) => {
    const body = createSessionBody.parse(request.body)
    const { worktree } = await workspace.resolve(body.worktreeId)
    const session = await engine.create({
      worktreeId: worktree.id,
      projectId: worktree.projectId,
      kind: body.kind,
      cwd: worktree.path,
      title: body.title,
      cols: body.cols,
      rows: body.rows,
    })
    broadcastInvalidate()
    return session
  })

  app.delete('/api/sessions/:id', async (request) => {
    const { id } = request.params as { id: string }
    await engine.kill(id)
    broadcastInvalidate()
    return { ok: true }
  })

  app.post('/api/sessions/:id/respawn', async (request) => {
    const { id } = request.params as { id: string }
    const session = await engine.respawn(id)
    if (!session) throw new HttpError(404, 'no such session')
    broadcastInvalidate()
    return session
  })
}
