const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const ALPHABET_MAP = new Map([...ALPHABET].map((char, index) => [char, index]))

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return ""

  const digits = [0]
  for (let i = 0; i < bytes.length; i += 1) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] * 256
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  let leadingZeros = 0
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros += 1
  }

  let result = "1".repeat(leadingZeros)
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    result += ALPHABET[digits[i]]
  }
  return result
}

export function decodeBase58(value: string): Uint8Array {
  const trimmed = value.trim()
  if (!trimmed) return new Uint8Array()

  const bytes = [0]
  for (const char of trimmed) {
    const valueIndex = ALPHABET_MAP.get(char)
    if (valueIndex === undefined) {
      throw new Error("Invalid base58 character")
    }
    let carry = valueIndex
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }

  let leadingOnes = 0
  while (leadingOnes < trimmed.length && trimmed[leadingOnes] === "1") {
    leadingOnes += 1
  }

  const out = new Uint8Array(leadingOnes + bytes.length)
  for (let i = 0; i < bytes.length; i += 1) {
    out[out.length - 1 - i] = bytes[i]
  }
  return out
}
