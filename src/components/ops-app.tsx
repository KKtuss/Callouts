"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { Camera, Square } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useEngineState } from "@/hooks/use-engine-state"
import { isCalloutInCurrentWindow } from "@/lib/snapshot-window"
import type { Callout, ClientState, DistributionTx, EngineLog, MigrationAudit, SnapshotAudit } from "@/engine/types"
import { getClockSnapshot, getServerClockSnapshot, subscribeClock } from "@/lib/clock"
import { explorerAddressUrl } from "@/lib/explorer"
import {
  displayToken,
  formatClockIso,
  formatDateTimeIso,
  formatInteger,
} from "@/lib/format"

function useCountdown(iso: string | null, paused: boolean) {
  const now = useSyncExternalStore(subscribeClock, getClockSnapshot, getServerClockSnapshot)
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
    body: JSON.stringify(body ?? {}),
  })
  const payload = (await response.json()) as { error?: string }
  if (!response.ok) throw new Error(payload.error ?? "Request failed")
}

function ingestStatusLabel(state: ClientState): string {
  const axiom = state.status.axiomIngest
  const pump = state.status.pumpIngest
  const count = state.callouts.length
  if (axiom?.connected) return `Axiom live · ${count} fetched`
  if (axiom?.enabled && axiom.lastError) return `Axiom error`
  if (axiom?.cookieConfigured && axiom.enabled) return `Axiom polling · ${count}`
  if (pump?.connected) return `Pump only · ${count} fetched`
  if (pump?.enabled) return "Pump connecting…"
  return "ingest off"
}

export function OpsApp({ initialState }: { initialState: ClientState | null }) {
  const { state, error } = useEngineState(initialState)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [mintDraft, setMintDraft] = useState(initialState?.status.config.coinMint ?? "")
  const [treasuryDraft, setTreasuryDraft] = useState(
    initialState?.status.treasuryPublicAddress ?? "",
  )
  const [allocationDraft, setAllocationDraft] = useState(
    String(initialState?.status.config.allocationAmount ?? ""),
  )
  const [minMinutesDraft, setMinMinutesDraft] = useState(
    String((initialState?.status.config.snapshotMinMs ?? 300_000) / 60_000),
  )
  const [maxMinutesDraft, setMaxMinutesDraft] = useState(
    String((initialState?.status.config.snapshotMaxMs ?? 900_000) / 60_000),
  )
  const [privateKeyDraft, setPrivateKeyDraft] = useState("")
  const [axiomCookieDraft, setAxiomCookieDraft] = useState("")
  const [migrationBonusDraft, setMigrationBonusDraft] = useState(
    String(initialState?.status.config.migrationBonusAmount ?? 10_000_000),
  )
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const countdown = useCountdown(state?.status.nextSnapshotAt ?? null, Boolean(state?.status.schedulerPaused))

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (state?.status.config.coinMint) setMintDraft(state.status.config.coinMint)
  }, [state?.status.config.coinMint])

  useEffect(() => {
    if (state?.status.treasuryPublicAddress) setTreasuryDraft(state.status.treasuryPublicAddress)
  }, [state?.status.treasuryPublicAddress])

  useEffect(() => {
    if (state?.status.config.allocationAmount != null) {
      setAllocationDraft(String(state.status.config.allocationAmount))
    }
  }, [state?.status.config.allocationAmount])

  useEffect(() => {
    if (state?.status.config.snapshotMinMs != null) {
      setMinMinutesDraft(String(state.status.config.snapshotMinMs / 60_000))
    }
    if (state?.status.config.snapshotMaxMs != null) {
      setMaxMinutesDraft(String(state.status.config.snapshotMaxMs / 60_000))
    }
  }, [state?.status.config.snapshotMinMs, state?.status.config.snapshotMaxMs])

  useEffect(() => {
    if (state?.status.config.migrationBonusAmount != null) {
      setMigrationBonusDraft(String(state.status.config.migrationBonusAmount))
    }
  }, [state?.status.config.migrationBonusAmount])

  useEffect(() => {
    if (!state?.audits.length) {
      setSelectedAuditId(null)
      return
    }
    if (!selectedAuditId || !state.audits.some((audit) => audit.id === selectedAuditId)) {
      setSelectedAuditId(state.audits[0].id)
    }
  }, [state?.audits, selectedAuditId])

  if (!mounted || !state) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {error ?? "Starting snapshot engine…"}
      </div>
    )
  }

  const live = [...state.callouts].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
  const windowed = live.filter((callout) =>
    isCalloutInCurrentWindow(
      callout.capturedAt,
      state.status.lastSnapshotAt,
      state.status.migration.watchStartedAt ?? state.status.startedAt,
    ),
  )
  const token = displayToken(state.status.config.distributionToken)
  const selectedAudit =
    state.audits.find((audit) => audit.id === selectedAuditId) ?? state.audits[0] ?? null
  const treasuryExplorer = explorerAddressUrl(
    state.status.treasuryPublicAddress,
    state.status.config.explorerAddressTemplate,
  )

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setNotice(null)
    try {
      await fn()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl min-h-0 flex-1 flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium tracking-[0.2em] text-amber-300/80 uppercase">Callout snap</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-white">{token}</h1>
          <p className="mt-1 text-sm text-white/55">
            {state.status.config.coinName ?? "Pump.fun mint"} · live newest on this mint · 1 wallet per
            window
          </p>
          <p className="mt-1 text-xs text-white/40">
            {state.status.telegramConnected
              ? `Publishing to Telegram ${state.status.telegramChannelId}`
              : "Telegram offline — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID"}
          </p>
        </div>
        <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-5 py-3 text-right">
          <div className="text-[11px] tracking-wide text-amber-200/70 uppercase">Snapshot in</div>
          <div className="font-mono text-3xl font-semibold tracking-tight text-white">{countdown}</div>
          <div className="text-[11px] text-white/40">
            {state.status.schedulerPaused ? "paused" : state.status.nextSnapshotRangeLabel}
          </div>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => run("snapshot", () => post("/api/admin/snapshot"))}
          disabled={Boolean(busy) || state.status.snapshotInProgress}
        >
          <Camera data-icon="inline-start" />
          Snapshot now
        </Button>
        <Button
          variant="outline"
          onClick={() => run("migration", () => post("/api/admin/migration"))}
          disabled={Boolean(busy) || state.status.migration.paid}
        >
          Check bonding
        </Button>
        {state.status.config.coinMint ? (
          <Button
            variant="outline"
            onClick={() =>
              run("stop", () => post("/api/admin/config", { coinMint: null }))
            }
            disabled={Boolean(busy)}
          >
            <Square data-icon="inline-start" />
            Stop and wipe
          </Button>
        ) : (
          <p className="self-center text-xs text-white/45">
            Set the mint and treasury key in Settings to start. That wipes the channel and arms Pump, FOMO, and payouts for that mint only.
          </p>
        )}
        <p className="self-center text-xs text-white/40">
          {windowed.length} eligible this window · {state.status.migration.eligibleCount} migration-ready
        </p>
      </div>

      {error || notice ? <p className="text-sm text-destructive">{notice ?? error}</p> : null}

      <Tabs defaultValue="live" className="flex min-h-0 flex-1 flex-col gap-4">
        <TabsList variant="line" className="w-full max-w-xs">
          <TabsTrigger value="live">Live</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="live" className="flex min-h-0 flex-1 flex-col outline-none">
          <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-2">
            <section className="flex min-h-0 flex-col rounded-2xl border border-white/10 bg-white/[0.03]">
              <div className="flex items-baseline justify-between gap-3 border-b border-white/5 px-4 py-3">
                <h2 className="text-sm font-medium text-white">Recent callouts</h2>
                <p className="text-xs text-white/40">{ingestStatusLabel(state)}</p>
              </div>
              {live.length === 0 ? (
                <div className="grid gap-2 px-4 py-10 text-sm text-white/45">
                  <p>No callouts stored for this mint yet.</p>
                  {!state.status.axiomIngest?.cookieConfigured ? (
                    <p className="text-amber-200/80">
                      Axiom is off — paste your Axiom session Cookie in Settings. Bonded / quiet mints
                      rarely appear on Pump&apos;s global newest feed, so you&apos;ll see 0 until Axiom is
                      connected.
                    </p>
                  ) : state.status.axiomIngest?.lastError ? (
                    <p className="text-destructive">{state.status.axiomIngest.lastError}</p>
                  ) : (
                    <p>Waiting for Axiom / Pump callouts on this mint…</p>
                  )}
                </div>
              ) : (
                <ul className="min-h-0 flex-1 divide-y divide-white/5 overflow-y-auto">
                  {live.map((callout) => (
                    <CalloutRow
                      key={callout.id}
                      callout={callout}
                      inWindow={isCalloutInCurrentWindow(
                        callout.capturedAt,
                        state.status.lastSnapshotAt,
                        state.status.migration.watchStartedAt ?? state.status.startedAt,
                      )}
                    />
                  ))}
                </ul>
              )}
            </section>

            <div className="flex min-h-0 flex-col gap-6">
              <MigrationPanel
                migration={state.status.migration}
                latest={state.migrations[0] ?? null}
                token={token}
                minCallouts={state.status.config.migrationMinCallouts}
                bonusAmount={state.status.config.migrationBonusAmount}
              />

              <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-white/10 bg-white/[0.03]">
                <div className="flex items-baseline justify-between gap-3 border-b border-white/5 px-4 py-3">
                  <h2 className="text-sm font-medium text-white">Snapshot outcomes</h2>
                  <p className="text-xs text-white/40">
                    {state.audits.length === 0 ? "none yet" : `${state.audits.length} stored`}
                  </p>
                </div>

                {!selectedAudit ? (
                  <p className="px-4 py-10 text-sm text-white/45">
                    Run a snapshot to pick the last callout and one random callout, then send treasury
                    supply to both wallets.
                  </p>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
                    <SnapshotDetail audit={selectedAudit} token={token} />
                    {state.audits.length > 1 ? (
                      <div className="grid gap-2">
                        <h3 className="text-xs font-medium tracking-wide text-white/45 uppercase">
                          Previous snapshots
                        </h3>
                        <ul className="divide-y divide-white/5 rounded-xl border border-white/10">
                          {state.audits.map((audit) => (
                            <li key={audit.id}>
                              <button
                                type="button"
                                className={`flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04] ${
                                  audit.id === selectedAudit.id ? "bg-white/[0.06]" : ""
                                }`}
                                onClick={() => setSelectedAuditId(audit.id)}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-mono text-xs text-white/70">
                                    {formatDateTimeIso(audit.snapshotTimestamp)}
                                  </span>
                                  <StatusBadge status={audit.confirmationStatus} />
                                </div>
                                <p className="truncate text-xs text-white/45">
                                  {audit.skipReason ??
                                    `${audit.calloutCount} callouts · last ${audit.lastCallout.callerUsername} · random ${audit.rouletteWinner.callerUsername}`}
                                </p>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                )}
              </section>
            </div>

            <WalletConsole logs={state.logs ?? []} />
          </div>
        </TabsContent>

        <TabsContent value="settings" className="min-h-0 flex-1 overflow-y-auto outline-none">
          <div className="mx-auto grid max-w-3xl gap-6">
            <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <h2 className="text-sm font-medium text-white">Settings</h2>
              <p className="mt-1 text-xs text-white/45">
                Mint, Axiom session, snapshot payouts, bonding bonus, timing, and treasury key.
              </p>

              <form
                className="mt-3 grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  const amount = Number(allocationDraft)
                  const migrationBonus = Number(migrationBonusDraft)
                  const minMinutes = Number(minMinutesDraft)
                  const maxMinutes = Number(maxMinutesDraft)
                  const mint = mintDraft.trim()
                  const currentMint = state.status.config.coinMint ?? ""
                  const key = privateKeyDraft.trim()
                  const axiomCookie = axiomCookieDraft.trim()
                  void run("settings", async () => {
                    await post("/api/admin/config", {
                      ...(mint !== currentMint ? { coinMint: mint || null } : {}),
                      allocationAmount: Number.isFinite(amount) ? amount : undefined,
                      migrationBonusAmount: Number.isFinite(migrationBonus) ? migrationBonus : undefined,
                      snapshotMinMs: Number.isFinite(minMinutes)
                        ? Math.round(minMinutes * 60_000)
                        : undefined,
                      snapshotMaxMs: Number.isFinite(maxMinutes)
                        ? Math.round(maxMinutes * 60_000)
                        : undefined,
                      ...(key ? { treasuryPrivateKey: key } : {}),
                      ...(axiomCookie ? { axiomCookie } : {}),
                    })
                    setPrivateKeyDraft("")
                    setAxiomCookieDraft("")
                  })
                }}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="mint" className="text-xs text-white/55">
                    Mint address
                  </Label>
                  <Input
                    id="mint"
                    value={mintDraft}
                    onChange={(event) => setMintDraft(event.target.value)}
                    placeholder="Pump.fun mint"
                    className="font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="axiom-cookie" className="text-xs text-white/55">
                      Axiom session cookie (required for mint callouts)
                    </Label>
                    <span
                      className={`text-[11px] ${
                        state.status.axiomIngest?.cookieConfigured
                          ? state.status.axiomIngest.connected
                            ? "text-emerald-300/80"
                            : "text-amber-300/80"
                          : "text-rose-300/80"
                      }`}
                    >
                      {state.status.axiomIngest?.cookieConfigured
                        ? state.status.axiomIngest.connected
                          ? "live"
                          : state.status.axiomIngest.lastError ?? "configured"
                        : "missing"}
                    </span>
                  </div>
                  <Input
                    id="axiom-cookie"
                    type="password"
                    value={axiomCookieDraft}
                    onChange={(event) => setAxiomCookieDraft(event.target.value)}
                    placeholder={
                      state.status.axiomIngest?.cookieConfigured
                        ? "Paste to replace (leave blank to keep)"
                        : "Cookie header from axiom.trade → Network → callouts"
                    }
                    className="font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="text-[11px] text-white/35">
                    DevTools on axiom.trade → Network → filter callouts → copy Request Headers → Cookie.
                    Needed for bonded / quiet mints (Pump global feed often returns nothing).
                  </p>
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="allocation" className="text-xs text-white/55">
                    Snapshot supply per winner ({token})
                  </Label>
                  <Input
                    id="allocation"
                    value={allocationDraft}
                    onChange={(event) => setAllocationDraft(event.target.value)}
                    inputMode="decimal"
                    className="font-mono text-xs"
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="migration-bonus" className="text-xs text-white/55">
                    Bonding / migration bonus ({token})
                  </Label>
                  <Input
                    id="migration-bonus"
                    value={migrationBonusDraft}
                    onChange={(event) => setMigrationBonusDraft(event.target.value)}
                    inputMode="decimal"
                    className="font-mono text-xs"
                  />
                  <p className="text-[11px] text-white/35">
                    Default 10,000,000 = 1% of 1B Pump supply. Paid once on bonding to a random current
                    holder with ≥{state.status.config.migrationMinCallouts} accepted callouts since this
                    mint was watched.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="snap-min" className="text-xs text-white/55">
                      Snapshot min (min)
                    </Label>
                    <Input
                      id="snap-min"
                      value={minMinutesDraft}
                      onChange={(event) => setMinMinutesDraft(event.target.value)}
                      inputMode="decimal"
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="snap-max" className="text-xs text-white/55">
                      Snapshot max (min)
                    </Label>
                    <Input
                      id="snap-max"
                      value={maxMinutesDraft}
                      onChange={(event) => setMaxMinutesDraft(event.target.value)}
                      inputMode="decimal"
                      className="font-mono text-xs"
                    />
                  </div>
                </div>

                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="treasury-key" className="text-xs text-white/55">
                      Dev / treasury private key
                    </Label>
                    <span
                      className={`text-[11px] ${
                        state.status.treasuryKeyConfigured ? "text-emerald-300/80" : "text-white/35"
                      }`}
                    >
                      {state.status.treasuryKeyConfigured ? "key loaded" : "not set"}
                    </span>
                  </div>
                  <Input
                    id="treasury-key"
                    type="password"
                    value={privateKeyDraft}
                    onChange={(event) => setPrivateKeyDraft(event.target.value)}
                    placeholder={
                      state.status.treasuryKeyConfigured
                        ? "Paste to replace (leave blank to keep)"
                        : "Base58 Solana secret key"
                    }
                    className="font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="text-[11px] text-white/35">
                    Stored in server memory and process env for this instance. On Vercel, also set{" "}
                    <span className="font-mono">TREASURY_PRIVATE_KEY</span> +{" "}
                    <span className="font-mono">CALLOUT_MINT</span> in project env or cold starts wipe
                    them. With the key loaded, snapshot payouts and creator-fee collects are live
                    on-chain.
                  </p>
                </div>

                <Button type="submit" variant="secondary" disabled={Boolean(busy)}>
                  Save settings
                </Button>
              </form>
            </section>

            <TreasuryPanel
              address={state.status.treasuryPublicAddress}
              explorerUrl={treasuryExplorer}
              balance={state.status.treasuryBalance}
              token={token}
              treasuryDraft={treasuryDraft}
              busy={busy}
              onTreasuryDraft={setTreasuryDraft}
              onSave={(patch) => run("treasury", () => post("/api/admin/config", patch))}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function WalletConsole({ logs }: { logs: EngineLog[] }) {
  return (
    <section className="mt-6 flex max-h-72 min-h-[12rem] flex-col rounded-2xl border border-emerald-500/20 bg-black/40">
      <div className="flex items-baseline justify-between gap-3 border-b border-white/5 px-4 py-3">
        <h2 className="text-sm font-medium text-emerald-200/90">Wallet / snapshot console</h2>
        <p className="text-xs text-white/40">{logs.length} lines · live</p>
      </div>
      {logs.length === 0 ? (
        <p className="px-4 py-8 font-mono text-xs text-white/35">
          Waiting for snapshot activity… Creator-fee collect and treasury sends will appear here.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3 font-mono text-[11px] leading-relaxed">
          {logs.map((line) => (
            <li
              key={`${line.at}:${line.level}:${line.message}`}
              className={
                line.level === "error"
                  ? "text-red-300/90"
                  : line.level === "warn"
                    ? "text-amber-200/85"
                    : line.message.includes("[wallet]")
                      ? "text-emerald-100/85"
                      : "text-white/55"
              }
            >
              <span className="text-white/30">{formatClockIso(line.at)} </span>
              {line.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function MigrationPanel({
  migration,
  latest,
  token,
  minCallouts,
  bonusAmount,
}: {
  migration: ClientState["status"]["migration"]
  latest: MigrationAudit | null
  token: string
  minCallouts: number
  bonusAmount: number
}) {
  const statusLabel = migration.paid
    ? "paid"
    : migration.bonded
      ? "bonded — paying…"
      : "watching for bonding"

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-white">Bonding bonus</h2>
        <p className="text-xs text-white/45">{statusLabel}</p>
      </div>
      <p className="mt-1 text-xs text-white/45">
        On bond, remaining treasury supply is split evenly across {formatInteger(5)} eligible holders
        (min {minCallouts} callouts). After that, snapshots claim creator fees and pay SOL.
      </p>
      {migration.progressPercent != null ? (
        <div className="mt-3 grid gap-1.5">
          <div className="flex items-baseline justify-between text-[11px] text-white/50">
            <span className="font-mono">
              {migration.progressPercent}%
              {migration.solRaised != null
                ? ` · ${migration.solRaised.toFixed(1)} / ${migration.solTarget} SOL`
                : ""}
            </span>
            <span>{statusLabel}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-amber-300 transition-[width]"
              style={{ width: `${Math.max(0, Math.min(100, migration.progressPercent))}%` }}
            />
          </div>
        </div>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-white/50">
        <div>Eligible wallets: {migration.eligibleCount}</div>
        <div>Bonded: {migration.bonded ? "yes" : "no"}</div>
      </div>
      {latest ? (
        <div className="mt-3 rounded-xl border border-white/10 bg-black/20 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs text-white/60">{formatDateTimeIso(latest.detectedAt)}</span>
            <StatusBadge status={latest.confirmationStatus} />
          </div>
          {latest.skipReason ? (
            <p className="mt-2 text-sm text-amber-100/90">{latest.skipReason}</p>
          ) : latest.winners?.length ? (
            <ul className="mt-2 grid gap-2">
              {latest.winners.map((row) => (
                <li key={row.wallet} className="rounded-lg border border-white/10 px-3 py-2">
                  <p className="text-sm font-medium text-white">{row.callerUsername}</p>
                  <p className="text-xs text-white/55">
                    {row.calloutCount} callouts · {formatInteger(row.amount)} {token}
                  </p>
                  <p className="break-all font-mono text-[11px] text-white/40">{row.wallet}</p>
                </li>
              ))}
            </ul>
          ) : latest.winner ? (
            <div className="mt-2 grid gap-1">
              <p className="text-sm font-medium text-white">{latest.winner.callerUsername}</p>
              <p className="text-xs text-white/55">
                {latest.winner.calloutCount} callouts · {formatInteger(latest.amount)} {token}
              </p>
              <p className="break-all font-mono text-[11px] text-white/40">{latest.winner.wallet}</p>
              {latest.transaction?.explorerUrl ? (
                <a
                  href={latest.transaction.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-sky-300/80 hover:text-sky-200"
                >
                  view tx
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function TreasuryPanel({
  address,
  explorerUrl,
  balance,
  token,
  treasuryDraft,
  busy,
  onTreasuryDraft,
  onSave,
}: {
  address: string
  explorerUrl: string
  balance: number
  token: string
  treasuryDraft: string
  busy: string | null
  onTreasuryDraft: (value: string) => void
  onSave: (patch: { treasuryPublicAddress?: string }) => void
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-white">Treasury</h2>
        <p className="font-mono text-xs text-amber-200/80">
          {formatInteger(balance)} {token}
        </p>
      </div>
      <p className="mt-1 text-xs text-white/45">
        Management wallet that pays each snapshot winner. Mock sends until a real key is wired for
        on-chain transfers.
      </p>
      <a
        href={explorerUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-2 block break-all font-mono text-[11px] text-sky-300/80 hover:text-sky-200"
      >
        {address}
      </a>

      <form
        className="mt-4 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          onSave({ treasuryPublicAddress: treasuryDraft.trim() })
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="treasury" className="text-xs text-white/55">
            Treasury wallet
          </Label>
          <div className="flex gap-2">
            <Input
              id="treasury"
              value={treasuryDraft}
              onChange={(event) => onTreasuryDraft(event.target.value)}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" variant="secondary" disabled={Boolean(busy) || !treasuryDraft.trim()}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </section>
  )
}

function SnapshotDetail({ audit, token }: { audit: SnapshotAudit; token: string }) {
  const lastTx = audit.transactions.find((tx) => tx.kind === "last_callout")
  const randomTx = audit.transactions.find((tx) => tx.kind === "roulette")

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-white/50">{formatDateTimeIso(audit.snapshotTimestamp)}</p>
          <p className="mt-1 text-sm text-white/70">
            Window {formatClockIso(audit.windowStart)} → {formatClockIso(audit.windowEnd)} ·{" "}
            {audit.calloutCount} unique callouts
          </p>
        </div>
        <StatusBadge status={audit.confirmationStatus} />
      </div>

      {audit.skipReason ? (
        <p className="rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
          {audit.skipReason}
        </p>
      ) : (
        <div className="grid gap-3">
          <WinnerCard
            label="Last callout"
            callout={audit.lastCallout}
            tx={lastTx}
            amount={audit.allocationAmount}
            token={token}
          />
          <WinnerCard
            label="Random callout"
            callout={audit.rouletteWinner}
            tx={randomTx}
            amount={audit.allocationAmount}
            token={token}
          />
        </div>
      )}

      {!audit.skipReason ? (
        <p className="text-[11px] text-white/35">
          Total sent {formatInteger(audit.totalDistributed || audit.allocationAmount * 2)} {token}
          {audit.selectionEntropyHex ? ` · entropy ${audit.selectionEntropyHex.slice(0, 16)}…` : ""}
        </p>
      ) : null}
    </div>
  )
}

function WinnerCard({
  label,
  callout,
  tx,
  amount,
  token,
}: {
  label: string
  callout: Callout
  tx?: DistributionTx
  amount: number
  token: string
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] tracking-wide text-amber-200/70 uppercase">{label}</p>
        <p className="font-mono text-xs text-white/55">
          {formatInteger(tx?.amount ?? amount)} {token}
        </p>
      </div>
      <p className="mt-1 text-sm font-medium text-white">{callout.callerUsername}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-white/70">
        {callout.thesis?.trim() || "—"}
      </p>
      <p className="mt-2 break-all font-mono text-[11px] text-white/40">{callout.wallet}</p>
      {tx ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-white/45">
          <span className="capitalize">{tx.status}</span>
          {tx.explorerUrl ? (
            <a href={tx.explorerUrl} target="_blank" rel="noreferrer" className="text-sky-300/80 hover:text-sky-200">
              view tx
            </a>
          ) : null}
          {tx.error ? <span className="text-destructive">{tx.error}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function StatusBadge({ status }: { status: SnapshotAudit["confirmationStatus"] }) {
  const variant =
    status === "confirmed" ? "default" : status === "skipped" ? "secondary" : status === "partial_failure" ? "destructive" : "outline"
  return <Badge variant={variant}>{status.replaceAll("_", " ")}</Badge>
}

function CalloutRow({ callout, inWindow }: { callout: Callout; inWindow: boolean }) {
  return (
    <li className="grid gap-1 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="truncate text-sm font-medium text-white">{callout.callerUsername}</div>
        <div className="shrink-0 text-[11px] text-white/40">
          {formatClockIso(callout.capturedAt)}
          {inWindow ? <span className="ml-2 text-amber-300">window</span> : null}
        </div>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/75">
        {callout.thesis?.trim() || "—"}
      </p>
      <div className="break-all font-mono text-[11px] text-white/40">{callout.wallet}</div>
    </li>
  )
}
