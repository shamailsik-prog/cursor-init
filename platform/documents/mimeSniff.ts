/** Best-effort MIME sniff for ingest when the client omits mimeType. */
export function sniffMimeType(bytes: Buffer): string {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf"
  }
  return "application/octet-stream"
}
