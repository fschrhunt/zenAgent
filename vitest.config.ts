import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "src/cli/**/*.ts",
        "src/daemon/**/*.ts",
        "src/mcp/**/*.ts",
        "src/resolution/**/*.ts",
        "src/routing/**/*.ts",
      ],
      exclude: ["src/cli.ts", "src/mcp.ts"],
      thresholds: {
        "src/cli/**": {
          statements: 60,
          branches: 55,
          functions: 65,
          lines: 60,
        },
        "src/daemon/**": {
          statements: 75,
          branches: 65,
          functions: 80,
          lines: 75,
        },
        "src/mcp/**": {
          statements: 80,
          branches: 45,
          functions: 90,
          lines: 80,
        },
        "src/resolution/**": {
          statements: 90,
          branches: 85,
          functions: 95,
          lines: 90,
        },
        "src/routing/**": {
          statements: 90,
          branches: 85,
          functions: 95,
          lines: 90,
        },
      },
    },
  },
});
