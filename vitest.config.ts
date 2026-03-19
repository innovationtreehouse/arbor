import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@arbor/db": path.resolve("./packages/db/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts"],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        lines: 90,
        branches: 80,
      },
    },
  },
});
