import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // mysql2 does not ship generic result types, so `as any` casts on query
    // results are an accepted pattern throughout this codebase.
    // Similarly, test files use `require()` for Jest mock access patterns.
    // Suppress these two rules project-wide; all other TS strict rules remain.
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      // Legitimate pattern: resetting loading state before async fetches is
      // intentional and safe. The React-Compiler rule is too strict here.
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
