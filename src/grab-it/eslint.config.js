import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  // bindings.ts is generated from the Rust commands by `npm run bindings`.
  globalIgnores(["dist", "src-tauri", "src/app/bindings.ts"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
  {
    // The smoke tests run in Node under WebdriverIO and Mocha; only the
    // callbacks they pass to browser.execute run in the page.
    files: ["e2e/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.mocha },
    },
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
]);
