import type { NextConfig } from "next";

if (process.env.NODE_ENV === "production" && process.env.OTTO_DEV_AUTH_BYPASS === "true") {
  throw new Error("Refusing to start with OTTO_DEV_AUTH_BYPASS=true in production.");
}

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
