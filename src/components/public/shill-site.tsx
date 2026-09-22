"use client"

import Image from "next/image"
import { useMemo, useRef, useSyncExternalStore } from "react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { useGSAP } from "@gsap/react"
import { getClockSnapshot, getServerClockSnapshot, subscribeClock } from "@/lib/clock"
import { formatElapsed, formatInteger, formatSolAmount } from "@/lib/format"
import { usePublicEngine } from "@/hooks/use-public-engine"
import type { PublicRound, PublicView } from "@/lib/public-view"
import { PRE_BOND_FOMO_NOTICE } from "@/lib/notices"
import { WalletAddress } from "@/components/public/wallet-address"
import { cn } from "@/lib/utils"

gsap.registerPlugin(useGSAP, ScrollTrigger)

/** Spec values that the engine does not expose as config. */
const BOND_LOTTERY_WINNERS = 5
const CREATOR_REWARD_SHARE = "10%"

const CALLOUT_BEATS = [
  "They spot a token.",
  "They have an opinion.",
  "They share it.",
  "They shill it.",
  "They tell everyone why they think it matters.",
] as const

const LOOP_STEPS = [
  "More people want to earn",
  "More callouts get posted",
  "More eyes land on SHILL",
  "More people join in",
  "More callouts",
  "and around again",
] as const

const SOURCE_META: Record<
  string,
  { label: string; icon: string; pill: string }
> = {
  "pump.fun": {
    label: "Pump.fun",
    icon: "/brand/pump-fun.ico",
    pill: "bg-emerald-400/15 text-emerald-700 ring-1 ring-emerald-500/25",
  },
  fomo: {
    label: "FOMO",
    icon: "/brand/fomo-family.ico",
    pill: "bg-purple-900/30 text-purple-300 ring-1 ring-purple-400/25",
  },
  axiom: {
    label: "Axiom",
    icon: "",
    pill: "bg-sky-900/30 text-sky-300 ring-1 ring-sky-400/25",
  },
}

function SourcePill({
  source,
  className,
}: {
  source: string
  className?: string
}) {
  const meta = SOURCE_META[source]
  if (!meta) return null
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
        meta.pill,
        className,
      )}
    >
      {meta.icon ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={meta.icon} alt="" width={10} height={10} className="h-2.5 w-2.5 rounded-sm object-contain" />
      ) : null}
      {meta.label}
    </span>
  )
}

function Flywheel() {
  const n = LOOP_STEPS.length
  return (
    <div className="flywheel mx-auto mt-5 sm:mt-6" role="list" aria-label="The SHILL flywheel">
      <div aria-hidden className="flywheel-ring" />
      <div aria-hidden className="flywheel-ring flywheel-ring-inner" />

      {LOOP_STEPS.map((step, i) => {
        const angle = (360 / n) * i - 90
        const accent = step === "and around again"
        return (
          <div
            key={step}
            role="listitem"
            className="flywheel-spoke"
            style={{ ["--spoke-angle" as string]: `${angle}deg` }}
          >
            <span className={cn("flywheel-chip", accent && "flywheel-chip-accent")}>{step}</span>
          </div>
        )
      })}
    </div>
  )
}

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function useNow() {
  return useSyncExternalStore(subscribeClock, getClockSnapshot, getServerClockSnapshot)
}

/** Milliseconds since `iso`, or null before the clock has started on the client. */
function useElapsed(iso: string | null) {
  const now = useNow()
  if (!iso || now === 0) return null
  return Math.max(0, now - Date.parse(iso))
}

function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number
  format: (value: number) => string
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef(value)

  useGSAP(
    () => {
      const el = ref.current
      if (!el) return
      const from = shown.current
      if (from === value || reducedMotion()) {
        shown.current = value
        el.textContent = format(value)
        return
      }
      const proxy = { value: from }
      gsap.to(proxy, {
        value,
        duration: 0.8,
        ease: "power2.out",
        onUpdate: () => {
          el.textContent = format(proxy.value)
        },
        onComplete: () => {
          shown.current = value
        },
      })
    },
    { dependencies: [value] },
  )

  return (
    <span ref={ref} className={className}>
      {format(value)}
    </span>
  )
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold tracking-[0.24em] text-primary uppercase">{children}</p>
  )
}

function Panel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("aqua-panel panel-reveal rounded-3xl px-6 py-7 sm:px-8", className)}>
      {children}
    </div>
  )
}

function Metric({
  label,
  value,
  caption,
  accent,
}: {
  label: string
  value: React.ReactNode
  caption?: React.ReactNode
  accent?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold tracking-[0.16em] text-shill-deep/50 uppercase sm:tracking-[0.2em]">
        {label}
      </div>
      <div
        className={cn(
          "mt-1.5 text-lg font-semibold break-words tabular-nums sm:truncate sm:text-2xl",
          accent ? "text-primary" : "text-shill-deep",
        )}
      >
        {value}
      </div>
      {caption ? (
        <div className="mt-1 text-xs font-medium leading-snug text-shill-deep/55 sm:truncate">
          {caption}
        </div>
      ) : null}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold tracking-[0.18em] text-shill-deep/45 uppercase">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold break-words text-shill-deep tabular-nums sm:truncate">
        {children}
      </div>
    </div>
  )
}

/** The two headline counters: time since last snapshot, and rewards sent. */
function CounterBar({ state }: { state: PublicView | null }) {
  const live = Boolean(state?.engine.live)
  // Idle (no mint) must not count from isolate boot — show a frozen zero.
  const origin =
    state?.engine.lastSnapshotAt ?? (live ? state?.engine.startedAt ?? null : null)
  const since = useElapsed(origin)
  const hasSnapshot = Boolean(state?.engine.lastSnapshotAt)
  const ticker = state?.allocation.distributionToken ?? "SHILL"
  const totals = state?.totals
  const elapsedLabel =
    since === null ? (live ? "—" : formatElapsed(0)) : formatElapsed(since)
  const elapsedCaption = hasSnapshot
    ? "last settled round"
    : live
      ? "waiting for the first snapshot"
      : "waiting for mint"

  return (
    <div className="aqua-panel panel-reveal grid grid-cols-1 gap-5 rounded-3xl px-5 py-5 sm:grid-cols-2 sm:gap-x-6 sm:gap-y-6 sm:px-8 sm:py-6 lg:grid-cols-4">
      <Metric
        label="Time since last snapshot"
        value={elapsedLabel}
        caption={elapsedCaption}
        accent
      />
      <Metric
        label="Rewards sent · supply"
        value={
          <>
            <AnimatedNumber value={totals?.tokenAmount ?? 0} format={formatInteger} />{" "}
            <span className="text-sm font-semibold text-shill-deep/60">{ticker}</span>
          </>
        }
        caption={`${totals?.supplyPercentLabel ?? "0%"} of total supply`}
      />
      <Metric
        label="Rewards sent · SOL"
        value={
          <>
            <AnimatedNumber value={totals?.solAmount ?? 0} format={formatSolAmount} />{" "}
            <span className="text-sm font-semibold text-shill-deep/60">SOL</span>
          </>
        }
        caption="creator rewards claimed and paid"
      />
      <Metric
        label="Total callouts"
        value={<AnimatedNumber value={totals?.callouts ?? 0} format={formatInteger} />}
        caption={
          state ? `random snapshots every ${state.engine.nextSnapshotRangeLabel}` : "—"
        }
      />
    </div>
  )
}

function LiveBoard({ state, error }: { state: PublicView | null; error: string | null }) {
  if (!state) {
    return (
      <Panel className="flex flex-col lg:h-full lg:min-h-[var(--rounds-feed-h)]">
        <p className="text-sm text-shill-deep/65">{error ?? "Connecting to the engine…"}</p>
      </Panel>
    )
  }

  return (
    <Panel className="flex flex-col lg:h-full lg:min-h-[var(--rounds-feed-h)]">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.2em] text-shill-deep uppercase">
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full",
              state.engine.live
                ? "bg-emerald-400 shadow-[0_0_12px_rgb(52_211_153)]"
                : "bg-amber-300",
            )}
          />
          {!state.mint.address
            ? "Waiting for SHILL tech to be live..."
            : state.engine.live
              ? "Engine live"
              : "Engine paused"}
        </div>
        <span className="text-xs font-medium text-shill-deep/50">
          Snapshot window {state.engine.nextSnapshotRangeLabel}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3.5 sm:grid-cols-3 sm:gap-x-6 sm:gap-y-4">
        <Field label="Mint">
          {state.mint.address ? (
            <WalletAddress
              address={state.mint.address}
              short={state.mint.addressShort ?? undefined}
              href={state.mint.explorerUrl}
              className="text-sm"
            />
          ) : (
            "waiting for SHILL tech to be live..."
          )}
        </Field>
        <Field label="Callers this window">
          {formatInteger(state.engine.calloutsInWindow)}
        </Field>
        <Field label="Per recipient">
          {state.allocation.amountLabel}
          <span className="ml-1 font-medium text-shill-deep/55">
            ({state.allocation.supplyPercentLabel})
          </span>
        </Field>
        <Field label="Snapshots taken">{formatInteger(state.totals.snapshots)}</Field>
        <Field label="Payouts settled">
          {formatInteger(state.totals.payouts)}
          <span className="ml-1 font-medium text-shill-deep/55">
            to {formatInteger(state.totals.wallets)} wallets
          </span>
        </Field>
        <Field label="Treasury">
          {state.treasury.address ? (
            <span className="flex min-w-0 flex-col">
              <span className="break-words">{state.treasury.balanceLabel}</span>
              <WalletAddress
                address={state.treasury.address}
                short={state.treasury.addressShort}
                href={state.treasury.explorerUrl}
                className="text-xs font-medium text-shill-deep/55"
              />
            </span>
          ) : (
            state.treasury.balanceLabel
          )}
        </Field>
        <div className="col-span-2 sm:col-span-1">
          <Field label="Bonding curve">
            {state.bonding.bonded
              ? "Bonded"
              : state.bonding.progressPercent !== null
                ? `${state.bonding.progressPercent}% · ${formatSolAmount(state.bonding.solRaised ?? 0)}/${state.bonding.solTarget} SOL`
                : "—"}
          </Field>
        </div>
      </div>

      <div className="aqua-rule mt-6" />

      <div className="mt-5 flex min-h-0 flex-1 flex-col">
        <div className="text-[10px] font-semibold tracking-[0.18em] text-shill-deep/45 uppercase">
          Callers in this window
        </div>
        {state.windowCallouts.length === 0 ? (
          <p className="mt-2 text-sm text-shill-deep/55">No callouts captured yet this window.</p>
        ) : (
          <div className="mt-2.5 flex flex-wrap content-start gap-2 lg:min-h-[6.75rem] lg:flex-1 lg:overflow-y-auto lg:overscroll-contain">
            {state.windowCallouts.map((c) => (
              <span
                key={c.id}
                className="voice-chip aqua-chip inline-flex max-w-full items-center gap-1.5 truncate rounded-full py-1.5 pl-3 pr-2 text-xs font-semibold text-shill-deep"
                title={c.wallet}
              >
                <span className="truncate">{c.username}</span>
                <SourcePill source={c.source} />
              </span>
            ))}
          </div>
        )}
      </div>
    </Panel>
  )
}

function RoundRow({ round }: { round: PublicRound }) {
  const explorer = round.explorerLinks[0]
  return (
    <article className="round-card rounded-2xl px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="text-xs font-semibold tracking-[0.18em] text-primary uppercase">
          Snapshot #{round.number}
        </span>
        <span className="text-[11px] text-shill-deep/50 tabular-nums sm:text-xs">
          {new Date(round.timestamp).toISOString().slice(11, 16)} UTC · {round.calloutCount} callers
        </span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {[
          { tag: "Latest callout", who: round.lastCaller },
          { tag: "Random callout", who: round.randomCaller },
        ].map(({ tag, who }) => {
          return (
            <div key={tag} className="min-w-0">
              <div className="text-[10px] font-semibold tracking-[0.16em] text-shill-deep/45 uppercase">
                {tag}
              </div>
              <div className="mt-1 truncate font-semibold text-shill-deep">
                {who?.username ?? "—"}
              </div>
              {who ? (
                <div className="mt-1">
                  <SourcePill source={who.source} />
                </div>
              ) : null}
              {who ? (
                <WalletAddress
                  className="mt-0.5 text-xs"
                  address={who.wallet}
                  short={who.walletShort}
                  href={who.walletUrl}
                />
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/45 pt-3">
        <span className="text-sm font-semibold text-shill-deep tabular-nums">
          {round.payoutLabel}
        </span>
        {explorer ? (
          <a
            href={explorer}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold text-primary transition hover:translate-x-0.5"
          >
            Solscan ↗
          </a>
        ) : null}
      </div>
    </article>
  )
}

export function ShillSite({ initialState }: { initialState: PublicView | null }) {
  const { state, error } = usePublicEngine(initialState)
  const root = useRef<HTMLDivElement>(null)

  const rounds = useMemo(
    () => state?.rounds.filter((r) => r.calloutCount > 0) ?? [],
    [state?.rounds],
  )

  const ticker = state?.allocation.distributionToken ?? "SHILL"
  const telegram = state?.telegram.publicUrl
  const xUrl = state?.social.xUrl
  const mintUrl = state?.mint.explorerUrl
  const mint = state?.mint.address
  const windowLabel = state?.engine.nextSnapshotRangeLabel ?? "5–15 minutes"
  const perRecipient = state?.allocation.supplyPercentLabel ?? "0.25%"
  const lotteryMinCallouts = state?.bonding.minCallouts ?? 2

  useGSAP(
    () => {
      if (reducedMotion()) return

      // Touch phones: no GSAP at all. Transforms + ScrollTrigger fight native
      // scroll and make the decorative layers feel like a stuck overlay.
      const coarse =
        typeof window !== "undefined" &&
        window.matchMedia("(hover: none) and (pointer: coarse)").matches
      if (coarse) return

      gsap.fromTo(
        ".hero-line",
        { opacity: 0, y: 22 },
        { opacity: 1, y: 0, duration: 0.85, ease: "power2.out", stagger: 0.12, delay: 0.1 },
      )

      gsap.to(".hero-logo", { y: -10, duration: 3.6, ease: "sine.inOut", yoyo: true, repeat: -1 })
      gsap.to(".float-slow", {
        y: "random(-12, 12)",
        x: "random(-8, 8)",
        duration: "random(5, 8)",
        ease: "sine.inOut",
        yoyo: true,
        repeat: -1,
        stagger: 0.5,
      })

      // Opacity only — never visibility:hidden (autoAlpha), so a missed trigger
      // can't leave the whole board as a blank dark sky.
      gsap.utils.toArray<HTMLElement>(".panel-reveal").forEach((panel) => {
        gsap.fromTo(
          panel,
          { opacity: 0, y: 26 },
          {
            opacity: 1,
            y: 0,
            duration: 0.7,
            ease: "power2.out",
            immediateRender: false,
            scrollTrigger: { trigger: panel, start: "top 88%", once: true },
          },
        )
      })

      gsap.utils.toArray<HTMLElement>(".beat").forEach((beat, i) => {
        gsap.fromTo(
          beat,
          { opacity: 0, x: -14 },
          {
            opacity: 1,
            x: 0,
            duration: 0.5,
            delay: i * 0.05,
            ease: "power2.out",
            immediateRender: false,
            scrollTrigger: { trigger: beat, start: "top 92%", once: true },
          },
        )
      })
    },
    { scope: root },
  )

  useGSAP(
    () => {
      if (reducedMotion()) return
      const coarse =
        typeof window !== "undefined" &&
        window.matchMedia("(hover: none) and (pointer: coarse)").matches
      if (coarse) return
      const chips = gsap.utils.toArray<HTMLElement>(".voice-chip")
      if (chips.length === 0) return
      gsap.fromTo(
        chips.slice(-3),
        { opacity: 0, y: 6 },
        { opacity: 1, y: 0, duration: 0.35, ease: "power2.out", stagger: 0.04 },
      )
    },
    { scope: root, dependencies: [state?.windowCallouts.length ?? 0] },
  )

  return (
    <div ref={root} className="aqua-world relative min-h-screen overflow-x-hidden">
      <main>
        {/* Panel 1 — the premise */}
        <section id="top" className="relative">
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="scene-sky absolute inset-0" />
            <div className="scene-rays absolute inset-0" />
            <div className="scene-floor absolute inset-x-0 top-[66%] bottom-0" />
            <div className="scene-caustics absolute inset-x-0 top-[66%] bottom-0" />
            <div className="scene-horizon absolute inset-x-0 top-[66%] h-px" />
            <div className="scene-grain absolute inset-0" />
            <div className="aqua-shard float-slow absolute -left-48 top-[18%] hidden h-[22rem] w-[22rem] rounded-[46%_54%_42%_58%/52%_44%_56%_48%] sm:block" />
            <div className="aqua-shard float-slow absolute -right-52 top-[22%] hidden h-[24rem] w-[24rem] rounded-[54%_46%_58%_42%/48%_56%_44%_52%] sm:block" />
            <span className="aqua-bubble float-slow absolute left-[4%] top-[72%] hidden h-16 w-16 opacity-55 sm:block" />
            <span className="aqua-bubble float-slow absolute right-[5%] top-[70%] hidden h-20 w-20 opacity-50 sm:block" />
          </div>

          <div className="relative mx-auto max-w-5xl px-4 pt-10 pb-12 sm:px-5 sm:pt-16 sm:pb-14">
            <div className="flex flex-col items-center text-center">
              <Image
                src="/brand/shill-mark.png"
                alt="SHILL"
                width={852}
                height={715}
                priority
                sizes="(max-width: 640px) 220px, 380px"
                className="hero-logo h-auto w-[13.5rem] object-contain drop-shadow-[0_14px_28px_rgb(8_60_120_/_0.32)] sm:w-[22rem]"
              />

              <h1 className="hero-line text-story mt-6 max-w-3xl text-[1.65rem] font-semibold leading-[1.2] tracking-tight text-shill-deep [text-shadow:0_6px_18px_rgb(8_60_120_/_0.18)] sm:mt-10 sm:text-4xl sm:leading-[1.15] md:text-[2.9rem]">
                In a world where nothing matters more than being heard, why should the loud voices
                get nothing?
              </h1>

              <p className="hero-line mt-4 max-w-xl text-pretty text-[0.95rem] leading-relaxed text-shill-deep/70 [text-shadow:0_4px_14px_rgb(8_60_120_/_0.14)] sm:mt-5 sm:max-w-3xl sm:text-lg">
                SHILL reads the Pump.fun callout section, takes random snapshots, and pays the
                wallets doing the talking. Automatically, on-chain, every {windowLabel}.
              </p>

              {mint ? (
                <div className="hero-line mt-5 flex max-w-3xl flex-wrap items-center justify-center gap-x-2 gap-y-1 px-1 text-sm text-shill-deep/75 sm:mt-6 sm:text-base">
                  <span className="font-semibold tracking-wide">CA :</span>
                  <WalletAddress
                    address={mint}
                    short={mint}
                    href={mintUrl}
                    className="min-w-0 max-w-full font-mono text-[11px] sm:text-sm"
                    wrap
                  />
                </div>
              ) : null}

              <div className="hero-line mt-7 flex w-full max-w-sm flex-col items-stretch gap-2.5 sm:mt-8 sm:max-w-none sm:flex-row sm:flex-wrap sm:items-center sm:justify-center sm:gap-3">
                <a
                  href="#mechanics"
                  className="aqua-button rounded-full px-7 py-3 text-center text-sm font-semibold tracking-[0.06em]"
                >
                  How it works
                </a>
                {telegram ? (
                  <a
                    href={telegram}
                    target="_blank"
                    rel="noreferrer"
                    className="aqua-chip rounded-full px-7 py-3 text-center text-sm font-semibold text-shill-deep transition hover:text-primary"
                  >
                    Telegram ↗
                  </a>
                ) : null}
                <a
                  href="#live"
                  className="aqua-chip rounded-full px-7 py-3 text-center text-sm font-semibold text-shill-deep transition hover:text-primary"
                >
                  Live board
                </a>
                {xUrl ? (
                  <a
                    href={xUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="aqua-chip rounded-full px-7 py-3 text-center text-sm font-semibold text-shill-deep transition hover:text-primary"
                  >
                    X ↗
                  </a>
                ) : null}
              </div>
            </div>

            <div className="mt-10 sm:mt-12">
              <CounterBar state={state} />
            </div>
            {mint && state && !state.bonding.bonded ? (
              <aside
                role="status"
                className="hero-line aqua-panel mt-4 rounded-3xl px-5 py-4 text-left sm:mt-5 sm:px-8 sm:py-4"
              >
                <p className="text-[12px] leading-relaxed text-shill-deep/80 sm:text-sm">
                  {PRE_BOND_FOMO_NOTICE}
                </p>
              </aside>
            ) : null}
          </div>
        </section>

        {/* Panel 2 — where it usually ends */}
        <section id="story" className="relative px-4 py-12 sm:px-5 sm:py-16">
          <div className="mx-auto grid max-w-5xl items-stretch gap-4 sm:gap-5 lg:grid-cols-2">
            <Panel className="flex h-full flex-col items-center px-5 py-6 text-center sm:px-8 sm:py-7">
              <h2 className="text-story text-xl font-semibold tracking-tight text-shill-deep sm:text-2xl">
                Every day people make callouts.
              </h2>
              <ul className="mt-5 inline-flex flex-col items-start space-y-2.5 text-left">
                {CALLOUT_BEATS.map((beat) => (
                  <li key={beat} className="beat flex items-start gap-3">
                    <span
                      aria-hidden
                      className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70"
                    />
                    <span className="text-sm leading-relaxed text-shill-deep/75">{beat}</span>
                  </li>
                ))}
              </ul>
              <div className="aqua-rule mt-auto w-full pt-6" />
              <p className="mt-5 text-sm font-semibold text-shill-deep/60">
                And usually, that&apos;s pretty much where it ends.
              </p>
              <p className="mt-3 text-sm font-semibold tracking-wide text-primary">
                But what if there was more to it?
              </p>
            </Panel>

            <Panel className="flex h-full flex-col items-center px-5 py-6 text-center sm:px-8 sm:py-7">
              <p className="text-story text-lg font-semibold leading-snug text-shill-deep sm:text-2xl">
                With SHILL, instead of just shouting into the void, your voice becomes part of the
                flywheel.
              </p>
              <p className="mt-4 max-w-md text-sm leading-relaxed text-shill-deep/70">
                The SHILL bot distributes supply and creator rewards to the holders that are
                actively engaging in the callout section of ${ticker}. No forms, no claims, no
                allowlist — post a callout, hold the token, and the snapshots do the rest.
              </p>
              <div className="mt-auto grid w-full max-w-sm grid-cols-2 gap-4 pt-6 text-center">
                <Field label="Paid per snapshot">2 wallets</Field>
                <Field label="Snapshot cadence">{windowLabel}</Field>
              </div>
            </Panel>
          </div>
        </section>

        {/* Panel 3 — the loop */}
        <section className="relative px-4 pb-12 sm:px-5 sm:pb-16">
          <div className="flywheel-stage relative mx-auto max-w-5xl">
            <Panel className="flywheel-panel relative z-0 overflow-visible px-4 pt-5 text-center sm:px-7 sm:pt-6">
              <h2 className="text-story text-xl font-semibold tracking-tight text-shill-deep sm:text-2xl">
                The flywheel
              </h2>

              <Flywheel />

              <div className="mx-auto mt-4 flex max-w-2xl flex-col items-center gap-1.5 text-sm font-semibold text-shill-deep sm:mt-4 sm:flex-row sm:justify-center sm:gap-3 sm:text-base">
                <p>More participation creates more attention</p>
                <span
                  aria-hidden
                  className="text-lg font-bold leading-none text-primary sm:text-xl"
                >
                  ↔
                </span>
                <p>More attention creates more participation</p>
              </div>
              <p className="mx-auto mt-3 max-w-xs text-sm leading-relaxed text-shill-deep/60 sm:mt-4 sm:max-w-sm">
                It&apos;s a simple loop built around the one thing everyone is already trying to do:
              </p>
              <p className="flywheel-punch relative z-10 mt-1.5 sm:mt-3">Get heard</p>
            </Panel>
            <Image
              src="/brand/shill-head.png"
              alt=""
              width={700}
              height={520}
              aria-hidden
              className="flywheel-head pointer-events-none absolute bottom-0 left-1.5 z-20 translate-y-[2px] drop-shadow-[0_10px_18px_rgb(8_60_120_/_0.28)] sm:left-3 sm:translate-y-[3px] md:left-5"
            />
            <Image
              src="/brand/shill-head.png"
              alt=""
              width={700}
              height={520}
              aria-hidden
              className="flywheel-head pointer-events-none absolute bottom-0 right-1.5 z-20 translate-y-[2px] -scale-x-100 drop-shadow-[0_10px_18px_rgb(8_60_120_/_0.28)] sm:right-3 sm:translate-y-[3px] md:right-5"
            />
          </div>
        </section>

        {/* Panel 4 — mechanics, three phases */}
        <section id="mechanics" className="relative px-4 pb-12 sm:px-5 sm:pb-16">
          <div className="mx-auto max-w-5xl">
            <div className="text-center">
              <Eyebrow>How it works</Eyebrow>
              <h2 className="text-story mt-3 text-xl font-semibold tracking-tight text-shill-deep sm:text-3xl">
                Three phases, one rule: callouts get paid.
              </h2>
            </div>

            <div className="mt-7 grid gap-4 sm:mt-8 sm:gap-5 lg:grid-cols-3">
              <Panel className="flex flex-col px-5 py-6 sm:px-6 sm:py-7">
                <Eyebrow>Phase 1 · pre-bond</Eyebrow>
                <h3 className="mt-2 text-lg font-semibold text-shill-deep">Supply rewards</h3>
                <p className="mt-3 text-sm leading-relaxed text-shill-deep/75">
                  The SHILL bot takes random snapshots of the Pump.fun callouts every {windowLabel}.
                  From each snapshot, two wallets are selected:
                </p>
                <ul className="mt-4 space-y-2 text-sm text-shill-deep/75">
                  <li className="flex gap-2">
                    <span aria-hidden className="text-primary">
                      →
                    </span>
                    The latest callout
                  </li>
                  <li className="flex gap-2">
                    <span aria-hidden className="text-primary">
                      →
                    </span>
                    One random callout from the snapshot
                  </li>
                </ul>
                <div className="mt-auto pt-5">
                  <div className="aqua-rule" />
                  <div className="mt-4 grid grid-cols-2 gap-4">
                    <Field label="Each receives">{perRecipient} of supply</Field>
                    <Field label="Per snapshot">{state?.allocation.amountLabel ?? "—"} ×2</Field>
                  </div>
                </div>
              </Panel>

              <Panel className="flex flex-col px-5 py-6 sm:px-6 sm:py-7">
                <Eyebrow>Phase 2 · on bond</Eyebrow>
                <h3 className="mt-2 text-lg font-semibold text-shill-deep">One-time lottery</h3>
                <p className="mt-3 text-sm leading-relaxed text-shill-deep/75">
                  After bonding, a new system kicks in. On bond, a special lottery plays one time.
                  Every wallet that has posted at least {lotteryMinCallouts} callouts and is still
                  holding enters the draw.
                </p>
                <p className="mt-3 text-sm leading-relaxed text-shill-deep/75">
                  The remaining supply in the dev wallet is split between{" "}
                  {BOND_LOTTERY_WINNERS} winners drawn from that lottery.
                </p>
                <div className="mt-auto pt-5">
                  <div className="aqua-rule" />
                  <div className="mt-4 grid grid-cols-2 gap-4">
                    <Field label="Winners">{BOND_LOTTERY_WINNERS}</Field>
                    <Field label="Eligible now">
                      {formatInteger(state?.bonding.eligibleCount ?? 0)} wallets
                    </Field>
                  </div>
                </div>
              </Panel>

              <Panel className="flex flex-col px-5 py-6 sm:px-6 sm:py-7">
                <Eyebrow>Phase 3 · post-bond</Eyebrow>
                <h3 className="mt-2 text-lg font-semibold text-shill-deep">Creator rewards</h3>
                <p className="mt-3 text-sm leading-relaxed text-shill-deep/75">
                  From there on, the treasury wallet claims creator rewards and sends them out to
                  users with the same snapshot system as pre-bond.
                </p>
                <p className="mt-3 text-sm leading-relaxed text-shill-deep/75">
                  Each snapshot pays {CREATOR_REWARD_SHARE} of the total creator rewards to two
                  wallets — the latest callout and one random callout, in SOL.
                </p>
                <div className="mt-auto pt-5">
                  <div className="aqua-rule" />
                  <div className="mt-4 grid grid-cols-2 gap-4">
                    <Field label="Per snapshot">{CREATOR_REWARD_SHARE} of rewards</Field>
                    <Field label="Sent so far">{state?.totals.solLabel ?? "0.00 SOL"}</Field>
                  </div>
                </div>
              </Panel>
            </div>
          </div>
        </section>

        {/* Panel 5 — live proof */}
        <section id="live" className="relative px-4 pb-14 sm:px-5 sm:pb-20">
          <div className="mx-auto max-w-5xl">
            <div className="text-center">
              <Eyebrow>Live</Eyebrow>
              <h2 className="text-story mt-3 text-xl font-semibold tracking-tight text-shill-deep sm:text-3xl">
                Every snapshot is public and verifiable.
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-shill-deep/65">
                Selection is committed with a CSPRNG before any animation plays, one entry per
                username or wallet per window, and every payout lands with a signature you can open
                on Solscan. The Telegram channel announces the same rounds as they happen.
              </p>
            </div>

            <div className="live-board-grid mt-7 grid items-stretch gap-4 sm:mt-8 sm:gap-5 lg:grid-cols-[1.15fr_1fr]">
              <LiveBoard state={state} error={error} />

              <div className="rounds-scroll aqua-scroll space-y-3 sm:space-y-4">
                {state && rounds.length === 0 ? (
                  <Panel>
                    <p className="text-sm text-shill-deep/60">
                      No settled snapshot yet. The first one publishes here the moment it lands.
                    </p>
                  </Panel>
                ) : (
                  rounds.map((round) => <RoundRow key={round.id} round={round} />)
                )}
              </div>
            </div>
          </div>
        </section>

      </main>

      <footer className="relative border-t border-white/40 bg-white/55 sm:bg-white/30 sm:backdrop-blur-md">
        <div className="mx-auto max-w-5xl px-4 py-5 sm:px-5 sm:py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="flex min-w-0 items-center gap-2.5">
              <Image
                src="/brand/shill-mark.png"
                alt=""
                width={852}
                height={715}
                className="h-8 w-auto object-contain"
              />
              <div className="min-w-0">
                <p className="text-xs font-bold tracking-[0.16em] text-shill-deep uppercase">
                  SHILL
                </p>
                <p className="truncate text-[11px] leading-snug text-shill-deep/55">
                  Speak up and take your money.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-semibold text-shill-deep/70">
              {telegram ? (
                <a
                  href={telegram}
                  target="_blank"
                  rel="noreferrer"
                  className="transition hover:text-primary"
                >
                  Telegram
                </a>
              ) : null}
              {xUrl ? (
                <a
                  href={xUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="transition hover:text-primary"
                >
                  X
                </a>
              ) : null}
              {mint ? (
                <a
                  href={`https://pump.fun/coin/${mint}`}
                  target="_blank"
                  rel="noreferrer"
                  className="transition hover:text-primary"
                >
                  Pump.fun
                </a>
              ) : null}
              {mintUrl ? (
                <a
                  href={mintUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="transition hover:text-primary"
                >
                  Solscan
                </a>
              ) : null}
            </div>

            <div className="min-w-0 sm:text-right">
              {mint ? (
                <WalletAddress
                  address={mint}
                  short={state?.mint.addressShort ?? undefined}
                  href={mintUrl}
                  className="justify-start text-xs sm:justify-end"
                />
              ) : (
                <span className="text-xs text-shill-deep/50">Not launched yet</span>
              )}
              <p className="mt-1 text-[11px] text-shill-deep/50 tabular-nums">
                {formatInteger(state?.totals.snapshots ?? 0)} snapshots ·{" "}
                {formatInteger(state?.totals.payouts ?? 0)} payouts
              </p>
            </div>
          </div>

          <p className="mt-4 border-t border-white/35 pt-3 text-[11px] leading-relaxed text-shill-deep/45">
            ${ticker} is a community token with an automated callout rewards engine. Rewards depend
            on snapshot timing and are not an investment return. Nothing here is financial advice —
            verify every payout on-chain.
          </p>
        </div>
      </footer>
    </div>
  )
}
