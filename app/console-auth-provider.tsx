"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth"
import { firebaseWebAuth } from "@/lib/console/firebase-client"
import type { ConsoleAuthContext } from "@/lib/console/auth-headers"

type ConsoleAuthState = ConsoleAuthContext & {
  user: User | null
  loading: boolean
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  signOutUser: () => Promise<void>
  setFirmId: (firmId: string) => void
}

const ConsoleAuthContextReact = createContext<ConsoleAuthState | null>(null)

export function ConsoleAuthProvider({
  children,
  defaultFirmId = "firmA",
}: {
  children: ReactNode
  defaultFirmId?: string
}) {
  const [user, setUser] = useState<User | null>(null)
  const [idToken, setIdToken] = useState<string | null>(null)
  const [firmId, setFirmId] = useState(defaultFirmId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const auth = firebaseWebAuth()
    return onAuthStateChanged(auth, async (next) => {
      setUser(next)
      if (!next) {
        setIdToken(null)
        setLoading(false)
        return
      }
      try {
        setIdToken(await next.getIdToken())
      } catch {
        setIdToken(null)
      } finally {
        setLoading(false)
      }
    })
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null)
    setLoading(true)
    try {
      const auth = firebaseWebAuth()
      const cred = await signInWithEmailAndPassword(auth, email, password)
      setIdToken(await cred.user.getIdToken())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed")
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  const signOutUser = useCallback(async () => {
    setError(null)
    await signOut(firebaseWebAuth())
    setIdToken(null)
  }, [])

  const value = useMemo<ConsoleAuthState>(
    () => ({
      user,
      idToken,
      firmId,
      loading,
      error,
      signIn,
      signOutUser,
      setFirmId,
    }),
    [user, idToken, firmId, loading, error, signIn, signOutUser]
  )

  return (
    <ConsoleAuthContextReact.Provider value={value}>{children}</ConsoleAuthContextReact.Provider>
  )
}

export function useConsoleAuth(): ConsoleAuthState {
  const ctx = useContext(ConsoleAuthContextReact)
  if (!ctx) {
    throw new Error("useConsoleAuth must be used within ConsoleAuthProvider")
  }
  return ctx
}
