import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/**
 * How a file is coloured.
 *
 * The palette itself lives in `styles.css` as `--code-*`, beside `--diff-add`
 * and `--diff-del` where the colour rules are stated -- CodeMirror emits real
 * CSS, so `var()` works here, and it keeps every colour decision in the one
 * file that is reviewed for them.
 *
 * Five colours and two rungs of the existing grey ladder, because the job is to
 * separate structure from literal from name from type from comment -- not to
 * enumerate token kinds. So every literal is one colour: a string, a number,
 * `true` and `null` are all data written down. In JSON that falls out nicely,
 * keys in one colour and values in another.
 *
 * Weight and slant appear four times and never as a second axis on colour:
 * comments are italic because they are the thing you slide past, and markdown
 * gets its own three because this repository's instructions are written in it.
 */
export const editorHighlight = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [
        t.keyword,
        t.controlKeyword,
        t.moduleKeyword,
        t.operatorKeyword,
        t.definitionKeyword,
        t.modifier,
        t.self,
      ],
      color: 'var(--code-keyword)',
    },
    {
      tag: [
        t.string,
        t.special(t.string),
        t.regexp,
        t.escape,
        t.character,
        t.number,
        t.integer,
        t.float,
        t.bool,
        t.null,
        t.atom,
        t.unit,
        t.color,
        t.url,
      ],
      color: 'var(--code-literal)',
    },
    {
      tag: [
        t.function(t.variableName),
        t.function(t.definition(t.variableName)),
        t.propertyName,
        t.attributeName,
        t.labelName,
        t.macroName,
      ],
      color: 'var(--code-name)',
    },
    {
      tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.tagName), t.annotation],
      color: 'var(--code-type)',
    },
    {
      tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
      color: 'var(--code-comment)',
      fontStyle: 'italic',
    },
    { tag: [t.meta, t.processingInstruction, t.documentMeta], color: 'var(--code-comment)' },
    {
      tag: [
        t.punctuation,
        t.separator,
        t.bracket,
        t.paren,
        t.brace,
        t.squareBracket,
        t.angleBracket,
        t.operator,
        t.derefOperator,
      ],
      color: 'var(--code-punct)',
    },
    { tag: t.invalid, color: 'var(--code-invalid)' },
    { tag: t.heading, color: 'var(--bone)', fontWeight: 'bold' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.quote, color: 'var(--code-comment)' },
    { tag: t.link, color: 'var(--code-name)', textDecoration: 'underline' },
    { tag: t.monospace, color: 'var(--code-literal)' },
  ]),
)

/**
 * The editor's own chrome.
 *
 * It lives here rather than in `styles.css` deliberately. CodeMirror injects
 * its theme under generated class names at a specificity a plain class rule can
 * lose to, and `web/CLAUDE.md` already records that specificity fights in that
 * file surface as "a section that is subtly wrong". So the stylesheet owns the
 * box around the editor and nothing inside it.
 */
export const editorTheme = EditorView.theme(
  {
    '&': {
      color: 'var(--code-plain)',
      /*
       * Transparent, not `--terminal-bg`. The pane already paints that ground,
       * and a second painted box on top of it shows as a frame at the padding
       * -- the same trap `TerminalView`'s `THEME.background` note describes.
       */
      backgroundColor: 'transparent',
      height: '100%',
      fontFamily: 'var(--font-mono)',
      /*
       * `.diffline`'s metrics exactly, so a file and its own patch line up
       * character for character when the two panels are open side by side.
       */
      fontSize: '13px',
    },
    // The pane draws the focus ring; a second one inside it is a double border.
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'inherit',
      lineHeight: '1.35',
      overflow: 'auto',
      // A content scroller, so it shows a thin scrollbar like `.files__diff`.
      scrollbarWidth: 'thin',
    },
    '.cm-content': { padding: '0', caretColor: '#8ab4f8' },
    '.cm-line': { padding: '0 8px 0 6px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--code-comment)',
      border: 'none',
      borderRight: '1px solid var(--rule)',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 8px', minWidth: '3ch' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--graphite)' },
    // One step off the ground and no more: it says where the cursor is without
    // becoming a band that sweeps across the pane as you move.
    '.cm-activeLine': { backgroundColor: '#141821' },
    /*
     * The terminal's own cursor and selection colours, so a selection here and
     * a selection in the terminal beside it are visibly the same act. Not
     * `--pulse`, which belongs to the focus ring alone.
     */
    '.cm-cursor, &.cm-focused .cm-cursor': {
      borderLeftColor: '#8ab4f8',
      borderLeftWidth: '2px',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: '#2d4f76',
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'transparent',
      outline: '1px solid var(--rule-bright)',
      color: 'inherit',
    },
    '.cm-nonmatchingBracket': { color: 'var(--code-invalid)' },
    '.cm-specialChar': { color: 'var(--code-invalid)' },
  },
  { dark: true },
)
