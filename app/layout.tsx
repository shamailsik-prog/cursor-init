import type { Metadata } from "next"
import localFont from "next/font/local"
import "./globals.css"

// Self-hosted (SIL OFL 1.1, licences in app/fonts/): the build never fetches from Google Fonts,
// whose download failing on CI runners broke `next build` (PR #8, PR #9).
const sans = localFont({
  variable: "--font-sans",
  src: [
    { path: "./fonts/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
})

const serif = localFont({
  variable: "--font-serif",
  src: [
    { path: "./fonts/source-serif-4-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/source-serif-4-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
})

export const metadata: Metadata = {
  title: "SIKANDER AI — Phase 0 foundations",
  description:
    "NHS Legal, Karachi. Gate G-0 foundations: courts prefix table, 159 document types, feature flags, Firestore rules.",
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${serif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  )
}
