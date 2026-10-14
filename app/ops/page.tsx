import { ConsoleAuthBanner } from "@/app/console-auth-banner"
import { ConsoleAuthProvider } from "@/app/console-auth-provider"
import { OperatorAuditConsole } from "@/app/ops/operator-audit-console"

export default function OpsPage() {
  return (
    <ConsoleAuthProvider>
      <ConsoleAuthBanner />
      <OperatorAuditConsole />
    </ConsoleAuthProvider>
  )
}
