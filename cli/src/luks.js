/**
 * Changing the password on a machine whose disk the password opens.
 *
 * Only cloud machines have one (`cloud/provision.sh`). On a laptop every
 * function here answers "there is no volume" and `swb password` behaves as it
 * always did.
 *
 * The rule this file exists for: **re-key the volume first, and write the new
 * hash only if that worked.** The other order gives a machine that accepts the
 * new password at the login and cannot open its own disk with it -- discovered
 * at the next reboot, by which time the old password is gone.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { deriveKey, isLuks, volumeSalt } from '../../cloud/unlock/derive.js'

const DEVICE = process.env.SWB_DATA_DEV ?? '/dev/disk/by-id/google-switchboard-data'

/** Is this a machine whose disk is opened by the IDE password? */
export const volumeConfigured = () => existsSync(DEVICE) && isLuks(DEVICE)

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
    execFileSync('sudo', ['cryptsetup', 'luksChangeKey', '--key-file=-', DEVICE, tmp], {
      input: oldKey,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
  } finally {
    unlinkSync(tmp)
  }
}
