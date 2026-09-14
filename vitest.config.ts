import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@jarvis/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
      "@jarvis/policy": fileURLToPath(new URL("./modules/policy/src/index.ts", import.meta.url)),
      // Subpath-aliaset MAA staa foer "@jarvis/core": Vite matcher ogsaa prefiks,
      // saa den brede noekkelen ville ellers skrevet om "@jarvis/core/testing"
      // til ".../src/index.ts/testing".
      "@jarvis/core/testing": fileURLToPath(new URL("./modules/core/src/testing/index.ts", import.meta.url)),
      "@jarvis/core": fileURLToPath(new URL("./modules/core/src/index.ts", import.meta.url)),
      "@jarvis/tasks": fileURLToPath(new URL("./modules/tasks/src/index.ts", import.meta.url)),
      "@jarvis/model-gateway": fileURLToPath(new URL("./modules/model-gateway/src/index.ts", import.meta.url)),
      "@jarvis/provider-adapters": fileURLToPath(new URL("./packages/provider-adapters/src/index.ts", import.meta.url)),
      "@jarvis/tool-gateway": fileURLToPath(new URL("./modules/tool-gateway/src/index.ts", import.meta.url)),
      "@jarvis/memory": fileURLToPath(new URL("./modules/memory/src/index.ts", import.meta.url)),
      "@jarvis/knowledge": fileURLToPath(new URL("./modules/knowledge/src/index.ts", import.meta.url)),
      "@jarvis/watchdog": fileURLToPath(new URL("./modules/watchdog/src/index.ts", import.meta.url)),
      "@jarvis/erasure": fileURLToPath(new URL("./modules/erasure/src/index.ts", import.meta.url)),
      "@jarvis/business": fileURLToPath(new URL("./modules/business/src/index.ts", import.meta.url)),
      "@jarvis/conversation-graph": fileURLToPath(new URL("./modules/conversation-graph/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: [
      "{apps,packages,modules}/*/test/**/*.test.ts",
      // Ikke-produkt infrastruktur (D-126): worker/supervisor-kilden i ops/ er
      // ren .mjs uten byggesteg, fordi den kjøres direkte av node på hosten.
      "ops/*/test/**/*.test.mjs"
    ],
    // Databasetester kjører mot ekte embedded PostgreSQL - oppstart tar tid,
    // og flere testfiler starter hver sin instans: kjør filene sekvensielt.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 240_000
  }
});
