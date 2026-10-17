import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep mongoose OUT of the bundle so every route/chunk shares ONE module
  // instance (one MongoClient). Without this, a hot reload can re-evaluate a
  // route with a fresh mongoose while shared model chunks keep the old
  // client — then transactions fail with "ClientSession must be from the
  // same MongoClient" and queued offline sales never sync (500 on every
  // retry).
  serverExternalPackages: ["mongoose"],
  // The dev badge is pinned bottom-left, where the POS mobile checkout bar
  // sits — it swallowed taps on the cart button. Compile/runtime errors are
  // still surfaced without it.
  devIndicators: false,
  experimental: {
    serverActions: {
      bodySizeLimit: "5mb",
    },
    // The React debug channel streams dev-only chunk metadata over the dev
    // server WebSocket. When a page is served from cache while offline (the
    // service-worker app shell), that stream never delivers and hydration
    // never completes — leaving the POS grid stuck on its skeleton. Offline
    // mode matters more than the devtools channel, so it stays off.
    reactDebugChannel: false,
  },
};

export default nextConfig;
