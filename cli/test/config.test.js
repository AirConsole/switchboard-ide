import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readConfig, stripComments } from '../src/instance.js'

/*
 * The config file is written by a person and read by this program, which is
 * the whole reason it may carry comments. Each case below is something a
 * person plausibly types.
 */
describe('comments in config.json', () => {
  it('keeps a URL intact', () => {
    // The trap this whole function exists for: the setting most likely to be
    // in this file is a URL, and a stripper that scans for // cuts the value
    // in half and blames the user's syntax.
    const text = '{ "host": "https://ide.example.com" }'
    expect(JSON.parse(stripComments(text))).toEqual({ host: 'https://ide.example.com' })
  })

  it('drops a line comment, and a trailing one', () => {
    const text = '{\n  // what the server listens on\n  "port": 7999 // and not 8083\n}'
    expect(JSON.parse(stripComments(text))).toEqual({ port: 7999 })
  })

  it('drops a block comment, including one spanning lines', () => {
    const text = '{ /* set this\n   behind a proxy */ "host": "ide.example.com:83" }'
    expect(JSON.parse(stripComments(text))).toEqual({ host: 'ide.example.com:83' })
  })

  it('leaves comment-looking text inside strings alone', () => {
    const text = '{ "host": "a//b", "bind": "/* not a comment */" }'
    expect(JSON.parse(stripComments(text))).toEqual({ host: 'a//b', bind: '/* not a comment */' })
  })

  it('does not end a string on an escaped quote', () => {
    const text = String.raw`{ "host": "he said \" // still a string" }`
    expect(JSON.parse(stripComments(text))).toEqual({ host: 'he said " // still a string' })
  })
})

describe('readConfig', () => {
  /** @type {string} */
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swb-config-'))
    process.env.SWB_STATE_DIR = dir
  })
  afterEach(() => {
    delete process.env.SWB_STATE_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a file whose settings are all commented out as no settings at all', () => {
    // This is the file `install.sh` writes, and the state most machines stay
    // in: every setting present, every one explained, none of them applied.
    writeFileSync(
      join(dir, 'config.json'),
      '{\n  // "port": 7999,\n  // "host": "ide.example.com:83",\n  // "bind": "0.0.0.0"\n}\n',
    )
    expect(readConfig()).toEqual({})
  })

  it('names the file when what is left is not JSON', () => {
    writeFileSync(join(dir, 'config.json'), '{ "port": 7999, }')
    expect(() => readConfig()).toThrow(/config\.json is not readable as config/)
  })
})
