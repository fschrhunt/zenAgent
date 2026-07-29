export * from "./browser/model.js";
export * from "./browser/registry.js";
export * from "./transport/capabilities.js";
export * from "./transport/chunking.js";
export * from "./transport/client.js";
export * from "./transport/delta.js";
export * from "./transport/framing.js";
export * from "./transport/payload.js";
export * from "./transport/protocol.js";
export * from "./transport/snapshot.js";
export * from "./native/connection.js";
export * from "./native/host.js";
export * from "./native/manifest.js";

export const ZEN_AGENT_VERSION = "0.1.0";

export const PRODUCT_PRINCIPLES = [
  "discover-before-open",
  "reuse-by-stable-id",
  "background-only",
  "space-aware",
] as const;

export type ProductPrinciple = (typeof PRODUCT_PRINCIPLES)[number];
