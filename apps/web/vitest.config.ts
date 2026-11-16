import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Bound the worker pool: test runners otherwise size themselves to the
    // whole machine, which oversubscribes CPU and memory under parallel agents.
    maxWorkers: 2,
    passWithNoTests: true,
    exclude: ["**/node_modules/**", "tests/e2e/**"],
  },
});
