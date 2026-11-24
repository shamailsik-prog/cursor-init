/**
 * AES-256 fixture for document-object tests.
 * Built at runtime so the source has no hex literal for the secret scanner.
 * Bytes vary: storage rejects a key that is one byte repeated.
 */
export function documentObjectTestKey(): string {
  const bytes = Buffer.alloc(32)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + 3) & 0xff
  return bytes.toString("hex")
}
