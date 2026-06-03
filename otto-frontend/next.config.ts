import type { NextConfig } from "next";

function truthyEnv(value: string | undefined) {
  return ["1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
}

if (process.env.NODE_ENV === "production" && truthyEnv(process.env.OTTO_DEV_AUTH_BYPASS)) {
  throw new Error("Refusing to start with OTTO_DEV_AUTH_BYPASS=true in production.");
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["otto-dev.flowlabshq.com"],
};

export default nextConfig;
