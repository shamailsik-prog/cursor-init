import type { Metadata } from "next"
import { IBM_Plex_Sans, Source_Serif_4 } from "next/font/google"
import "./globals.css"

const sans = IBM_Plex_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
})

const serif = Source_Serif_4({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["500", "600"],
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
