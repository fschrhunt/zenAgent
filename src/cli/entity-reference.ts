import type { BrowserSpaceId, BrowserTabId } from "../browser/model.js";

const REFERENCE_PREFIX = "zen:";

interface SerializedEntityReference {
  readonly kind: "space" | "tab";
  readonly profile: string;
  readonly session: string;
  readonly id: string;
}

export class EntityReferenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EntityReferenceError";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeReference(reference: string): SerializedEntityReference {
  if (!reference.startsWith(REFERENCE_PREFIX)) {
    throw new EntityReferenceError(
      "Expected an opaque ID printed by `zen-agent spaces list` or `zen-agent tabs list`.",
    );
  }

  let value: unknown;

  try {
    const json = Buffer.from(
      reference.slice(REFERENCE_PREFIX.length),
      "base64url",
    ).toString("utf8");
    value = JSON.parse(json) as unknown;
  } catch {
    throw new EntityReferenceError("The opaque browser entity ID is invalid.");
  }

  if (
    !isRecord(value) ||
    (value["kind"] !== "space" && value["kind"] !== "tab") ||
    typeof value["profile"] !== "string" ||
    value["profile"].length === 0 ||
    typeof value["session"] !== "string" ||
    value["session"].length === 0 ||
    typeof value["id"] !== "string" ||
    value["id"].length === 0
  ) {
    throw new EntityReferenceError("The opaque browser entity ID is invalid.");
  }

  return {
    kind: value["kind"],
    profile: value["profile"],
    session: value["session"],
    id: value["id"],
  };
}

export function formatEntityReference(
  id: BrowserSpaceId | BrowserTabId,
): string {
  const value: SerializedEntityReference = {
    kind: id.kind,
    profile: id.sessionId.profileId.transportId,
    session: id.sessionId.transportId,
    id: id.transportId,
  };

  return `${REFERENCE_PREFIX}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

function requireReferenceKind(
  reference: string,
  kind: "space" | "tab",
): SerializedEntityReference {
  const decoded = decodeReference(reference);

  if (decoded.kind !== kind) {
    throw new EntityReferenceError(
      `Expected a ${kind} ID, but the supplied opaque ID identifies a ${decoded.kind}.`,
    );
  }

  return decoded;
}

export function parseSpaceReference(reference: string): BrowserSpaceId {
  const decoded = requireReferenceKind(reference, "space");
  return {
    kind: "space",
    sessionId: {
      kind: "session",
      profileId: {
        kind: "profile",
        transportId: decoded.profile,
      },
      transportId: decoded.session,
    },
    transportId: decoded.id,
  };
}

export function parseTabReference(reference: string): BrowserTabId {
  const decoded = requireReferenceKind(reference, "tab");
  return {
    kind: "tab",
    sessionId: {
      kind: "session",
      profileId: {
        kind: "profile",
        transportId: decoded.profile,
      },
      transportId: decoded.session,
    },
    transportId: decoded.id,
  };
}
