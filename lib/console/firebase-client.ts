import { initializeApp, getApps, type FirebaseApp } from "firebase/app"
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth"

function emulatorProjectId(): string {
  return (
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    "demo-sikander"
  )
}

export function firebaseWebApp(): FirebaseApp {
  const existing = getApps()[0]
  if (existing) return existing
  const authEmulator = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST?.trim()
  return initializeApp({
    projectId: emulatorProjectId(),
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim() || "demo-api-key",
  })
}

let authEmulatorConnected = false

export function firebaseWebAuth(): Auth {
  const auth = getAuth(firebaseWebApp())
  const host =
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST?.trim() ||
    (typeof window !== "undefined"
      ? (window as unknown as { __FIREBASE_AUTH_EMULATOR_HOST__?: string })
          .__FIREBASE_AUTH_EMULATOR_HOST__
      : undefined)
  if (host && !authEmulatorConnected) {
    connectAuthEmulator(auth, `http://${host}`, { disableWarnings: true })
    authEmulatorConnected = true
  }
  return auth
}
