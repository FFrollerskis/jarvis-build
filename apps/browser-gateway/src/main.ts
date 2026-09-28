import { PlaywrightBrowserEngine } from "./browser-engine.ts";
import { createBrowserGateway } from "./server.ts";

/**
 * D-339: egen prosess (CLAUDE.md ufravikelig regel 5, SAMME "egen
 * prosess"-presedens som voice-gateway, D-212). Ingen database, ingen
 * secrets - denne prosessen har ingen ekstern credential i det hele tatt,
 * bare en delt Chromium-instans.
 */
const port = Number(process.env["JARVIS_BROWSER_GATEWAY_PORT"] ?? "3030");
const engine = new PlaywrightBrowserEngine();
const server = createBrowserGateway({ engine });

server.listen(port, () => {
  console.log(`jarvis-browser-gateway listening on :${port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await engine.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
