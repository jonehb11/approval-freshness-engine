import { defineConfig } from "vitest/config";

// Restrict discovery to the source test tree. Without this, running `npm run build` before
// `npm test` (the CI order) makes vitest ALSO pick up the compiled copies under dist/test/,
// double-running every suite — and the compiled copies of tests that resolve repo paths
// relative to their own file location (CODEOWNERS sync guard, pr.ts static source guard)
// fail from dist/test/'s different depth. Source tests are the only tests.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
