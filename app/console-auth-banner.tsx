"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useConsoleAuth } from "@/app/console-auth-provider"

export function ConsoleAuthBanner() {
  const auth = useConsoleAuth()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  if (auth.loading) {
    return (
      <p className="text-xs text-muted-foreground px-4 py-2 border-b">
        Checking Firebase session…
      </p>
    )
  }

  if (auth.idToken) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
        <span className="text-muted-foreground">Signed in</span>
        <span className="font-mono">{auth.user?.email ?? auth.user?.uid}</span>
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">Firm</span>
          <Input
            className="h-7 w-28 font-mono text-xs"
            value={auth.firmId}
            onChange={(e) => auth.setFirmId(e.target.value)}
          />
        </label>
        <Button type="button" size="sm" variant="outline" onClick={() => auth.signOutUser()}>
          Sign out
        </Button>
      </div>
    )
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2 border-b px-4 py-2 text-xs"
      onSubmit={async (e) => {
        e.preventDefault()
        await auth.signIn(email, password)
      }}
    >
      <span className="text-muted-foreground w-full sm:w-auto">
        Sign in (Firebase ID token required for API calls)
      </span>
      <Input
        className="h-8 w-48"
        placeholder="email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="username"
      />
      <Input
        className="h-8 w-40"
        placeholder="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
      />
      <Button type="submit" size="sm">Sign in</Button>
      {auth.error ? <span className="text-destructive">{auth.error}</span> : null}
    </form>
  )
}
