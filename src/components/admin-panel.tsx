"use client"

import { useState, useSyncExternalStore, type ReactNode } from "react"
import {
  Camera,
  Dices,
  Landmark,
  Pause,
  Play,
  Radio,
  Shield,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ClientState, EngineConfig, SnapshotAudit } from "@/engine/types"
import { formatClockIso, formatDateTimeIso, formatInteger, truncateWallet } from "@/lib/format"

function phaseCopy(state: ClientState): string {
  if (state.status.snapshotInProgress) {
    switch (state.status.phase) {
      case "capturing":
        return "Capturing callouts"
      case "roulette":
        return "Roulette animation (winner already chosen)"
      case "announcing":
        return "Publishing recipients"
      case "distributing":
        return "Treasury sendout"
      case "finalizing":
        return "Writing final confirmation"
      default:
        return "Snapshot in progress"
    }
  }
  if (state.status.schedulerPaused) return "Scheduler paused"
  return "Collecting callouts"
}

function useCountdown(iso: string | null, paused: boolean) {
  const now = useSyncExternalStore(
    (onStoreChange) => {
      const id = setInterval(onStoreChange, 1000)
      return () => clearInterval(id)
    },
    () => Date.now(),
    () => 0,
  )
  if (paused || !iso) return "—"
  if (now === 0) return "…"
  const delta = Date.parse(iso) - now
  if (delta <= 0) return "imminent"
  const total = Math.ceil(delta / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

async function post(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  })
  const payload = (await response.json()) as { error?: string }
  if (!response.ok) throw new Error(payload.error ?? "Request failed")
  return payload
}

export function AdminPanel({ state }: { state: ClientState }) {
  const countdown = useCountdown(state.status.nextSnapshotAt, state.status.schedulerPaused)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [amount, setAmount] = useState(String(state.status.config.allocationAmount))
  const [token, setToken] = useState(state.status.config.distributionToken)
  const [minMin, setMinMin] = useState(String(Math.round(state.status.config.snapshotMinMs / 60_000)))
  const [maxMin, setMaxMin] = useState(String(Math.round(state.status.config.snapshotMaxMs / 60_000)))
  const [manual, setManual] = useState({
    token: "$BONK",
    caller: "opsdesk",
    wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  })

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setNotice(null)
    try {
      await fn()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed")
    } finally {
      setBusy(null)
    }
  }

  const saveConfig = (patch: Partial<EngineConfig>) =>
    run("config", () => post("/api/admin/config", patch))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Card className="border-white/10 bg-card/80">
        <CardHeader className="border-b border-white/5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Shield className="size-4 text-amber-300" />
                Private operations
              </CardTitle>
              <CardDescription>
                These controls never appear on Telegram. The public channel can only receive
                automated messages.
              </CardDescription>
            </div>
            <Badge variant={state.status.schedulerPaused ? "secondary" : "default"}>
              {phaseCopy(state)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 pt-4 sm:grid-cols-3">
          <Metric label="Next snapshot" value={countdown} hint={state.status.nextSnapshotRangeLabel} />
          <Metric
            label="Callouts in window"
            value={String(state.status.calloutsInWindow)}
            hint="Frozen at snapshot time"
          />
          <Metric
            label="Treasury"
            value={`${formatInteger(state.status.treasuryBalance)} ${state.status.config.distributionToken}`}
            hint="Public address only"
          />
        </CardContent>
        <CardContent className="flex flex-wrap gap-2 pt-0">
          <Button
            onClick={() => run("snapshot", () => post("/api/admin/snapshot"))}
            disabled={Boolean(busy) || state.status.snapshotInProgress}
          >
            <Camera data-icon="inline-start" />
            Run snapshot now
          </Button>
          {state.status.schedulerPaused ? (
            <Button variant="outline" onClick={() => run("resume", () => post("/api/admin/resume"))}>
              <Play data-icon="inline-start" />
              Resume scheduler
            </Button>
          ) : (
            <Button variant="outline" onClick={() => run("pause", () => post("/api/admin/pause"))}>
              <Pause data-icon="inline-start" />
              Pause scheduler
            </Button>
          )}
          {notice ? <p className="w-full text-sm text-destructive">{notice}</p> : null}
        </CardContent>
      </Card>

      <Tabs defaultValue="callouts">
        <TabsList>
          <TabsTrigger value="callouts">Callouts</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="treasury">Treasury</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="callouts" className="mt-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Radio className="size-4" />
                Collector window
              </CardTitle>
              <CardDescription>
                Ingest is private. Callouts arriving after a snapshot timestamp cannot change
                that round’s recipients.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <Field label="Token">
                  <Input
                    value={manual.token}
                    onChange={(e) => setManual((m) => ({ ...m, token: e.target.value }))}
                  />
                </Field>
                <Field label="Caller">
                  <Input
                    value={manual.caller}
                    onChange={(e) => setManual((m) => ({ ...m, caller: e.target.value }))}
                  />
                </Field>
                <Field label="Wallet">
                  <Input
                    value={manual.wallet}
                    placeholder="Solana address"
                    onChange={(e) => setManual((m) => ({ ...m, wallet: e.target.value }))}
                  />
                </Field>
              </div>
              <Button
                variant="secondary"
                disabled={Boolean(busy)}
                onClick={() =>
                  run("ingest", () =>
                    post("/api/ingest/callout", {
                      token: manual.token,
                      callerUsername: manual.caller,
                      wallet: manual.wallet,
                      source: "private-ingest",
                    }),
                  )
                }
              >
                Ingest callout
              </Button>
              <Separator />
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {state.callouts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No callouts in the current window.</p>
                ) : (
                  [...state.callouts].reverse().map((callout) => (
                    <div
                      key={callout.id}
                      className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-white/5 px-3 py-2"
                    >
                      <span className="font-mono text-sm text-amber-200">{callout.token}</span>
                      <div className="min-w-0">
                        <div className="truncate text-sm">{callout.callerUsername}</div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">
                          {truncateWallet(callout.wallet)}
                        </div>
                      </div>
                      <span className="text-[11px] text-muted-foreground">
                        {formatClockIso(callout.capturedAt)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="config" className="mt-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Engine configuration</CardTitle>
              <CardDescription>
                Allocation, cadence, and sources are owned by this console — never by channel
                viewers.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Allocation per recipient">
                  <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
                </Field>
                <Field label="Distribution token">
                  <Input value={token} onChange={(e) => setToken(e.target.value)} />
                </Field>
                <Field label="Min interval (minutes)">
                  <Input value={minMin} onChange={(e) => setMinMin(e.target.value)} />
                </Field>
                <Field label="Max interval (minutes)">
                  <Input value={maxMin} onChange={(e) => setMaxMin(e.target.value)} />
                </Field>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/10 px-3 py-2">
                <div>
                  <div className="text-sm font-medium">Demo callout feeder</div>
                  <div className="text-xs text-muted-foreground">
                    Simulated collector. Not a Telegram input path.
                  </div>
                </div>
                <Switch
                  checked={state.status.config.feederEnabled}
                  onCheckedChange={(checked) => saveConfig({ feederEnabled: Boolean(checked) })}
                />
              </div>
              <Button
                onClick={() =>
                  saveConfig({
                    allocationAmount: Number(amount),
                    distributionToken: token.trim() || "TOKEN",
                    snapshotMinMs: Number(minMin) * 60_000,
                    snapshotMaxMs: Number(maxMin) * 60_000,
                  })
                }
              >
                Save config
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="treasury" className="mt-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Landmark className="size-4" />
                Treasury (display only)
              </CardTitle>
              <CardDescription>
                Private keys never enter Telegram, this UI, logs, or audit records. Sends are
                executed by the engine after recipients are already chosen.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="rounded-lg bg-muted/40 p-3 font-mono text-xs break-all">
                {state.status.treasuryPublicAddress}
              </div>
              <p className="text-sm text-muted-foreground">
                Balance {formatInteger(state.status.treasuryBalance)}{" "}
                {state.status.config.distributionToken}. Demo mode mocks Solana confirmations and
                still emits explorer links for the public trail.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit" className="mt-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Dices className="size-4" />
                Snapshot audit trail
              </CardTitle>
              <CardDescription>
                Full internal dataset for every round, including entropy commitment and
                transaction signatures.
              </CardDescription>
            </CardHeader>
            <CardContent className="max-h-[28rem] space-y-3 overflow-y-auto">
              {state.audits.length === 0 ? (
                <p className="text-sm text-muted-foreground">No snapshots recorded yet.</p>
              ) : (
                state.audits.map((audit) => <AuditCard key={audit.id} audit={audit} />)
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-background/40 p-3">
      <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="mt-1 font-mono text-lg">{value}</div>
      <div className="text-[11px] text-muted-foreground">{hint}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  )
}

function AuditCard({ audit }: { audit: SnapshotAudit }) {
  return (
    <details className="rounded-xl border border-white/10 px-3 py-2">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs">{formatDateTimeIso(audit.snapshotTimestamp)}</span>
          <Badge variant={audit.confirmationStatus === "confirmed" ? "default" : "secondary"}>
            {audit.confirmationStatus}
          </Badge>
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          {audit.skipReason ??
            `${audit.calloutCount} callouts · last ${audit.lastCallout.token} · roulette ${audit.rouletteWinner.token}`}
        </div>
      </summary>
      <div className="mt-3 space-y-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        <div>Previous snapshot: {audit.previousSnapshotTimestamp ?? "none"}</div>
        <div>Window: {audit.windowStart} → {audit.windowEnd}</div>
        <div>Last callout: {audit.lastCallout.token} {audit.lastCallout.wallet}</div>
        <div>
          Roulette pool: {audit.rouletteCandidatePool.map((item) => item.token).join(", ") || "—"}
        </div>
        <div>
          Selected: {audit.rouletteWinner.token} index {audit.rouletteIndex} via {audit.selectionMethod}
        </div>
        <div>Entropy: {audit.selectionEntropyHex || "—"}</div>
        <div>Selection committed: {audit.selectionCommittedAt}</div>
        <div>Animation started: {audit.animationStartedAt ?? "n/a"}</div>
        {audit.transactions.map((tx) => (
          <div key={`${tx.kind}-${tx.calloutId}`}>
            {tx.kind}: {tx.amount} {tx.distributionToken} → {tx.wallet} · {tx.status}
            {tx.signature ? ` · ${tx.signature}` : ""}
          </div>
        ))}
      </div>
    </details>
  )
}
