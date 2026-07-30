import { describe, expect, it } from "vitest";

import {
  evaluatePageWaitCondition,
  pageWaitConditionLocator,
  PageWaitConditionError,
  validatePageWaitCondition,
  type PageWaitObservation,
} from "../../src/page/wait.js";
import type { PageSemanticNode } from "../../src/page/model.js";

function node(overrides: Partial<PageSemanticNode> = {}): PageSemanticNode {
  return {
    elementRef: "element-1",
    frameRef: "frame-1",
    parentElementRef: null,
    role: "button",
    name: "Save changes",
    visibleText: "Save",
    visible: true,
    geometry: {
      x: 10,
      y: 20,
      width: 100,
      height: 30,
      viewportX: 10,
      viewportY: 20,
      viewportWidth: 100,
      viewportHeight: 30,
    },
    shadowRoot: "none",
    state: {
      disabled: false,
      editable: false,
      checked: null,
      selected: null,
      expanded: null,
      pressed: null,
      required: false,
      readonly: false,
      invalid: false,
      level: null,
      orientation: null,
    },
    actionHints: ["click"],
    ...overrides,
  };
}

function observation(
  overrides: Partial<PageWaitObservation> = {},
): PageWaitObservation {
  return {
    documentId: "document-2",
    url: "https://example.test/account?mode=edit",
    loadState: "complete",
    nodes: [node()],
    ...overrides,
  };
}

describe("page wait conditions", () => {
  it("strictly validates every portable condition kind", () => {
    expect(
      validatePageWaitCondition({
        kind: "load-state",
        state: "interactive",
      }),
    ).toEqual({ kind: "load-state", state: "interactive" });
    expect(
      validatePageWaitCondition({
        kind: "url-exact",
        url: "https://example.test/",
      }),
    ).toEqual({ kind: "url-exact", url: "https://example.test/" });
    expect(
      validatePageWaitCondition({
        kind: "url-contains",
        value: "/account",
      }),
    ).toEqual({ kind: "url-contains", value: "/account" });
    expect(
      validatePageWaitCondition({ kind: "text-present", text: "Save" }),
    ).toEqual({ kind: "text-present", text: "Save" });
    expect(
      validatePageWaitCondition({ kind: "text-absent", text: "Deleted" }),
    ).toEqual({ kind: "text-absent", text: "Deleted" });
    expect(
      validatePageWaitCondition({
        kind: "locator",
        locator: { kind: "role", role: "button", name: "Save" },
        state: "enabled",
      }),
    ).toEqual({
      kind: "locator",
      locator: { kind: "role", role: "button", name: "Save" },
      state: "enabled",
    });
    expect(
      validatePageWaitCondition({
        kind: "document-changed",
        fromDocumentId: "document-1",
      }),
    ).toEqual({
      kind: "document-changed",
      fromDocumentId: "document-1",
    });
  });

  it("rejects malformed conditions, locators, empty strings, and extra fields", () => {
    const invalid = [
      null,
      { kind: "unknown" },
      { kind: "load-state", state: "idle" },
      { kind: "url-exact", url: "" },
      { kind: "text-present", text: "Save", surprise: true },
      {
        kind: "locator",
        locator: { kind: "role", role: "", unknown: true },
        state: "visible",
      },
      {
        kind: "locator",
        locator: { kind: "css", selector: "button" },
        state: "selected",
      },
      { kind: "document-changed", fromDocumentId: 1 },
    ];

    for (const value of invalid) {
      expect(() => validatePageWaitCondition(value)).toThrow(
        PageWaitConditionError,
      );
    }
  });

  it("extracts a locator only for locator conditions", () => {
    const locatorCondition = validatePageWaitCondition({
      kind: "locator",
      locator: { kind: "label", label: "Email" },
      state: "visible",
    });

    expect(pageWaitConditionLocator(locatorCondition)).toEqual({
      kind: "label",
      label: "Email",
    });
    expect(
      pageWaitConditionLocator({
        kind: "load-state",
        state: "complete",
      }),
    ).toBeUndefined();
  });

  it("uses monotonic document load-state semantics", () => {
    expect(
      evaluatePageWaitCondition(
        { kind: "load-state", state: "loading" },
        observation({ loadState: "interactive" }),
      ),
    ).toBe(true);
    expect(
      evaluatePageWaitCondition(
        { kind: "load-state", state: "complete" },
        observation({ loadState: "interactive" }),
      ),
    ).toBe(false);
  });

  it("evaluates exact and substring URL conditions", () => {
    const current = observation();

    expect(
      evaluatePageWaitCondition(
        { kind: "url-exact", url: current.url },
        current,
      ),
    ).toBe(true);
    expect(
      evaluatePageWaitCondition(
        { kind: "url-exact", url: "https://example.test/" },
        current,
      ),
    ).toBe(false);
    expect(
      evaluatePageWaitCondition(
        { kind: "url-contains", value: "/account" },
        current,
      ),
    ).toBe(true);
  });

  it("matches text only on visible semantic nodes and inverts absence", () => {
    const current = observation({
      nodes: [
        node({ visible: false, visibleText: "Secret" }),
        node({ elementRef: "element-2", name: "Confirm order" }),
      ],
    });

    expect(
      evaluatePageWaitCondition(
        { kind: "text-present", text: "Secret" },
        current,
      ),
    ).toBe(false);
    expect(
      evaluatePageWaitCondition(
        { kind: "text-present", text: "Confirm" },
        current,
      ),
    ).toBe(true);
    expect(
      evaluatePageWaitCondition(
        { kind: "text-absent", text: "Deleted" },
        current,
      ),
    ).toBe(true);
  });

  it.each([
    ["attached", [node()], true],
    ["attached", [], false],
    ["detached", [], true],
    ["visible", [node({ visible: true })], true],
    ["visible", [node({ visible: false })], false],
    ["hidden", [], true],
    ["hidden", [node({ visible: false })], true],
    ["hidden", [node({ visible: true })], false],
    ["enabled", [node({ state: { ...node().state, disabled: false } })], true],
    ["enabled", [node({ state: { ...node().state, disabled: null } })], false],
    ["disabled", [node({ state: { ...node().state, disabled: true } })], true],
    [
      "disabled",
      [node({ state: { ...node().state, disabled: false } })],
      false,
    ],
  ] as const)("evaluates locator state %s", (state, nodes, expected) => {
    expect(
      evaluatePageWaitCondition(
        {
          kind: "locator",
          locator: { kind: "css", selector: "button" },
          state,
        },
        observation({ query: { nodes, truncated: false } }),
      ),
    ).toBe(expected);
  });

  it("requires a query result for locator conditions", () => {
    expect(() =>
      evaluatePageWaitCondition(
        {
          kind: "locator",
          locator: { kind: "css", selector: "button" },
          state: "attached",
        },
        observation(),
      ),
    ).toThrow(PageWaitConditionError);
  });

  it("detects a document generation change", () => {
    expect(
      evaluatePageWaitCondition(
        { kind: "document-changed", fromDocumentId: "document-1" },
        observation({ documentId: "document-2" }),
      ),
    ).toBe(true);
    expect(
      evaluatePageWaitCondition(
        { kind: "document-changed", fromDocumentId: "document-2" },
        observation({ documentId: "document-2" }),
      ),
    ).toBe(false);
  });
});
