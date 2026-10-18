// Audit F18 re-audit follow-up (spec ruling R13): the compile-time constant that marks a Cloud Functions bundle.
// functions/build.mjs defines it in lib/index.js (the deployed `api` function; the emulator loads the same file) and in
// the operator CLIs; functions/src/p1/transport.ts builds a paid transport only where it is defined. It is never an
// environment variable, so no deployment setting can turn it on in another process. G-0 [19] fails on any JS/TS outside
// functions/ that names it. functions/test/f18-transport-runtime.test.ts bundles the transport with it.
export const FUNCTIONS_RUNTIME_DEFINE = Object.freeze({ __SIKANDER_FUNCTIONS_RUNTIME__: "true" })
