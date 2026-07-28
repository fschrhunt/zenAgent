import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli/run.js";

describe("runCli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the version", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    expect(runCli(["version"])).toBe(0);
    expect(stdout).toHaveBeenCalledWith("0.1.0\n");
  });

  it("rejects an unknown command", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(runCli(["drive-my-screen"])).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Unknown command: drive-my-screen"),
    );
  });
});
