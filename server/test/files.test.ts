import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, chmod, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { basename, join, resolve } from 'node:path'
import {
  containedPath,
  findFiles,
  grepFiles,
  invalidateStatus,
  listDirectory,
  mediaFile,
  mediaKindOf,
  mediaTypeOf,
  readTextFile,
  takeableFile,
  uploadFile,
  writeTextFile,
} from '../src/files.js'
import { config } from '../src/config.js'
import { HttpError } from '../src/http-error.js'
import { addWorktree } from '../src/git/worktree.js'
import { makeRepoWithCommit, type TempRepo } from './helpers/repo.js'

/** The status of a thrown HttpError, or the error itself if it is not one. */
const statusOf = async (promise: Promise<unknown>): Promise<number | unknown> => {
  try {
    await promise
    return 'did not throw'
  } catch (err) {
    return err instanceof HttpError ? err.status : err
  }
}

describe('containment', () => {
  let repo: TempRepo
  let outside: string

  beforeEach(async () => {
    repo = await makeRepoWithCommit()
    outside = await mkdtemp(join(tmpdir(), 'swb-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'not yours\n')
    await repo.write('src/a.ts', 'export const a = 1\n')
    await repo.commit('add src')
  })
  afterEach(async () => {
    await repo.cleanup()
    await rm(outside, { recursive: true, force: true })
  })

  it('resolves a path inside the worktree', async () => {
    expect(await containedPath(repo.path, 'src/a.ts')).toBe(
      resolve(await containedPath(repo.path, ''), 'src/a.ts'),
    )
  })

  it('lets the worktree root itself through', async () => {
    await expect(containedPath(repo.path, '')).resolves.toBeTypeOf('string')
    await expect(containedPath(repo.path, '.')).resolves.toBeTypeOf('string')
  })

  it('refuses an escape through ..', async () => {
    expect(await statusOf(containedPath(repo.path, '../../../etc/passwd'))).toBe(403)
    expect(await statusOf(containedPath(repo.path, 'src/../../..'))).toBe(403)
  })

  it('refuses an absolute path rather than quietly re-rooting it', async () => {
    // Refusing means a client bug is loud instead of odd.
    expect(await statusOf(containedPath(repo.path, '/etc/passwd'))).toBe(400)
  })

  it('refuses a NUL, which node would otherwise turn into a 500', async () => {
    expect(await statusOf(containedPath(repo.path, 'src/a\0.ts'))).toBe(400)
  })

  it('refuses a symlink pointing out of the worktree', async () => {
    /*
     * `resolve()` folds away `..` but knows nothing about symlinks, so a link
     * committed into a repository and pointing at /etc would sail through it.
     */
    await symlink(join(outside, 'secret.txt'), join(repo.path, 'escape.txt'))
    expect(await statusOf(containedPath(repo.path, 'escape.txt'))).toBe(403)
  })

  it('refuses a symlinked directory pointing out of the worktree', async () => {
    await symlink(outside, join(repo.path, 'elsewhere'))
    expect(await statusOf(containedPath(repo.path, 'elsewhere/secret.txt'))).toBe(403)
  })

  it('allows a symlink that stays inside', async () => {
    await symlink(join(repo.path, 'src', 'a.ts'), join(repo.path, 'link.ts'))
    await expect(containedPath(repo.path, 'link.ts')).resolves.toContain('a.ts')
  })

  it('refuses a sibling worktree whose name merely extends this one’s', async () => {
    /*
     * `startsWith(root)` alone is wrong, and quietly so: `/a/bc` starts with
     * `/a/b`. This is that case, built for real.
     */
    const sibling = `${repo.path}-extra`
    const rel = `../${basename(sibling)}/secret.txt`
    await mkdir(sibling, { recursive: true })
    try {
      await writeFile(join(sibling, 'secret.txt'), 'not yours\n')
      expect(await statusOf(containedPath(repo.path, rel))).toBe(403)
    } finally {
      await rm(sibling, { recursive: true, force: true })
    }
  })

  it('refuses .git by name, at any depth', async () => {
    /*
     * By name because `check-ignore` never reports it, and in a linked worktree
     * it is a *file* rather than a directory, so a kind test would miss it too.
     * At depth because this repo's own convention puts worktrees at
     * `<repo>/.claude/worktrees/<branch>`, whose `.git` is a real file here.
     */
    expect(await statusOf(containedPath(repo.path, '.git/config'))).toBe(403)
    const nested = join(repo.path, '.claude', 'worktrees', 'inner')
    await addWorktree({ root: repo.path, path: nested, branch: 'inner' })
    expect(await statusOf(containedPath(repo.path, '.claude/worktrees/inner/.git'))).toBe(403)
  })

  it('says 404 for a path that does not exist', async () => {
    // Existence is required on purpose: nothing here creates files, and it also
    // disposes of the dangling symlink, which a write would follow.
    expect(await statusOf(containedPath(repo.path, 'nope.txt'))).toBe(404)
    await symlink(join(outside, 'gone.txt'), join(repo.path, 'dangling.txt'))
    expect(await statusOf(containedPath(repo.path, 'dangling.txt'))).toBe(404)
  })
})

describe('listing', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeRepoWithCommit()
    await repo.write('src/a.ts', 'a\n')
    await repo.write('src/b.ts', 'b\n')
    await repo.write('dist/built.js', 'built\n')
    await repo.write('.gitignore', 'dist/\n')
    await repo.commit('add tree')
    invalidateStatus(repo.path)
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('lists one level, directories first then by name', async () => {
    const listing = await listDirectory(repo.path, '')
    expect(listing.path).toBe('')
    expect(listing.entries.map((e) => e.name)).toEqual(['src', '.gitignore', 'README.md'])
    expect(listing.entries[0]?.kind).toBe('dir')
  })

  it('applies the repository’s ignore rules', async () => {
    const names = (await listDirectory(repo.path, '')).entries.map((e) => e.name)
    expect(names).not.toContain('dist')
  })

  it('refuses an ignored directory outright rather than showing it empty', async () => {
    expect(await statusOf(listDirectory(repo.path, 'dist'))).toBe(404)
  })

  it('never lists .git', async () => {
    expect((await listDirectory(repo.path, '')).entries.map((e) => e.name)).not.toContain('.git')
  })

  it('marks a changed file and every directory above it', async () => {
    await repo.write('src/a.ts', 'changed\n')
    invalidateStatus(repo.path)
    const root = await listDirectory(repo.path, '')
    expect(root.entries.find((e) => e.name === 'src')?.changed).toBe(true)
    const src = await listDirectory(repo.path, 'src')
    expect(src.entries.find((e) => e.name === 'a.ts')?.changed).toBe(true)
    // Absent rather than false: in a clean repository that would be every entry.
    expect(src.entries.find((e) => e.name === 'b.ts')?.changed).toBeUndefined()
  })

  it('reports a symlinked directory as a directory', async () => {
    // `dirent.isDirectory()` is false for a link to one, so reporting the
    // link's own kind would make clicking it an error every time.
    await symlink(join(repo.path, 'src'), join(repo.path, 'src-link'))
    const entry = (await listDirectory(repo.path, '')).entries.find((e) => e.name === 'src-link')
    expect(entry?.kind).toBe('dir')
  })

  it('drops a link that dangles or points out of the worktree', async () => {
    await symlink('/etc', join(repo.path, 'etc-link'))
    await symlink(join(repo.path, 'gone'), join(repo.path, 'dead-link'))
    const names = (await listDirectory(repo.path, '')).entries.map((e) => e.name)
    expect(names).not.toContain('etc-link')
    expect(names).not.toContain('dead-link')
  })

  it('refuses to list a file', async () => {
    expect(await statusOf(listDirectory(repo.path, 'README.md'))).toBe(400)
  })
})

describe('find', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeRepoWithCommit()
    await repo.write('web/src/views/FilesPane.tsx', 'x\n')
    await repo.write('web/src/api.ts', 'x\n')
    await repo.write('dist/FilesPane.js', 'x\n')
    await repo.write('.gitignore', 'dist/\n')
    await repo.commit('add tree')
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('asks git nothing for an empty query', async () => {
    expect(await findFiles(repo.path, '   ')).toEqual({ hits: [] })
  })

  it('finds files and the directories on the way to them', async () => {
    const { hits } = await findFiles(repo.path, 'views')
    expect(hits).toContainEqual({ path: 'web/src/views', kind: 'dir' })
    expect(hits).toContainEqual({ path: 'web/src/views/FilesPane.tsx', kind: 'file' })
  })

  it('ranks a hit in the name above one only in the path', async () => {
    // Someone typing `filespane` means the file, not the directory above it.
    const { hits } = await findFiles(repo.path, 'filespane')
    expect(hits[0]?.path).toBe('web/src/views/FilesPane.tsx')
  })

  it('is case-insensitive', async () => {
    expect((await findFiles(repo.path, 'FILESPANE')).hits).not.toHaveLength(0)
  })

  it('inherits the ignore rules from ls-files', async () => {
    const { hits } = await findFiles(repo.path, 'FilesPane')
    expect(hits.map((hit) => hit.path)).not.toContain('dist/FilesPane.js')
  })
})

describe('grep', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeRepoWithCommit()
    await repo.write('src/a.ts', 'const one = 1\n  // Needle: here\nconst two = 2\n')
    await repo.write('src/b:c.ts', 'x\nneedle: with a colon\n')
    await repo.write('dist/out.js', 'needle\n')
    await repo.write('.gitignore', 'dist/\n')
    await repo.commit('add src')
    // Written after the commit, so it is untracked: an agent's new file.
    await repo.write('src/new.ts', 'NEEDLE fresh\n')
    await writeFile(join(repo.path, 'blob.bin'), Buffer.from([0, 110, 101, 101, 100, 108, 101]))
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('asks git nothing for an empty query', async () => {
    expect(await grepFiles(repo.path, '  ')).toEqual({ hits: [] })
  })

  it('finds the line, case-insensitively, trimmed, and numbered from 1', async () => {
    const { hits } = await grepFiles(repo.path, 'needle:')
    expect(hits).toContainEqual({ path: 'src/a.ts', line: 2, text: '// Needle: here' })
  })

  it('reads a colon in the path as part of it', async () => {
    // `-z`: a colon-separated parse would split `src/b:c.ts` in two.
    const { hits } = await grepFiles(repo.path, 'colon')
    expect(hits).toEqual([{ path: 'src/b:c.ts', line: 2, text: 'needle: with a colon' }])
  })

  it('searches untracked files, but not ignored or binary ones', async () => {
    const paths = (await grepFiles(repo.path, 'needle')).hits.map((hit) => hit.path)
    expect(paths).toContain('src/new.ts')
    expect(paths).not.toContain('dist/out.js')
    expect(paths).not.toContain('blob.bin')
  })

  it('takes the query as a fixed string, even one that looks like an option', async () => {
    expect((await grepFiles(repo.path, 'const .* =')).hits).toEqual([])
    await repo.write('src/dash.ts', '--version is a flag\n')
    const { hits } = await grepFiles(repo.path, '--version')
    expect(hits.map((hit) => hit.path)).toEqual(['src/dash.ts'])
  })

  it('stops at a screenful, and says so', async () => {
    await repo.write('src/many.ts', 'hit\n'.repeat(5))
    for (let index = 0; index < 20; index++) {
      await repo.write(`src/many-${index}.ts`, 'hit\n'.repeat(30))
    }
    const { hits, truncated } = await grepFiles(repo.path, 'hit')
    expect(hits).toHaveLength(200)
    expect(truncated).toBe(true)
    // No one file is the whole answer.
    expect(hits.filter((hit) => hit.path === 'src/many-0.ts').length).toBeLessThanOrEqual(20)
  })

  it('keeps the spaces in a query, which in a file mean something', async () => {
    await repo.write('src/lines.ts', 'line 7 here\nline 70 here\n')
    const { hits } = await grepFiles(repo.path, 'line 7 ')
    expect(hits.map((hit) => hit.text)).toEqual(['line 7 here'])
  })

  it('names a file it cut short, and only one that was', async () => {
    await repo.write('src/twenty.ts', 'hit\n'.repeat(20))
    await repo.write('src/thirty.ts', 'hit\n'.repeat(30))
    const { hits, more } = await grepFiles(repo.path, 'hit')
    expect(hits.filter((hit) => hit.path === 'src/thirty.ts')).toHaveLength(20)
    expect(hits.filter((hit) => hit.path === 'src/twenty.ts')).toHaveLength(20)
    expect(more).toEqual(['src/thirty.ts'])
  })
})

describe('read and write', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeRepoWithCommit()
    await repo.write('src/a.ts', 'export const a = 1\n')
    await repo.commit('add src')
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('reads a text file with an identity to save against', async () => {
    const content = await readTextFile(repo.path, 'src/a.ts')
    expect('text' in content && content.text).toBe('export const a = 1\n')
    expect('rev' in content && content.rev).toBeTruthy()
  })

  it('answers a follow-poll with unchanged rather than the bytes again', async () => {
    const first = await readTextFile(repo.path, 'src/a.ts')
    const rev = 'rev' in first ? first.rev : ''
    expect(await readTextFile(repo.path, 'src/a.ts', rev)).toEqual({ unchanged: true, rev })
  })

  it('refuses a binary file rather than showing U+FFFD', async () => {
    await writeFile(join(repo.path, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02]))
    const content = await readTextFile(repo.path, 'blob.bin')
    expect('binary' in content && content.binary).toBe(true)
    expect('text' in content).toBe(false)
  })

  it('names a media type for a binary the browser can draw', async () => {
    // The panel shows an image instead of saying there is nothing to see, and
    // this is the whole of how it knows to.
    await repo.write('logo.png', 'not really a png, and it does not matter here')
    const content = await readTextFile(repo.path, 'logo.png')
    expect('media' in content && content.media).toBe('image/png')
    expect('binary' in content && content.binary).toBe(true)
    expect('text' in content).toBe(false)
  })

  it('leaves a binary with no renderer as binary alone', async () => {
    await writeFile(join(repo.path, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02]))
    const content = await readTextFile(repo.path, 'blob.bin')
    expect('media' in content).toBe(false)
  })

  it('shows an image over the size cap, which only ever applied to text', async () => {
    /*
     * The order of the two checks is the point. `maxFileBytes` exists because a
     * text file has to travel through JSON, and an image does not travel this
     * way at all -- the browser fetches it from /raw. With the cap first, every
     * photograph in the repository answered "too large to open here".
     */
    const big = Buffer.alloc(config.maxFileBytes + 1, 0x41)
    await writeFile(join(repo.path, 'big.jpg'), big)
    const content = await readTextFile(repo.path, 'big.jpg')
    expect('media' in content && content.media).toBe('image/jpeg')
    expect('tooLarge' in content).toBe(false)
  })

  it('opens an SVG in the editor, because it is text', async () => {
    // The rule is "not text, but the browser can show it". An SVG is text, and
    // editing one is the reason to open it.
    await repo.write('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
    const content = await readTextFile(repo.path, 'icon.svg')
    expect('text' in content && content.text).toContain('<svg')
    expect('media' in content).toBe(false)
  })

  it('refuses a latin-1 file, which has no NUL but would be rewritten on save', async () => {
    // A strict decode is the check that actually protects the file: latin-1
    // decodes happily into U+FFFD, and saving it back rewrites every non-ASCII
    // byte in it.
    await writeFile(join(repo.path, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    const content = await readTextFile(repo.path, 'latin.txt')
    expect('binary' in content && content.binary).toBe(true)
  })

  it('saves, and hands back the fresh rev the next poll needs', async () => {
    const before = await readTextFile(repo.path, 'src/a.ts')
    const rev = 'rev' in before ? before.rev : ''
    const saved = await writeTextFile(repo.path, 'src/a.ts', 'export const a = 2\n', rev)
    expect(saved.rev).not.toBe(rev)
    /*
     * Without the fresh rev the follow-poll two seconds later sees the client's
     * own write as a foreign change and announces that the file moved.
     */
    expect(await readTextFile(repo.path, 'src/a.ts', saved.rev)).toEqual({
      unchanged: true,
      rev: saved.rev,
    })
  })

  it('refuses a save against a rev the file has moved past', async () => {
    // Last-writer-wins between a human and the agent in this worktree is how
    // work disappears.
    const stale = 'not-the-current-rev'
    expect(await statusOf(writeTextFile(repo.path, 'src/a.ts', 'clobbered\n', stale))).toBe(409)
    const content = await readTextFile(repo.path, 'src/a.ts')
    expect('text' in content && content.text).toBe('export const a = 1\n')
  })

  it('carries the fresh rev on the refusal, so no second round trip is needed', async () => {
    try {
      await writeTextFile(repo.path, 'src/a.ts', 'x\n', 'stale')
      expect.unreachable()
    } catch (err) {
      expect((err as HttpError).code).toBe('stale-file')
      expect((err as HttpError).details?.rev).toBeTruthy()
    }
  })

  it('writes in place, keeping the inode', async () => {
    /*
     * Deliberately not write-a-temp-then-rename, which `state.ts` next door
     * does: a rename changes the inode, breaks hardlinks and drops the mode.
     */
    await chmod(join(repo.path, 'src/a.ts'), 0o640)
    const before = await readTextFile(repo.path, 'src/a.ts')
    const rev = 'rev' in before ? before.rev : ''
    const saved = await writeTextFile(repo.path, 'src/a.ts', 'x\n', rev)
    // The rev carries the inode as its last field; only mtime and size move.
    expect(saved.rev.split('-').at(-1)).toBe(rev.split('-').at(-1))
  })

  it('refuses to read or write anything outside the worktree', async () => {
    expect(await statusOf(readTextFile(repo.path, '../../../etc/passwd'))).toBe(403)
    expect(await statusOf(writeTextFile(repo.path, '/etc/passwd', 'x', 'r'))).toBe(400)
  })
})

/** One name per row of the table, plus files that are not in it at all. */
const KNOWN = [
  'a.png', 'a.apng', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.avif', 'a.bmp', 'a.ico',
  'a.mp4', 'a.m4v', 'a.webm', 'a.ogv', 'a.mov',
  'a.mp3', 'a.m4a', 'a.aac', 'a.wav', 'a.flac', 'a.ogg', 'a.oga', 'a.opus',
  'a.pdf',
  'a.txt', 'a.svg', 'a.mkv', 'noextension', 'dir.d/README',
]

describe('media files', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeRepoWithCommit()
    await repo.write('art/logo.png', 'pretend bytes')
    await repo.commit('add art')
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('reads the extension case-insensitively', () => {
    expect(mediaTypeOf('a/B.PNG')).toBe('image/png')
    expect(mediaTypeOf('a/photo.JPEG')).toBe('image/jpeg')
  })

  it('does not take a dot in a directory name for an extension', () => {
    // `img.d/README` has a dot in it, and none of it is an extension.
    expect(mediaTypeOf('img.d/README')).toBe(undefined)
    expect(mediaTypeOf('noextension')).toBe(undefined)
  })

  it('names what a video, a sound file and a PDF are shown as', async () => {
    expect(mediaTypeOf('clip.mp4')).toBe('video/mp4')
    expect(mediaTypeOf('clip.webm')).toBe('video/webm')
    expect(mediaTypeOf('Screen Recording.MOV')).toBe('video/quicktime')
    expect(mediaTypeOf('take.mp3')).toBe('audio/mpeg')
    // Opus travels in an Ogg container and has to be named as one: Chrome's
    // media stack does not accept `audio/opus` for it.
    expect(mediaTypeOf('take.opus')).toBe('audio/ogg')
    expect(mediaTypeOf('spec.pdf')).toBe('application/pdf')
  })

  it('leaves out the containers no browser here can open', async () => {
    /*
     * The table is a list of renderers, not of formats. Chrome demuxes no
     * Matroska whatever the codecs inside, and a black box with a broken
     * control strip is worse than the note saying there is nothing to see.
     * `.m3u8` needs Media Source Extensions and a player we do not have.
     */
    for (const name of ['film.mkv', 'film.avi', 'film.wmv', 'stream.m3u8', 'tune.mid']) {
      expect(mediaTypeOf(name)).toBe(undefined)
    }
  })

  it('says which element shows a file, for exactly the files it can show', async () => {
    expect(mediaKindOf('logo.png')).toBe('image')
    expect(mediaKindOf('clip.mp4')).toBe('video')
    expect(mediaKindOf('take.mp3')).toBe('audio')
    expect(mediaKindOf('spec.pdf')).toBe('pdf')
    expect(mediaKindOf('notes.txt')).toBe(undefined)
    /*
     * The biconditional, over the whole table: a kind exists exactly when a
     * type does. A row added later whose prefix `mediaKindOf` does not know
     * would otherwise be a file the server happily serves and the panel cannot
     * draw -- opened, blank, with nothing said about why.
     */
    for (const name of KNOWN) {
      expect(mediaKindOf(name) === undefined).toBe(mediaTypeOf(name) === undefined)
    }
  })

  it('plays a video over the size cap, for the reason an image is shown', async () => {
    // The same check order as the image above, and it matters more here: a
    // video is normally *far* over a cap that exists for text in JSON.
    const big = Buffer.alloc(config.maxFileBytes + 1, 0x41)
    await writeFile(join(repo.path, 'big.mp4'), big)
    const content = await readTextFile(repo.path, 'big.mp4')
    expect('media' in content && content.media).toBe('video/mp4')
    expect('tooLarge' in content).toBe(false)
  })

  it('serves nothing it does not have a renderer for', async () => {
    // The route hands the browser this type verbatim, so the table is the only
    // thing that decides what a file is served as.
    expect(await statusOf(mediaFile(repo.path, 'README.md'))).toBe(415)
  })

  it('is contained like every other read', async () => {
    // It streams bytes straight out of the worktree, so the escape that matters
    // is the one that never reaches `readTextFile`.
    expect(await statusOf(mediaFile(repo.path, '../../../etc/hosts.png'))).toBe(403)
  })

  it('names the file to stream and what to serve it as', async () => {
    const media = await mediaFile(repo.path, 'art/logo.png')
    expect(media.type).toBe('image/png')
    expect(media.file.endsWith('art/logo.png')).toBe(true)
    expect(media.size).toBe('pretend bytes'.length)
  })
})

describe('files to take away', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeRepoWithCommit()
    await repo.write('art/logo.png', 'pretend bytes')
    await repo.commit('add art')
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('hands over a file there is no renderer for', async () => {
    /*
     * The bug: a file the panel would not open -- not text, or past the cap --
     * had no way out of the IDE at all, because the only route that streams
     * bytes refused anything the media table did not name. Reported as
     * "if a file is too large to be displayed, there is no download button".
     */
    expect(await statusOf(mediaFile(repo.path, 'README.md'))).toBe(415)
    const take = await takeableFile(repo.path, 'README.md')
    expect(take.type).toBe('application/octet-stream')
    expect(take.file.endsWith('README.md')).toBe(true)
  })

  it('names an image as itself, so the one route serves both', async () => {
    expect((await takeableFile(repo.path, 'art/logo.png')).type).toBe('image/png')
  })

  it('has nothing to do with the size cap', async () => {
    // The cap is about text going through JSON, and a file over it is exactly
    // the one this exists for: it streams from disk, so nothing here reads a
    // size at all.
    const big = 'x'.repeat(config.maxFileBytes + 1)
    await repo.write('huge.log', big)
    const take = await takeableFile(repo.path, 'huge.log')
    expect(take.size).toBe(big.length)
    const read = await readTextFile(repo.path, 'huge.log')
    expect('tooLarge' in read ? read.tooLarge : false).toBe(true)
  })

  it('is contained like every other read', async () => {
    // Taking the media gate off must not take the boundary off with it.
    expect(await statusOf(takeableFile(repo.path, '../../../etc/hosts'))).toBe(403)
    expect(await statusOf(takeableFile(repo.path, 'art'))).toBe(400)
  })
})

describe('a file dropped into a directory', () => {
  let repo: TempRepo

  const drop = (dir: string, name: string, body: string): Promise<unknown> =>
    uploadFile(repo.path, dir, name, Readable.from([Buffer.from(body)]))

  beforeEach(async () => {
    repo = await makeRepoWithCommit()
    await repo.write('src/a.ts', 'a\n')
    await repo.commit('add src')
    invalidateStatus(repo.path)
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('writes the bytes where they were dropped', async () => {
    const saved = await drop('src', 'clip.mp4', 'pretend bytes')
    expect(saved).toMatchObject({ path: 'src/clip.mp4', size: 'pretend bytes'.length })
    expect(await readFile(join(repo.path, 'src/clip.mp4'), 'utf8')).toBe('pretend bytes')
  })

  it('takes the worktree root, which is a directory like any other', async () => {
    await drop('', 'top.bin', 'x')
    expect(await readFile(join(repo.path, 'top.bin'), 'utf8')).toBe('x')
  })

  it('refuses to overwrite what is already there', async () => {
    /*
     * A name already taken is far more often a mistake than an intention, and a
     * silent overwrite is neither recoverable nor noticed. The reader can see
     * what is there and decide.
     */
    expect(await statusOf(drop('src', 'a.ts', 'clobbered'))).toBe(409)
    expect(await readFile(join(repo.path, 'src/a.ts'), 'utf8')).toBe('a\n')
  })

  it('refuses a name that is a path', async () => {
    /*
     * The containment check is on the *directory*, because the file does not
     * exist yet and `containedPath` requires existence -- so this is the half
     * that closes it. `../` in a name would otherwise be joined onto a path
     * that had just passed.
     */
    expect(await statusOf(drop('src', '../escaped.txt', 'x'))).toBe(400)
    expect(await statusOf(drop('src', 'nested/deep.txt', 'x'))).toBe(400)
    expect(await statusOf(drop('src', '..', 'x'))).toBe(400)
    expect(await statusOf(drop('src', 'a\0b', 'x'))).toBe(400)
  })

  it('is contained like every other write', async () => {
    expect(await statusOf(drop('../../../tmp', 'x.txt', 'x'))).toBe(403)
    expect(await statusOf(drop('.git', 'config', 'x'))).toBe(403)
  })

  it('refuses a directory as the destination when it is a file', async () => {
    expect(await statusOf(drop('src/a.ts', 'x.txt', 'x'))).toBe(400)
  })

  it('leaves nothing behind when the body fails halfway', async () => {
    /*
     * A temp file beside the target, renamed on, is what keeps a half-written
     * file from appearing in the tree under its final name -- and if the body
     * stops, neither name is left holding anything.
     */
    const broken = new Readable({
      read() {
        this.push(Buffer.from('half'))
        this.destroy(new Error('the network went away'))
      },
    })
    await expect(uploadFile(repo.path, 'src', 'big.bin', broken)).rejects.toThrow(/went away/)
    const left = await readdir(join(repo.path, 'src'))
    expect(left).toEqual(['a.ts'])
  })
})
