import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts"],
      // Entry points that only wire things up and call the network or the console.
      exclude: ["lib/**/index.ts", "lib/eval/run.ts", "lib/eval/live.ts", "lib/web/main.ts"],
      reporter: ["text", "json-summary"],
      // CI fails if coverage drops below these.
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 85 },
    },
  },
});
