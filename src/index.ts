export * from "./browser/model.js";
export * from "./browser/registry.js";
export * from "./config/discovery.js";
export * from "./config/path.js";
export * from "./config/schema.js";
export * from "./daemon/client.js";
export * from "./daemon/logger.js";
export * from "./daemon/paths.js";
export * from "./daemon/protocol.js";
export * from "./daemon/serial.js";
export * from "./daemon/server.js";
export * from "./daemon/service.js";
export * from "./routing/policy.js";
export * from "./security/diagnostics.js";
export * from "./security/limits.js";
export * from "./security/url-policy.js";
export * from "./transport/capabilities.js";
export * from "./transport/chunking.js";
export * from "./transport/client.js";
export * from "./transport/delta.js";
export * from "./transport/framing.js";
export * from "./transport/payload.js";
export * from "./transport/protocol.js";
export * from "./transport/snapshot.js";
export * from "./native/connection.js";
export * from "./native/daemon-host.js";
export * from "./native/host.js";
export * from "./native/install.js";
export * from "./native/manifest.js";
export * from "./resolution/index.js";

export const ZEN_AGENT_VERSION = "0.1.0";

export const PRODUCT_PRINCIPLES = [
  "discover-before-open",
  "reuse-by-stable-id",
  "background-only",
  "space-aware",
] as const;

export type ProductPrinciple = (typeof PRODUCT_PRINCIPLES)[number];
