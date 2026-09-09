import type { FastifyInstance } from 'fastify'
import type { SessionKind } from '@ide-n-dream/shared'
import { z } from 'zod'
import type { SessionEngine } from '../session/engine.js'
import type { StateStore } from '../state.js'
import { HttpError, type Workspace } from '../workspace.js'
import { commitDiff, fileDiff, worktreeChanges } from '../git/changes.js'
import { claudeArgs } from '../session/claude.js'

const openProjectBody = z.object({
  path: z.string().min(1),
  /** Create the directory and initialise a repository if it is not there yet. */
  create: z.boolean().default(false),
  /** With `create`, put files already in the directory into the first commit. */
  commitExisting: z.boolean().default(true),
})
const createWorktreeBody = z.object({
  projectId: z.string().min(1),
  branch: z.string().min(1),
  base: z.string().optional(),
  /** Start a Claude session in the new worktree immediately. */
  startClaude: z.boolean().default(true),
})
/**
 * A boolean in a query string, read by value rather than by truthiness.
 *
 * `z.coerce.boolean()` is wrong here, and dangerously so: it applies
 * JavaScript's Boolean(), for which the string "false" is true. That made
 * "discard uncommitted changes" and "delete the branch" permanently on, so
 * unchecking them still threw away uncommitted work and deleted the branch.
 */
const queryFlag = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1')

const removeWorktreeQuery = z.object({
  force: queryFlag,
  deleteBranch: queryFlag,
})
const sleepQuery = z.object({
  /** Leave Claude thinking; only the tile goes away. */
  keepClaude: queryFlag,
  /** Leave the terminals running, whose scrollback a kill would lose. */
  keepTerminals: queryFlag,
})
const diffQuery = z.object({
  /** An uncommitted file, relative to the worktree. */
  file: z.string().min(1).optional(),
  /** Or a commit to show the patch of. Mutually exclusive with `file`. */
  commit: z.string().min(1).optional(),
  /** An untracked file has no HEAD side, so it is diffed against /dev/null. */
  untracked: queryFlag,
  /** Where a renamed file came from, so the diff reads as a rename. */
  from: z.string().min(1).optional(),
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
    const { path, create, commitExisting } = openProjectBody.parse(request.body)
    const project = await workspace.openProject(path, { create, commitExisting })
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

  /*
   * What a worktree has changed, committed and not.
   *
   * Read-only on purpose: in this workflow the agent commits its own work, so
   * the human's missing capability is seeing what it did, not driving git.
   */
  app.get('/api/worktrees/:id/changes', async (request) => {
    const { id } = request.params as { id: string }
    const { worktree, project } = await workspace.resolve(id)
    return worktreeChanges({
      worktreeId: worktree.id,
      root: project.root,
      path: worktree.path,
      isMain: worktree.isMain,
    })
  })

  app.get('/api/worktrees/:id/diff', async (request) => {
    const { id } = request.params as { id: string }
    const query = diffQuery.parse(request.query)
    const { worktree } = await workspace.resolve(id)
    if (query.commit !== undefined) {
      return { patch: await commitDiff(worktree.path, query.commit) }
    }
    if (query.file === undefined) {
      throw new HttpError(400, 'Ask for either a file or a commit')
    }
    return {
      patch: await fileDiff(worktree.path, query.file, query.untracked, query.from),
    }
  })

  /*
   * Put a worktree to sleep: stop what it is running.
   *
   * The awake/asleep list itself is the client's -- what is on screen is a UI
   * question -- but killing processes is not something a client can do, and
   * neither is the invalidate that tells every other client the sessions have
   * gone. A kill emits no event of its own.
   */
  app.post('/api/worktrees/:id/sleep', async (request) => {
    const { id } = request.params as { id: string }
    const { keepClaude, keepTerminals } = sleepQuery.parse(request.query)
    const { worktree } = await workspace.resolve(id)
    const kinds: SessionKind[] = []
    if (!keepClaude) kinds.push('claude')
    if (!keepTerminals) kinds.push('shell')
    if (kinds.length > 0) await engine.killForWorktree(worktree.id, kinds)
    broadcastInvalidate()
    return { ok: true, sessions: engine.listForWorktree(worktree.id) }
  })

  /*
   * Wake a worktree: make sure Claude is running in it, carrying on where it
   * left off.
   *
   * Three cases, and the third is the one that matters. A live session is left
   * alone. A dead record is revived in place, which keeps its tmux window and
   * scrollback. And a worktree whose session was killed by sleeping has no
   * record at all, so it gets a new one -- with `--continue`, or the
   * conversation would silently start over.
   */
  app.post('/api/worktrees/:id/wake', async (request) => {
    const { id } = request.params as { id: string }
    const { worktree } = await workspace.resolve(id)
    const existing = engine
      .listForWorktree(worktree.id)
      .find((session) => session.kind === 'claude')

    if (existing && existing.liveness !== 'dead') {
      return { ok: true, session: existing }
    }
    const args = await claudeArgs(worktree.path, true)
    const session = existing
      ? await engine.respawn(existing.id, args)
      : await engine.create({
          worktreeId: worktree.id,
          projectId: worktree.projectId,
          kind: 'claude',
          cwd: worktree.path,
          args,
        })
    broadcastInvalidate()
    return { ok: true, session }
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
