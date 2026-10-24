import type { Firestore } from "firebase-admin/firestore"

export async function assertFirestoreEmulatorPortFree(host: string, port: number): Promise<void> {
  const net = await import("node:net")
  const open = await new Promise<boolean>((resolve) => {
    const socket = net.connect(port, host)
    socket.once("connect", () => {
      socket.end()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })
  if (open) throw new Error(`Firestore emulator already answers on ${host}:${port}`)
}

export async function assertFirestoreTargetEmpty(db: Firestore): Promise<void> {
  const cols = await db.listCollections()
  if (cols.length > 0) throw new Error("target Firestore emulator is not empty")
}
