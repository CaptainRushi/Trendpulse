import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "web/dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  // Plain JS tooling scripts have no tsconfig project — parse without type info.
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false },
      globals: { process: "readonly", console: "readonly" },
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Single-file exception: the asset-copy helper is plain JS tooling.
          allowDefaultProject: ["server/scripts/copy-assets.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/test/**/*.ts", "**/test/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      // Fakes and promise-returning test doubles intentionally omit await.
      "@typescript-eslint/require-await": "off",
    },
  },
);
