export * from "./browser/model.js";
export * from "./browser/registry.js";

export const ZEN_AGENT_VERSION = "0.1.0";

export const PRODUCT_PRINCIPLES = [
  "discover-before-open",
  "reuse-by-stable-id",
  "background-only",
  "space-aware",
] as const;

export type ProductPrinciple = (typeof PRODUCT_PRINCIPLES)[number];
