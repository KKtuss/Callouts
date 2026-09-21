"use client"

import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { cn } from "@/lib/utils"

export function WalletAddress({
  address,
  short,
  href,
  className,
  wrap = false,
}: {
  address: string
  short?: string
  href?: string | null
  className?: string
  wrap?: boolean
}) {
  const [copied, setCopied] = useState(false)
  if (!address) return <span className="text-muted-foreground">—</span>

  const label = short || address
  const labelClass = wrap
    ? "break-all font-medium tracking-wide text-shill-deep transition hover:text-primary"
    : "truncate font-medium tracking-wide text-shill-deep transition hover:text-primary"

  async function copy() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* ignore */
    }
  }

  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5", className)}>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title={address}
          className={labelClass}
        >
          {label}
        </a>
      ) : (
        <span title={address} className={wrap ? "break-all font-medium tracking-wide" : "truncate font-medium tracking-wide"}>
          {label}
        </span>
      )}
      <button
        type="button"
        onClick={copy}
        aria-label="Copy address"
        title="Copy address"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-primary/15 bg-white/60 text-muted-foreground transition hover:border-primary/35 hover:text-primary"
      >
        {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  )
}
