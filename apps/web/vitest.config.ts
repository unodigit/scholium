import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Vitest 2 defaults minWorkers to the machine's CPU count, which exceeds an
    // explicit maxWorkers on many-core machines; pin both bounds.
    minWorkers: 1,
    maxWorkers: 2,
    passWithNoTests: true,
  },
});