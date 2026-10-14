// Deterministic AES-256 key for vitest; production must set a unique secret.
process.env.SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY ??=
  "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00"
