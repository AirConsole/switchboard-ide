import { createRequire } from 'node:module'
import { config } from '../config.js'

/**
 * @xterm/headless and @xterm/addon-serialize ship CommonJS as their `main` with
 * no `exports` map, and Node's CJS named-export detection fails on them
 * ("does not provide an export named 'Terminal'"). createRequire is the
 * reliable interop, and `typeof import(...)` keeps it fully typed.
 */
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize')

/**
 * A server-side terminal emulator shadowing one session.
 *
 * This exists so a reconnecting browser can be repainted correctly. Replaying a
 * raw byte ring buffer cannot work here: it slices mid-escape-sequence, and
 * every TUI we care about (Claude Code included) runs on the alternate screen,
 * where replayed history is meaningless. Serializing the emulator's actual
 * state reproduces the screen, its colours and the `?1049h` alt-screen entry.
 *
 * It doubles as the source for attention detection, since it already holds the
 * rendered text of what the user would be looking at.
 */
export class TerminalMirror {
  private readonly term: InstanceType<typeof Terminal>
  private readonly serializer: InstanceType<typeof SerializeAddon>

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: config.mirrorScrollback,
      allowProposedApi: true,
    })
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.serializer)
  }

  get cols(): number {
    return this.term.cols
  }

  get rows(): number {
    return this.term.rows
  }

  write(data: string | Uint8Array): void {
    this.term.write(data as string)
  }

  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return
    this.term.resize(cols, rows)
  }

  /** Resolve once every queued write has been parsed. */
  flush(): Promise<void> {
    return new Promise((resolve) => this.term.write('', resolve))
  }

  /** A repaint of current screen + scrollback, safe to write into a fresh xterm. */
  async snapshot(): Promise<string> {
    await this.flush()
    return this.serializer.serialize({ scrollback: config.mirrorScrollback })
  }

  /**
   * Plain text of the last `rows` meaningful visible lines, used to recognise a
   * TUI that is sitting on a prompt.
   *
   * Trailing blank lines are stripped BEFORE taking the last `rows`, not after.
   * A full-screen dialog draws near the top of the alternate screen and leaves
   * the rest blank, so slicing first would return nothing but empty rows and
   * every dialog would read as "idle".
   */
  tailText(rows = 12): string {
    const buffer = this.term.buffer.active
    const lines: string[] = []
    const end = buffer.baseY + this.term.rows
    for (let y = buffer.baseY; y < end; y++) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
    }
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
    return lines.slice(-rows).join('\n')
  }

  dispose(): void {
    this.term.dispose()
  }
}
