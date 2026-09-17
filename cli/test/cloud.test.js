import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deriveKey } from '../../cloud/unlock/derive.js'

/*
 * The cloud machine is shell and YAML, so what is testable here is what a
 * typo would silently break rather than loudly: the generated Caddy config,
 * which decides what is reachable from the internet, and the key derivation,
 * which decides whether a volume ever opens again.
 *
 * Every assertion below was checked by breaking the line it guards.
 */
const CLOUD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cloud')

/** Run setup.sh's own renderer, with the variables it would have on a machine. */
const renderCaddyfile = (ip = '203.0.113.7', internal = '10.10.0.2') =>
  execFileSync(
    'bash',
    [
      '-c',
      // One function out of the setup script, because running the script
      // itself would install packages. The end marker is why it can be cut
      // out at all: the config it emits is full of lines that are just `}`.
      `IP=${ip}; INTERNAL_IP=${internal}; IDE_PORT=7999; UNLOCK_PORT=7998; PORT_LO=8000; PORT_HI=8099
       eval "$(sed -n '/^render_caddyfile() {/,/^} # end render_caddyfile/p' ${CLOUD}/setup.sh)"
       render_caddyfile`,
    ],
    { encoding: 'utf8' },
  )

describe('the scripts parse', () => {
  it.each([
    ['provision.sh', 'sh'],
    ['setup.sh', 'bash'],
    ['unlocked.sh', 'bash'],
  ])('%s', (file, shell) => {
    expect(() => execFileSync(shell, ['-n', join(CLOUD, file)])).not.toThrow()
  })

  it('cloud-config carries the placeholders provision.sh fills in', () => {
    const yaml = readFileSync(join(CLOUD, 'cloud-config.yaml'), 'utf8')
    expect(yaml.startsWith('#cloud-config')).toBe(true)
    for (const key of ['PLACEHOLDER_SETUP_B64', 'PLACEHOLDER_REPO_URL', 'PLACEHOLDER_REPO_REF']) {
      expect(yaml).toContain(key)
    }
    // The setup script arrives base64 on one line; a placeholder that had
    // wandered into a folded block would make invalid YAML on every machine.
    expect(/^ +content: PLACEHOLDER_SETUP_B64$/m.test(yaml)).toBe(true)
  })
})

describe('the Caddy config decides what the internet can reach', () => {
  const rendered = renderCaddyfile()

  it('answers a bare IP at all', () => {
    // A browser sends no SNI for an IP address, so without this Caddy has no
    // matching site and fails the handshake -- with a valid certificate in
    // hand. Measured on a real VM; the log said the certificate was obtained.
    expect(rendered).toMatch(/^\s*default_sni 203\.0\.113\.7$/m)
  })

  it('binds every test port to the internal address, and only those', () => {
    const sites = [...rendered.matchAll(/^https:\/\/([\d.]+)(?::(\d+))? \{\n([\s\S]*?)^\}/gm)]
    const test = sites.filter(([, , port]) => port !== undefined)
    expect(test).toHaveLength(100)
    expect(test.map(([, , port]) => Number(port))).toEqual(
      Array.from({ length: 100 }, (_, i) => 8000 + i),
    )
    for (const [, , port, body] of test) {
      // Without `bind`, Caddy takes 0.0.0.0:<port> -- which includes loopback,
      // so the service that is meant to listen there cannot start at all.
      expect(body).toContain('bind 10.10.0.2')
      expect(body).toContain(`reverse_proxy 127.0.0.1:${port}`)
    }
    // The IDE is not one of them: it is on 443, behind the password, and a
    // stray `bind` on it would take it off the public address entirely.
    const ide = sites.filter(([, , port]) => port === undefined)
    expect(ide).toHaveLength(1)
    const ideBody = ide[0]?.[3] ?? ''
    expect(ideBody).not.toContain('bind ')
    expect(ideBody).toContain('reverse_proxy 127.0.0.1:7999')
  })

  it('falls through to the unlock page only when the IDE is down', () => {
    const ide = rendered.match(/^https:\/\/[\d.]+ \{\n([\s\S]*?)^\}/m)?.[1] ?? ''
    expect(ide).toContain('handle_errors')
    expect(ide).toContain('reverse_proxy 127.0.0.1:7998')
    // 502 is "the IDE is not running". Catching everything would answer a
    // 404 from the IDE with a password prompt.
    expect(ide).toMatch(/err\.status_code} == 502/)
  })

  it('asks for the short-lived profile once, globally', () => {
    // Once, not per site: Let's Encrypt issues an IP certificate under this
    // profile and no other, and 101 sites for one hostname each declaring an
    // issuer is 101 automation policies for one name, which Caddy refuses --
    // measured, the machine came up with no web server at all.
    expect([...rendered.matchAll(/profile shortlived/g)]).toHaveLength(1)
    expect(rendered).toMatch(/^\s*cert_issuer acme \{$/m)
    // ... and never per site, which is the shape that refuses to start.
    expect(rendered).not.toMatch(/^\s+issuer acme \{$/m)
  })
})

describe('the volume key', () => {
  // 64MB of scrypt each, so these are slow on purpose -- that is the property.
  it('is the same key for the same password and salt', async () => {
    const salt = randomBytes(32)
    expect(await deriveKey('open sesame', salt)).toBe(await deriveKey('open sesame', salt))
  }, 20_000)

  it('is a different key for the same password under a different salt', async () => {
    const password = 'open sesame'
    expect(await deriveKey(password, randomBytes(32))).not.toBe(
      await deriveKey(password, randomBytes(32)),
    )
  }, 20_000)

  it('carries no newline, which cryptsetup would read as the end of the key', async () => {
    const key = await deriveKey('open sesame', randomBytes(32))
    expect(key).not.toContain('\n')
    expect(key.length).toBeGreaterThan(40)
  }, 20_000)
})
