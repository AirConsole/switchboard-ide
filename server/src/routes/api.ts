import { createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { MACHINE_WORKTREE_ID, PROTOCOL_VERSION, type SessionKind } from '@switchboard/shared'
import { z } from 'zod'
import type { SessionEngine } from '../session/engine.js'
import type { StateStore } from '../state.js'
import { HttpError } from '../http-error.js'
import type { Workspace } from '../workspace.js'
import { commitDiff, fileDiff, worktreeChanges } from '../git/changes.js'
import { claudeArgs } from '../session/claude.js'
import { config } from '../config.js'
import { hostKeyFor } from '../remote/scope.js'
import { PEER_READ_HEADER } from '../remote/peer.js'
import { usage } from '../usage.js'

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
  deleteRemoteBranch: queryFlag,
})
const branchQuery = z.object({ name: z.string() })
const closeProjectQuery = z.object({
  /** Stop everything the project is running on the way out. */
  sleep: queryFlag,
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

const createTodoBody = z.object({ prompt: z.string().min(1).max(PROMPT_MAX) })

const patchTodoBody = z.object({
  prompt: z.string().min(1).max(PROMPT_MAX).optional(),
  /** RUN NEXT. True appends to the end of this worktree's queue. */
  queued: z.boolean().optional(),
  /** Move it to another worktree: the work was parked against the wrong agent. */
  worktreeId: z.string().min(1).optional(),
})

/*
 * A worktree-relative path. `''` is the worktree root, which is a directory the
 * browser must be able to list, so there is no `.min(1)` here.
 *
 * Everything else about it -- `..`, an absolute path, a NUL, a symlink pointing
 * out of the tree -- is decided by `containedPath` against the real filesystem,
 * because none of those are questions a string schema can answer.
 */
const filePath = z.string()
const treeQuery = z.object({ path: filePath.default('') })
const findQuery = z.object({
  /** What to look for. Empty finds nothing rather than everything. */
  q: z.string().default(''),
})
const fileQuery = z.object({
  path: filePath.min(1),
  /** The rev the client already holds; unchanged files then cost one stat. */
  ifNotRev: z.string().optional(),
})
/**
 * `/raw`'s query. `rev` is accepted and ignored -- it is a cache key the client
 * puts in the URL, not something the server reads; see the route.
 *
 * `download` asks for the bytes to be handed over rather than drawn, which is
 * the only thing that reaches a file the panel would not open at all.
 */
const rawQuery = z.object({
  path: filePath.min(1),
  rev: z.string().optional(),
  download: z.literal('1').optional(),
})
const saveFileBody = z.object({
  path: filePath.min(1),
  /** No `.min(1)`: saving a file empty is a legitimate edit. */
  text: z.string(),
  /** Required. A save is always to a file that was read first. */
  ifRev: z.string().min(1),
})
/*
 * The UI blob is the client's, but it is also persisted and served to every
 * other client, so its *shape* is the server's business: `PATCH /api/ui
 * {"awake":"everything"}` used to stick, and no later call could undo it
 * because a patch can only overwrite a key with another unchecked value.
 */
export const uiShape = z
  .object({
    // The panel and mode names are the shared unions; anything else in the
    // list would be filtered by the client anyway, and storing it helps nobody.
    panels: z.record(z.string(), z.array(z.enum(['todo', 'files', 'terminals']))),
    activeTerminalByWorktree: z.record(z.string(), z.string()),
    openPathByWorktree: z.record(z.string(), z.string()),
    expandedByWorktree: z.record(z.string(), z.array(z.string())),
    filesModeByWorktree: z.record(z.string(), z.enum(['files', 'changes', 'commits'])),
    openFilesByWorktree: z.record(z.string(), z.array(z.string())),
    markdownPreview: z.boolean(),
    /*
     * How many times the keyboard walk has been used, which the row reads to
     * decide whether to draw the shortcut unasked. A count, so: a whole number
     * and not a negative one.
     */
    stepsTaken: z.number().int().min(0),
  })
  .partial()

const uiPatchBody = uiShape
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

  /*
   * Who this machine is, for a gateway that has just been pointed at it.
   *
   * The version is here rather than in a header so a mismatch is a reply a
   * human can be shown, naming both numbers. It is compared on every read and
   * not only when a peer is added, because the other machine is upgraded on its
   * own schedule.
   */
  app.get('/api/server', async () => ({
    name: config.serverName,
    protocolVersion: PROTOCOL_VERSION,
    // So a gateway can tell this machine from itself, whatever address it used.
    instanceId: config.instanceId,
  }))

  /*
   * `localOnly` when another machine is the one asking. See `Workspace.snapshot`:
   * without it, two instances pointed at each other recurse.
   */
  app.get('/api/snapshot', async (request) =>
    workspace.snapshot({ localOnly: request.headers[PEER_READ_HEADER] !== undefined }),
  )

  /*
   * Claude's own usage limits, cached for five minutes.
   *
   * Reading them costs a `claude -p /usage` process, so the cache is the point:
   * the client polls on its own clock and every poll inside the window is
   * answered from the last reading. See server/src/usage.ts.
   */
  app.get('/api/usage', async () => usage())

  app.get('/api/browse', async (request) => {
    const { path } = browseQuery.parse(request.query)
    return workspace.browse(path)
  })

  /*
   * Projects that were closed, for the picker to offer back. Its own endpoint
   * rather than a field on the snapshot: the snapshot is polled, and answering
   * this stats every remembered path.
   */
  app.get('/api/recents', async () => workspace.recentProjects())

  app.post('/api/projects', async (request) => {
    const { path, create, commitExisting } = openProjectBody.parse(request.body)
    const project = await workspace.openProject(path, { create, commitExisting })
    broadcastInvalidate()
    return project
  })

  /*
   * Closing a project takes it out of the top bar. With `sleep`, it also stops
   * every session the project has running -- which the client asks about,
   * because those processes outlive the browser and would otherwise be left
   * alive with nothing on screen owning them.
   */
  /**
   * The machines this one can read from.
   *
   * Never the credential: this is the picker's list, and the token that reaches
   * a peer is held here and sent server to server.
   */
  app.get('/api/servers', async () =>
    store.servers.map((server) => ({
      key: hostKeyFor(server.baseUrl),
      baseUrl: server.baseUrl,
      name: server.name,
      /** Whether that machine still accepts this one. Never the credential. */
      refused: workspace.linkRefused(server.baseUrl),
    })),
  )

  app.post('/api/servers', async (request) => {
    const body = z
      .object({
        baseUrl: z.string().min(1),
        /*
         * That machine's password, typed once and exchanged for a link token
         * there. It reaches this server and goes no further than the one login
         * request; it is never stored.
         */
        password: z.string().min(1).optional(),
        /** A static `SWB_TOKEN`, still accepted for a machine set up that way. */
        token: z.string().min(1).optional(),
      })
      .refine((b) => b.password !== undefined || b.token !== undefined, {
        message: 'that machine’s password',
      })
      .parse(request.body)
    const server = await workspace.addServer(body)
    // Other tabs, and this tab's own relay, have to learn there is a machine.
    broadcastInvalidate()
    return { key: hostKeyFor(server.baseUrl), baseUrl: server.baseUrl, name: server.name }
  })

  app.delete('/api/servers', async (request) => {
    const body = z.object({ baseUrl: z.string().min(1) }).parse(request.body)
    workspace.removeServer(body.baseUrl)
    broadcastInvalidate()
    return { ok: true }
  })

  app.delete('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string }
    const { sleep } = closeProjectQuery.parse(request.query)
    await workspace.closeProject(id, { sleep })
    broadcastInvalidate()
    return { ok: true }
  })

  app.patch('/api/ui', async (request) => {
    const patch = uiPatchBody.parse(request.body)
    return store.patchUi(patch)
  })

  /*
   * Whether a branch name is already taken, so the form can say which of the
   * two things `git worktree add` does it is about to do. Read-only and cheap:
   * one `show-ref` per keystroke-after-a-pause.
   */
  app.get('/api/projects/:id/branch', async (request) => {
    const { id } = request.params as { id: string }
    const { name } = branchQuery.parse(request.query)
    return workspace.describeBranch(id, name)
  })

  app.post('/api/worktrees', async (request) => {
    const body = createWorktreeBody.parse(request.body)
    const worktree = await workspace.createWorktree(body)
    // A worktree you just made is one you want to work in.
    await workspace.setAwake([worktree.id], true)
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
    const { force, deleteBranch, deleteRemoteBranch } = removeWorktreeQuery.parse(request.query)
    await workspace.removeWorktree({
      worktreeId: id,
      force,
      alsoDeleteBranch: deleteBranch,
      alsoDeleteRemoteBranch: deleteRemoteBranch,
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
   * A worktree's files: one directory, one file, and saving one back.
   *
   * Unlike `/changes` next door, this half is not read-only. The agent is still
   * the thing that writes most of the code here, but a typo you can see is not
   * worth a round trip through a conversation.
   */
  app.get('/api/worktrees/:id/tree', async (request) => {
    const { id } = request.params as { id: string }
    const { path } = treeQuery.parse(request.query)
    return workspace.fileTree(id, path)
  })

  /*
   * Files matching a fragment, anywhere in the worktree.
   *
   * Separate from `/tree` because it answers a different question: the tree
   * says what is beside what, and this says where something is. Nothing from
   * the client is used as a path -- every result comes out of git -- so there
   * is no containment question here, only in the read that follows.
   */
  app.get('/api/worktrees/:id/find', async (request) => {
    const { id } = request.params as { id: string }
    const { q } = findQuery.parse(request.query)
    return workspace.findFiles(id, q)
  })

  app.get('/api/worktrees/:id/file', async (request) => {
    const { id } = request.params as { id: string }
    const { path, ifNotRev } = fileQuery.parse(request.query)
    return workspace.readFile(id, path, ifNotRev)
  })

  /*
   * The bytes of a file the browser draws itself: an image, today.
   *
   * Separate from `/file` because it is the one response here that is not JSON
   * -- base64 through the snapshot would be a third larger and would sit in two
   * heaps on the way -- and because an `<img src>` is exactly a GET the browser
   * makes on its own.
   *
   * `rev` is not read. It is in the URL so that a file the agent regenerates is
   * a *different* URL and repaints on the next poll, which is what a cache is
   * otherwise entitled to prevent. The type comes from our own extension table,
   * never from the client.
   *
   * Three headers, all of them about the same worry -- this serves bytes from
   * the worktree on the origin the IDE itself runs on:
   *
   * - `nosniff`, so a file whose bytes disagree with its extension is not
   *   re-interpreted as something executable.
   * - a `default-src 'none'; sandbox` CSP, which is what makes navigating
   *   straight to this URL inert. An `<img>` cannot run script in any case, but
   *   a person pasting the link into the address bar is a different renderer.
   * - a disposition with no filename in it, ever. `inline` for a file being
   *   drawn, `attachment` for one being taken away, and in both cases the name
   *   comes from the `download` attribute on the client's own anchor -- which
   *   wins precisely because this header carries no filename, and is one less
   *   thing to have to escape correctly.
   *
   * `?download=1` is the second of those, and the difference is *which* files
   * may be asked for: drawing one needs an entry in the media table, taking one
   * away needs nothing but containment, since a file the panel refuses to show
   * is the whole reason the button exists. See `takeableFile`.
   */
  app.get('/api/worktrees/:id/raw', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { path, download } = rawQuery.parse(request.query)
    const taking = download === '1'
    const { file, type, size } = taking
      ? await workspace.takeableFile(id, path)
      : await workspace.mediaFile(id, path)
    return reply
      .type(type)
      .header('content-length', size)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('content-disposition', taking ? 'attachment' : 'inline')
      /*
       * Never stored. The URL already changes whenever the file does, so a
       * cache buys one fetch per image per edit -- and the thing it would be
       * keeping on disk is the contents of someone's working tree.
       */
      .header('cache-control', 'no-store')
      .send(createReadStream(file))
  })

  /*
   * Fastify's default body limit is 1 MiB, which would reject a save well under
   * `maxFileBytes` before the handler ever ran. Doubled and then some, because
   * a file of quote characters JSON-escapes to twice its size, plus room for
   * the envelope around it.
   */
  app.put(
    '/api/worktrees/:id/file',
    { bodyLimit: config.maxFileBytes * 2 + 65536 },
    async (request) => {
      const { id } = request.params as { id: string }
      const { path, text, ifRev } = saveFileBody.parse(request.body)
      const saved = await workspace.writeFile(id, path, text, ifRev)
      /*
       * A save moves no part of the poller's signature when the file was
       * already dirty -- `id:branch:head:dirty:missing` is unchanged by editing
       * something that was modified anyway -- so the changes list beside this one
       * would sit stale until something else happened. A kill has the same
       * problem and the same answer.
       */
      broadcastInvalidate()
      return saved
    },
  )

  /*
   * Put a worktree to sleep: record it, and stop what it is running.
   *
   * Asleep is recorded here, on the machine the worktree lives on, so every
   * browser and every machine linking this one agrees -- see `Worktree.awake`.
   * The kill needs the invalidate too: a kill emits no event of its own.
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
    const todo = await workspace.updateTodo(id, patch)
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
    await workspace.setAwake([worktree.id], false)
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
    await workspace.setAwake([worktree.id], true)
    const existing = engine
      .listForWorktree(worktree.id)
      .find((session) => session.kind === 'claude')

    if (existing && existing.liveness !== 'dead') {
      // Awake changed even though nothing was spawned, and every other viewer
      // has to hear it.
      broadcastInvalidate()
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
    /*
     * The machine's own terminal, which has no worktree to resolve and takes
     * its cwd from the one place that is always there.
     *
     * A branch here rather than a route of its own: what is being asked for is
     * a session, the engine never looks a worktree up anyway, and a second
     * route would be a second thing for the proxy, the gate and the client to
     * know about. `projectId` is empty on purpose -- it is what `killForProject`
     * matches on, and no project may take this terminal down with it.
     */
    if (body.worktreeId === MACHINE_WORKTREE_ID) {
      const session = await engine.create({
        worktreeId: MACHINE_WORKTREE_ID,
        projectId: '',
        kind: 'shell',
        cwd: homedir(),
        title: body.title,
        cols: body.cols,
        rows: body.rows,
      })
      broadcastInvalidate()
      return session
    }
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
