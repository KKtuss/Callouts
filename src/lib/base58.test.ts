import { describe, expect, it } from "vitest"
import { encodeBase58 } from "@/lib/base58"

describe("encodeBase58", () => {
  it("encodes the empty buffer and a known 32-byte key length", () => {
    expect(encodeBase58(new Uint8Array())).toBe("")
    expect(encodeBase58(new Uint8Array(32).fill(1)).length).toBeGreaterThanOrEqual(32)
    expect(encodeBase58(new Uint8Array(32).fill(1))).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/)
  })
})
