import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { Extension } from '@codemirror/state'

/**
 * Which grammar a filename calls for.
 *
 * `matchFilename` matches whole names as well as extensions, so `Makefile` and
 * `Dockerfile` are covered without a special case.
 */
const descFor = (path: string): LanguageDescription | null =>
  LanguageDescription.matchFilename(languages, path.slice(path.lastIndexOf('/') + 1))

/**
 * The grammar if it is already in memory.
 *
 * Switching between two TypeScript files must not flash a frame of unhighlighted
 * text on its way through a promise, and after the first `.ts` it never has to.
 */
export const loadedLanguageFor = (path: string): Extension | null =>
  descFor(path)?.support ?? null

/**
 * The grammar, fetching it if this is the first file of its kind.
 *
 * `@codemirror/language-data` holds a literal `import()` per language, so Vite
 * finds them statically and emits one lazy chunk each: the initial bundle does
 * not grow by a grammar for every language the editor could open, only
 * `node_modules` does.
 */
export const languageFor = async (path: string): Promise<Extension | null> => {
  const desc = descFor(path)
  return desc === null ? null : desc.load()
}
