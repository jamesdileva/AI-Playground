import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "test-results/",
      "playwright-report/",
      "*.tmp.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ["tests/e2e/**/*.ts", "playwright.config.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/room/queries.ts", "src/canvas/queries.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/\\b(FROM|INTO|UPDATE)\\s+(messages|canvas_ops)\\b/i]",
          message:
            "Touch the messages table only through src/room/queries.ts and canvas_ops only through src/canvas/queries.ts (Rule I isolation).",
        },
        {
          selector:
            "TemplateLiteral > TemplateElement[value.raw=/\\b(FROM|INTO|UPDATE)\\s+(messages|canvas_ops)\\b/i]",
          message:
            "Touch the messages table only through src/room/queries.ts and canvas_ops only through src/canvas/queries.ts (Rule I isolation).",
        },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
