import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@jarvis/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
      "@jarvis/policy": fileURLToPath(new URL("./modules/policy/src/index.ts", import.meta.url)),
      "@jarvis/core": fileURLToPath(new URL("./modules/core/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["{apps,packages,modules}/*/test/**/*.test.ts"],
    // Databasetester kjører mot ekte embedded PostgreSQL - oppstart tar tid.
    testTimeout: 30_000,
    hookTimeout: 240_000
  }
});
