const SAFE_DIAGNOSTIC_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;

/**
 * Reduce an arbitrary exception to a bounded classification.
 *
 * Messages and stacks may contain URLs, page data, form values, filesystem
 * paths, or malformed frame excerpts. They are intentionally never returned.
 */
export function sanitizedErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "unknown-error";
  }

  const record = error as Readonly<Record<string, unknown>>;
  const code = record["code"];

  if (typeof code === "string" && SAFE_DIAGNOSTIC_CODE.test(code)) {
    return code;
  }

  const name = record["name"];

  if (typeof name === "string" && SAFE_DIAGNOSTIC_CODE.test(name)) {
    return name;
  }

  return "unknown-error";
}

export function crashDiagnostic(component: string, error: unknown): string {
  const safeComponent = SAFE_DIAGNOSTIC_CODE.test(component)
    ? component
    : "process";
  return `${safeComponent} failed (${sanitizedErrorCode(error)})`;
}
