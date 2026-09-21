/**
 * FOMO Family (prod-api.fomo.family) comment/thesis shapes.
 * Theses on a trade show up as top-level comments (parentId: null).
 */

export type FomoFamilyComment = {
  commentId: string
  tradeId: string
  userId: string
  handle: string | null
  thesis: string
  tokenAddress: string
  createdAtMs: number
  parentId: string | null
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function createdAtMsFrom(row: UnknownRecord): number | null {
  const iso = asString(row.createdAt)
  if (!iso) return null
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseFomoFamilyComment(
  raw: unknown,
  preferMint?: string | null,
): FomoFamilyComment | null {
  const row = asRecord(raw)
  if (!row) return null

  const commentId = asString(row.id)
  const tradeId = asString(row.tradeId)
  const userId = asString(row.userId)
  const tokenAddress = asString(row.tokenAddress)
  const createdAtMs = createdAtMsFrom(row)
  const thesis =
    asString(row.comment) ??
    asString(asRecord(Array.isArray(row.commentSegments) ? row.commentSegments[0] : null)?.text) ??
    ""
  if (!commentId || !tradeId || !userId || !tokenAddress || createdAtMs === null) return null
  if (preferMint && tokenAddress !== preferMint) return null

  return {
    commentId,
    tradeId,
    userId,
    handle:
      asString(row.username) ??
      asString(row.handle) ??
      asString(row.userHandle) ??
      asString(row.displayName),
    thesis,
    tokenAddress,
    createdAtMs,
    parentId: asString(row.parentId),
  }
}

/** Top-level theses only (replies have parentId). */
export function parseFomoFamilyCommentsPayload(
  payload: unknown,
  preferMint?: string | null,
): FomoFamilyComment[] {
  const root = asRecord(payload)
  const responseObject = asRecord(root?.responseObject)
  const list =
    (Array.isArray(responseObject?.comments) ? responseObject.comments : null) ??
    (Array.isArray(root?.comments) ? root.comments : null) ??
    (Array.isArray(payload) ? payload : null) ??
    []

  const out: FomoFamilyComment[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const row = parseFomoFamilyComment(item, preferMint)
    if (!row || row.parentId) continue
    if (seen.has(row.commentId)) continue
    seen.add(row.commentId)
    out.push(row)
  }
  return out.sort((a, b) => b.createdAtMs - a.createdAtMs)
}

export function fomoFamilyTradeCommentsUrl(tradeId: string, apiBase?: string): string {
  const root = (apiBase ?? "https://prod-api.fomo.family").replace(/\/$/, "")
  return `${root}/trades/${encodeURIComponent(tradeId)}/comments`
}
