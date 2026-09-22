import { defineConfig } from "vitest/config";

// Unit tests only: fast, no browser, no network. `pnpm test` must pass on a fresh clone.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    exclude: ["**/*.e2e.test.ts", "**/node_modules/**"],
  },
});
