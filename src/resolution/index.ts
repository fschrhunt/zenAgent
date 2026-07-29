export {
  matchTab,
  validateMatchRequest,
  type TabMatch,
  type TabMatchEvaluation,
  type TabMatchRequest,
  type TabMatchRule,
} from "./match.js";
export {
  TabResolutionError,
  TabResolver,
  type AmbiguousResolution,
  type OpenedResolution,
  type ResolutionCandidate,
  type ResolveTabRequest,
  type ReusedResolution,
  type TabResolution,
  type TabResolutionTransport,
} from "./resolver.js";
export {
  hostnameMatchesDomain,
  isSensitiveOrStatefulUrl,
  normalizedHostname,
  normalizedOrigin,
  normalizeDomain,
  normalizeUrl,
  ResolutionUrlError,
} from "./url.js";
