/**
 * Changing the password on a machine whose disk that password opens.
 *
 * Only cloud machines have one (`cloud/provision.sh`). On a laptop there is no
 * such device and `swb password` behaves exactly as it always did.
 *
 * Two rules, both of which cost a measured bug to learn:
 *
 *   - **Re-key the volume first, and write the new hash only if that worked.**
 *     The other order gives a machine that accepts the new password at the
 *     login and cannot open its own disk with it -- discovered at the next
 *     reboot, by which time the old password is gone.
 *   - **"I cannot tell" is not "there is no volume".** Asking cryptsetup about
 *     the device fails without root, and reading that failure as "no volume
 *     here" is how `--stdin` changed the login password on an encrypted
 *     machine and left the disk key untouched. Measured on a real machine.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { deriveKey, isLuks, volumeSalt } from '../../cloud/unlock/derive.js'

const DEVICE = process.env.SWB_DATA_DEV ?? '/dev/disk/by-id/google-switchboard-data'

/**
 * @returns {'none'|'encrypted'|'unknown'} whether the IDE password also opens a
 * disk on this machine -- or whether that question could not be answered.
 */
export const volumeState = () => {
  if (!existsSync(DEVICE)) return 'none'
  try {
    return isLuks(DEVICE) ? 'encrypted' : 'none'
  } catch {
    // The device is there and we cannot read it: no sudo, most likely. Saying
    // "no volume" here is the dangerous answer, so say neither.
    return 'unknown'
  }
}

/**
 * Replace the password's key slot. The recovery slot is never touched, so a
 * failure here still leaves a way in.
 *
 * @param {string} oldPassword
 * @param {string} newPassword
 */
export const rekey = async (oldPassword, newPassword) => {
  const salt = volumeSalt(DEVICE)
  const oldKey = await deriveKey(oldPassword, salt)
  const newKey = await deriveKey(newPassword, salt)
  // cryptsetup wants the new key as a file while stdin carries the old one.
  // /dev/shm is memory: a file on the boot disk here would leave the key in
  // the clear on the one disk that is not encrypted.
  const tmp = `/dev/shm/swb-rekey-${process.pid}`
  writeFileSync(tmp, newKey, { mode: 0o600 })
  try {
    const root = typeof process.getuid === 'function' && process.getuid() === 0
    const args = ['cryptsetup', 'luksChangeKey', '--key-file=-', DEVICE, tmp]
    const cmd = root ? 'cryptsetup' : 'sudo'
    const argv = root ? args.slice(1) : ['-n', ...args]
    execFileSync(cmd, argv, { input: oldKey, stdio: ['pipe', 'ignore', 'pipe'] })
  } finally {
    unlinkSync(tmp)
  }
}
