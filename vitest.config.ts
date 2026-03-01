import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/cli/**",
        "src/mcp/server.ts",
        "src/providers/local.ts",
        "src/providers/ollama.ts",
        "src/providers/openai.ts",
        "src/db/connection.ts",
        "src/core/index.ts",
        "src/db/index.ts",
        "src/providers/index.ts",
        "src/providers/embedding.ts",
        "src/web/graph-api.ts",
      ],
      thresholds: {
        statements: 75,
        branches: 75,
        functions: 75,
        lines: 75,
      },
    },
  },
});
