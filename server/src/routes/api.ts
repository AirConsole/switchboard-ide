import type { FastifyInstance } from 'fastify'
import type { SessionKind } from '@ide-n-dream/shared'
import { z } from 'zod'
import type { SessionEngine } from '../session/engine.js'
import type { StateStore } from '../state.js'
import { HttpError, type Workspace } from '../workspace.js'
import { commitDiff, fileDiff, worktreeChanges } from '../git/changes.js'
import { claudeArgs } from '../session/claude.js'

/**
 * How long a Claude started with `--continue` gets to prove it survived.
 *
 * `claude --continue` refuses outright when the conversation it would resume is
 * already running somewhere else -- it prints why and exits 1, measured at 1.1s
 * -- and a worktree in that state could never be started from here: every click
 * respawned the same refusal, and the message was never on screen to say so.
 * Comfortably longer than the measured failure, and paid only in the background.
 */
const CONTINUE_GRACE_MS = 5000

/** Lines of a dead session's output the UI is given to explain the exit. */
const TAIL_LINES = 20

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
/** A prompt is a paragraph, not an essay; the cap is a sanity bound, not a rule. */
const PROMPT_MAX = 20_000

const createTodoBody = z.object({
  title: z.string().max(200).optional(),
  prompt: z.string().min(1).max(PROMPT_MAX),
})

const patchTodoBody = z.object({
  /** Null clears the title; absent leaves it alone. */
  title: z.string().max(200).nullable().optional(),
  prompt: z.string().min(1).max(PROMPT_MAX).optional(),
  /** RUN NEXT. True appends to the end of this worktree's queue. */
  queued: z.boolean().optional(),
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
    await workspace.closeProject(id)
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
  /*
   * Todos ride the snapshot rather than having a GET of their own: the client
   * already refetches it on every invalidate, and a second way to read them
   * would be a second thing that can disagree.
   */
  app.post('/api/worktrees/:id/todos', async (request) => {
    const { id } = request.params as { id: string }
    const body = createTodoBody.parse(request.body)
    const todo = await workspace.createTodo({ worktreeId: id, ...body })
    broadcastInvalidate()
    return todo
  })

  app.patch('/api/todos/:id', async (request) => {
    const { id } = request.params as { id: string }
    const patch = patchTodoBody.parse(request.body)
    const todo = workspace.updateTodo(id, patch)
    broadcastInvalidate()
    return todo
  })

  app.delete('/api/todos/:id', async (request) => {
    const { id } = request.params as { id: string }
    workspace.deleteTodo(id)
    broadcastInvalidate()
    return { ok: true }
  })

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
    if (session && args.includes('--continue')) void fallBackIfContinueRefused(session.id)
    return { ok: true, session }
  })

  /**
   * The last thing a session printed, so the interface can say why it stopped
   * instead of only that it did.
   */
  app.get('/api/sessions/:id/tail', async (request) => {
    const { id } = request.params as { id: string }
    if (!engine.get(id)) throw new HttpError(404, 'no such session')
    return { lines: await engine.tail(id, TAIL_LINES) }
  })

  /**
   * Start the conversation over when `--continue` bounced off it.
   *
   * Deliberately not awaited by the request: the refusal takes about a second
   * to happen and a wake that is going to work must not wait for it. The client
   * learns about the restart through the invalidate, like any other change.
   *
   * Only a non-zero exit qualifies. Someone typing /exit within the window exits
   * zero, and restarting Claude under them would be the opposite of helpful.
   */
  /** Sessions a fallback is already watching; see below. */
  const watchedForRefusal = new Set<string>()

  const fallBackIfContinueRefused = async (sessionId: string): Promise<void> => {
    // One watcher per session. Two clicks landing in the moment between the
    // refusal and the restart would otherwise leave a second watcher behind,
    // and it would kill the Claude the first one had just started.
    if (watchedForRefusal.has(sessionId)) return
    watchedForRefusal.add(sessionId)
    try {
      if (!(await engine.failedWithin(sessionId, CONTINUE_GRACE_MS))) return
      // No args: the conversation could not be resumed, so this is a fresh one.
      if (await engine.respawn(sessionId, [])) broadcastInvalidate()
    } finally {
      watchedForRefusal.delete(sessionId)
    }
  }

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
