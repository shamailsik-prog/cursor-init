/**
 * The Firestore document written to `upload_sessions`.
 * `expiresAt` is the TTL field (one day). `firmId` is on the row and on every file.
 */
export function uploadSessionRecord(session: {
  firmId: string
  matterId: string | null
  callerId: string
  storagePath: string
  createdAtMs: number
  expiresAtMs: number
  files: ReadonlyArray<object>
}): Record<string, unknown> {
  return {
    firmId: session.firmId,
    matterId: session.matterId,
    callerId: session.callerId,
    storagePath: session.storagePath,
    createdAtMs: session.createdAtMs,
    expiresAtMs: session.expiresAtMs,
    expiresAt: new Date(session.expiresAtMs),
    files: session.files.map((file) => ({ ...file })),
  }
}
