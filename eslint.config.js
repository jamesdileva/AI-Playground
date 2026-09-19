import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/room/queries.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/\\b(FROM|INTO|UPDATE)\\s+messages\\b/i]",
          message:
            "Touch the messages table only through src/room/queries.ts (Rule I isolation).",
        },
        {
          selector:
            "TemplateLiteral > TemplateElement[value.raw=/\\b(FROM|INTO|UPDATE)\\s+messages\\b/i]",
          message:
            "Touch the messages table only through src/room/queries.ts (Rule I isolation).",
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
