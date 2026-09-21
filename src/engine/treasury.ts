import { randomBytes } from "node:crypto"
import { encodeBase58 } from "@/lib/base58"
import { explorerTxUrl } from "@/lib/explorer"
import { parseSolanaSecretKey } from "@/lib/solana-key"
import type { DistributionTx, EngineConfig } from "@/engine/types"

export type TreasurySendInput = {
  wallet: string
  amount: number
  distributionToken: string
}

export type TreasuryResult = {
  signature: string
  explorerUrl: string
  confirmedAt: string
  /** Present for live sends — used by the ops wallet console. */
  walletTrace?: {
    solBeforeLamports: number
    solAfterLamports: number
    tokenBefore: number | null
    tokenAfter: number | null
  }
}

export type CreatorFeeCollectResult = {
  /** Null when nothing was submitted (mock mode, empty vault, or no ixs). */
  signature: string | null
  explorerUrl: string | null
  claimedLamports: number
  claimedSol: number
  beforeLamports: number
  afterLamports: number
  instructionCount: number
  skippedReason: string | null
}

export interface Treasury {
  publicAddress: string
  balance: number
  readonly keyConfigured: boolean
  /** True when send() is a real (or test-mock) payout. False = dry run, do not lottery. */
  readonly live: boolean
  setSecretKey(raw: string | null): void
  /** Refresh on-chain balance when supported; mock treasuries are a no-op. */
  refreshBalance(): Promise<number>
  /** Sweep Pump bonding-curve + AMM creator fees into this wallet. */
  collectCreatorFees(): Promise<CreatorFeeCollectResult>
  send(input: TreasurySendInput): Promise<TreasuryResult>
}

function mockSignature(): string {
  return encodeBase58(randomBytes(64))
}

function wipe(bytes: Uint8Array | null) {
  if (!bytes) return
  bytes.fill(0)
}

export class MockTreasury implements Treasury {
  publicAddress: string
  balance: number
  private secretKey: Uint8Array | null = null

  constructor(
    private readonly config: () => EngineConfig,
    private readonly delay: (ms: number) => Promise<void>,
    startingBalance = 1_000_000,
    publicAddress?: string,
  ) {
    this.balance = startingBalance
    this.publicAddress = publicAddress ?? config().treasuryPublicAddress
  }

  get keyConfigured(): boolean {
    return this.secretKey !== null
  }

  get live(): boolean {
    return true
  }

  setSecretKey(raw: string | null) {
    if (!raw?.trim()) {
      wipe(this.secretKey)
      this.secretKey = null
      return
    }
    const parsed = parseSolanaSecretKey(raw)
    wipe(this.secretKey)
    this.secretKey = parsed.secretKey
    this.publicAddress = parsed.publicAddress
  }

  async refreshBalance(): Promise<number> {
    return this.balance
  }

  async collectCreatorFees(): Promise<CreatorFeeCollectResult> {
    return {
      signature: null,
      explorerUrl: null,
      claimedLamports: 0,
      claimedSol: 0,
      beforeLamports: 0,
      afterLamports: 0,
      instructionCount: 0,
      skippedReason: this.keyConfigured
        ? "Mock treasury — creator fee collect is a no-op"
        : "Treasury private key not configured (mock mode)",
    }
  }

  async send(input: TreasurySendInput): Promise<TreasuryResult> {
    if (input.amount <= 0) {
      throw new Error("Allocation amount must be positive")
    }
    if (this.balance < input.amount) {
      throw new Error("Treasury balance is insufficient")
    }

    const cfg = this.config()
    if (cfg.mockTxDelayMs > 0) {
      await this.delay(cfg.mockTxDelayMs)
    }

    this.balance -= input.amount
    const signature = mockSignature()
    return {
      signature,
      explorerUrl: explorerTxUrl(signature, cfg.explorerTxTemplate),
      confirmedAt: new Date().toISOString(),
    }
  }
}

export function txPending(partial: Omit<DistributionTx, "signature" | "explorerUrl" | "status" | "confirmedAt" | "error" | "submittedAt">): DistributionTx {
  return {
    ...partial,
    signature: null,
    explorerUrl: null,
    status: "pending",
    submittedAt: new Date().toISOString(),
    confirmedAt: null,
    error: null,
  }
}
