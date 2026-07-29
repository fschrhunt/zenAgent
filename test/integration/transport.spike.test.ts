/**
 * DEV-261 transport spike harness.
 *
 * Proves, against a real Zen build, that WebDriver BiDi can discover and
 * operate tabs without selecting them. Requires Zen to be installed, so it is
 * opt-in:
 *
 *   npm run spike:transport            # headless
 *   ZEN_SPIKE_HEADED=1 npm run spike:transport
 *
 * The invariant every case asserts is the same one the product promises: the
 * map of which browsing context is visible must be identical before and after
 * the operation. `browsingContext.activate` is included as a control -- it is
 * the one command that is *supposed* to change that map, and it does.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BidiClient } from "./bidi.js";
import { launchScratchZen, locateZen, type ScratchZen } from "./zen.js";

const enabled = process.env["ZEN_SPIKE"] === "1";
const headless = process.env["ZEN_SPIKE_HEADED"] !== "1";
const zen = enabled ? locateZen() : undefined;

interface BrowsingContextInfo {
  readonly context: string;
  readonly url: string;
  readonly userContext: string;
  readonly clientWindow: string;
  readonly parent: string | null;
  readonly originalOpener: string | null;
  readonly children: readonly BrowsingContextInfo[];
}

/** A page that reports its own visibility and keeps a timer running. */
const PROBE_PAGE =
  "data:text/html," +
  encodeURIComponent(
    `<title>probe</title><body><input id="field">` +
      `<div id="ticks">0</div>` +
      `<script>` +
      `let n = 0; setInterval(() => { n++; ` +
      `document.getElementById("ticks").textContent = String(n); }, 100);` +
      `</script>`,
  );

describe.skipIf(!enabled || zen === undefined)(
  "Zen BiDi transport",
  () => {
    let instance: ScratchZen;
    let client: BidiClient;

    beforeAll(async () => {
      if (zen === undefined) throw new Error("Zen not found");
      instance = await launchScratchZen(zen, { headless });
      if (instance.sessionUrl === undefined) {
        throw new Error("Zen did not announce a BiDi endpoint");
      }
      client = await BidiClient.connect(instance.sessionUrl);
      await client.newSession();
      await client.subscribe([
        "browsingContext.contextCreated",
        "browsingContext.contextDestroyed",
        "browsingContext.navigationStarted",
        "browsingContext.domContentLoaded",
        "browsingContext.load",
      ]);
    }, 90_000);

    afterAll(async () => {
      // Always end the session. An abrupt disconnect leaks it permanently.
      await client?.close();
      await instance?.stop();
    });

    const getTree = async (): Promise<readonly BrowsingContextInfo[]> =>
      (
        await client.send<{ contexts: BrowsingContextInfo[] }>(
          "browsingContext.getTree",
        )
      ).contexts;

    const evaluate = async (context: string, expression: string) => {
      const result = await client.send<{
        result: { type: string; value?: unknown };
      }>("script.evaluate", {
        expression,
        target: { context },
        awaitPromise: false,
      });
      return result.result.value;
    };

    /** Which contexts the browser currently considers visible. */
    const visibilityMap = async (): Promise<Record<string, unknown>> => {
      const map: Record<string, unknown> = {};
      for (const info of await getTree()) {
        map[info.context] = await evaluate(
          info.context,
          "document.visibilityState",
        );
      }
      return map;
    };

    it("enumerates tabs that existed before the client connected", async () => {
      const contexts = await getTree();

      expect(contexts.length).toBeGreaterThan(0);
      const first = contexts[0];
      expect(first).toBeDefined();
      // The identifiers the tab registry will be built on.
      expect(first?.context).toEqual(expect.any(String));
      expect(first?.clientWindow).toEqual(expect.any(String));
      expect(first?.userContext).toEqual(expect.any(String));
    });

    it("opens a background tab without changing what is visible", async () => {
      const before = await visibilityMap();

      const created = await client.send<{ context: string }>(
        "browsingContext.create",
        { type: "tab", background: true },
      );

      const after = await visibilityMap();
      // The new context is additive; nothing that already existed changed.
      for (const [context, state] of Object.entries(before)) {
        expect(after[context]).toBe(state);
      }
      expect(after[created.context]).toBe("hidden");
    });

    it("navigates a non-selected tab without selecting it", async () => {
      const { context } = await client.send<{ context: string }>(
        "browsingContext.create",
        { type: "tab", background: true },
      );
      const before = await visibilityMap();

      await client.send("browsingContext.navigate", {
        context,
        url: PROBE_PAGE,
        wait: "complete",
      });

      expect(await visibilityMap()).toEqual(before);
      expect(await evaluate(context, "document.title")).toBe("probe");
    });

    it("types into a non-selected tab without selecting it", async () => {
      const { context } = await client.send<{ context: string }>(
        "browsingContext.create",
        { type: "tab", background: true },
      );
      await client.send("browsingContext.navigate", {
        context,
        url: PROBE_PAGE,
        wait: "complete",
      });
      await evaluate(context, "document.getElementById('field').focus()");
      const before = await visibilityMap();

      await client.send("input.performActions", {
        context,
        actions: [
          {
            type: "key",
            id: "keyboard",
            actions: [..."hi"].flatMap((value) => [
              { type: "keyDown", value },
              { type: "keyUp", value },
            ]),
          },
        ],
      });

      expect(await visibilityMap()).toEqual(before);
      expect(
        await evaluate(context, "document.getElementById('field').value"),
      ).toBe("hi");
    });

    it("screenshots a non-selected tab without selecting it", async () => {
      const { context } = await client.send<{ context: string }>(
        "browsingContext.create",
        { type: "tab", background: true },
      );
      await client.send("browsingContext.navigate", {
        context,
        url: PROBE_PAGE,
        wait: "complete",
      });
      const before = await visibilityMap();

      const shot = await client.send<{ data: string }>(
        "browsingContext.captureScreenshot",
        { context },
      );

      expect(shot.data.length).toBeGreaterThan(0);
      expect(await visibilityMap()).toEqual(before);
    });

    it("keeps a stable context id across a cross-origin navigation", async () => {
      const { context } = await client.send<{ context: string }>(
        "browsingContext.create",
        { type: "tab", background: true },
      );

      await client.send("browsingContext.navigate", {
        context,
        url: "data:text/html,<title>one</title>",
        wait: "complete",
      });
      await client.send("browsingContext.navigate", {
        context,
        url: "about:blank",
        wait: "complete",
      });

      const found = (await getTree()).find((info) => info.context === context);
      expect(found).toBeDefined();
    });

    it("reports lifecycle events for background contexts", () => {
      const seen = new Set(client.events.map((event) => event.method));

      expect(seen).toContain("browsingContext.contextCreated");
      expect(seen).toContain("browsingContext.navigationStarted");
      expect(seen).toContain("browsingContext.load");
      // No selection event exists. Selection is invisible to BiDi.
      expect([...seen].some((name) => name.includes("activate"))).toBe(false);
    });

    it("CONTROL: activate is the one command that changes visibility", async () => {
      const { context } = await client.send<{ context: string }>(
        "browsingContext.create",
        { type: "tab", background: true },
      );
      expect(await evaluate(context, "document.visibilityState")).toBe(
        "hidden",
      );

      await client.send("browsingContext.activate", { context });

      expect(await evaluate(context, "document.visibilityState")).toBe(
        "visible",
      );
    });
  },
  120_000,
);
