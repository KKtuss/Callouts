import { isCalloutInCurrentWindow } from "@/lib/snapshot-window"
import type { Callout, ClientState, EngineLog, SnapshotAudit } from "@/engine/types"
import type { PublicCallout, PublicRound, PublicView } from "@/lib/public-view"

function snapMs(value: string | null | undefined) {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function unionById<T extends { id: string }>(prev: T[], next: T[]): T[] {
  const byId = new Map<string, T>()
  for (const row of prev) byId.set(row.id, row)
  for (const row of next) byId.set(row.id, row)
  return [...byId.values()]
}

function laterIso(a: string | null | undefined, b: string | null | undefined) {
  return snapMs(a) >= snapMs(b) ? (a ?? null) : (b ?? null)
}

function pickPublicRounds(prev: PublicRound[], next: PublicRound[]): PublicRound[] {
  if (!next.length && prev.length) return prev
  if (!prev.length) return next
  const prevAt = Math.max(0, ...prev.map((round) => snapMs(round.timestamp)))
  const nextAt = Math.max(0, ...next.map((round) => snapMs(round.timestamp)))
  if (nextAt < prevAt) return prev
  if (nextAt > prevAt) return next
  const prevTx = prev.reduce((sum, round) => sum + round.transactions.length, 0)
  const nextTx = next.reduce((sum, round) => sum + round.transactions.length, 0)
  return nextTx >= prevTx ? next : prev
}

function pickAudits(prev: SnapshotAudit[], next: SnapshotAudit[]): SnapshotAudit[] {
  if (!next.length && prev.length) return prev
  if (!prev.length) return next
  const prevAt = Math.max(0, ...prev.map((audit) => snapMs(audit.snapshotTimestamp)))
  const nextAt = Math.max(0, ...next.map((audit) => snapMs(audit.snapshotTimestamp)))
  if (nextAt < prevAt) return prev
  if (nextAt > prevAt) return next
  const prevTx = prev.reduce((sum, audit) => sum + audit.transactions.length, 0)
  const nextTx = next.reduce((sum, audit) => sum + audit.transactions.length, 0)
  return nextTx >= prevTx ? next : prev
}

function logKey(log: EngineLog) {
  const msg = log.message
  if (/\[wallet\] Next snapshot in /.test(msg)) return `${log.level}|next-snapshot`
  if (/\[wallet\] Pin mint /.test(msg) && /starting a fresh window/.test(msg)) {
    return `${log.level}|pin-mismatch`
  }
  if (/^New cycle/.test(msg)) return `${log.level}|new-cycle`
  return `${log.level}|${msg}`
}

/** Isolate log ids are `log-1`, `log-2` per process — merge by content so the console does not flicker. */
export function mergeLogs(prev: EngineLog[] | undefined, next: EngineLog[] | undefined): EngineLog[] {
  const byKey = new Map<string, EngineLog>()
  const consider = (row: EngineLog) => {
    const key = logKey(row)
    const existing = byKey.get(key)
    if (!existing || snapMs(row.at) >= snapMs(existing.at)) {
      byKey.set(key, { ...row, id: key })
    }
  }
  for (const row of prev ?? []) consider(row)
  for (const row of next ?? []) consider(row)
  return [...byKey.values()]
    .sort((a, b) => {
      const dt = snapMs(b.at) - snapMs(a.at)
      if (dt !== 0) return dt
      return a.message.localeCompare(b.message)
    })
    .slice(0, 200)
}

function mergeMessages<T extends { id: string; kind: string }>(prev: T[], next: T[]): T[] {
  const nextHasFinal = next.some((item) => item.kind === "final")
  const prevFinal = prev.filter((item) => item.kind === "final")
  const nextHasQualified = next.some((item) => item.kind === "qualified")
  const prevQualified = prev.filter((item) => item.kind === "qualified")
  let messages = next
  if (!nextHasFinal && prevFinal.length) {
    messages = [...messages.filter((item) => item.kind !== "final"), ...prevFinal]
  }
  if (!nextHasQualified && prevQualified.length) {
    messages = [...messages.filter((item) => item.kind !== "qualified"), ...prevQualified]
  }
  return messages
}

/** Keep the larger live window across flaky serverless isolates. Never rewind a newer snapshot. */
export function mergePublicView(prev: PublicView | null, next: PublicView): PublicView {
  if (!prev) return next
  if ((prev.mint.address ?? "") !== (next.mint.address ?? "")) return next
  const prevSnap = snapMs(prev.engine.lastSnapshotAt)
  const nextSnap = snapMs(next.engine.lastSnapshotAt)
  if (nextSnap < prevSnap) return prev

  const windowCallouts =
    nextSnap > prevSnap
      ? next.windowCallouts
      : (unionById(prev.windowCallouts, next.windowCallouts).sort(
          (a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt),
        ) as PublicCallout[])
  const rounds = pickPublicRounds(prev.rounds, next.rounds)

  return {
    ...next,
    windowCallouts,
    rounds,
    messages: mergeMessages(prev.messages, next.messages),
    engine: {
      ...next.engine,
      lastSnapshotAt: laterIso(prev.engine.lastSnapshotAt, next.engine.lastSnapshotAt),
      lastPayoutAt: laterIso(prev.engine.lastPayoutAt, next.engine.lastPayoutAt),
      calloutsInWindow: Math.max(next.engine.calloutsInWindow, windowCallouts.length),
    },
  }
}

export function mergeClientState(prev: ClientState | null, next: ClientState): ClientState {
  if (!prev) return next
  const logs = mergeLogs(prev.logs, next.logs)
  if ((prev.status.config?.coinMint ?? "") !== (next.status.config?.coinMint ?? "")) {
    return { ...next, logs }
  }
  const prevSnap = snapMs(prev.status.lastSnapshotAt)
  const nextSnap = snapMs(next.status.lastSnapshotAt)
  if (nextSnap < prevSnap) {
    return { ...prev, logs }
  }

  const callouts =
    nextSnap > prevSnap
      ? next.callouts
      : (unionById(prev.callouts, next.callouts).sort(
          (a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt),
        ) as Callout[])
  const windowCount = callouts.filter((row) =>
    isCalloutInCurrentWindow(
      row.capturedAt,
      next.status.lastSnapshotAt,
      next.status.migration?.watchStartedAt ?? next.status.startedAt,
    ),
  ).length
  const audits = pickAudits(prev.audits, next.audits)

  return {
    ...next,
    callouts,
    audits,
    logs,
    messages: mergeMessages(prev.messages, next.messages),
    status: {
      ...next.status,
      lastSnapshotAt: laterIso(prev.status.lastSnapshotAt, next.status.lastSnapshotAt),
      calloutsInWindow: Math.max(next.status.calloutsInWindow, windowCount),
    },
  }
}
