import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@jarvis/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
      "@jarvis/policy": fileURLToPath(new URL("./modules/policy/src/index.ts", import.meta.url)),
      "@jarvis/core": fileURLToPath(new URL("./modules/core/src/index.ts", import.meta.url)),
      "@jarvis/tasks": fileURLToPath(new URL("./modules/tasks/src/index.ts", import.meta.url)),
      "@jarvis/model-gateway": fileURLToPath(new URL("./modules/model-gateway/src/index.ts", import.meta.url)),
      "@jarvis/provider-adapters": fileURLToPath(new URL("./packages/provider-adapters/src/index.ts", import.meta.url)),
      "@jarvis/tool-gateway": fileURLToPath(new URL("./modules/tool-gateway/src/index.ts", import.meta.url)),
      "@jarvis/memory": fileURLToPath(new URL("./modules/memory/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["{apps,packages,modules}/*/test/**/*.test.ts"],
    // Databasetester kjører mot ekte embedded PostgreSQL - oppstart tar tid,
    // og flere testfiler starter hver sin instans: kjør filene sekvensielt.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 240_000
  }
});
