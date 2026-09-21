import { afterEach, describe, expect, it, vi } from "vitest"
import { Keypair } from "@solana/web3.js"
import { encodeBase58 } from "@/lib/base58"
import { DEFAULT_CONFIG } from "@/engine/store"
import { SolanaTreasury } from "@/engine/solana-treasury"
import { AIDEN_MINT } from "@/lib/coin"

describe("SolanaTreasury", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("falls back to mock sends when no private key is loaded", async () => {
    const treasury = new SolanaTreasury(
      () => ({ ...DEFAULT_CONFIG, mockTxDelayMs: 0, coinMint: AIDEN_MINT }),
      async () => undefined,
    )
    const before = treasury.balance
    const result = await treasury.send({
      wallet: "So11111111111111111111111111111111111111112",
      amount: 100,
      distributionToken: "AIDEN",
    })
    expect(result.signature).toBeTruthy()
    expect(treasury.balance).toBe(before - 100)
    expect(treasury.live).toBe(false)
  })

  it("skips creator fee collect in mock mode", async () => {
    const treasury = new SolanaTreasury(() => ({ ...DEFAULT_CONFIG, mockTxDelayMs: 0 }))
    const result = await treasury.collectCreatorFees()
    expect(result.signature).toBeNull()
    expect(result.skippedReason).toMatch(/mock/i)
  })

  it("derives the public address from a private key", () => {
    const kp = Keypair.generate()
    const treasury = new SolanaTreasury(() => DEFAULT_CONFIG)
    treasury.setSecretKey(encodeBase58(kp.secretKey))
    expect(treasury.keyConfigured).toBe(true)
    expect(treasury.live).toBe(true)
    expect(treasury.publicAddress).toBe(kp.publicKey.toBase58())
  })
})
