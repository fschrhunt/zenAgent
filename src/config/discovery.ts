import {
  CONFIG_SCHEMA_VERSION,
  ConfigValidationError,
  parseConfig,
  type SpaceMappings,
} from "./schema.js";

export interface DiscoveredSpace {
  readonly id: string;
  readonly name?: string;
}

export interface SpaceMappingSelection {
  readonly personal?: string;
  readonly work?: string;
  readonly aliases?: Readonly<Record<string, string>>;
}

export class SpaceMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaceMappingError";
  }
}

/**
 * Validates a command's requested mappings against an already-discovered
 * snapshot. It does not activate, select, or otherwise touch a Zen Space.
 */
export function mapDiscoveredSpaces(
  discovered: readonly DiscoveredSpace[],
  selection: SpaceMappingSelection,
): SpaceMappings {
  const discoveredIds = new Set(discovered.map((space) => space.id));
  if (discoveredIds.size !== discovered.length) {
    throw new SpaceMappingError(
      "The discovered Space list contains duplicate stable IDs.",
    );
  }

  const aliases = selection.aliases ?? {};
  const requested = [
    ...(selection.personal === undefined
      ? []
      : [{ name: "personal", id: selection.personal }]),
    ...(selection.work === undefined
      ? []
      : [{ name: "work", id: selection.work }]),
    ...Object.entries(aliases).map(([name, id]) => ({ name, id })),
  ];
  if (requested.length === 0) {
    throw new SpaceMappingError(
      "At least one Space mapping must be requested.",
    );
  }

  for (const item of requested) {
    if (!discoveredIds.has(item.id)) {
      throw new SpaceMappingError(
        `Cannot map '${item.name}' to undiscovered Space ID '${item.id}'. Refresh discovery and use an exact returned ID.`,
      );
    }
  }

  const spaces = {
    ...(selection.personal === undefined
      ? {}
      : { personal: selection.personal }),
    ...(selection.work === undefined ? {} : { work: selection.work }),
    aliases: { ...aliases },
  };

  try {
    return parseConfig({
      version: CONFIG_SCHEMA_VERSION,
      profile: "discovery-validation",
      spaces,
      routing: { rules: [] },
    }).spaces;
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw new SpaceMappingError(error.message);
    }
    throw error;
  }
}
