/**
 * Capability detection for Zen internals.
 *
 * ADR 0001 names drift in Zen's internals as the main risk of this transport:
 * `gZenWorkspaces`, `allStoredTabs`, and `moveTabToWorkspace` are undocumented
 * and can change between releases. So the extension probes for each one at
 * startup and reports what it actually found, and the host refuses to operate
 * on anything it was not told is present.
 *
 * The failure mode this prevents is the dangerous one: calling an internal that
 * has quietly changed shape and switching the user's visible Space as a result.
 */

import { TransportProtocolError } from "./protocol.js";

/**
 * Browser builds whose privileged Zen internals have passed the complete
 * headed transport proof.
 *
 * Match both versions exactly. The capability probe catches an internal that
 * disappeared, while this allowlist catches the more dangerous case where an
 * internal kept its name but changed semantics.
 */
export const SUPPORTED_ZEN_BUILDS = [
  {
    browserVersion: "1.21.9b",
    geckoVersion: "153.0",
  },
] as const;

export interface ZenBuildVersion {
  readonly browserVersion: string;
  readonly geckoVersion: string;
}

export const TRANSPORT_CAPABILITIES = [
  /** `gZenWorkspaces.getWorkspaces()` returns Spaces with uuid and name. */
  "zen.spaces.enumerate",
  /** `gZenWorkspaces.moveTabToWorkspace()` routes a tab without switching. */
  "zen.spaces.route",
  /** `gZenWorkspaces.allStoredTabs` sees tabs in every Space, loaded or not. */
  "zen.tabs.enumerate-all-spaces",
  /** `gBrowser.addTab()` opens without selecting. */
  "zen.tabs.open-background",
  /** `gBrowser.selectedTab` is readable, so selected state is observable. */
  "browser.tabs.selected",
  /** Window focus is observable. */
  "browser.windows.focused",
  /** Per-tab sound state is observable. */
  "browser.tabs.media-state",
  /** Per-window private-browsing state is observable. */
  "browser.windows.private",
  /** Packaged JSWindowActor can inspect a loaded page without activation. */
  "browser.pages.inspect",
] as const;

export type TransportCapability = (typeof TRANSPORT_CAPABILITIES)[number];

/**
 * Capabilities without which the product's first two principles — look before
 * you open, and reuse by stable id — cannot be honoured at all.
 *
 * Enumerating every Space is the one that BiDi and a plain WebExtension both
 * failed. Without it the transport is blind to whichever Space the user is not
 * currently looking at, which is exactly the failure ADR 0001 rejected.
 */
export const REQUIRED_CAPABILITIES: readonly TransportCapability[] = [
  "zen.spaces.enumerate",
  "zen.tabs.enumerate-all-spaces",
  "browser.windows.private",
];

export function isTransportCapability(
  value: unknown,
): value is TransportCapability {
  return (
    typeof value === "string" &&
    (TRANSPORT_CAPABILITIES as readonly string[]).includes(value)
  );
}

/**
 * Keep only recognised capabilities.
 *
 * A newer extension may report capabilities this host has never heard of.
 * Dropping them is correct: the host cannot use what it cannot name, and the
 * protocol version check already catches genuinely incompatible peers.
 */
export function knownCapabilities(
  reported: readonly unknown[],
): readonly TransportCapability[] {
  return reported.filter(isTransportCapability);
}

export function hasCapability(
  capabilities: readonly TransportCapability[],
  capability: TransportCapability,
): boolean {
  return capabilities.includes(capability);
}

export function isSupportedZenBuild(build: ZenBuildVersion): boolean {
  return SUPPORTED_ZEN_BUILDS.some(
    (supported) =>
      supported.browserVersion === build.browserVersion &&
      supported.geckoVersion === build.geckoVersion,
  );
}

/**
 * Refuse builds that have not passed the headed safety proof.
 *
 * Zen's Space APIs are undocumented. Merely finding methods with the expected
 * names does not prove that calling them still leaves focus, selection, and the
 * visible Space unchanged, so an unknown version cannot safely degrade.
 */
export function assertSupportedZenBuild(build: ZenBuildVersion): void {
  if (isSupportedZenBuild(build)) {
    return;
  }

  const supported = SUPPORTED_ZEN_BUILDS.map(
    (candidate) =>
      `Zen ${candidate.browserVersion} / Gecko ${candidate.geckoVersion}`,
  ).join(", ");

  throw new TransportProtocolError(
    "unsupported-capability",
    `Zen ${build.browserVersion} / Gecko ${build.geckoVersion} has not passed Zen Agent's headed safety proof, so Zen Agent will not operate on it. Supported builds: ${supported}.`,
  );
}

/**
 * Throw unless every required capability is present.
 *
 * The message names the Zen version, because the resolution is almost always
 * "this Zen release moved something", and the version is what turns a bug
 * report into a fix.
 */
export function assertRequiredCapabilities(
  capabilities: readonly TransportCapability[],
  browserVersion: string,
): void {
  const missing = REQUIRED_CAPABILITIES.filter(
    (capability) => !capabilities.includes(capability),
  );

  if (missing.length === 0) {
    return;
  }

  throw new TransportProtocolError(
    "unsupported-capability",
    `Zen ${browserVersion} did not expose ${missing.join(", ")}. Zen Agent cannot discover tabs safely on this build, so it will not try. Please report the Zen version.`,
  );
}

/**
 * Throw unless a capability a specific operation needs is present.
 *
 * Called before mutating anything, so an unsupported build produces a refusal
 * rather than a partial change.
 */
export function requireCapability(
  capabilities: readonly TransportCapability[],
  capability: TransportCapability,
  operation: string,
): void {
  if (capabilities.includes(capability)) {
    return;
  }

  throw new TransportProtocolError(
    "unsupported-capability",
    `${operation} needs ${capability}, which this Zen build does not expose.`,
  );
}
