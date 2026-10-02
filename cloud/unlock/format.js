/**
 * Format the data volume, once, from `provision-gcp.sh create`.
 *
 * Reads the IDE password on stdin and prints the recovery passphrase on
 * stdout. Neither is ever written to disk here -- the password becomes a key
 * slot and is forgotten, and the recovery passphrase is the caller's to show
 * the human and drop.
 *
 * It refuses a device that already carries a LUKS header. Re-running `create`
 * is supposed to be safe, and "safe" for this step means "does not reformat
 * the disk holding everything you have".
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { deriveKey, isLuks } from './derive.js'

const device = process.env.SWB_DATA_DEV ?? '/dev/disk/by-id/google-switchboard-data'
const mapper = process.env.SWB_MAPPER ?? 'switchboard-data'

const password = readFileSync(0, 'utf8').replace(/\n$/, '')
if (password === '') {
  console.error('format: no password on stdin')
  process.exit(1)
}

if (isLuks(device)) {
  console.error(`format: ${device} already holds a LUKS volume; refusing`)
  process.exit(2)
}

/*
 * The UUID is chosen here rather than by cryptsetup, because it is also the
 * salt -- and the key has to exist before the header it will open does.
 */
const uuid = randomUUID()
const key = await deriveKey(password, Buffer.from(uuid, 'utf8'))
// Words, not bytes: this is the thing a person copies into a password manager
// and may one day have to type by hand.
const recovery = [...randomBytes(10)].map((b) => b.toString(36).padStart(2, '0')).join('-')

execFileSync(
  'cryptsetup',
  ['luksFormat', '--type', 'luks2', '--batch-mode', '--uuid', uuid, '--key-file=-', device],
  { input: key },
)

/*
 * The second slot, so a forgotten password is recoverable and a lost recovery
 * passphrase is not fatal either. cryptsetup wants the *new* key as a file
 * rather than on stdin, which stdin is already carrying the existing one -- so
 * it goes through /dev/shm, which is memory, mode 0600, and unlinked
 * immediately. A file on the boot disk here would undo the entire arrangement.
 */
const tmp = `/dev/shm/swb-recovery-${process.pid}`
writeFileSync(tmp, recovery, { mode: 0o600 })
try {
  execFileSync('cryptsetup', ['luksAddKey', '--key-file=-', device, tmp], { input: key })
} finally {
  unlinkSync(tmp)
}

execFileSync('cryptsetup', ['open', '--key-file=-', device, mapper], { input: key })
execFileSync('mkfs.ext4', ['-q', '-L', 'switchboard', `/dev/mapper/${mapper}`])

process.stdout.write(`${recovery}\n`)
