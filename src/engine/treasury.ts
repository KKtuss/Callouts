import { randomBytes } from "node:crypto"
import { encodeBase58 } from "@/lib/base58"
import { explorerTxUrl } from "@/lib/explorer"
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
}

export interface Treasury {
  publicAddress: string
  balance: number
  send(input: TreasurySendInput): Promise<TreasuryResult>
}

function mockSignature(): string {
  return encodeBase58(randomBytes(64))
}

export class MockTreasury implements Treasury {
  publicAddress: string
  balance: number

  constructor(
    private readonly config: () => EngineConfig,
    private readonly delay: (ms: number) => Promise<void>,
    startingBalance = 1_000_000,
    publicAddress?: string,
  ) {
    this.balance = startingBalance
    this.publicAddress = publicAddress ?? config().treasuryPublicAddress
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
