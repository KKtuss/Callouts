import { randomBytes } from "node:crypto"
import { pickIndex, nodeSecureRandom, type SecureRandom } from "@/lib/crypto-random"
import { generateWallet, normalizeCallout } from "@/engine/collector"
import type { Callout, EngineConfig } from "@/engine/types"

const TOKENS = [
  "BONK",
  "WIF",
  "POPCAT",
  "MEW",
  "PNUT",
  "GOAT",
  "MOODENG",
  "GIGA",
  "TREMP",
  "RETARDIO",
  "SLERF",
  "BOME",
  "WEN",
  "JUP",
  "PYTH",
]

const CALLERS = [
  "alpha",
  "degenwhale",
  "chartwizard",
  "onchainowl",
  "liqhunter",
  "mintsniper",
  "bagholder",
  "solquest",
  "nfteater",
  "yieldfox",
  "pxlking",
  "voidcaller",
]

export class CalloutFeeder {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true

  constructor(
    private readonly ingest: (callout: Callout) => void,
    private readonly config: () => EngineConfig,
    private readonly random: SecureRandom = nodeSecureRandom,
    private readonly enabled: () => boolean = () => true,
  ) {}

  start() {
    this.stopped = false
    this.arm()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  emitOne(now = new Date()): Callout {
    const cfg = this.config()
    const source = cfg.calloutSources[0] ?? "demo-feed"
    const token = TOKENS[pickIndex(TOKENS.length, this.random)]
    const caller = CALLERS[pickIndex(CALLERS.length, this.random)]
    const callout = normalizeCallout({
      token,
      callerUsername: caller,
      wallet: generateWallet(),
      source,
      capturedAt: now.toISOString(),
      id: `co_${randomBytes(6).toString("hex")}`,
    })
    this.ingest(callout)
    return callout
  }

  private arm() {
    if (this.stopped) return
    const cfg = this.config()
    const min = Math.max(250, cfg.feederMinMs)
    const max = Math.max(min, cfg.feederMaxMs)
    const delay = min + this.random.int(max - min + 1)
    this.timer = setTimeout(() => {
      if (!this.stopped && this.enabled() && cfg.feederEnabled) {
        this.emitOne()
      }
      this.arm()
    }, delay)
  }
}
