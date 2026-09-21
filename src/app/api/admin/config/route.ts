import { requireAdmin } from "@/lib/admin-auth"
import { clearWatchMint, getRuntime, setAxiomCookie, setWatchMint } from "@/engine/runtime"
import type { EngineConfig } from "@/engine/types"

export const dynamic = "force-dynamic"

type ConfigBody = Partial<EngineConfig> & {
  /** Write-only. Never echoed in client state. */
  treasuryPrivateKey?: string | null
  /** Write-only Axiom session Cookie header. Never echoed. */
  axiomCookie?: string | null
}

export async function POST(request: Request) {
  const denied = requireAdmin(request)
  if (denied) return denied

  const body = (await request.json()) as ConfigBody
  try {
    if (Object.prototype.hasOwnProperty.call(body, "coinMint")) {
      const raw = typeof body.coinMint === "string" ? body.coinMint.trim() : ""
      if (raw) await setWatchMint(raw)
      else await clearWatchMint()
    }

    if (Object.prototype.hasOwnProperty.call(body, "treasuryPrivateKey")) {
      const raw = body.treasuryPrivateKey
      getRuntime().engine.setTreasuryPrivateKey(
        typeof raw === "string" && raw.trim() ? raw.trim() : null,
      )
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
    return Response.json(getRuntime().store.clientState())
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid config" },
      { status: 400 },
    )
  }
}
