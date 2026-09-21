export type HolderCheck = (wallet: string, mint: string) => Promise<boolean>

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com"

/**
 * True if the wallet holds any amount of the mint (token account uiAmount > 0).
 */
export async function walletHoldsMint(
  wallet: string,
  mint: string,
  fetchImpl: typeof fetch = fetch,
  rpcUrl = process.env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC,
): Promise<boolean> {
  try {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [wallet, { mint }, { encoding: "jsonParsed" }],
      }),
      cache: "no-store",
    })
    if (!response.ok) return false
    const payload = (await response.json()) as {
      result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null; amount?: string } } } } } }> }
    }
    const accounts = payload.result?.value ?? []
    for (const entry of accounts) {
      const amount = entry.account?.data?.parsed?.info?.tokenAmount
      if (!amount) continue
      if (typeof amount.uiAmount === "number" && amount.uiAmount > 0) return true
      if (typeof amount.amount === "string" && amount.amount !== "0") return true
    }
    return false
  } catch {
    return false
  }
}

export async function filterHolders(
  wallets: string[],
  mint: string,
  check: HolderCheck = walletHoldsMint,
): Promise<string[]> {
  const unique = [...new Set(wallets)]
  const held = await Promise.all(
    unique.map(async (wallet) => ((await check(wallet, mint)) ? wallet : null)),
  )
  return held.filter((wallet): wallet is string => Boolean(wallet))
}
