import { TRANSPORT_CAPABILITIES } from "../../src/transport/capabilities.js";
import type {
  ZenSnapshotPayload,
  ZenTabPayload,
  ZenWindowPayload,
} from "../../src/transport/payload.js";

export function tabPayload(
  overrides: Partial<ZenTabPayload> = {},
): ZenTabPayload {
  return {
    id: "tab-1",
    spaceId: "{personal}",
    url: "https://example.com/",
    title: "Example",
    loadState: "complete",
    selected: false,
    soundPlaying: false,
    containerId: "1",
    private: false,
    lifecycleState: "open",
    essential: false,
    ...overrides,
  };
}

export function windowPayload(
  overrides: Partial<ZenWindowPayload> = {},
): ZenWindowPayload {
  return {
    id: "window-1",
    private: false,
    focused: true,
    spaces: [
      { id: "{personal}", name: "Personal", order: 0, containerId: "1" },
      { id: "{work}", name: "Work", order: 1, containerId: "4" },
    ],
    tabs: [tabPayload()],
    ...overrides,
  };
}

export function snapshotPayload(
  overrides: Partial<ZenSnapshotPayload> = {},
): ZenSnapshotPayload {
  return {
    session: {
      profileId: "tddguwg7.Default (release)",
      sessionId: "session-1",
      browserVersion: "1.21.9b",
      geckoVersion: "153.0",
      capabilities: [...TRANSPORT_CAPABILITIES],
      profileName: "Default (release)",
      isDefaultProfile: true,
    },
    capturedAt: "2026-07-28T00:00:00.000Z",
    windows: [windowPayload()],
    ...overrides,
  };
}
