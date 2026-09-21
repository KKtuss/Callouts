import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js"
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token"
import { explorerTxUrl } from "@/lib/explorer"
import { isSolPayout } from "@/lib/rewards"
import { parseSolanaSecretKey } from "@/lib/solana-key"
import type { EngineConfig } from "@/engine/types"
import { MockTreasury, type CreatorFeeCollectResult, type Treasury, type TreasuryResult, type TreasurySendInput } from "@/engine/treasury"

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com"

function wipe(bytes: Uint8Array | null) {
  if (!bytes) return
  bytes.fill(0)
}

function uiToRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Allocation amount must be positive")
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new Error(`Unsupported mint decimals: ${decimals}`)
  }
  // Config amounts are whole UI units (e.g. 2_500_000 tokens). Keep integer path exact.
  if (Number.isInteger(amount)) {
    return BigInt(amount) * BigInt(10) ** BigInt(decimals)
  }
  const scaled = amount * 10 ** decimals
  const raw = Math.round(scaled)
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error("Allocation amount is too small for mint decimals")
  }
  return BigInt(raw)
}

function tokenProgramForOwner(owner: PublicKey): PublicKey {
  if (owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
  if (owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID
  throw new Error(`Unsupported token program: ${owner.toBase58()}`)
}

/**
 * On-chain treasury. When a private key is loaded, sends real SOL / SPL transfers.
 * Without a key, falls back to MockTreasury so demos keep working.
 */
export class SolanaTreasury implements Treasury {
  publicAddress: string
  balance = 0
  private secretKey: Uint8Array | null = null
  private readonly connection: Connection
  private readonly mock: MockTreasury

  constructor(
    private readonly config: () => EngineConfig,
    delay: (ms: number) => Promise<void> = async () => undefined,
    rpcUrl = process.env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC,
    publicAddress?: string,
  ) {
    this.connection = new Connection(rpcUrl, "confirmed")
    this.publicAddress = publicAddress ?? config().treasuryPublicAddress
    this.mock = new MockTreasury(config, delay, 1_000_000_000, this.publicAddress)
    this.balance = this.mock.balance
  }

  get keyConfigured(): boolean {
    return this.secretKey !== null
  }

  /** True when the next send() will hit the chain. */
  get live(): boolean {
    return this.secretKey !== null
  }

  setSecretKey(raw: string | null) {
    if (!raw?.trim()) {
      wipe(this.secretKey)
      this.secretKey = null
      this.mock.setSecretKey(null)
      return
    }
    const parsed = parseSolanaSecretKey(raw)
    wipe(this.secretKey)
    this.secretKey = parsed.secretKey
    this.publicAddress = parsed.publicAddress
    this.mock.setSecretKey(raw)
    this.mock.publicAddress = parsed.publicAddress
  }

  async refreshBalance(): Promise<number> {
    if (!this.secretKey) {
      this.balance = this.mock.balance
      return this.balance
    }
    const cfg = this.config()
    try {
      if (isSolPayout(cfg.distributionToken)) {
        const lamports = await this.connection.getBalance(new PublicKey(this.publicAddress))
        this.balance = lamports / LAMPORTS_PER_SOL
        return this.balance
      }
      const mint = cfg.coinMint
      if (!mint) {
        this.balance = 0
        return 0
      }
      const mintPk = new PublicKey(mint)
      const mintInfo = await this.connection.getAccountInfo(mintPk, "confirmed")
      if (!mintInfo) {
        this.balance = 0
        return 0
      }
      const programId = tokenProgramForOwner(mintInfo.owner)
      const ata = getAssociatedTokenAddressSync(
        mintPk,
        new PublicKey(this.publicAddress),
        false,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      )
      try {
        const account = await getAccount(this.connection, ata, "confirmed", programId)
        const mintData = await getMint(this.connection, mintPk, "confirmed", programId)
        this.balance = Number(account.amount) / 10 ** mintData.decimals
        return this.balance
      } catch {
        this.balance = 0
        return 0
      }
    } catch (error) {
      console.error("[treasury] balance refresh failed", error)
      return this.balance
    }
  }

  async send(input: TreasurySendInput): Promise<TreasuryResult> {
    if (!this.secretKey) {
      const result = await this.mock.send(input)
      this.balance = this.mock.balance
      return result
    }
    if (input.amount <= 0) {
      throw new Error("Allocation amount must be positive")
    }
    const payer = this.keypair()
    const cfg = this.config()
    const solBefore = await this.connection.getBalance(payer.publicKey)
    const tokenBefore = await this.tokenUiBalance(payer.publicKey, cfg.coinMint)
    const signature = isSolPayout(input.distributionToken)
      ? await this.sendSol(payer, input.wallet, input.amount)
      : await this.sendSpl(payer, input.wallet, input.amount, cfg)

    const solAfter = await this.connection.getBalance(payer.publicKey)
    const tokenAfter = await this.tokenUiBalance(payer.publicKey, cfg.coinMint)
    await this.refreshBalance()

    return {
      signature,
      explorerUrl: explorerTxUrl(signature, cfg.explorerTxTemplate),
      confirmedAt: new Date().toISOString(),
      walletTrace: {
        solBeforeLamports: solBefore,
        solAfterLamports: solAfter,
        tokenBefore,
        tokenAfter,
      },
    }
  }

  async collectCreatorFees(): Promise<CreatorFeeCollectResult> {
    if (!this.secretKey) {
      return this.mock.collectCreatorFees()
    }

    const payer = this.keypair()
    const cfg = this.config()
    const { OnlinePumpSdk } = await import("@pump-fun/pump-sdk")
    const sdk = new OnlinePumpSdk(this.connection)
    const creator = payer.publicKey

    let beforeLamports = 0
    try {
      const beforeBn = await sdk.getCreatorVaultBalanceBothPrograms(creator)
      beforeLamports = Number(beforeBn.toString())
    } catch (error) {
      console.warn("[treasury] creator vault balance read failed", error)
    }

    if (beforeLamports <= 0) {
      return {
        signature: null,
        explorerUrl: null,
        claimedLamports: 0,
        claimedSol: 0,
        beforeLamports,
        afterLamports: beforeLamports,
        instructionCount: 0,
        skippedReason: "Creator fee vault is empty",
      }
    }

    const instructions = await sdk.collectCoinCreatorFeeAllQuotesInstructions(creator, creator)
    if (instructions.length === 0) {
      return {
        signature: null,
        explorerUrl: null,
        claimedLamports: 0,
        claimedSol: 0,
        beforeLamports,
        afterLamports: beforeLamports,
        instructionCount: 0,
        skippedReason: "No collect instructions built (vault may already be drained)",
      }
    }

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ...instructions,
    )
    const signature = await sendAndConfirmTransaction(this.connection, tx, [payer], {
      commitment: "confirmed",
      maxRetries: 3,
    })

    let afterLamports = 0
    try {
      const afterBn = await sdk.getCreatorVaultBalanceBothPrograms(creator)
      afterLamports = Number(afterBn.toString())
    } catch {
      afterLamports = 0
    }

    const claimedLamports = Math.max(0, beforeLamports - afterLamports)
    await this.refreshBalance()

    return {
      signature,
      explorerUrl: explorerTxUrl(signature, cfg.explorerTxTemplate),
      claimedLamports,
      claimedSol: claimedLamports / LAMPORTS_PER_SOL,
      beforeLamports,
      afterLamports,
      instructionCount: instructions.length,
      skippedReason: null,
    }
  }

  private async tokenUiBalance(owner: PublicKey, mint: string | null): Promise<number | null> {
    if (!mint) return null
    try {
      const mintPk = new PublicKey(mint)
      const mintInfo = await this.connection.getAccountInfo(mintPk, "confirmed")
      if (!mintInfo) return null
      const programId = tokenProgramForOwner(mintInfo.owner)
      const ata = getAssociatedTokenAddressSync(
        mintPk,
        owner,
        false,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      )
      const account = await getAccount(this.connection, ata, "confirmed", programId)
      const mintData = await getMint(this.connection, mintPk, "confirmed", programId)
      return Number(account.amount) / 10 ** mintData.decimals
    } catch {
      return 0
    }
  }

  private keypair(): Keypair {
    if (!this.secretKey) {
      throw new Error("Treasury private key is not configured")
    }
    return Keypair.fromSecretKey(this.secretKey)
  }

  private async sendSol(payer: Keypair, wallet: string, amountSol: number): Promise<string> {
    const lamports = Math.round(amountSol * LAMPORTS_PER_SOL)
    if (lamports <= 0) throw new Error("SOL amount is too small")
    const balance = await this.connection.getBalance(payer.publicKey)
    if (balance < lamports) {
      throw new Error("Treasury SOL balance is insufficient")
    }
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: new PublicKey(wallet),
        lamports,
      }),
    )
    return sendAndConfirmTransaction(this.connection, tx, [payer], {
      commitment: "confirmed",
      maxRetries: 3,
    })
  }

  private async sendSpl(
    payer: Keypair,
    wallet: string,
    amountUi: number,
    cfg: EngineConfig,
  ): Promise<string> {
    const mintAddress = cfg.coinMint
    if (!mintAddress) {
      throw new Error("Coin mint is required for token payouts")
    }

    const mintPk = new PublicKey(mintAddress)
    const mintInfo = await this.connection.getAccountInfo(mintPk, "confirmed")
    if (!mintInfo) throw new Error(`Mint account not found: ${mintAddress}`)
    const programId = tokenProgramForOwner(mintInfo.owner)
    const mintData = await getMint(this.connection, mintPk, "confirmed", programId)
    const rawAmount = uiToRaw(amountUi, mintData.decimals)

    const fromAta = getAssociatedTokenAddressSync(
      mintPk,
      payer.publicKey,
      false,
      programId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    const toOwner = new PublicKey(wallet)
    const toAta = getAssociatedTokenAddressSync(
      mintPk,
      toOwner,
      false,
      programId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )

    let fromBalance: bigint
    try {
      const fromAccount = await getAccount(this.connection, fromAta, "confirmed", programId)
      fromBalance = fromAccount.amount
    } catch {
      throw new Error("Treasury has no token account for this mint — fund the treasury ATA first")
    }
    if (fromBalance < rawAmount) {
      throw new Error("Treasury token balance is insufficient")
    }

    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        toAta,
        toOwner,
        mintPk,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createTransferCheckedInstruction(
        fromAta,
        mintPk,
        toAta,
        payer.publicKey,
        rawAmount,
        mintData.decimals,
        [],
        programId,
      ),
    )

    return sendAndConfirmTransaction(this.connection, tx, [payer], {
      commitment: "confirmed",
      maxRetries: 3,
    })
  }
}
