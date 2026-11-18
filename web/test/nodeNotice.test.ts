import { describe, expect, it } from 'vitest'
import type { MachineNode } from '@switchboard/shared'
import { nodeNotice } from '../src/components/NodeBanner.js'

const machine = (name: string, running: string, update: string | null): MachineNode => ({
  key: name === 'here' ? null : name,
  name,
  node: { running, update },
})

describe('nodeNotice', () => {
  it('lists only the machines behind', () => {
    const notice = nodeNotice([machine('here', '26.13.1', null), machine('ide', '22.22.1', '22.23.5')])
    expect(notice?.lines).toEqual([{ name: 'ide', running: '22.22.1', update: '22.23.5' }])
  })

  it('is nothing when every machine is current', () => {
    expect(nodeNotice([machine('here', '26.13.1', null)])).toBeNull()
  })

  // "Later" is kept by this key: it must change when a newer release arrives
  // or another machine falls behind, or a dismissal would hide a fix it never showed.
  it('changes identity with a newer release or another machine', () => {
    const first = nodeNotice([machine('ide', '22.22.1', '22.23.5')])?.key
    expect(nodeNotice([machine('ide', '22.22.1', '22.23.6')])?.key).not.toBe(first)
    expect(nodeNotice([machine('ide', '22.22.1', '22.23.5'), machine('here', '26.12.0', '26.13.1')])?.key).not.toBe(first)
    expect(nodeNotice([machine('ide', '22.22.1', '22.23.5')])?.key).toBe(first)
  })
})
