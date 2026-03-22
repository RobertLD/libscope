import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // Map @libscope/parsers to TypeScript source so vitest doesn't need a pre-built dist
      "@libscope/parsers": resolve(import.meta.dirname, "packages/parsers/src/index.ts"),
    },
  },
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
        "src/api/indexing/repoConfig.ts",
        "src/api/indexing/repoIndexer.ts",
        "src/db/connection.ts",
        "src/core/index.ts",
        "src/db/index.ts",
        "src/providers/index.ts",
        "src/providers/embedding.ts",
        "src/web/graph-api.ts",
        "src/core/parsers/index.ts",
      ],
      thresholds: {
        statements: 75,
        branches: 73,
        functions: 75,
        lines: 75,
      },
    },
  },
});
