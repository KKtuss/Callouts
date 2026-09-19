export function explorerTxUrl(signature: string, template?: string): string {
  const base = template?.trim() || "https://solscan.io/tx/{signature}"
  return base.replaceAll("{signature}", encodeURIComponent(signature))
}

export function explorerAddressUrl(address: string, template?: string): string {
  const base = template?.trim() || "https://solscan.io/account/{address}"
  return base.replaceAll("{address}", encodeURIComponent(address))
}
