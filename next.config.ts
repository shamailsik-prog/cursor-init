import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16 blocks HMR from 127.0.0.1 unless listed; Preview and the
  // inspector must work on the IP URL as well as localhost.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // The nine F02 routes call createRouter in-process. That pulls firebase-functions
  // (and firebase-admin) into the route graph. Require them at runtime from
  // node_modules; do not bundle them. CI's Next job does not install functions/.
  serverExternalPackages: ["firebase-functions", "firebase-admin"],
};

// Not wrapped with withEve(): Phase 0 keeps `next dev` as the foundation
// inspector. The eve agent is invoked through POST /api/p1/committee-brain
// so classification + mask always run. See agent/ and platform/p1/.
export default nextConfig;
