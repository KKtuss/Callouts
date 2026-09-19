import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import { decodeBase58, encodeBase58 } from "@/lib/base58"
import { parseSolanaSecretKey } from "@/lib/solana-key"

function rawEd25519Keypair(): { seed: Uint8Array; publicKey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" })
  const spki = publicKey.export({ type: "spki", format: "der" })
  // PKCS8 ed25519: last 32 bytes are the seed.
  const seed = new Uint8Array(pkcs8.subarray(pkcs8.length - 32))
  const pub = new Uint8Array(spki.subarray(spki.length - 32))
  // sanity: recreate
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)])
  const rebuilt = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" }))
  const rebuiltSpki = rebuilt.export({ type: "spki", format: "der" })
  expect(Buffer.from(rebuiltSpki.subarray(rebuiltSpki.length - 32)).equals(Buffer.from(pub))).toBe(true)
  return { seed, publicKey: pub }
}

describe("solana secret key parsing", () => {
  it("round-trips base58 bytes", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 17) & 0xff)
    expect(decodeBase58(encodeBase58(bytes))).toEqual(bytes)
  })

  it("accepts a 64-byte keypair and exposes the public address", () => {
    const { seed, publicKey } = rawEd25519Keypair()
    const secret = new Uint8Array(64)
    secret.set(seed, 0)
    secret.set(publicKey, 32)
    const encoded = encodeBase58(secret)
    const parsed = parseSolanaSecretKey(encoded)
    expect(parsed.publicAddress).toBe(encodeBase58(publicKey))
    expect(parsed.secretKey).toHaveLength(64)
  })

  it("accepts a 32-byte seed and derives the public address", () => {
    const { seed, publicKey } = rawEd25519Keypair()
    const parsed = parseSolanaSecretKey(encodeBase58(seed))
    expect(parsed.publicAddress).toBe(encodeBase58(publicKey))
  })
})
