const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return ""

  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1

  const size = ((bytes.length - zeros) * 138) / 100 + 1
  const b58 = new Uint8Array(size)
  let length = 0

  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]
    let j = 0
    for (let k = size - 1; k >= 0; k -= 1) {
      if (carry === 0 && j >= length) break
      carry += 256 * b58[k]
      b58[k] = carry % 58
      carry = (carry / 58) | 0
      j += 1
    }
    length = j
  }

  let start = size - length
  while (start < size && b58[start] === 0) start += 1

  let result = "1".repeat(zeros)
  for (let i = start; i < size; i += 1) {
    result += ALPHABET[b58[i]]
  }
  return result
}
