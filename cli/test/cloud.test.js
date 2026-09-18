import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
const renderCaddyfile = (ip = '203.0.113.7', internal = '10.10.0.2', domain = '') =>
  execFileSync(
    'bash',
    [
      '-c',
      // One function out of the setup script, because running the script
      // itself would install packages. The end marker is why it can be cut
      // out at all: the config it emits is full of lines that are just `}`.
      `IP=${ip}; INTERNAL_IP=${internal}; DOMAIN=${domain}; IDE_PORT=7999; UNLOCK_PORT=7998; PORT_LO=8000; PORT_HI=8099
       eval "$(sed -n '/^render_caddyfile() {/,/^} # end render_caddyfile/p' ${CLOUD}/setup.sh)"
       render_caddyfile`,
    ],
    { encoding: 'utf8' },
  )

describe('the scripts parse', () => {
  it.each([
    ['provision-gcp.sh', 'sh'],
    ['setup.sh', 'bash'],
    ['unlocked.sh', 'bash'],
  ])('%s', (file, shell) => {
    expect(() => execFileSync(shell, ['-n', join(CLOUD, file)])).not.toThrow()
  })

  it('cloud-config carries the placeholders provision-gcp.sh fills in', () => {
    const yaml = readFileSync(join(CLOUD, 'cloud-config.yaml'), 'utf8')
    expect(yaml.startsWith('#cloud-config')).toBe(true)
    for (const key of ['PLACEHOLDER_SETUP_B64', 'PLACEHOLDER_REPO_URL', 'PLACEHOLDER_REPO_REF']) {
      expect(yaml).toContain(key)
    }
    // The setup script arrives base64 on one line; a placeholder that had
    // wandered into a folded block would make invalid YAML on every machine.
    expect(/^ +content: PLACEHOLDER_SETUP_B64$/m.test(yaml)).toBe(true)
  })

  it('fills in every placeholder it declares', () => {
    // A placeholder nothing substitutes reaches the machine literally, and a
    // flag nothing carries does nothing -- measured: --no-sudo was passed as
    // instance metadata that the setup script never read, so it was a flag
    // that silently granted sudo.
    const yaml = readFileSync(join(CLOUD, 'cloud-config.yaml'), 'utf8')
    const provision = readFileSync(join(CLOUD, 'provision-gcp.sh'), 'utf8')
    for (const [placeholder] of yaml.matchAll(/PLACEHOLDER_[A-Z0-9_]+/g)) {
      expect(provision).toContain(`s|${placeholder}|`)
    }
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

describe('running it straight from the internet', () => {
  // `curl ... | sh` has no "next to this script": $0 is the shell's own name.
  // So the two files the machine is made of are fetched from the same
  // repository and ref the machine will build from -- and this is the line
  // that turns the one URL into the other.
  /** @param {string} repo */
  const rawUrlFor = (repo) =>
    execFileSync(
      'sh',
      [
        '-c',
        `printf '%s' "${repo}" | sed 's|^https://github.com/|https://raw.githubusercontent.com/|; s|\\.git$||'`,
      ],
      { encoding: 'utf8' },
    )

  it.each([
    ['https://github.com/AirConsole/switchboard-ide.git', 'https://raw.githubusercontent.com/AirConsole/switchboard-ide'],
    ['https://github.com/AirConsole/switchboard-ide', 'https://raw.githubusercontent.com/AirConsole/switchboard-ide'],
  ])('%s', (repo, expected) => {
    expect(rawUrlFor(repo)).toBe(expected)
  })

  it('fetches before it builds anything', () => {
    // A ref that does not exist should cost nothing. Finding out the machine's
    // own files cannot be fetched *after* creating a network and a disk is
    // finding out too late.
    const script = readFileSync(join(CLOUD, 'provision-gcp.sh'), 'utf8')
    const create = script.slice(script.indexOf('cmd_create() {'))
    expect(create.indexOf('ensure_machine_files')).toBeLessThan(create.indexOf('ensure_network'))
  })
})

describe('the machine is named after its person', () => {
  const provision = () => readFileSync(join(CLOUD, 'provision-gcp.sh'), 'utf8')

  /** @param {string} name */
  const validUser = (name) => {
    try {
      execFileSync('sh', ['-c', `${provision().match(/^valid_user\(\) \{[\s\S]*?^\}/m)?.[0]}\nvalid_user "$1"`, '_', name])
      return true
    } catch {
      return false
    }
  }

  it.each([
    ['andrin', true],
    ['andrin-v', true],
    ['a_b', true],
    // An account the image already has: taking it over would hand the
    // person's files to whatever the account was for.
    ['ubuntu', false],
    ['root', false],
    ['systemd-resolve', false],
    ['docker', false],
    // Not a Linux login at all.
    ['Andrin', false],
    ['1abc', false],
    ['-x', false],
    ['', false],
    ["an'drin", false],
    ['a'.repeat(33), false],
  ])('%s is %s', (name, ok) => {
    expect(validUser(name)).toBe(ok)
  })

  it('reads who the machine is for off the disk before a restore deletes the disk', () => {
    // A snapshot restore replaces the data disk with one that has no labels.
    // Read after the delete, the name would be gone and the restored machine
    // would belong to whoever ran recreate -- and own none of the files.
    const script = provision()
    const recreate = script.slice(script.indexOf('cmd_recreate() {'))
    expect(recreate.indexOf('resolve_user')).toBeGreaterThan(-1)
    expect(recreate.indexOf('resolve_user')).toBeLessThan(recreate.indexOf('disks delete'))
  })

  it('decides who before building anything', () => {
    const script = provision()
    const create = script.slice(script.indexOf('cmd_create() {'))
    expect(create.indexOf('resolve_user')).toBeLessThan(create.indexOf('ensure_network'))
  })

  it('names the person nowhere by hand', () => {
    // Six places said `switchboard` where they meant the person, and each is a
    // place the name could go stale in. The software keeps its own name --
    // /opt/switchboard, /etc/switchboard, switchboard.service -- which is a
    // different thing, and is not what this looks for.
    for (const file of ['provision-gcp.sh', 'setup.sh', 'unlocked.sh']) {
      const text = readFileSync(join(CLOUD, file), 'utf8')
      expect(text, file).not.toMatch(/\/home\/switchboard|sudo -u switchboard|switchboard:switchboard|-o switchboard/)
    }
  })
})

describe('a password piped in is the password used', () => {
  /*
   * The real script against a stand-in gcloud that behaves like the real one
   * where it matters: `compute ssh` forwards stdin to the far end, exactly as
   * ssh does. It records what the format step is handed, which is the password
   * that becomes the key to the disk.
   *
   * Measured before the fix: the wait-for-install loop is an ssh, it swallowed
   * the pipe, and the format step was handed a *generated* password -- which
   * `create` then printed as though it were the one asked for.
   */
  it('reaches the disk, not the first ssh that happens to run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swb-shim-'))
    try {
      writeFileSync(
        join(dir, 'gcloud'),
        `#!/bin/sh
case "$*" in
  *"addresses describe"*"value(address)"*) echo 203.0.113.9 ;;
  *"disks describe"*"switchboard-user"*) echo andrin ;;
  *"config get-value account"*) echo me@example.com ;;
  *"compute ssh"*format.js*) cat > "${dir}/format-stdin"; echo rec-over-y ;;
  *"compute ssh"*) cat > /dev/null ;;
esac
exit 0
`,
      )
      writeFileSync(join(dir, 'curl'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(dir, 'gcloud'), 0o755)
      chmodSync(join(dir, 'curl'), 0o755)
      try {
        execFileSync(
          'sh',
          [join(CLOUD, 'provision-gcp.sh'), 'create', 'x', '--project', 'p', '--yes', '--in-org', '--password-stdin'],
          { input: 'the-piped-password', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: ['pipe', 'ignore', 'ignore'] },
        )
      } catch {
        // Where the stand-in stops being convincing is past the point this is
        // about; what matters is what the format step was handed.
      }
      expect(readFileSync(join(dir, 'format-stdin'), 'utf8')).toBe('the-piped-password')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('who touched the machine', () => {
  const filter = () =>
    execFileSync(
      'sh',
      ['-c', `${readFileSync(join(CLOUD, 'provision-gcp.sh'), 'utf8').match(/^touched_filter\(\) \{[\s\S]*?^\}/m)?.[0]}\ntouched_filter me@example.com`],
      { encoding: 'utf8', env: { ...process.env, PROJECT: 'p', ZONE: 'z', VM: 'switchboard-box', DATA_DISK: 'switchboard-box-data' } },
    )

  it('asks by name, so a rebuilt machine is still the one asked about', () => {
    // It held the VM's instance id, which `recreate` replaces -- after one
    // rebuild it listed nothing, about a machine that no longer existed.
    expect(filter()).not.toContain('instance_id')
    expect(filter()).toContain('protoPayload.resourceName="projects/p/zones/z/instances/switchboard-box"')
  })

  it('sees the data disk wherever it turns up', () => {
    // Measured: a snapshot is logged against the disk and carries no instance
    // id; an attach is logged against the *other* VM, with ours only in the
    // request. The old filter could see neither.
    expect(filter()).toContain('protoPayload.resourceName="projects/p/zones/z/disks/switchboard-box-data"')
    expect(filter()).toContain('protoPayload.request.source:"disks/switchboard-box-data"')
  })

  it('leaves out the one reading it, and Google taking the scheduled snapshots', () => {
    expect(filter()).toContain('principalEmail!="me@example.com"')
    expect(filter()).toContain('NOT protoPayload.authenticationInfo.principalEmail:"compute-system.iam.gserviceaccount.com"')
  })

  it('is not an alert any more', () => {
    // It was, and it caught almost none of what it named. A promise to mail
    // you is worse than no promise when the mail never comes.
    const script = readFileSync(join(CLOUD, 'provision-gcp.sh'), 'utf8')
    expect(script).not.toMatch(/monitoring policies create|--alert-email/)
  })
})

describe('a domain, when one is associated', () => {
  const rendered = renderCaddyfile('203.0.113.7', '10.10.0.2', 'ide.example.com')

  it('is answered to everywhere the address is, and never instead of it', () => {
    // The address is the one name that cannot be wrong, and it is what you
    // fall back to the day the DNS is. So every site carries both.
    const sites = [...rendered.matchAll(/^(https:\/\/\S+(?:, \S+)?) \{$/gm)].map(([, a]) => a ?? '')
    expect(sites).toHaveLength(101)
    expect(sites.every((a) => a.includes('203.0.113.7') && a.includes('ide.example.com'))).toBe(true)
  })

  it('redirects to whichever name was typed', () => {
    // `redir https://<ip>` on a request for the domain would bounce the
    // browser off the name it asked for, once per visit, forever.
    expect(rendered).toContain('redir https://{host}{uri} permanent')
  })

  it('still identifies the machine by its address when no name is sent', () => {
    // A browser sends no SNI for a bare IP, so this is what answers the
    // address itself; a domain request carries its own name.
    expect(rendered).toMatch(/^\s*default_sni 203\.0\.113\.7$/m)
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
