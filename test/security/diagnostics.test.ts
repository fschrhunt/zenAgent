import { describe, expect, it } from "vitest";

import {
  crashDiagnostic,
  sanitizedErrorCode,
} from "../../src/security/diagnostics.js";

describe("crash diagnostics", () => {
  it("retains a safe error classification but omits message and stack", () => {
    const error = Object.assign(
      new Error(
        "https://secret.example/?token=do-not-log /Users/person/profile",
      ),
      { code: "browser-unavailable" },
    );
    const diagnostic = crashDiagnostic("native-host", error);

    expect(diagnostic).toBe("native-host failed (browser-unavailable)");
    expect(diagnostic).not.toContain("secret.example");
    expect(diagnostic).not.toContain("token");
    expect(diagnostic).not.toContain("/Users/");
  });

  it("refuses attacker-controlled diagnostic classifications", () => {
    expect(
      sanitizedErrorCode({
        code: "secret value with spaces",
        name: "also/not-safe",
      }),
    ).toBe("unknown-error");
  });
});
