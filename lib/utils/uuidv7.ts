// lib/utils/uuidv7.ts
// RFC 9562 §5.7 — UUID version 7 generator.
//
// Format: 48-bit Unix timestamp (ms) | 4-bit version=7 | 12-bit seq | 2-bit variant | 62-bit random
//
// UUIDv7 is used for time-sortable database IDs (Run, Node, AuditLog).
// Advantages over UUIDv4:
//   - Monotonically ordered within the same millisecond (12-bit sequence counter).
//   - Clustered inserts on B-tree indices (avoid page thrashing).
//   - Embeds creation timestamp — no separate created_at query needed for coarse ordering.
//
// DoD T1.2 requirement: all new IDs for Run, Node, AuditLog use UUIDv7.

import { randomBytes } from 'node:crypto'

// Monotonic sequence counter — prevents duplicate UUIDs within the same ms.
let _lastMs = 0
let _seq    = 0

/**
 * Generate a time-sortable UUID version 7 string.
 *
 * Thread-safe for single-threaded Node.js. The sequence counter wraps
 * at 0xFFF (4095) and resets to 0 when the millisecond advances.
 *
 * @returns UUID string in the format `xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx`
 */
export function uuidv7(): string {
  const now = Date.now()

  if (now === _lastMs) {
    _seq = (_seq + 1) & 0xFFF   // 12-bit counter; wraps silently at 4095/ms
  } else {
    _seq    = 0
    _lastMs = now
  }

  // 48-bit timestamp
  const msHigh = Math.floor(now / 0x1_0000_0000)   // top 16 bits
  const msLow  = now >>> 0                          // bottom 32 bits (unsigned)

  // 12-bit sequence (bits 48–59 in the UUID layout)
  const seqAndVersion = (0x7000 | _seq)             // version=7, 12-bit seq

  // 62 random bits — bytes 8–15 (but byte 8 has the 2-bit 10xx variant header).
  const rand = randomBytes(8)
  // RFC 9562 §4.1: set top 2 bits of byte 8 to 10 (variant = 0b10)
  rand[0] = (rand[0]! & 0x3F) | 0x80

  // Assemble the 16-byte UUID.
  // Bytes 0–5: 48-bit ms timestamp
  // Bytes 6–7: 4-bit version (0111) + 12-bit seq
  // Bytes 8–15: 2-bit variant (10) + 62 random bits
  const b0  = (msHigh >>> 8)  & 0xFF
  const b1  = msHigh          & 0xFF
  const b2  = (msLow >>> 24)  & 0xFF
  const b3  = (msLow >>> 16)  & 0xFF
  const b4  = (msLow >>> 8)   & 0xFF
  const b5  = msLow           & 0xFF
  const b6  = (seqAndVersion >>> 8) & 0xFF
  const b7  = seqAndVersion   & 0xFF

  const hex = (n: number) => n.toString(16).padStart(2, '0')

  return (
    hex(b0) + hex(b1) + hex(b2) + hex(b3) +
    '-' +
    hex(b4) + hex(b5) +
    '-' +
    hex(b6) + hex(b7) +
    '-' +
    hex(rand[0]!) + hex(rand[1]!) +
    '-' +
    hex(rand[2]!) + hex(rand[3]!) + hex(rand[4]!) + hex(rand[5]!) + hex(rand[6]!) + hex(rand[7]!)
  )
}
