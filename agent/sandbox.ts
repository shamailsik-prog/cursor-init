import { defineSandbox } from "eve/sandbox"

/**
 * Committee Brain sandbox: no provider egress from the sandbox.
 * Default tools are off; this is belt-and-suspenders if bash is ever re-enabled.
 */
export default defineSandbox({
  async onSession({ use: applySession }) {
    const session = await applySession()
    // just-bash keeps a fixed deny-all posture and rejects setNetworkPolicy;
    // capable backends (Docker/Vercel) get an explicit deny-all applied here.
    await session.setNetworkPolicy("deny-all").catch(() => {})
  },
})
