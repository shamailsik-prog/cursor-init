import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import globals from "globals";

// Next/React rules do not apply to the Cloud Functions package (P3-19).
const NEXT_ONLY = /^(@next\/next|react|react-hooks|jsx-a11y)\//;
const offForFunctions = Object.fromEntries(
  [...nextVitals, ...nextTs]
    .flatMap((c) => Object.keys(c.rules ?? {}))
    .filter((k) => NEXT_ONLY.test(k))
    .map((k) => [k, "off"]),
);

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Allow intentionally-unused bindings that are `_`-prefixed, and the
      // common "omit a property" pattern of destructuring alongside a rest.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ["functions/**/*.{ts,mjs}"],
    languageOptions: { globals: globals.node },
    rules: offForFunctions,
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "functions/lib/**",
    "functions/node_modules/**",
    "functions/.stryker-tmp/**",
    ".stryker-tmp/**",
    "reports/**",
  ]),
]);

export default eslintConfig;
