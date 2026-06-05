import type { NextConfig } from "next";

function truthyEnv(value: string | undefined) {
  return ["1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
}

if (process.env.NODE_ENV === "production" && truthyEnv(process.env.OTTO_DEV_AUTH_BYPASS)) {
  throw new Error("Refusing to start with OTTO_DEV_AUTH_BYPASS=true in production.");
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["otto-dev.flowlabshq.com"],
  async headers() {
    if (process.env.NODE_ENV === "production") return [];
    const noStoreHeaders = [
      {
        key: "Cache-Control",
        value: "no-store, no-cache, must-revalidate, proxy-revalidate",
      },
      { key: "Pragma", value: "no-cache" },
      { key: "Expires", value: "0" },
    ];
    return [
      {
        source: "/_next/:path*",
        headers: noStoreHeaders,
      },
      {
        source: "/onboarding/upload",
        headers: noStoreHeaders,
      },
      {
        source: "/process/:id/capture/upload-document",
        headers: noStoreHeaders,
      },
    ];
  },
};

export default nextConfig;
