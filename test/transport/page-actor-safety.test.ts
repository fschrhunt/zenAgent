import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const actorSource = readFileSync(
  new URL("../../extension/actors/ZenAgentPageChild.sys.mjs", import.meta.url),
  "utf8",
).replace("export class ZenAgentPageChild", "class ZenAgentPageChild");

function inspectRegisteredClick(source: string): unknown {
  const win = {};
  const document = { defaultView: win, parentNode: null };
  const ancestor = {
    nodeType: 1,
    parentNode: document,
    host: null,
    getAttribute() {
      return null;
    },
  };
  const element = {
    nodeType: 1,
    parentNode: ancestor,
    host: null,
    ownerDocument: document,
    getAttribute() {
      return null;
    },
  };

  return runInNewContext(
    `${actorSource}
assertEventInteractionSafety(element, "Click", ["click"]);
true;`,
    {
      Components: { utils: {} },
      JSWindowActorChild: class {},
      element,
      Services: {
        els: {
          getListenerInfoFor(target: unknown) {
            return target === ancestor
              ? [
                  {
                    type: "click",
                    listenerObject: {},
                    toSource: () => source,
                  },
                ]
              : [];
          },
        },
      },
    },
  );
}

describe("page actor interaction safety", () => {
  it("accepts inspectable registered handlers without foreground UI", () => {
    expect(inspectRegisteredClick("() => updateApplicationState()")).toBe(true);
  });

  it("refuses unsafe registered handlers on the propagation path", () => {
    expect(() =>
      inspectRegisteredClick("() => window.alert('blocked')"),
    ).toThrow(
      expect.objectContaining({
        code: "policy-rejection",
      }),
    );
  });
});
