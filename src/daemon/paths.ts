import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface DaemonPaths {
  readonly directory: string;
  readonly socket: string;
  readonly lock: string;
}

export class DaemonDiscoveryError extends Error {
  public readonly code: "ambiguous-profile";

  public constructor(message: string) {
    super(message);
    this.name = "DaemonDiscoveryError";
    this.code = "ambiguous-profile";
  }
}

export interface DaemonDiscoveryOptions {
  /** Test/bootstrap override; production uses the current user's daemon dir. */
  readonly directory?: string;
}

/**
 * Keep the socket path short enough for Darwin's Unix-socket limit while
 * separating profiles without putting a profile path or name in the filename.
 */
export function daemonPaths(profileId = "default"): DaemonPaths {
  const profileKey = createHash("sha256")
    .update(profileId)
    .digest("hex")
    .slice(0, 12);
  const directory = join(
    tmpdir(),
    `zen-agent-${String(process.getuid?.() ?? process.pid)}`,
  );

  return {
    directory,
    socket: join(directory, `${profileKey}.sock`),
    lock: join(directory, `${profileKey}.lock`),
  };
}

/**
 * Resolve the daemon socket without guessing a profile.
 *
 * A configured profile maps deterministically to its socket. During first-run
 * bootstrap, exactly one published profile may be discovered automatically;
 * multiple profiles are an explicit ambiguity that configuration must resolve.
 */
export async function discoverDaemonSocket(
  profileId?: string,
  options: DaemonDiscoveryOptions = {},
): Promise<string> {
  const directory = options.directory ?? daemonPaths().directory;

  if (profileId !== undefined) {
    return join(directory, basename(daemonPaths(profileId).socket));
  }

  const paths = daemonPaths();
  let entries: readonly string[];

  try {
    entries = await readdir(directory);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return join(directory, basename(paths.socket));
    }

    throw error;
  }

  const sockets = entries
    .filter((entry) => /^[a-f0-9]{12}\.sock$/u.test(entry))
    .toSorted();

  if (sockets.length === 0) {
    return join(directory, basename(paths.socket));
  }

  const socket = sockets[0];

  if (sockets.length > 1 || socket === undefined) {
    throw new DaemonDiscoveryError(
      "More than one Zen profile daemon is active. Configure an explicit profile before issuing browser commands.",
    );
  }

  return join(directory, socket);
}
