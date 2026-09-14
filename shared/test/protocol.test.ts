import { describe, expect, it } from 'vitest'
import {
  FRAME_OUTPUT,
  OUTPUT_HEADER_BYTES,
  decodeOutputFrame,
  encodeOutputFrame,
} from '../src/protocol.js'

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)

describe('output frames', () => {
  it('round-trips a payload under its stream id', () => {
    const payload = bytes(0x1b, 0x5b, 0x32, 0x4a, 0xff, 0x00)
    const decoded = decodeOutputFrame(encodeOutputFrame(7, payload))
    expect(decoded?.streamId).toBe(7)
    expect([...(decoded?.payload ?? [])]).toEqual([...payload])
  })

  it('writes the tag and a little-endian stream id', () => {
    const frame = encodeOutputFrame(0x01020304, bytes(0x41))
    expect(frame[0]).toBe(FRAME_OUTPUT)
    expect([...frame.subarray(1, 5)]).toEqual([0x04, 0x03, 0x02, 0x01])
    expect(frame[OUTPUT_HEADER_BYTES]).toBe(0x41)
  })

  it('carries a stream id above 2^31, which a signed read would mangle', () => {
    expect(decodeOutputFrame(encodeOutputFrame(0xffffffff, bytes()))?.streamId).toBe(0xffffffff)
  })

  it('carries an empty payload', () => {
    const decoded = decodeOutputFrame(encodeOutputFrame(3, bytes()))
    expect(decoded?.streamId).toBe(3)
    expect(decoded?.payload.length).toBe(0)
  })

  it('decodes a frame sitting at an offset inside a larger buffer', () => {
    /*
     * A socket hands over a view into a pooled buffer, not a buffer of its own.
     * `new DataView(frame.buffer)` would then read the header from the start of
     * the pool rather than from the start of the frame, so the byteOffset has
     * to be passed through -- this is the case that catches it being dropped.
     */
    const frame = encodeOutputFrame(9, bytes(0x61, 0x62))
    const pool = new Uint8Array(frame.length + 16)
    pool.set(frame, 11)
    const view = pool.subarray(11, 11 + frame.length)
    const decoded = decodeOutputFrame(view)
    expect(decoded?.streamId).toBe(9)
    expect([...(decoded?.payload ?? [])]).toEqual([0x61, 0x62])
  })

  it('refuses a frame that is shorter than its header', () => {
    expect(decodeOutputFrame(bytes(FRAME_OUTPUT, 0, 0, 0))).toBeNull()
    expect(decodeOutputFrame(bytes())).toBeNull()
  })

  it('refuses a frame with some other tag', () => {
    expect(decodeOutputFrame(bytes(0x02, 0, 0, 0, 0, 0x41))).toBeNull()
  })
})
