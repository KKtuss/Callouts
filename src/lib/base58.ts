const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

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
