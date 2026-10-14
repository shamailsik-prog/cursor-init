/** Auth + Firestore emulators (set by `firebase emulators:exec`). */
export const HAS_AUTH_FIRESTORE_EMULATORS = Boolean(
  process.env.FIRESTORE_EMULATOR_HOST?.trim() && process.env.FIREBASE_AUTH_EMULATOR_HOST?.trim()
)

/** Functions HTTP host:port (set when the Functions emulator is in the `emulators:exec` set). */
export function functionsEmulatorHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit =
    env.FIREBASE_FUNCTIONS_EMULATOR_HOST?.trim() || env.FUNCTIONS_EMULATOR_HOST?.trim()
  if (!explicit) return null
  return explicit.replace(/^https?:\/\//, "")
}

/** Functions HTTP emulator (requires `FIREBASE_FUNCTIONS_EMULATOR_HOST` or `FUNCTIONS_EMULATOR_HOST`). */
export const HAS_FUNCTIONS_HTTP_EMULATOR = Boolean(functionsEmulatorHost())

const onCi = Boolean(process.env.CI) && !/^(false|0)$/i.test(process.env.CI ?? "")

export function requireAuthFirestoreEmulators(context: string): void {
  if (onCi && !HAS_AUTH_FIRESTORE_EMULATORS) {
    throw new Error(
      `${context} requires FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST (run via firebase emulators:exec --only auth,firestore).`
    )
  }
}

export function requireFunctionsHttpEmulator(context: string): void {
  if (onCi && !HAS_FUNCTIONS_HTTP_EMULATOR) {
    throw new Error(
      `${context} requires the Functions HTTP emulator (firebase emulators:exec --only auth,firestore,functions).`
    )
  }
}
