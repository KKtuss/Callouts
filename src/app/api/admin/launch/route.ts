/**
 * POST /api/admin/launch
 *
 * Single-call token launch. Replaces the old workflow of:
 *   1. Update 8+ Vercel env vars
 *   2. Deploy
 *   3. Discover token name separately
 *   4. Update more env vars
 *   5. Deploy again
 *   6. Call admin/config
 *
 * Now it's just:
 *   POST /api/admin/launch { mint, pumpPrivateKey, fomoTreasuryWallet }
 *   → returns in ~5s with the engine live and Telegram updated.
 *
 * All config is persisted to Redis (callout:config) so every future
 * cold-start isolate picks it up without a redeploy.
 */
import { requireAdmin } from "@/lib/admin-auth"
import {
  encryptTreasuryKey,
  saveDurableConfig,
} from "@/engine/durable-config"
import {
  getRuntime,
  persistDurableConfig,
  setWatchMint,
  waitForRuntime,
} from "@/engine/runtime"
import { isMintAddress, fetchCoinMetadata } from "@/lib/coin"

export const dynamic = "force-dynamic"

type LaunchBody = {
  /** Solana mint address of the new token. */
  mint: string
  /** Raw base58 private key for the Pump treasury wallet. */
  pumpPrivateKey: string
  /** Public address of the FOMO treasury wallet (admin-managed). */
  fomoTreasuryWallet: string
  /** Optional: ms between snapshots min (default 300 000 = 5 min). */
  snapshotMinMs?: number
  /** Optional: ms between snapshots max (default 900 000 = 15 min). */
  snapshotMaxMs?: number
  /** Optional: token allocation per winner per snapshot. */
  allocationAmount?: number
}

export async function POST(request: Request) {
  const denied = requireAdmin(request)
  if (denied) return denied

  let body: LaunchBody
  try {
    body = (await request.json()) as LaunchBody
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { mint, pumpPrivateKey, fomoTreasuryWallet } = body
  const mintTrimmed = typeof mint === "string" ? mint.trim() : ""
  const keyTrimmed = typeof pumpPrivateKey === "string" ? pumpPrivateKey.trim() : ""
  const fomoTrimmed = typeof fomoTreasuryWallet === "string" ? fomoTreasuryWallet.trim() : ""

  if (!mintTrimmed || !isMintAddress(mintTrimmed)) {
    return Response.json({ error: "Invalid or missing mint address" }, { status: 400 })
  }
  if (!keyTrimmed) {
    return Response.json({ error: "Missing pumpPrivateKey" }, { status: 400 })
  }
  if (!fomoTrimmed) {
    return Response.json({ error: "Missing fomoTreasuryWallet" }, { status: 400 })
  }

  try {
    // 1. Fetch token metadata (pump.fun, ~300ms from Vercel).
    const meta = await fetchCoinMetadata(mintTrimmed)

    // 2. Load runtime and apply treasury key + FOMO wallet immediately on this isolate.
    const runtime = await waitForRuntime()
    runtime.engine.setTreasuryPrivateKey(keyTrimmed)
    runtime.engine.updateConfig({
      fomoTreasuryWallet: fomoTrimmed,
      ...(body.snapshotMinMs ? { snapshotMinMs: body.snapshotMinMs } : {}),
      ...(body.snapshotMaxMs ? { snapshotMaxMs: body.snapshotMaxMs } : {}),
      ...(body.allocationAmount ? { allocationAmount: body.allocationAmount } : {}),
    })

    // 3. Encrypt the private key and persist ALL config to Redis.
    //    Every future cold-start isolate loads this — no redeploy needed.
    const adminKey = process.env.ADMIN_KEY?.trim() ?? ""
    const encryptedKey = adminKey ? encryptTreasuryKey(keyTrimmed, adminKey) : null

    await saveDurableConfig({
      fomoTreasuryWallet: fomoTrimmed,
      treasuryPublicAddress: runtime.store.treasuryPublicAddress || null,
      encryptedTreasuryKey: encryptedKey,
      snapshotMinMs: body.snapshotMinMs ?? runtime.store.config.snapshotMinMs,
      snapshotMaxMs: body.snapshotMaxMs ?? runtime.store.config.snapshotMaxMs,
      allocationAmount: body.allocationAmount ?? runtime.store.config.allocationAmount,
      creatorRewardShareBps: runtime.store.config.creatorRewardShareBps,
    })

    // 4. Switch mint (fetches metadata, wipes old Redis state, updates Telegram pin).
    //    Telegram purge is now batched (deleteMessages) so this completes in ~3–5s
    //    instead of 140s.
    await setWatchMint(mintTrimmed)

    // 5. Persist config again after setWatchMint (it may reset some fields).
    await persistDurableConfig(getRuntime(), { encryptedKey })

    const state = getRuntime().store.clientState()
    return Response.json({
      ok: true,
      token: meta.ticker,
      name: meta.name,
      mint: mintTrimmed,
      treasury: getRuntime().store.treasuryPublicAddress,
      fomoWallet: fomoTrimmed,
      keyConfigured: getRuntime().store.treasuryKeyConfigured,
      nextSnapshotAt: state.status.nextSnapshotAt,
      snapshotMinMs: state.status.config.snapshotMinMs,
      snapshotMaxMs: state.status.config.snapshotMaxMs,
      allocationAmount: state.status.config.allocationAmount,
      note: "Config persisted to Redis — all isolates will pick this up on cold start without a redeploy.",
    })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Launch failed" },
      { status: 500 },
    )
  }
}
