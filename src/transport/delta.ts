/**
 * Incremental changes between snapshots.
 *
 * Zen's DOM events are not a guaranteed-complete change feed — a tab can be
 * moved, discarded, or restored in ways that emit nothing useful — so these
 * deltas are an optimisation, not the source of truth. Anything the extension
 * is unsure about arrives as `registry.invalidated` instead, which tells the
 * client to take a fresh snapshot rather than trust an incremental view.
 */

import type {
  BrowserDelta,
  BrowserSessionId,
  BrowserSpaceId,
  BrowserWindowId,
  RegistryChange,
} from "../browser/model.js";
import {
  BROWSER_MODEL_VERSION,
  sessionEntityId,
  type BrowserSnapshot,
} from "../browser/model.js";
import { knownCapabilities, type TransportCapability } from "./capabilities.js";
import { parseTabPayload, type ZenTabPayload } from "./payload.js";
import { TransportProtocolError, type TransportEventName } from "./protocol.js";
import { toTabEntity, zenSpaceUuid } from "./snapshot.js";

export interface DeltaWindowContext {
  readonly windowId: BrowserWindowId;
  /** Zen Space uuid to the Space identity composed for this window. */
  readonly spaces: ReadonlyMap<string, BrowserSpaceId>;
}

export interface DeltaContext {
  readonly session: BrowserSessionId;
  readonly capabilities: readonly TransportCapability[];
  readonly windows: ReadonlyMap<string, DeltaWindowContext>;
}

/**
 * Derive the context needed to interpret events, from the snapshot they follow.
 *
 * Events are only meaningful relative to a snapshot: a `tab.created` in a
 * window the client has never seen cannot be placed, and is a signal that the
 * client's view is stale rather than something to patch in.
 */
export function deltaContext(snapshot: BrowserSnapshot): DeltaContext {
  const session = snapshot.sessions[0]?.id;

  if (session === undefined) {
    throw new TransportProtocolError(
      "internal",
      "A snapshot must contain exactly one browser session to derive delta context.",
    );
  }

  const spacesByWindow = new Map<string, Map<string, BrowserSpaceId>>();

  for (const space of snapshot.spaces) {
    const windowKey = space.windowId.transportId;
    const spaces =
      spacesByWindow.get(windowKey) ?? new Map<string, BrowserSpaceId>();
    // The Space's transport id is `<windowId>/<zen uuid>`; index by the uuid,
    // which is what Zen's events report.
    spaces.set(zenSpaceUuid(space.id.transportId), space.id);
    spacesByWindow.set(windowKey, spaces);
  }

  const windows = new Map<string, DeltaWindowContext>();

  for (const window of snapshot.windows) {
    windows.set(window.id.transportId, {
      windowId: window.id,
      spaces: spacesByWindow.get(window.id.transportId) ?? new Map(),
    });
  }

  return {
    session,
    // The session record types capabilities as plain strings, so re-narrow to
    // the ones this build understands rather than trusting the array's type.
    capabilities: knownCapabilities(snapshot.sessions[0]?.capabilities ?? []),
    windows,
  };
}

export interface DeltaOptions {
  readonly sequence: number;
  readonly observedAt: string;
}

/**
 * Map one extension event onto a registry delta.
 *
 * Returns `undefined` for events that carry no registry change — a client
 * should re-snapshot on `registry.invalidated` rather than receive an empty
 * delta that would consume a sequence number for nothing.
 */
export function toDelta(
  eventName: TransportEventName,
  payload: unknown,
  context: DeltaContext,
  options: DeltaOptions,
): BrowserDelta | undefined {
  const change = toChange(eventName, payload, context);

  if (change === undefined) {
    return undefined;
  }

  return {
    schemaVersion: BROWSER_MODEL_VERSION,
    sequence: options.sequence,
    observedAt: options.observedAt,
    changes: [change],
  };
}

function toChange(
  eventName: TransportEventName,
  payload: unknown,
  context: DeltaContext,
): RegistryChange | undefined {
  switch (eventName) {
    case "tab.created":
    case "tab.updated": {
      const { window, tab } = parseTabEvent(payload, context);
      return {
        type: "entity.upserted",
        entity: toTabEntity(
          tab,
          window.windowId,
          window.spaces,
          context.session,
          context.capabilities,
        ),
      };
    }
    case "tab.removed": {
      const { tabId } = parseTabRefEvent(payload, context);
      return {
        type: "entity.removed",
        id: sessionEntityId("tab", context.session, tabId),
        reason: "closed",
      };
    }
    case "tab.crashed": {
      const { tabId } = parseTabRefEvent(payload, context);
      return {
        type: "tab.crashed",
        id: sessionEntityId("tab", context.session, tabId),
      };
    }
    case "session.ready":
    case "session.ending":
    case "registry.invalidated":
      return undefined;
  }
}

function windowContext(
  payload: unknown,
  context: DeltaContext,
): DeltaWindowContext {
  if (typeof payload !== "object" || payload === null) {
    throw new TransportProtocolError(
      "invalid-request",
      "A tab event payload must be an object.",
    );
  }

  const windowId = (payload as { windowId?: unknown }).windowId;

  if (typeof windowId !== "string") {
    throw new TransportProtocolError(
      "invalid-request",
      "A tab event must name its window.",
    );
  }

  const window = context.windows.get(windowId);

  if (window === undefined) {
    // The event refers to a window the last snapshot did not contain, which
    // means the client's view is already stale. Say so instead of inventing it.
    throw new TransportProtocolError(
      "stale-id",
      `Tab event referred to unknown window ${JSON.stringify(windowId)}; a fresh snapshot is required.`,
    );
  }

  return window;
}

function parseTabEvent(
  payload: unknown,
  context: DeltaContext,
): { window: DeltaWindowContext; tab: ZenTabPayload } {
  const window = windowContext(payload, context);
  const tab = parseTabPayload((payload as { tab?: unknown }).tab);
  return { window, tab };
}

function parseTabRefEvent(
  payload: unknown,
  context: DeltaContext,
): { window: DeltaWindowContext; tabId: string } {
  const window = windowContext(payload, context);
  const tabId = (payload as { tabId?: unknown }).tabId;

  if (typeof tabId !== "string" || tabId.trim().length === 0) {
    throw new TransportProtocolError(
      "invalid-request",
      "A tab event must name its tab.",
    );
  }

  return { window, tabId };
}
