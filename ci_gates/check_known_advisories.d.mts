// Types for check_known_advisories.mjs (imported by tests/known-advisories-gate.test.ts).
export type Finding = {
  scope: string
  id: string
  pkg: string
  severity: string
  title: string
  aliases?: string[]
}
export type AllowlistRow = {
  scope: string
  id: string
  pkg: string
  severity: string
  reason: string
  owner: string
  reviewBy: string
}
export function npmFindings(scope: string, report: unknown): Finding[]
export function pipFindings(scope: string, report: unknown): Finding[]
export function parseAllowlist(markdown: string): AllowlistRow[]
export function compareToAllowlist(
  findings: Finding[],
  allowlist: AllowlistRow[]
): { listed: Finding[]; unlisted: Finding[]; stale: AllowlistRow[] }
