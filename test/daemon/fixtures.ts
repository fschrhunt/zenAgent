import {
  known,
  sessionEntityId,
  type BrowserSnapshot,
  type BrowserTab,
} from "../../src/browser/model.js";
import type {
  DaemonTransport,
  DaemonTransportFactory,
} from "../../src/daemon/service.js";
import { PAGE_SCHEMA_VERSION } from "../../src/page/model.js";
import type {
  ZenTransportEvent,
  ZenTransportListener,
} from "../../src/transport/client.js";
import type { TransportCapability } from "../../src/transport/capabilities.js";
import { browserFixture } from "../browser/fixtures.js";

export interface FakeDaemonTransport extends DaemonTransport {
  readonly calls: string[];
  emit(event: ZenTransportEvent): void;
  replaceSnapshot(snapshot: BrowserSnapshot): void;
  readonly closed: boolean;
  readonly mutationGate: {
    wait: boolean;
    release(): void;
  };
}

export function fakeDaemonTransport(
  snapshot = browserFixture().snapshot,
): FakeDaemonTransport {
  let current = snapshot;
  let isClosed = false;
  const listeners = new Set<ZenTransportListener>();
  const calls: string[] = [];
  let releaseMutation: (() => void) | undefined;
  let mutationPromise: Promise<void> | undefined;
  const gate = {
    wait: false,
    release(): void {
      releaseMutation?.();
      releaseMutation = undefined;
      mutationPromise = undefined;
      gate.wait = false;
    },
  };

  const waitForGate = async (): Promise<void> => {
    if (!gate.wait) {
      return;
    }

    mutationPromise ??= new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    await mutationPromise;
  };

  const transport: FakeDaemonTransport = {
    capabilities: [
      "zen.spaces.enumerate",
      "zen.spaces.route",
      "zen.tabs.enumerate-all-spaces",
      "zen.tabs.open-background",
      "browser.windows.private",
      "browser.pages.inspect",
      "browser.pages.snapshot",
      "browser.pages.query",
      "browser.pages.click",
      "browser.pages.fill",
      "browser.pages.type",
      "browser.pages.press",
      "browser.pages.select",
      "browser.pages.check",
      "browser.pages.submit",
      "browser.pages.history",
    ] satisfies readonly TransportCapability[],
    get sessionId() {
      return current.sessions[0]?.id;
    },
    calls,
    mutationGate: gate,
    get closed() {
      return isClosed;
    },
    connect() {
      calls.push("connect");
      return Promise.resolve(current);
    },
    snapshot() {
      calls.push("snapshot");
      return Promise.resolve(current);
    },
    async openTab(options) {
      calls.push(
        `open:${options.windowId ?? ""}:${options.zenSpaceUuid ?? ""}`,
      );
      await waitForGate();
      const session = current.sessions[0];
      const window = current.windows[0];

      if (session === undefined || window === undefined) {
        throw new Error("fixture has no session or window");
      }

      const id = sessionEntityId("tab", session.id, "opened-tab");
      const tab = {
        kind: "tab",
        id,
        windowId: window.id,
        spaceId:
          current.spaces[0] === undefined
            ? known(null)
            : known(current.spaces[0].id),
        browsingContextId: known(null),
        url: known(options.url),
        title: known("Opened"),
        loadState: known("loading"),
        selected: known(false),
        mediaState: known("none"),
        containerId: known(null),
        private: known(false),
        lifecycleState: "open",
      } satisfies BrowserTab;
      current = { ...current, tabs: [...current.tabs, tab] };
      return id.transportId;
    },
    async moveTab(tabId, zenSpaceUuid) {
      calls.push(`move:${tabId}:${zenSpaceUuid}`);
      await waitForGate();
    },
    async navigateTab(tabId, url) {
      calls.push(`navigate:${tabId}:${url}`);
      await waitForGate();
    },
    inspectPage(tabId, options) {
      calls.push(`inspect:${tabId}:${String(options?.maxChars ?? "")}`);
      return Promise.resolve({
        url: "https://example.com/",
        title: "Example",
        loadState: "complete",
        visibleText: "Visible fixture text",
        truncated: false,
        visitedTextNodes: 1,
      });
    },
    snapshotPage(tabId, options) {
      calls.push(`page-snapshot:${tabId}:${String(options?.maxNodes ?? "")}`);
      return Promise.resolve({
        schemaVersion: PAGE_SCHEMA_VERSION,
        snapshotId: "snapshot-1",
        documentId: "document-1",
        tabId,
        capturedAt: "2026-07-29T00:00:00.000Z",
        url: "https://example.com/",
        title: "Example",
        loadState: "complete",
        rootFrameRef: "frame-1",
        frames: [
          {
            frameRef: "frame-1",
            parentFrameRef: null,
            documentId: "document-1",
            url: "https://example.com/",
            loadState: "complete",
            availability: "available",
          },
        ],
        nodes: [],
        truncation: {
          frames: false,
          nodes: false,
          strings: false,
          totalBytes: false,
        },
      });
    },
    queryPage(target, options) {
      calls.push(
        `page-query:${target.tabId}:${target.snapshotId}:${options.locator.kind}`,
      );
      return Promise.resolve({ nodes: [], truncated: false });
    },
    clickPage(target) {
      calls.push(`page-click:${target.tabId}:${target.elementRef}`);
      return Promise.resolve({
        performed: true,
        documentId: target.documentId,
      });
    },
    fillPage(target) {
      calls.push(`page-fill:${target.tabId}:${target.elementRef}`);
      return Promise.resolve({
        performed: true,
        documentId: target.documentId,
      });
    },
    typePage(target) {
      calls.push(`page-type:${target.tabId}:${target.elementRef}`);
      return Promise.resolve({
        performed: true,
        documentId: target.documentId,
      });
    },
    pressPage(target) {
      calls.push(`page-press:${target.tabId}:${target.elementRef}`);
      return Promise.resolve({
        performed: true,
        documentId: target.documentId,
      });
    },
    selectPage(target) {
      calls.push(`page-select:${target.tabId}:${target.elementRef}`);
      return Promise.resolve({
        performed: true,
        documentId: target.documentId,
      });
    },
    checkPage(target) {
      calls.push(`page-check:${target.tabId}:${target.elementRef}`);
      return Promise.resolve({
        performed: true,
        documentId: target.documentId,
      });
    },
    uncheckPage(target) {
      calls.push(`page-uncheck:${target.tabId}:${target.elementRef}`);
      return Promise.resolve({
        performed: true,
        documentId: target.documentId,
      });
    },
    submitPage(target) {
      calls.push(`page-submit:${target.tabId}:${target.elementRef}`);
      return Promise.resolve({
        performed: true,
        documentId: target.documentId,
      });
    },
    backPage(target) {
      calls.push(`page-back:${target.tabId}:${target.documentId}`);
      return Promise.resolve({
        performed: true,
        documentId: target.documentId,
      });
    },
    forwardPage(target) {
      calls.push(`page-forward:${target.tabId}:${target.documentId}`);
      return Promise.resolve({
        performed: true,
        documentId: target.documentId,
      });
    },
    async reloadTab(tabId) {
      calls.push(`reload:${tabId}`);
      await waitForGate();
    },
    async closeTab(tabId) {
      calls.push(`close:${tabId}`);
      await waitForGate();
      current = {
        ...current,
        tabs: current.tabs.filter((tab) => tab.id.transportId !== tabId),
        browsingContexts: current.browsingContexts.filter(
          (context) => context.tabId.transportId !== tabId,
        ),
        frames: current.frames.filter((frame) => {
          const context = current.browsingContexts.find(
            (candidate) =>
              candidate.id.transportId === frame.browsingContextId.transportId,
          );
          return context?.tabId.transportId !== tabId;
        }),
        elements: current.elements.filter(
          (element) => element.tabId.transportId !== tabId,
        ),
      };
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      isClosed = true;
    },
    emit(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    replaceSnapshot(snapshotValue) {
      current = snapshotValue;
    },
  };

  return transport;
}

export function transportSequence(
  ...transports: readonly FakeDaemonTransport[]
): DaemonTransportFactory {
  let index = 0;
  return () => {
    const transport = transports[index];

    if (transport === undefined) {
      throw new Error("No scripted transport remains.");
    }

    index += 1;
    return transport;
  };
}
