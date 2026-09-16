import { defineSandbox } from "eve/sandbox"

/**
 * Committee Brain sandbox: no provider egress from the sandbox.
 * Default tools are off; this is belt-and-suspenders if bash is ever re-enabled.
 */
export default defineSandbox({
  async onSession({ use: applySession }) {
    await applySession({ networkPolicy: "deny-all" })
  },
})
