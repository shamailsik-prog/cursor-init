import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16 blocks HMR from 127.0.0.1 unless listed; Preview and the
  // inspector must work on the IP URL as well as localhost.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
