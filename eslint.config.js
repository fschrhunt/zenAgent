import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.{ts,mts,cts}"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Browser-chrome code that runs inside Zen, not Node. Its globals are
    // injected by Firefox's SchemaAPIManager sandbox.
    files: ["extension/**/*.js", "test/integration/fixtures/**/*.js"],
    languageOptions: {
      globals: {
        ExtensionAPI: "readonly",
        ExtensionCommon: "readonly",
        IOUtils: "readonly",
        Services: "readonly",
        ChromeUtils: "readonly",
        Cc: "readonly",
        Ci: "readonly",
        Cu: "readonly",
        browser: "readonly",
        crypto: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        WeakRef: "readonly",
      },
    },
    rules: {
      // The API class is consumed by reading it back off the sandbox global,
      // so it has no in-file reference.
      "no-unused-vars": "off",
    },
  },
);
