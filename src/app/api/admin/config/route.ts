import { requireAdmin } from "@/lib/admin-auth"
import { encryptTreasuryKey } from "@/engine/durable-config"
import { clearWatchMint, getRuntime, persistDurableConfig, setAxiomCookie, setWatchMint } from "@/engine/runtime"
import type { EngineConfig } from "@/engine/types"

export const dynamic = "force-dynamic"

type ConfigBody = Partial<EngineConfig> & {
  /** Write-only. Never echoed in client state. */
  treasuryPrivateKey?: string | null
  /** Write-only Axiom session Cookie header. Never echoed. */
  axiomCookie?: string | null
}

// Fields that should be persisted to Redis durable config when changed via this route.
const DURABLE_FIELDS: (keyof EngineConfig)[] = [
  "fomoTreasuryWallet",
  "snapshotMinMs",
  "snapshotMaxMs",
  "allocationAmount",
  "creatorRewardShareBps",
]

export async function POST(request: Request) {
  const denied = requireAdmin(request)
  if (denied) return denied

  const body = (await request.json()) as ConfigBody
  let encryptedKey: string | null | undefined = undefined // undefined = no change

  try {
    if (Object.prototype.hasOwnProperty.call(body, "treasuryPrivateKey")) {
      const raw = body.treasuryPrivateKey
      const trimmed = typeof raw === "string" && raw.trim() ? raw.trim() : null
      getRuntime().engine.setTreasuryPrivateKey(trimmed)
      const adminKey = process.env.ADMIN_KEY?.trim() ?? ""
      encryptedKey = trimmed && adminKey ? encryptTreasuryKey(trimmed, adminKey) : null
    }

    if (Object.prototype.hasOwnProperty.call(body, "coinMint")) {
      const raw = typeof body.coinMint === "string" ? body.coinMint.trim() : ""
      if (raw) await setWatchMint(raw)
      else await clearWatchMint()
    }

    // Mint start can reload an older durable key during hydrate — re-apply the
    // key from this request so the new treasury wins.
    if (Object.prototype.hasOwnProperty.call(body, "treasuryPrivateKey")) {
      const raw = body.treasuryPrivateKey
      const trimmed = typeof raw === "string" && raw.trim() ? raw.trim() : null
      getRuntime().engine.setTreasuryPrivateKey(trimmed)
      const adminKey = process.env.ADMIN_KEY?.trim() ?? ""
      encryptedKey = trimmed && adminKey ? encryptTreasuryKey(trimmed, adminKey) : null
    }

    if (Object.prototype.hasOwnProperty.call(body, "axiomCookie")) {
      const raw = body.axiomCookie
      setAxiomCookie(typeof raw === "string" && raw.trim() ? raw.trim() : null)
    }

    const {
      coinMint: _mint,
      coinName: _name,
      distributionToken: _token,
      treasuryPrivateKey: _secret,
      axiomCookie: _axiom,
      ...rest
    } = body
    if (Object.keys(rest).length > 0) {
      getRuntime().engine.updateConfig(rest)
    }

    // Persist any durable fields to Redis so all isolates pick them up.
    const hasDurableChange =
      encryptedKey !== undefined ||
      DURABLE_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(body, f))

    if (hasDurableChange) {
      await persistDurableConfig(getRuntime(), {
        ...(encryptedKey !== undefined ? { encryptedKey } : {}),
      })
    }

    return Response.json(getRuntime().store.clientState())
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid config" },
      { status: 400 },
    )
  }
}
