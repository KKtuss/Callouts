import { createPrivateKey, createPublicKey } from "node:crypto"
import { decodeBase58, encodeBase58 } from "@/lib/base58"

export type SolanaSecretKey = {
  /** 64-byte Solana secret key (seed + pubkey). */
  secretKey: Uint8Array
  publicAddress: string
}

function ed25519PublicFromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes")
  // PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)])
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" })
  const publicKey = createPublicKey(privateKey)
  const exported = publicKey.export({ type: "spki", format: "der" })
  // SPKI for Ed25519 ends with the 32-byte raw public key.
  return new Uint8Array(exported.subarray(exported.length - 32))
}

/**
 * Accepts a Solana secret key as base58 (64-byte keypair or 32-byte seed).
 * Never log or return the raw key to clients.
 */
export function parseSolanaSecretKey(raw: string): SolanaSecretKey {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error("Treasury private key is required")

  let decoded: Uint8Array
  try {
    decoded = decodeBase58(trimmed)
  } catch {
    throw new Error("Treasury private key must be base58")
  }

  let secretKey: Uint8Array
  let publicKey: Uint8Array

  if (decoded.length === 64) {
    secretKey = decoded
    publicKey = decoded.slice(32)
  } else if (decoded.length === 32) {
    publicKey = ed25519PublicFromSeed(decoded)
    secretKey = new Uint8Array(64)
    secretKey.set(decoded, 0)
    secretKey.set(publicKey, 32)
  } else {
    throw new Error("Treasury private key must decode to 32 or 64 bytes")
  }

  return {
    secretKey,
    publicAddress: encodeBase58(publicKey),
  }
}
