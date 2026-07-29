/**
 * The raw shape the Zen extension reports, and its validation.
 *
 * This is deliberately close to what chrome JS can observe, not to what the
 * browser model wants. Translation happens in `snapshot.ts`, so that the one
 * place that fabricates nothing is easy to review: anything the extension could
 * not determine arrives here as `null` and leaves as an explicit `unknown`.
 */

import { TransportProtocolError } from "./protocol.js";

export interface ZenSessionPayload {
  /**
   * Stable across restarts. The profile directory's leaf name, which is what
   * lets a replacement session be associated with the same configured profile.
   */
  readonly profileId: string;
  /** Minted when the extension starts. A new browser run means a new one. */
  readonly sessionId: string;
  readonly browserVersion: string;
  readonly geckoVersion: string;
  readonly capabilities: readonly string[];
  readonly profileName: string | null;
  readonly isDefaultProfile: boolean | null;
}

export interface ZenSpacePayload {
  /** Zen's own Space uuid, from `zen-sessions.jsonlz4`. */
  readonly id: string;
  readonly name: string | null;
  readonly order: number | null;
  /** The bound Firefox container's `userContextId`, as a string. Optional. */
  readonly containerId: string | null;
}

export type ZenTabLifecycle = "open" | "discarded" | "crashed";

export type ZenLoadState = "unloaded" | "loading" | "interactive" | "complete";

export interface ZenTabPayload {
  /**
   * Minted by the extension and held in a `WeakMap` keyed on the tab element,
   * so it survives moving the tab between Spaces and windows but not a browser
   * restart — which is exactly the lifetime the model gives a session entity.
   */
  readonly id: string;
  /** Zen's `zen-workspace-id`. Null for "essential" tabs, which sit outside every Space. */
  readonly spaceId: string | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly loadState: ZenLoadState | null;
  readonly selected: boolean | null;
  /**
   * Whether the tab is currently emitting sound. This cannot distinguish "no
   * media" from "media paused", so `snapshot.ts` only ever reports playing.
   */
  readonly soundPlaying: boolean | null;
  readonly containerId: string | null;
  readonly private: boolean | null;
  readonly lifecycleState: ZenTabLifecycle;
  /** Zen "essential" tabs are shown across all Spaces and belong to none. */
  readonly essential: boolean;
}

export interface ZenWindowPayload {
  readonly id: string;
  readonly private: boolean | null;
  readonly focused: boolean | null;
  readonly spaces: readonly ZenSpacePayload[];
  readonly tabs: readonly ZenTabPayload[];
}

export interface ZenSnapshotPayload {
  readonly session: ZenSessionPayload;
  readonly capturedAt: string;
  readonly windows: readonly ZenWindowPayload[];
}

const LIFECYCLE_STATES: readonly ZenTabLifecycle[] = [
  "open",
  "discarded",
  "crashed",
];

const LOAD_STATES: readonly ZenLoadState[] = [
  "unloaded",
  "loading",
  "interactive",
  "complete",
];

function invalid(detail: string): never {
  throw new TransportProtocolError(
    "invalid-request",
    `The Zen extension sent a malformed snapshot: ${detail}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${field} must be a non-empty string.`);
  }

  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    invalid(`${field} must be a string or null.`);
  }

  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "boolean") {
    invalid(`${field} must be a boolean or null.`);
  }

  return value;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${field} must be a finite number or null.`);
  }

  return value;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalid(`${field} must be an array.`);
  }

  return value;
}

function parseSession(value: unknown): ZenSessionPayload {
  if (!isRecord(value)) {
    invalid("session must be an object.");
  }

  return {
    profileId: requireString(value["profileId"], "session.profileId"),
    sessionId: requireString(value["sessionId"], "session.sessionId"),
    browserVersion: requireString(
      value["browserVersion"],
      "session.browserVersion",
    ),
    geckoVersion: requireString(value["geckoVersion"], "session.geckoVersion"),
    capabilities: requireArray(
      value["capabilities"],
      "session.capabilities",
    ).map((capability, index) =>
      requireString(capability, `session.capabilities[${String(index)}]`),
    ),
    profileName: optionalString(value["profileName"], "session.profileName"),
    isDefaultProfile: optionalBoolean(
      value["isDefaultProfile"],
      "session.isDefaultProfile",
    ),
  };
}

function parseSpace(value: unknown, path: string): ZenSpacePayload {
  if (!isRecord(value)) {
    invalid(`${path} must be an object.`);
  }

  return {
    id: requireString(value["id"], `${path}.id`),
    name: optionalString(value["name"], `${path}.name`),
    order: optionalNumber(value["order"], `${path}.order`),
    containerId: optionalString(value["containerId"], `${path}.containerId`),
  };
}

/**
 * Validate one tab.
 *
 * Exported because tab events carry the same shape as a snapshot's tabs, and
 * validating them through one path is what keeps the two from drifting.
 */
export function parseTabPayload(value: unknown, path = "tab"): ZenTabPayload {
  if (!isRecord(value)) {
    invalid(`${path} must be an object.`);
  }

  const lifecycleState = value["lifecycleState"];

  if (!LIFECYCLE_STATES.includes(lifecycleState as ZenTabLifecycle)) {
    invalid(
      `${path}.lifecycleState must be one of ${LIFECYCLE_STATES.join(", ")}.`,
    );
  }

  const loadState = value["loadState"];

  if (
    loadState !== null &&
    loadState !== undefined &&
    !LOAD_STATES.includes(loadState as ZenLoadState)
  ) {
    invalid(
      `${path}.loadState must be one of ${LOAD_STATES.join(", ")}, or null.`,
    );
  }

  const essential = value["essential"];

  if (typeof essential !== "boolean") {
    invalid(`${path}.essential must be a boolean.`);
  }

  return {
    id: requireString(value["id"], `${path}.id`),
    spaceId: optionalString(value["spaceId"], `${path}.spaceId`),
    url: optionalString(value["url"], `${path}.url`),
    title: optionalString(value["title"], `${path}.title`),
    loadState: (loadState ?? null) as ZenLoadState | null,
    selected: optionalBoolean(value["selected"], `${path}.selected`),
    soundPlaying: optionalBoolean(
      value["soundPlaying"],
      `${path}.soundPlaying`,
    ),
    containerId: optionalString(value["containerId"], `${path}.containerId`),
    private: optionalBoolean(value["private"], `${path}.private`),
    lifecycleState: lifecycleState as ZenTabLifecycle,
    essential,
  };
}

function parseWindow(value: unknown, path: string): ZenWindowPayload {
  if (!isRecord(value)) {
    invalid(`${path} must be an object.`);
  }

  return {
    id: requireString(value["id"], `${path}.id`),
    private: optionalBoolean(value["private"], `${path}.private`),
    focused: optionalBoolean(value["focused"], `${path}.focused`),
    spaces: requireArray(value["spaces"], `${path}.spaces`).map(
      (space, index) => parseSpace(space, `${path}.spaces[${String(index)}]`),
    ),
    tabs: requireArray(value["tabs"], `${path}.tabs`).map((tab, index) =>
      parseTabPayload(tab, `${path}.tabs[${String(index)}]`),
    ),
  };
}

/**
 * Validate a `browser.snapshot` result.
 *
 * Rejects rather than repairs. A snapshot that cannot be trusted structurally
 * cannot be trusted to be complete either, and an incomplete tab list is what
 * makes an agent open a duplicate tab.
 */
export function parseSnapshotPayload(value: unknown): ZenSnapshotPayload {
  if (!isRecord(value)) {
    invalid("the payload must be an object.");
  }

  const windows = requireArray(value["windows"], "windows").map(
    (window, index) => parseWindow(window, `windows[${String(index)}]`),
  );

  const windowIds = new Set<string>();
  const tabIds = new Set<string>();

  for (const window of windows) {
    if (windowIds.has(window.id)) {
      invalid(`window id ${JSON.stringify(window.id)} appeared twice.`);
    }

    windowIds.add(window.id);
    const spaceIds = new Set<string>();

    for (const space of window.spaces) {
      if (spaceIds.has(space.id)) {
        invalid(
          `Space id ${JSON.stringify(space.id)} appeared twice in one window.`,
        );
      }

      spaceIds.add(space.id);
    }

    for (const tab of window.tabs) {
      if (tabIds.has(tab.id)) {
        invalid(`tab id ${JSON.stringify(tab.id)} appeared twice.`);
      }

      tabIds.add(tab.id);
    }
  }

  return {
    session: parseSession(value["session"]),
    capturedAt: requireString(value["capturedAt"], "capturedAt"),
    windows,
  };
}
