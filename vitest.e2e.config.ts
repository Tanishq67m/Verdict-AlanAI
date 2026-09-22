import { defineConfig } from "vitest/config";

// Browser tests: drive real Chromium against a local fixture app with a scripted LLM.
// Needs `pnpm setup:browsers` once. No network, no API key.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
