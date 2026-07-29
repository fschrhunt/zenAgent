import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { startNativeHost } from "../../src/native/host.js";
import { MessageDecoder } from "../../src/transport/framing.js";
import {
  event,
  parseMessage,
  response,
  type TransportEventName,
} from "../../src/transport/protocol.js";
import { encodeChunked } from "../../src/transport/chunking.js";
import {
  snapshotPayload,
  tabPayload,
  windowPayload,
} from "../transport/fixtures.js";

/**
 * The whole host loop, driven the way Zen drives it.
 *
 * This is the closest thing to an end-to-end test that can run without a
 * browser: real framing, real protocol, the host's own connect-and-reconcile
 * chain. What it cannot cover is whether Zen loads the extension at all, which
 * is why `docs/transport.md` keeps a list of what is still unproven.
 */
function scriptedBrowser(): {
  input: PassThrough;
  output: PassThrough;
  requests: string[];
  emit(name: TransportEventName, payload: unknown): void;
  setTabCount(count: number): void;
} {
  // `input` is what the host reads; `output` is what it writes.
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new MessageDecoder();
  const requests: string[] = [];
  let tabCount = 2;

  const deliver = (value: unknown): void => {
    for (const frame of encodeChunked(value)) {
      input.write(Buffer.from(frame));
    }
  };

  const payload = (): ReturnType<typeof snapshotPayload> =>
    snapshotPayload({
      windows: [
        windowPayload({
          tabs: Array.from({ length: tabCount }, (_, n) =>
            tabPayload({
              id: `tab-${String(n + 1)}`,
              spaceId: n % 2 === 0 ? "{personal}" : "{work}",
              selected: n === 0,
            }),
          ),
        }),
      ],
    });

  output.on("data", (chunk: Buffer) => {
    for (const raw of decoder.push(chunk)) {
      const message = parseMessage(raw);

      if (message.type !== "request") {
        continue;
      }

      requests.push(message.method);

      if (message.method === "session.describe") {
        deliver(response(message.id, snapshotPayload().session));
      } else if (message.method === "browser.snapshot") {
        deliver(response(message.id, payload()));
      }
    }
  });

  return {
    input,
    output,
    requests,
    emit(name, eventPayload) {
      deliver(event(name, eventPayload));
    },
    setTabCount(count) {
      tabCount = count;
    },
  };
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20));
};

describe("the native host", () => {
  it("handshakes, snapshots, and loads the registry once", async () => {
    const browser = scriptedBrowser();
    const log: string[] = [];
    const host = await startNativeHost({
      input: browser.input,
      output: browser.output,
      log: (line) => log.push(line),
    });

    expect(browser.requests).toEqual(["session.describe", "browser.snapshot"]);
    expect(host.registry.entities("tab")).toHaveLength(2);
    expect(log.join("\n")).toContain("connected; capabilities");
  });

  it("does not load the initial snapshot twice when session.ready races it", async () => {
    // The extension emits `session.ready` as soon as it has a listener, which
    // can land while the first snapshot is still in flight. Loading twice is
    // rejected by the registry outright, so this must funnel through one chain.
    const browser = scriptedBrowser();
    const log: string[] = [];
    const starting = startNativeHost({
      input: browser.input,
      output: browser.output,
      log: (line) => log.push(line),
    });

    browser.emit("session.ready", { reason: "the extension started" });
    const host = await starting;
    await settle();

    expect(log.join("\n")).not.toContain("already been loaded");
    expect(log.join("\n")).not.toContain("snapshot failed");
    expect(host.registry.entities("tab")).toHaveLength(2);
  });

  it("applies a tab.created delta without taking a fresh snapshot", async () => {
    const browser = scriptedBrowser();
    const host = await startNativeHost({
      input: browser.input,
      output: browser.output,
      log: () => undefined,
    });

    browser.emit("tab.created", {
      windowId: "window-1",
      tab: tabPayload({ id: "tab-3", spaceId: "{work}" }),
    });
    await settle();

    expect(host.registry.entities("tab")).toHaveLength(3);
    expect(
      browser.requests.filter((method) => method === "browser.snapshot"),
    ).toHaveLength(1);
  });

  it("re-snapshots when the extension says its view cannot be trusted", async () => {
    const browser = scriptedBrowser();
    const host = await startNativeHost({
      input: browser.input,
      output: browser.output,
      log: () => undefined,
    });

    browser.setTabCount(4);
    browser.emit("registry.invalidated", { reason: "a window opened" });
    await settle();

    expect(host.registry.entities("tab")).toHaveLength(4);
    expect(
      browser.requests.filter((method) => method === "browser.snapshot"),
    ).toHaveLength(2);
  });

  it("keeps page content out of the log", async () => {
    // The fixture's tabs carry a URL and a title. Neither may appear.
    const browser = scriptedBrowser();
    const log: string[] = [];
    await startNativeHost({
      input: browser.input,
      output: browser.output,
      log: (line) => log.push(line),
    });

    const written = log.join("\n");
    expect(written).not.toContain("example.com");
    expect(written).not.toContain("Example");
    expect(written).toContain("2 tab(s)");
  });
});
