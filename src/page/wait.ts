import {
  MAX_PAGE_STRING_CHARS,
  type PageLoadState,
  type PageLocator,
  type PageQueryResult,
  type PageSemanticNode,
} from "./model.js";

export type PageLocatorWaitState =
  "attached" | "detached" | "visible" | "hidden" | "enabled" | "disabled";

export type PageWaitCondition =
  | Readonly<{ kind: "load-state"; state: PageLoadState }>
  | Readonly<{ kind: "url-exact"; url: string }>
  | Readonly<{ kind: "url-contains"; value: string }>
  | Readonly<{ kind: "text-present"; text: string }>
  | Readonly<{ kind: "text-absent"; text: string }>
  | Readonly<{
      kind: "locator";
      locator: PageLocator;
      state: PageLocatorWaitState;
    }>
  | Readonly<{ kind: "document-changed"; fromDocumentId: string }>;

export interface PageWaitObservation {
  readonly documentId: string;
  readonly url: string;
  readonly loadState: PageLoadState;
  readonly nodes: readonly PageSemanticNode[];
  /**
   * The result of evaluating a locator condition's locator against the same
   * document generation. Omit it for conditions that do not use a locator.
   */
  readonly query?: PageQueryResult;
}

export class PageWaitConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageWaitConditionError";
  }
}

const LOAD_STATE_ORDER: Readonly<Record<PageLoadState, number>> = {
  loading: 0,
  interactive: 1,
  complete: 2,
};

const LOCATOR_WAIT_STATES: readonly PageLocatorWaitState[] = [
  "attached",
  "detached",
  "visible",
  "hidden",
  "enabled",
  "disabled",
];

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PageWaitConditionError(`${subject} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));

  if (unexpected !== undefined) {
    throw new PageWaitConditionError(
      `${subject} contains unexpected field ${JSON.stringify(unexpected)}.`,
    );
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  subject: string,
): string {
  const candidate = value[key];

  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > MAX_PAGE_STRING_CHARS
  ) {
    throw new PageWaitConditionError(
      `${subject}.${key} must be a non-empty string of at most ${String(MAX_PAGE_STRING_CHARS)} characters.`,
    );
  }

  return candidate;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  subject: string,
): string | undefined {
  if (!(key in value)) {
    return undefined;
  }

  return requiredString(value, key, subject);
}

function parseLocator(value: unknown): PageLocator {
  const locator = record(value, "locator");
  const kind = locator["kind"];

  switch (kind) {
    case "role": {
      exactKeys(locator, ["kind", "role", "name"], "locator");
      const name = optionalString(locator, "name", "locator");
      return {
        kind,
        role: requiredString(locator, "role", "locator"),
        ...(name === undefined ? {} : { name }),
      };
    }
    case "label":
      exactKeys(locator, ["kind", "label"], "locator");
      return {
        kind,
        label: requiredString(locator, "label", "locator"),
      };
    case "text":
      exactKeys(locator, ["kind", "text"], "locator");
      return { kind, text: requiredString(locator, "text", "locator") };
    case "placeholder":
      exactKeys(locator, ["kind", "placeholder"], "locator");
      return {
        kind,
        placeholder: requiredString(locator, "placeholder", "locator"),
      };
    case "css":
      exactKeys(locator, ["kind", "selector"], "locator");
      return {
        kind,
        selector: requiredString(locator, "selector", "locator"),
      };
    case "element":
      exactKeys(locator, ["kind", "elementRef"], "locator");
      return {
        kind,
        elementRef: requiredString(locator, "elementRef", "locator"),
      };
    default:
      throw new PageWaitConditionError(
        "locator.kind is not a supported locator kind.",
      );
  }
}

/**
 * Parses an untrusted wait condition and rejects unknown fields. This keeps the
 * daemon's polling loop independent from any particular protocol schema.
 */
export function validatePageWaitCondition(input: unknown): PageWaitCondition {
  const condition = record(input, "condition");
  const kind = condition["kind"];

  switch (kind) {
    case "load-state": {
      exactKeys(condition, ["kind", "state"], "condition");
      const state = condition["state"];
      if (
        state !== "loading" &&
        state !== "interactive" &&
        state !== "complete"
      ) {
        throw new PageWaitConditionError(
          "condition.state is not a supported page load state.",
        );
      }
      return { kind, state };
    }
    case "url-exact":
      exactKeys(condition, ["kind", "url"], "condition");
      return { kind, url: requiredString(condition, "url", "condition") };
    case "url-contains":
      exactKeys(condition, ["kind", "value"], "condition");
      return {
        kind,
        value: requiredString(condition, "value", "condition"),
      };
    case "text-present":
    case "text-absent":
      exactKeys(condition, ["kind", "text"], "condition");
      return { kind, text: requiredString(condition, "text", "condition") };
    case "locator": {
      exactKeys(condition, ["kind", "locator", "state"], "condition");
      const state = condition["state"];
      if (
        typeof state !== "string" ||
        !(LOCATOR_WAIT_STATES as readonly string[]).includes(state)
      ) {
        throw new PageWaitConditionError(
          "condition.state is not a supported locator wait state.",
        );
      }
      return {
        kind,
        locator: parseLocator(condition["locator"]),
        state: state as PageLocatorWaitState,
      };
    }
    case "document-changed":
      exactKeys(condition, ["kind", "fromDocumentId"], "condition");
      return {
        kind,
        fromDocumentId: requiredString(
          condition,
          "fromDocumentId",
          "condition",
        ),
      };
    default:
      throw new PageWaitConditionError(
        "condition.kind is not a supported page wait condition.",
      );
  }
}

export function pageWaitConditionLocator(
  condition: PageWaitCondition,
): PageLocator | undefined {
  return condition.kind === "locator" ? condition.locator : undefined;
}

function containsVisibleText(
  nodes: readonly PageSemanticNode[],
  text: string,
): boolean {
  return nodes.some(
    (node) =>
      node.visible &&
      (node.visibleText.includes(text) || node.name.includes(text)),
  );
}

function evaluateLocator(
  state: PageLocatorWaitState,
  result: PageQueryResult | undefined,
): boolean {
  if (result === undefined) {
    throw new PageWaitConditionError(
      "A locator wait condition requires a query result.",
    );
  }

  switch (state) {
    case "attached":
      return result.nodes.length > 0;
    case "detached":
      return result.nodes.length === 0;
    case "visible":
      return result.nodes.some((node) => node.visible);
    case "hidden":
      return (
        result.nodes.length === 0 || result.nodes.every((node) => !node.visible)
      );
    case "enabled":
      return result.nodes.some((node) => node.state.disabled === false);
    case "disabled":
      return result.nodes.some((node) => node.state.disabled === true);
  }
}

/**
 * Evaluates one already-validated condition against a single polling
 * observation. Reaching `interactive` also satisfies `loading`, and reaching
 * `complete` satisfies both earlier load states.
 */
export function evaluatePageWaitCondition(
  condition: PageWaitCondition,
  observation: PageWaitObservation,
): boolean {
  switch (condition.kind) {
    case "load-state":
      return (
        LOAD_STATE_ORDER[observation.loadState] >=
        LOAD_STATE_ORDER[condition.state]
      );
    case "url-exact":
      return observation.url === condition.url;
    case "url-contains":
      return observation.url.includes(condition.value);
    case "text-present":
      return containsVisibleText(observation.nodes, condition.text);
    case "text-absent":
      return !containsVisibleText(observation.nodes, condition.text);
    case "locator":
      return evaluateLocator(condition.state, observation.query);
    case "document-changed":
      return observation.documentId !== condition.fromDocumentId;
  }
}
