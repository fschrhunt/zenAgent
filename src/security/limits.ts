import type { BrowserSnapshot } from "../browser/model.js";

export const MAX_DAEMON_JSON_DEPTH = 64;
export const MAX_DAEMON_JSON_NODES = 100_000;
export const MAX_DAEMON_STRING_BYTES = 1024 * 1024;
export const MAX_BROWSER_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const MAX_BROWSER_WINDOWS = 128;
export const MAX_BROWSER_SPACES = 4_096;
export const MAX_BROWSER_TABS = 50_000;
export const MAX_BROWSER_CONTEXTS = 50_000;
export const MAX_BROWSER_FRAMES = 100_000;
export const MAX_BROWSER_ELEMENTS = 100_000;

export class ResourceLimitError extends Error {
  public readonly limit: string;

  public constructor(limit: string, message: string) {
    super(message);
    this.name = "ResourceLimitError";
    this.limit = limit;
  }
}

/**
 * Iterative JSON-shape validation avoids recursive stack exhaustion.
 *
 * Socket input is already valid JSON, but service tests and future in-process
 * adapters can call the daemon directly. Reject cycles, excessive nesting,
 * huge scalar strings, and object-node floods before fingerprinting params.
 */
export function assertJsonResourceLimits(
  value: unknown,
  options: {
    readonly maxDepth?: number;
    readonly maxNodes?: number;
    readonly maxStringBytes?: number;
  } = {},
): void {
  const maxDepth = options.maxDepth ?? MAX_DAEMON_JSON_DEPTH;
  const maxNodes = options.maxNodes ?? MAX_DAEMON_JSON_NODES;
  const maxStringBytes = options.maxStringBytes ?? MAX_DAEMON_STRING_BYTES;
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [
    { value, depth: 0 },
  ];
  const seen = new Set<object>();
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();

    if (current === undefined) {
      break;
    }

    nodes += 1;

    if (nodes > maxNodes) {
      throw new ResourceLimitError(
        "json-nodes",
        `JSON input exceeds the ${String(maxNodes)} node limit.`,
      );
    }

    if (current.depth > maxDepth) {
      throw new ResourceLimitError(
        "json-depth",
        `JSON input exceeds the ${String(maxDepth)} level nesting limit.`,
      );
    }

    if (typeof current.value === "string") {
      if (Buffer.byteLength(current.value, "utf8") > maxStringBytes) {
        throw new ResourceLimitError(
          "json-string-bytes",
          `A JSON string exceeds the ${String(maxStringBytes)} byte limit.`,
        );
      }
      continue;
    }

    if (typeof current.value !== "object" || current.value === null) {
      continue;
    }

    if (seen.has(current.value)) {
      throw new ResourceLimitError(
        "json-cycle",
        "JSON input must not contain a reference cycle.",
      );
    }

    seen.add(current.value);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);

    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

/**
 * Bound what the daemon retains, separately from the native frame ceiling.
 *
 * A valid 64 MiB native message could otherwise remain live indefinitely in
 * the registry. Both serialized size and entity counts are bounded.
 */
export function assertBrowserSnapshotLimits(
  snapshot: BrowserSnapshot,
  maxBytes = MAX_BROWSER_SNAPSHOT_BYTES,
): void {
  const counts: readonly Readonly<{
    name: string;
    actual: number;
    maximum: number;
  }>[] = [
    {
      name: "windows",
      actual: snapshot.windows.length,
      maximum: MAX_BROWSER_WINDOWS,
    },
    {
      name: "Spaces",
      actual: snapshot.spaces.length,
      maximum: MAX_BROWSER_SPACES,
    },
    {
      name: "tabs",
      actual: snapshot.tabs.length,
      maximum: MAX_BROWSER_TABS,
    },
    {
      name: "browsing contexts",
      actual: snapshot.browsingContexts.length,
      maximum: MAX_BROWSER_CONTEXTS,
    },
    {
      name: "frames",
      actual: snapshot.frames.length,
      maximum: MAX_BROWSER_FRAMES,
    },
    {
      name: "elements",
      actual: snapshot.elements.length,
      maximum: MAX_BROWSER_ELEMENTS,
    },
  ];

  for (const count of counts) {
    if (count.actual > count.maximum) {
      throw new ResourceLimitError(
        "snapshot-entities",
        `Browser snapshot contains too many ${count.name}; the limit is ${String(count.maximum)}.`,
      );
    }
  }

  let serialized: string;

  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    throw new ResourceLimitError(
      "snapshot-json",
      "Browser snapshot is not serializable JSON.",
    );
  }

  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new ResourceLimitError(
      "snapshot-bytes",
      `Browser snapshot exceeds the ${String(maxBytes)} byte retained-state limit.`,
    );
  }
}
